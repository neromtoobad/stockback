import { readFileSync } from "node:fs";
for (const line of readFileSync(".env", "utf8").split("\n")) { const m = line.match(/^([A-Z_]+)=(.*)$/); if (m) process.env[m[1]] = m[2]; }
const { readReceipt, mapReceipt, planStockback, DEFAULT_RULES } = await import("../src/lib/pipeline");

const text = process.argv[2] ?? `COSTCO WHOLESALE #1024 Burbank CA
KS WATER 40PK      4.99
COCA-COLA 35PK    17.99
AIRPODS PRO 2    189.99
CELSIUS 15CT      24.99
TIDE PODS 81      21.99
BANANAS            1.99
KIRKLAND WINE     7.99
SUBTOTAL         269.93
TAX               24.02
TOTAL            293.95
VISA ****4417`;

const t0 = Date.now();
const r = await readReceipt({ text });
console.log("READ", r.trace.latencyMs, "ms", JSON.stringify(r.data));
const m = await mapReceipt(r.data);
console.log("MAP", m.trace.latencyMs, "ms", JSON.stringify(m.data, null, 1));
const p = await planStockback(r.data, m.data, DEFAULT_RULES);
console.log("POLICY", p.trace.latencyMs, "ms");
console.log(JSON.stringify(p.plan, null, 1));
console.log("TOTAL", Date.now() - t0, "ms", [r.trace, m.trace, p.trace].map(t => `${t.step}:${t.promptTokens}/${t.completionTokens}`).join(" "));
