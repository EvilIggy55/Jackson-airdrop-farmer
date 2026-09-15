/**
 * sweep-to-address.ts -- move every farm wallet's ETH to ONE address you control.
 *
 * DRY RUN IS THE DEFAULT. Without --execute it reads balances and estimates fees
 * from public chain data only: no private key is decrypted and nothing is signed.
 * The dry run therefore works with plain npx; sending needs the key wrapper.
 *
 *   npx tsx src/sweep-to-address.ts 0xYourAddress                     # dry run
 *   .\farm.ps1 src/sweep-to-address.ts 0xYourAddress --execute --confirm ABCD
 *        (ABCD = the last 4 characters of the destination address)
 *   add --chains unichain,megaeth to limit the chains
 *
 * Per wallet, per chain: unwrap any WETH, then send the native ETH balance minus a
 * fee reserve. Amounts below MIN_SWEEP are skipped as not worth the fee. USDC and
 * other tokens are NOT moved.
 */
import "dotenv/config";
import { ethers } from "ethers";
import { appendFileSync, mkdirSync } from "fs";
import path from "path";
import { fileURLToPath } from "url";

// The project default Ethereum RPC (eth.llamarpc.com) was unreachable when this
// was written; the chains module reads RPC_* at import time, so set it first.
process.env.RPC_ETHEREUM ||= "https://ethereum-rpc.publicnode.com";

const { loadWallets, getPrivateKey } = await import("./wallet-manager.js");
const { getProvider, getChain } = await import("./chains/index.js");
const { WETH_ADDRESSES } = await import("./protocols/weth.js");

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const RECEIPTS = path.resolve(__dirname, "../logs/sweep-receipts.jsonl");

const DEFAULT_CHAINS = ["ethereum", "base", "scroll", "linea", "zksync", "arbitrum", "optimism", "megaeth", "abstract", "unichain"];
const MIN_SWEEP = ethers.parseEther("0.00005");
const TX_TIMEOUT_MS = 180_000;

// Chains that bill an L1 data fee on top of L2 gas. Without reserving it, a
// "balance minus gas" send fails for insufficient funds.
const L1_FEE_ORACLES: Record<string, string> = {
  base: "0x420000000000000000000000000000000000000F",
  optimism: "0x420000000000000000000000000000000000000F",
  unichain: "0x420000000000000000000000000000000000000F",
  megaeth: "0x420000000000000000000000000000000000000F",
  scroll: "0x5300000000000000000000000000000000000002",
};
const ORACLE_ABI = ["function getL1Fee(bytes) view returns (uint256)"];
const WETH_ABI = ["function balanceOf(address) view returns (uint256)", "function withdraw(uint256 wad)"];
const WETH_IFACE = new ethers.Interface(WETH_ABI);

type FeeFields = { maxFeePerGas: bigint; maxPriorityFeePerGas: bigint } | { gasPrice: bigint };
type Quote = { gasLimit: bigint; fee: FeeFields; l1Fee: bigint; total: bigint };

