import { NextResponse } from "next/server";
import { runsFor, liveRuns, stats } from "@/lib/store";
import { quotesFor } from "@/lib/prices";
import { pocketId } from "@/lib/pocket";
import { fail } from "@/lib/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  try {
    const pocket = await pocketId();
    const [runs, live, totals] = await Promise.all([runsFor(pocket), liveRuns(), stats()]);
    const agg = new Map<string, { shares: number; cost: number; receipts: number }>();
    for (const r of runs) for (const f of r.fills) {
      if (f.error) continue;
      const a = agg.get(f.ticker) ?? { shares: 0, cost: 0, receipts: 0 };
      a.shares += f.shares;
      a.cost += f.usd;
      a.receipts += 1;
      agg.set(f.ticker, a);
    }
    const quotes = await quotesFor([...agg.keys()]).catch(() => ({}) as Record<string, { bid: number }>);
    const holdings = [...agg.entries()]
      .map(([ticker, a]) => {
        const price = (quotes as Record<string, { bid: number }>)[ticker]?.bid ?? 0;
        return { ticker, shares: a.shares, cost: a.cost, value: price ? a.shares * price : a.cost, receipts: a.receipts };
      })
      .sort((x, y) => y.value - x.value);
    const slim = (list: typeof runs) =>
      list.map((r) => ({ id: r.id, created_at: r.created_at, merchant: r.merchant, spend_usd: r.spend_usd, total_usd: r.total_usd, mode: r.mode, fills: r.fills, flagged: r.flagged }));
    return NextResponse.json({ holdings, runs: slim(runs), live: slim(live), stats: totals });
  } catch (err) {
    return fail(err);
  }
}
