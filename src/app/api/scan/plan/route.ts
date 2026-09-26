import { NextResponse } from "next/server";
import { planStockback, DEFAULT_RULES, type Mapping, type Receipt } from "@/lib/pipeline";
import { fail } from "@/lib/http";

export const runtime = "nodejs";
export const maxDuration = 120;

export async function POST(req: Request) {
  try {
    const { receipt, mapping, rules } = (await req.json()) as { receipt: Receipt; mapping: Mapping; rules?: string };
    if (!receipt?.items || !mapping?.items) return fail(new Error("Missing receipt or mapping"), 400);
    const { plan, trace } = await planStockback(receipt, mapping, rules?.trim() || DEFAULT_RULES);
    return NextResponse.json({ plan, trace });
  } catch (err) {
    return fail(err);
  }
}
