// Per-pocket agent wallets on Robinhood Chain.
//
// Each browser "pocket" can create its own agent wallet. The private key is generated here,
// encrypted with AES-256-GCM under WALLET_ENC_KEY and stored in Postgres; the agent signs
// that pocket's stock-back buys and withdrawals with it through Coinbase AgentKit.
// This is custodial by design for the demo (small amounts, clearly labelled). Production
// would move keys to Coinbase CDP server wallets or a smart account with spending limits.
import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { encodeFunctionData, erc20Abi, formatUnits, getAddress, isAddress, type Address, type Hex } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { getWalletRow, insertWalletRow, runsFor } from "@/lib/store";
import { findStockToken, getEthUsd, getStockBalance, getWalletState, rhPublicClient, RH_EXPLORER } from "@/lib/rh/swap";
import { token } from "@/lib/tokens";

function encKey(): Buffer {
  const b64 = process.env.WALLET_ENC_KEY;
  if (!b64) throw new Error("WALLET_ENC_KEY is not set");
  const key = Buffer.from(b64, "base64");
  if (key.length !== 32) throw new Error("WALLET_ENC_KEY must be 32 bytes, base64");
  return key;
}
function encrypt(plain: string): string {
  const iv = randomBytes(12), c = createCipheriv("aes-256-gcm", encKey(), iv);
  const body = Buffer.concat([c.update(plain, "utf8"), c.final()]);
  return ["v1", iv.toString("base64"), c.getAuthTag().toString("base64"), body.toString("base64")].join(".");
}
function decrypt(box: string): string {
  const [v, iv, tag, body] = box.split(".");
  if (v !== "v1") throw new Error("unknown key format");
  const d = createDecipheriv("aes-256-gcm", encKey(), Buffer.from(iv, "base64"));
  d.setAuthTag(Buffer.from(tag, "base64"));
  return Buffer.concat([d.update(Buffer.from(body, "base64")), d.final()]).toString("utf8");
}

export async function getPocketWallet(pocket: string) {
  const row = await getWalletRow(pocket);
  return row ? { address: getAddress(row.address) as Address, created_at: row.created_at } : null;
}

export async function createPocketWallet(pocket: string) {
  const existing = await getWalletRow(pocket);
  if (existing) return { address: getAddress(existing.address) as Address };
  const pk = generatePrivateKey();
  const address = privateKeyToAccount(pk).address;
  const row = await insertWalletRow({ pocket, address, enc_key: encrypt(pk), created_at: new Date().toISOString() });
  return { address: getAddress(row.address) as Address };
}

/** AgentKit wallet provider for this pocket (server-only). */
export async function pocketSigner(pocket: string) {
  const row = await getWalletRow(pocket);
  if (!row) return null;
  const { walletProviderFor } = await import("@/lib/rh/agentkit");
  return walletProviderFor(decrypt(row.enc_key));
}

/** Tickers this pocket has bought live, so we only read balances that can be non-zero. */
async function ownedTickers(pocket: string) {
  const runs = await runsFor(pocket, 200);
  return [...new Set(runs.flatMap((r) => r.fills.filter((f) => f.tx_hash).map((f) => f.ticker)))];
}

export async function pocketWalletState(pocket: string) {
  const w = await getPocketWallet(pocket);
  if (!w) return null;
  const [state, tickers] = await Promise.all([getWalletState(w.address), ownedTickers(pocket)]);
  const holdings = (
    await Promise.all(
      tickers.map(async (t) => {
        const tok = await findStockToken(t);
        if (!tok) return null;
        const b = await getStockBalance(tok.address, w.address).catch(() => null);
        return b && b.raw > 0n ? { ticker: t, units: b.shares, usd: b.valueUsd } : null;
      }),
    )
  ).filter((h): h is { ticker: string; units: number; usd: number | null } => Boolean(h));
  const eth = Number(state.ethFormatted);
  return {
    address: w.address,
    eth,
    ethUsd: eth * state.ethUsd,
    holdings,
    holdingsUsd: holdings.reduce((s, h) => s + (h.usd ?? 0), 0),
    explorer: `${RH_EXPLORER}/address/${w.address}`,
  };
}

/** USD this pocket can spend on buys right now, after keeping a gas reserve for the buy and a withdrawal. */
export async function spendableUsd(address: Address) {
  const [bal, ethUsd] = await Promise.all([rhPublicClient().getBalance({ address }), getEthUsd()]);
  const usd = Number(formatUnits(bal, 18)) * ethUsd;
  return Math.max(0, usd - 0.12);
}

const locks = new Set<string>();

/** Sends every stock token this pocket holds, then the remaining ETH (minus gas), to `to`. */
export async function withdrawAll(pocket: string, to: string) {
  if (!isAddress(to)) throw new Error("That isn't a valid address");
  const dest = getAddress(to);
  if (locks.has(pocket)) throw new Error("A withdrawal is already running");
  locks.add(pocket);
  try {
    const signer = await pocketSigner(pocket);
    if (!signer) throw new Error("No agent wallet for this pocket");
    const from = getAddress(signer.getAddress()) as Address;
    if (from === dest) throw new Error("That's the agent wallet itself");
    const client = rhPublicClient();
    const sent: { what: string; hash: Hex; url: string }[] = [];
    for (const t of await ownedTickers(pocket)) {
      const tok = await findStockToken(t);
      if (!tok) continue;
      const raw = await client.readContract({ address: tok.address, abi: erc20Abi, functionName: "balanceOf", args: [from] });
      if (raw === 0n) continue;
      const data = encodeFunctionData({ abi: erc20Abi, functionName: "transfer", args: [dest, raw] });
      const hash = (await signer.sendTransaction({ to: tok.address, data })) as Hex;
      await signer.waitForTransactionReceipt(hash);
      sent.push({ what: `${t} (${token(t)?.name ?? t})`, hash, url: `${RH_EXPLORER}/tx/${hash}` });
    }
    // then the ETH, leaving enough for this transfer's worst-case fee (gas limit and max fee both get padded)
    const bal = await client.getBalance({ address: from });
    const gasPrice = bal > 0n ? await client.getGasPrice() : 0n;
    const gas = bal > 0n ? await client.estimateGas({ account: from, to: dest, value: 0n }).catch(() => 400_000n) : 0n;
    const fee = gas * gasPrice * 4n;
    if (bal > 0n && bal > fee * 2n) {
      const hash = (await signer.sendTransaction({ to: dest, value: bal - fee })) as Hex;
      await signer.waitForTransactionReceipt(hash);
      sent.push({ what: `${formatUnits(bal - fee, 18).slice(0, 10)} ETH`, hash, url: `${RH_EXPLORER}/tx/${hash}` });
    }
    return { to: dest, sent };
  } finally {
    locks.delete(pocket);
  }
}
