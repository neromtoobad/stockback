import { NextResponse } from "next/server";
import { pocketId } from "@/lib/pocket";
import { createPocketWallet, pocketWalletState, spendableUsd } from "@/lib/wallets";
import { fail } from "@/lib/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

async function view(pocket: string) {
  const state = await pocketWalletState(pocket);
  if (!state) return { wallet: null };
  const spendable = await spendableUsd(state.address).catch(() => 0);
  return { wallet: { ...state, spendable, live: spendable >= 0.1 } };
}

export async function GET() {
  try {
    return NextResponse.json(await view(await pocketId()));
  } catch (err) {
    return fail(err);
  }
}

// Creates this pocket's agent wallet (idempotent).
export async function POST() {
  try {
    const pocket = await pocketId();
    await createPocketWallet(pocket);
    return NextResponse.json(await view(pocket));
  } catch (err) {
    return fail(err);
  }
}
