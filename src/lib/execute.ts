import { randomUUID } from "node:crypto";
import type { Mapping, Plan, Receipt } from "@/lib/pipeline";
import type { ServTrace } from "@/lib/serv";
import { quotesFor } from "@/lib/prices";
import { token } from "@/lib/tokens";
import { saveRun, type Fill, type Run } from "@/lib/store";
import { onchainBuyAll, onchainQuote } from "@/lib/rh/bridge";

// Live buys spend the real agent wallet, so they need the owner's passcode and stay tiny.
const LIVE_PASSCODE = process.env.LIVE_PASSCODE ?? "";
const LIVE_MAX_USD = Number(process.env.LIVE_MAX_USD_PER_RECEIPT ?? "0.30");
// Below this a leg costs more in gas than it buys, so it stays simulated.
const LIVE_MIN_LEG_USD = 0.05;

export function isLive(passcode?: string) {
  return Boolean(LIVE_PASSCODE && passcode && passcode === LIVE_PASSCODE);
}

export async function executePlan(args: {
  pocket: string;
  receipt: Receipt;
  mapping: Mapping;
  plan: Plan;
  traces: ServTrace[];
  live: boolean;
}): Promise<Run> {
  const { plan, live } = args;
  const id = randomUUID();
  const buys = plan.buys.filter((b) => token(b.ticker) && b.usd > 0);
  const quotes = await quotesFor(buys.map((b) => b.ticker)).catch(() => ({}) as Awaited<ReturnType<typeof quotesFor>>);

  const baseFill = (b: (typeof buys)[number]): Fill => {
    const price = quotes[b.ticker]?.ask ?? 0;
    return { ticker: b.ticker, usd: b.usd, fee_usd: b.fee_usd, price, shares: price > 0 ? b.usd / price : 0, mode: "simulated" };
  };

  // Scale live spend down to the demo budget; the plan itself is untouched.
  const planned = buys.reduce((s, b) => s + b.usd, 0);
  const scale = live && planned > LIVE_MAX_USD ? LIVE_MAX_USD / planned : 1;
  const liveLegs = live ? buys.filter((b) => b.usd * scale >= LIVE_MIN_LEG_USD).map((b) => ({ ticker: b.ticker, usd: round4(b.usd * scale) })) : [];
  const liveResults = liveLegs.length ? await onchainBuyAll(liveLegs, id) : [];

  const fills: Fill[] = await Promise.all(
    buys.map(async (b) => {
      const base = baseFill(b);
      const lr = liveResults.find((r) => r.ticker === b.ticker);
      if (lr?.txHash) {
        const leg = liveLegs.find((l) => l.ticker === b.ticker)!;
        return { ...base, usd: leg.usd, mode: "live" as const, route: lr.route, tx_hash: lr.txHash, shares: lr.units ?? base.shares };
      }
      const oq = await onchainQuote(b.ticker, b.usd).catch(() => null);
      const why = lr?.error ? `live buy skipped: ${lr.error}` : live ? "below the live minimum, simulated" : "";
      return {
        ...base,
        shares: oq?.units ?? base.shares,
        route: oq ? `${oq.route} · quoted on-chain` : "Robinhood token price · no liquid pool yet",
        ...(why ? { error: undefined, route: `${oq ? oq.route : "Robinhood token price"} · ${why}` } : {}),
      };
    }),
  );

  const run: Run = {
    id,
    pocket: args.pocket,
    created_at: new Date().toISOString(),
    merchant: args.receipt.merchant,
    currency: args.receipt.currency,
    spend_usd: plan.spend_usd,
    total_usd: round4(fills.reduce((s, f) => s + f.usd + f.fee_usd, 0)),
    fee_usd: plan.fee_usd,
    mode: fills.some((f) => f.mode === "live") ? "live" : "simulated",
    fills,
    receipt: args.receipt,
    mapping: args.mapping,
    plan,
    traces: args.traces,
    flagged: args.receipt.unusual_text,
  };
  await saveRun(run);
  return run;
}

const round4 = (n: number) => Math.round(n * 10000) / 10000;
