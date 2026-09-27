import { NextResponse } from "next/server";
import { pocketId } from "@/lib/pocket";
import { withdrawAll } from "@/lib/wallets";
import { fail } from "@/lib/http";

export const runtime = "nodejs";
export const maxDuration = 300;

export async function POST(req: Request) {
  try {
    const { to } = (await req.json()) as { to?: string };
    if (!to) return fail(new Error("Enter an address to withdraw to"), 400);
    return NextResponse.json(await withdrawAll(await pocketId(), to));
  } catch (err) {
    return fail(err, 400);
  }
}
