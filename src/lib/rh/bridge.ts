// Adapter between the app and the Robinhood Chain swap layer (swap.ts / agentkit.ts).
import type { Address } from "viem";
import { formatUnits } from "viem";
import {
  agentAddress,
  executeBasket,
  executeBuy,
  findStockToken,
  getStockBalance,
  getWalletState,
  quoteBuy,
  type BuyQuote,
} from "@/lib/rh/swap";

const SLIPPAGE_BPS = 150;

export async function onchainQuote(ticker: string, usd: number): Promise<{ route: string; units: number } | null> {
  const t = await findStockToken(ticker);
  if (!t) return null;
  const q = await quoteBuy({ tokenAddress: t.address, usdAmount: usd }, { inputAsset: "ETH" });
  return q ? { route: q.route, units: q.expectedOutShares } : null;
}

export type LiveLeg = { ticker: string; usd: number };
export type LiveResult = {
  ticker: string;
  txHash?: string;
  route: string;
  units?: number;
  error?: string;
};

// Buys every leg it can from the agent wallet: ETH-input Uniswap v3 legs go into one
// multicall basket transaction; anything else is sent on its own.
export async function onchainBuyAll(legs: LiveLeg[], key: string): Promise<LiveResult[]> {
  const quoted = await Promise.all(
    legs.map(async (leg) => {
      const t = await findStockToken(leg.ticker);
      const q = t ? await quoteBuy({ tokenAddress: t.address, usdAmount: leg.usd }, { inputAsset: "ETH" }).catch(() => null) : null;
      return { leg, q };
    }),
  );

  const results: LiveResult[] = [];
  for (const { leg, q } of quoted) {
    if (!q) results.push({ ticker: leg.ticker, route: "no liquid on-chain pool right now", error: "no route" });
  }
  const ok = quoted.filter((x): x is { leg: LiveLeg; q: BuyQuote } => Boolean(x.q));
  const basket = ok.filter((x) => x.q.inputAsset === "ETH" && x.q.exec.kind === "v3");
  const single = ok.filter((x) => !basket.includes(x));

  if (basket.length > 1) {
    try {
      const r = await executeBasket({ quotes: basket.map((x) => x.q), slippageBps: SLIPPAGE_BPS, idempotencyKey: `${key}:basket` });
      for (const x of basket) {
        const leg = r.legs.find((l) => l.symbol === x.q.symbol);
        results.push({
          ticker: x.leg.ticker,
          txHash: r.txHash,
          route: `${x.q.route} · basket tx`,
          units: leg?.amountOut !== undefined ? toShares(leg.amountOut, x.q) : x.q.expectedOutShares,
        });
      }
    } catch (err) {
      for (const x of basket) results.push({ ticker: x.leg.ticker, route: x.q.route, error: msg(err) });
    }
  } else {
    single.push(...basket);
  }

  for (const x of single) {
    try {
      const r = await executeBuy({ quote: x.q, slippageBps: SLIPPAGE_BPS, idempotencyKey: `${key}:${x.q.symbol}` });
      results.push({ ticker: x.leg.ticker, txHash: r.txHash, route: x.q.route, units: r.amountOut !== undefined ? toShares(r.amountOut, x.q) : x.q.expectedOutShares });
    } catch (err) {
      results.push({ ticker: x.leg.ticker, route: x.q.route, error: msg(err) });
    }
  }
  return results;
}

function toShares(raw: bigint, q: BuyQuote) {
  const tokens = Number(formatUnits(raw, 18));
  const expectedTokens = Number(formatUnits(q.expectedOut, 18));
  const mult = expectedTokens > 0 ? q.expectedOutShares / expectedTokens : 1;
  return tokens * mult;
}

const msg = (err: unknown) => (err instanceof Error ? err.message : String(err)).slice(0, 200);

export async function walletSnapshot(tickers: string[] = []): Promise<{
  address: string;
  eth: number;
  usdg: number;
  usd: number;
  holdings: { ticker: string; units: number; usd: number | null }[];
}> {
  const address = agentAddress();
  const [w, balances] = await Promise.all([
    getWalletState(address),
    Promise.all(
      [...new Set(tickers)].map(async (t) => {
        const tok = await findStockToken(t);
        if (!tok) return null;
        const b = await getStockBalance(tok.address as Address, address).catch(() => null);
        return b && b.raw > 0n ? { ticker: t, units: b.shares, usd: b.valueUsd } : null;
      }),
    ),
  ]);
  return {
    address,
    eth: Number(w.ethFormatted),
    usdg: Number(w.usdgFormatted),
    usd: w.totalUsd,
    holdings: balances.filter((b): b is { ticker: string; units: number; usd: number | null } => Boolean(b)),
  };
}
