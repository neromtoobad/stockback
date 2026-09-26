import { cookies } from "next/headers";
import { randomUUID } from "node:crypto";

// Anonymous "pocket": each browser gets its own ledger without sign-up.
export async function pocketId(): Promise<string> {
  const jar = await cookies();
  const existing = jar.get("sb_pocket")?.value;
  if (existing && /^[a-f0-9-]{36}$/.test(existing)) return existing;
  const id = randomUUID();
  jar.set("sb_pocket", id, { httpOnly: true, sameSite: "lax", maxAge: 60 * 60 * 24 * 365, path: "/" });
  return id;
}
