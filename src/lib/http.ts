import { NextResponse } from "next/server";
import { ServError } from "@/lib/serv";

export function fail(err: unknown, status = 500) {
  const message = err instanceof Error ? err.message : String(err);
  const code = err instanceof ServError ? 502 : status;
  console.error("[stockback]", message);
  return NextResponse.json({ error: message }, { status: code });
}