function argValue(name: string): string | undefined {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

function eth(wei: bigint): string {
  return Number(ethers.formatEther(wei)).toFixed(6);
}

function withTimeout<T>(p: Promise<T>, ms: number, what: string): Promise<T> {
  return Promise.race([p, new Promise<T>((_, rej) => setTimeout(() => rej(new Error(`${what} not confirmed within ${ms / 1000}s`)), ms))]);
}

async function quote(chain: string, from: string, to: string, data: string, value: bigint): Promise<Quote> {
  const provider = getProvider(chain);
  const [feeData, estimate, nonce] = await Promise.all([
    provider.getFeeData(),
    provider.estimateGas({ from, to, data, value }),
    provider.getTransactionCount(from, "pending"),
  ]);
  // Headroom for zk chains, whose estimates move with pubdata price. Unused gas is refunded.
  const gasLimit = (estimate * 125n) / 100n;
  let fee: FeeFields;
  let perGas: bigint;
  if (feeData.maxFeePerGas != null && feeData.maxPriorityFeePerGas != null) {
    fee = { maxFeePerGas: feeData.maxFeePerGas, maxPriorityFeePerGas: feeData.maxPriorityFeePerGas };
    perGas = feeData.maxFeePerGas;
  } else if (feeData.gasPrice != null) {
    fee = { gasPrice: feeData.gasPrice };
    perGas = feeData.gasPrice;
  } else {
    throw new Error("RPC returned no fee data");
  }
  let l1Fee = 0n;
  const oracle = L1_FEE_ORACLES[chain];
  if (oracle) {
    try {
      const unsigned = ethers.Transaction.from({
        type: "gasPrice" in fee ? 0 : 2, chainId: getChain(chain).chainId, nonce, to, value, data, gasLimit, ...fee,
      }).unsignedSerialized;
      const raw: bigint = await new ethers.Contract(oracle, ORACLE_ABI, provider).getL1Fee(unsigned + "00".repeat(68));
      l1Fee = (raw * 150n) / 100n; // signature bytes + price movement
    } catch {
      l1Fee = 0n; // not an L1-fee chain after all
    }
  }
  return { gasLimit, fee, l1Fee, total: gasLimit * perGas + l1Fee };
}

function record(entry: Record<string, unknown>): void {
  mkdirSync(path.dirname(RECEIPTS), { recursive: true });
  appendFileSync(RECEIPTS, JSON.stringify({ timestamp: new Date().toISOString(), ...entry }) + "\n");
}

async function main(): Promise<number> {
  const rawDest = process.argv.slice(2).find((a) => /^0x[0-9a-fA-F]{40}$/.test(a));
  if (!rawDest) {
    console.log("Usage: npx tsx src/sweep-to-address.ts 0xDestination [--chains a,b] [--execute --confirm LAST4]");
    return 2;
  }
  let dest: string;
  try {
    dest = ethers.getAddress(rawDest); // rejects a mistyped mixed-case checksum
  } catch {
    console.log("ABORT: that address fails its checksum - it has a typo. Copy it again from your wallet app.");
    return 1;
  }
  // zkSync/Abstract reserve addresses below 2^16 for system contracts; nobody's wallet lives there.
  if (BigInt(dest) < 0x10000n) { console.log("ABORT: reserved/burn-range address - not a real wallet."); return 1; }

  const wallets = loadWallets();
  if (wallets.some((w) => ethers.getAddress(w.address) === dest)) {
    console.log("ABORT: the destination is one of the farm's own wallets.");
    return 1;
  }

  const execute = process.argv.includes("--execute");
  if (execute) {
    const confirm = (argValue("--confirm") || "").toLowerCase();
    if (confirm !== dest.slice(-4).toLowerCase()) {
      console.log(`ABORT: --execute needs --confirm with the last 4 characters of the destination (${dest.slice(-4)}).`);
      return 1;
    }
  }
  const chains = (argValue("--chains")?.split(",").map((c) => c.trim().toLowerCase()).filter(Boolean)) || DEFAULT_CHAINS;
  const allowContract = process.argv.includes("--allow-contract");

  let price = 0;
  try {
    const r = await fetch("https://api.coingecko.com/api/v3/simple/price?ids=ethereum&vs_currencies=usd");
    price = (await r.json()).ethereum.usd;
  } catch { /* display only */ }
  const usd = (wei: bigint) => (price ? `$${(Number(ethers.formatEther(wei)) * price).toFixed(2)}` : "");

  console.log(`${execute ? "EXECUTE" : "DRY RUN (nothing decrypted, nothing sent)"} -> ${dest}`);
  console.log(`wallets: ${wallets.length} | chains: ${chains.join(", ")}${price ? ` | ETH $${price}` : ""}\n`);

  let grandReceive = 0n, grandFees = 0n;
  const problems: string[] = [];

  for (const chain of chains) {
    const provider = getProvider(chain);
    const wethAddr = WETH_ADDRESSES[chain];
    try {
      const code = await provider.getCode(dest);
      if (code !== "0x") {
        const delegated = code.toLowerCase().startsWith("0xef0100"); // EIP-7702 account, still key-controlled
        if (!delegated && !allowContract) {
          problems.push(`${chain}: destination is a smart contract here - skipped (re-run with --allow-contract only if that contract is your wallet)`);
          console.log(`== ${chain}: SKIPPED - destination has contract code on this chain`);
          continue;
        }
        console.log(`== ${chain}: note - destination is ${delegated ? "a delegated (EIP-7702) account" : "a contract you allowed"}`);
      }
    } catch (e) {
      problems.push(`${chain}: could not reach RPC (${(e as Error).message.slice(0, 80)})`);
      console.log(`== ${chain}: SKIPPED - RPC unreachable`);
      continue;
    }

    let chainReceive = 0n, chainFees = 0n;
    const lines: string[] = [];
    for (const w of wallets) {
      const tag = `W${String(w.index).padStart(2, "0")}`;
      try {
        const bal = await provider.getBalance(w.address);
        const weth: bigint = wethAddr ? await new ethers.Contract(wethAddr, WETH_ABI, provider).balanceOf(w.address) : 0n;
        if (bal === 0n && weth === 0n) continue;

        let unwrap: Quote | null = null;
        let wethUsable = weth;
        if (weth > 0n) {
          unwrap = await quote(chain, w.address, wethAddr, WETH_IFACE.encodeFunctionData("withdraw", [weth]), 0n);
          if (bal < unwrap.total) { wethUsable = 0n; unwrap = null; problems.push(`${chain} ${tag}: ${eth(weth)} WETH stuck - not enough ETH to pay the unwrap fee`); }
        }
        const send = await quote(chain, w.address, dest, "0x", 1n);
        const fees = (unwrap?.total ?? 0n) + send.total;
        const receive = bal + wethUsable - fees;

        if (receive < MIN_SWEEP) {
          lines.push(`  ${tag} balance ${eth(bal)}${weth ? ` + WETH ${eth(weth)}` : ""} -> skip (after ~${eth(fees)} fees only ${eth(receive > 0n ? receive : 0n)} left)`);
          continue;
        }
        chainReceive += receive; chainFees += fees;

        if (!execute) {
          lines.push(`  ${tag} balance ${eth(bal)}${wethUsable ? ` + WETH ${eth(wethUsable)} (unwrap first)` : ""} -> send ~${eth(receive)} ${usd(receive)}  (fee reserve ${eth(fees)})`);
          continue;
        }

        const signer = new ethers.Wallet(getPrivateKey(w), provider);
        if (unwrap && wethUsable > 0n) {
          const utx = await signer.sendTransaction({ to: wethAddr, data: WETH_IFACE.encodeFunctionData("withdraw", [wethUsable]), gasLimit: unwrap.gasLimit, ...unwrap.fee });
          record({ chain, from: w.address, kind: "unwrap", hash: utx.hash, amountWei: wethUsable.toString() });
          await withTimeout(utx.wait(), TX_TIMEOUT_MS, "unwrap");
          lines.push(`  ${tag} unwrapped ${eth(wethUsable)} WETH  ${utx.hash}`);
        }
        const fresh = await provider.getBalance(w.address);
        const q = await quote(chain, w.address, dest, "0x", 1n);
        const value = fresh - q.total;
        if (value < MIN_SWEEP) { lines.push(`  ${tag} skip after unwrap - only ${eth(value > 0n ? value : 0n)} left over fees`); continue; }
        const tx = await signer.sendTransaction({ to: dest, value, gasLimit: q.gasLimit, ...q.fee });
        record({ chain, from: w.address, to: dest, kind: "sweep", hash: tx.hash, valueWei: value.toString() });
        try {
          await withTimeout(tx.wait(), TX_TIMEOUT_MS, "send");
          lines.push(`  ${tag} SENT ${eth(value)} ETH ${usd(value)}  ${getChain(chain).explorerUrl}/tx/${tx.hash}`);
        } catch (e) {
          lines.push(`  ${tag} submitted ${eth(value)} ETH, confirmation pending: ${tx.hash}`);
          problems.push(`${chain} ${tag}: ${(e as Error).message}`);
        }
      } catch (e) {
        const msg = (e as Error).message.split("\n")[0].slice(0, 140);
        lines.push(`  ${tag} ERROR ${msg}`);
        problems.push(`${chain} ${tag}: ${msg}`);
      }
    }
    if (lines.length) {
      console.log(`== ${chain}: ${execute ? "moved" : "would receive"} ~${eth(chainReceive)} ETH ${usd(chainReceive)} (fees ~${eth(chainFees)})`);
      lines.forEach((l) => console.log(l));
    } else {
      console.log(`== ${chain}: nothing to move`);
    }
    grandReceive += chainReceive; grandFees += chainFees;
  }

  console.log(`\nTOTAL ${execute ? "moved" : "to receive"}: ~${eth(grandReceive)} ETH ${usd(grandReceive)} | fees reserved ~${eth(grandFees)} ETH ${usd(grandFees)}`);
  console.log("Funds arrive on the SAME chain they left from; your wallet app shows each chain separately. USDC is not moved.");
  if (problems.length) { console.log("\nIssues:"); problems.forEach((p) => console.log(`  - ${p}`)); }
  if (execute) console.log(`\nReceipts: ${RECEIPTS}`);
  return problems.length && execute ? 1 : 0;
}

process.exit(await main());
