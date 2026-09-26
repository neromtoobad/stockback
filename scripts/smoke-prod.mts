// End-to-end smoke test against a deployed Stockback: read → map → plan → execute (simulated).
const base = process.argv[2] ?? "https://web-production-53b74.up.railway.app";
const text = process.argv[3] ?? `CARD STATEMENT - SEPTEMBER
09/01 NETFLIX.COM          15.49
09/02 GOOGLE*YOUTUBEPREM   13.99
09/03 MICROSOFT*365 PERS    9.99
09/14 UBER *EATS           31.20
09/22 DRAFTKINGS            50.00
TOTAL                     120.67`;
let cookie = "";
async function post(path: string, body: unknown) {
  const t = Date.now();
  const res = await fetch(base + path, { method: "POST", headers: { "content-type": "application/json", cookie }, body: JSON.stringify(body) });
  const set = res.headers.get("set-cookie");
  if (set) cookie = set.split(";")[0];
  const json = await res.json();
  if (!res.ok) throw new Error(`${path} ${res.status} ${JSON.stringify(json)}`);
  console.log(path, res.status, `${Date.now() - t}ms`);
  return json;
}
const r = await post("/api/scan/read", { text });
const m = await post("/api/scan/map", { receipt: r.receipt });
const p = await post("/api/scan/plan", { receipt: r.receipt, mapping: m.mapping });
const e = await post("/api/scan/execute", { receipt: r.receipt, mapping: m.mapping, plan: p.plan, traces: [r.trace, m.trace, p.trace] });
console.log("lines:", p.plan.lines.map((l: { description: string; target: string | null; via: string }) => `${l.description} → ${l.target ?? "skip"} (${l.via})`).join(" | "));
console.log("fills:", e.run.fills.map((f: { ticker: string; usd: number; route: string }) => `${f.ticker} $${f.usd} ${f.route}`).join(" | "));
console.log("page:", `${base}/r/${e.run.id}`);
