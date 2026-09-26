import { NextResponse } from "next/server";
import type { Mapping, Plan, Receipt } from "@/lib/pipeline";
import type { ServTrace } from "@/lib/serv";
import { executePlan, isLive } from "@/lib/execute";
import { pocketId } from "@/lib/pocket";
import { fail } from "@/lib/http";

export const runtime = "nodejs";
export const maxDuration = 300;

export async function POST(req: Request) {
  try {
    const body = (await req.json()) as { receipt: Receipt; mapping: Mapping; plan: Plan; traces: ServTrace[]; passcode?: string };
    if (!body.plan?.buys || !body.receipt) return fail(new Error("Missing plan"), 400);
    const pocket = await pocketId();
    const run = await executePlan({
      pocket,
      receipt: body.receipt,
      mapping: body.mapping,
      plan: body.plan,
      traces: (body.traces ?? []).slice(0, 10),
      live: isLive(body.passcode),
    });
    return NextResponse.json({ run });
  } catch (err) {
    return fail(err);
  }
}
