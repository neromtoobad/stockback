import { NextResponse } from "next/server";
import { walletSnapshot } from "@/lib/rh/bridge";
import { liveRuns } from "@/lib/store";
import { fail } from "@/lib/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

let cache: { at: number; body: unknown } | null = null;

export async function GET() {
  try {
    if (cache && Date.now() - cache.at < 20_000) return NextResponse.json(cache.body);
    const runs = await liveRuns(50);
    const tickers = runs.flatMap((r) => r.fills.filter((f) => f.tx_hash).map((f) => f.ticker));
    const body = await walletSnapshot(tickers);
    cache = { at: Date.now(), body };
    return NextResponse.json(body);
  } catch (err) {
    return fail(err);
  }
}
