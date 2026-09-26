import { NextResponse } from "next/server";
import { mapReceipt, type Receipt } from "@/lib/pipeline";
import { fail } from "@/lib/http";

export const runtime = "nodejs";
export const maxDuration = 120;

export async function POST(req: Request) {
  try {
    const { receipt } = (await req.json()) as { receipt: Receipt };
    if (!receipt?.items) return fail(new Error("Missing receipt"), 400);
    const { data, trace } = await mapReceipt(receipt);
    return NextResponse.json({ mapping: data, trace });
  } catch (err) {
    return fail(err);
  }
}
