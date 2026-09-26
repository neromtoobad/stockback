import { NextResponse } from "next/server";
import { quotesFor } from "@/lib/prices";

export const runtime = "nodejs";
export const revalidate = 60;

const TAPE = ["SPY", "QQQ", "AAPL", "NVDA", "AMZN", "COST", "NFLX", "META", "GOOGL", "MSFT", "TSLA", "LULU", "SHOP", "VTI"];

export async function GET() {
  try {
    const q = await quotesFor(TAPE);
    return NextResponse.json(TAPE.filter((s) => q[s]).map((s) => ({ symbol: s, price: q[s].mid, halted: q[s].halted })));
  } catch {
    return NextResponse.json([]);
  }
}
