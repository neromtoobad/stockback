import { NextResponse } from "next/server";
import { saveRun, type Run } from "@/lib/store";
import { isLive } from "@/lib/execute";
import { fail } from "@/lib/http";

export const runtime = "nodejs";

// Owner-only: copy runs recorded elsewhere (e.g. a local live buy) into this database.
export async function POST(req: Request) {
  try {
    const { passcode, runs } = (await req.json()) as { passcode?: string; runs?: Run[] };
    if (!isLive(passcode)) return fail(new Error("Forbidden"), 403);
    if (!Array.isArray(runs) || runs.length > 50) return fail(new Error("Send 1-50 runs"), 400);
    for (const r of runs) {
      if (!r?.id || !r.fills || !r.plan) return fail(new Error("Malformed run"), 400);
      await saveRun(r);
    }
    return NextResponse.json({ imported: runs.length });
  } catch (err) {
    return fail(err);
  }
}
