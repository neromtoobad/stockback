/**
 * Read-only probe of Robinhood Chain stock-token liquidity for Stockback. Sends NOTHING.
 *   npx tsx scripts/probe-swap.ts            # default ticker set
 *   npx tsx scripts/probe-swap.ts NVDA,TSLA  # custom set
 *   npx tsx scripts/probe-swap.ts --all      # every registry token, quotes only (liquid list for the SERV mapping)
 *
 * For each ticker: best ETH-input route, quotes for $0.10 and $1.00, implied price vs Robinhood's API price,
 * an eth_simulateV1 of the exact swap calldata executeBuy would send, and gas for one swap in USD.
 * Also: USDG-input route (v3 vs v4) simulated with approvals, and an AgentKit wiring smoke test (read-only action).
 */
import { existsSync } from "node:fs";
import { formatUnits } from "viem";

if (existsSync(".env")) process.loadEnvFile(".env");

const TICKERS = (process.argv.slice(2).find((a) => !a.startsWith("--")) ??
  "NVDA,AAPL,TSLA,SPY,AMZN,KO,PEP,SBUX,MCD,WMT,NFLX,UBER,META,GOOGL,COST,NKE,DIS,MSFT,QQQ,HD,TGT,CMG,LULU,SPOT").split(",");

const pct = (x: number | null | undefined) => (x == null ? "   n/a" : `${x >= 0 ? "+" : ""}${x.toFixed(2)}%`.padStart(7));

async function scanAll(rh: typeof import("../src/lib/rh/swap")) {
  const all = await rh.getStockTokens();
  console.log(`Scanning all ${all.length} registry tokens (ETH input, $0.10 and $1.00, quotes only)...`);
  const res: { sym: string; name: string; route: string; dev: number | null; drift: number; liquid: boolean }[] = [];
  let i = 0;
  await Promise.all(Array.from({ length: 4 }, async () => {
    while (i < all.length) {
      const t = all[i++];
      try {
        const [a, b] = await Promise.all([
          rh.quoteBuy({ tokenAddress: t.address, usdAmount: 0.1 }, { inputAsset: "ETH", maxDeviationPct: 1000 }),
          rh.quoteBuy({ tokenAddress: t.address, usdAmount: 1 }, { inputAsset: "ETH", maxDeviationPct: 1000 }),
        ]);
        if (!a || !b) continue;
        const drift = (b.impliedPriceUsd / a.impliedPriceUsd - 1) * 100; // price impact going $0.10 -> $1.00
        const liquid = a.priceDeviationPct !== null && Math.abs(a.priceDeviationPct) <= 5 && drift <= 1;
        res.push({ sym: t.symbol, name: t.name, route: b.route, dev: a.priceDeviationPct, drift, liquid });
      } catch { /* skip */ }
    }
  }));
  res.sort((x, y) => x.sym.localeCompare(y.sym));
  for (const r of res) console.log(`${r.liquid ? "LIQUID" : "thin  "} ${r.sym.padEnd(6)} ${r.name.slice(0, 30).padEnd(31)} ${r.route.padEnd(46)} dev ${pct(r.dev)} impact$1 ${pct(r.drift)}`);
  const liquid = res.filter((r) => r.liquid);
  console.log(`\nRoutable: ${res.length}/${all.length}; liquid (|dev| <= 5%, $1 impact <= 1%): ${liquid.length}`);
  console.log(JSON.stringify(liquid.map((r) => r.sym)));
}

async function main() {
  const rh = await import("../src/lib/rh/swap");
  if (process.argv.includes("--all")) return scanAll(rh);
  const wallet = await rh.getWalletState();
  const ethUsd = await rh.getEthUsd();
  console.log(`Agent ${wallet.address}  ETH ${wallet.ethFormatted}  USDG ${wallet.usdgFormatted}  (ETH/USD on-chain ${ethUsd.toFixed(2)})`);
  const all = await rh.getStockTokens();
  console.log(`Robinhood registry: ${all.length} active stock tokens on chain 4663\n`);

  let gasSample: Awaited<ReturnType<typeof rh.estimateSwapGas>> | null = null;
  const liquid: string[] = [];
  const rows: string[] = [];
  for (const sym of TICKERS) {
    const t = all.find((a) => a.symbol === sym);
    if (!t) { rows.push(`${sym.padEnd(6)} not listed on Robinhood Chain`); continue; }
    try {
      const [q10, q100] = await Promise.all([
        rh.quoteBuy({ tokenAddress: t.address, usdAmount: 0.1 }, { inputAsset: "ETH", maxDeviationPct: 1000 }),
        rh.quoteBuy({ tokenAddress: t.address, usdAmount: 1 }, { inputAsset: "ETH", maxDeviationPct: 1000 }),
      ]);
      if (!q10 || !q100) { rows.push(`${sym.padEnd(6)} NO ROUTE`); continue; }
      const sim = await rh.simulateBuy(q10, { slippageBps: 100 });
      const gas = await rh.estimateSwapGas(q10).catch(() => null);
      if (gas && (!gasSample || gas.gas > gasSample.gas)) gasSample = gas;
      const ok = (q10.priceDeviationPct ?? 0) <= 5 && sim.ok;
      if (ok) liquid.push(sym);
      const simTxt = sim.ok ? `sim OK out=${sim.amountOut === q10.expectedOut ? "exact" : sim.amountOut}` : `SIM FAIL ${sim.error}`;
      rows.push(
        `${sym.padEnd(6)} ${ok ? "LIQUID " : "THIN   "} ${q10.route.padEnd(44)} ` +
        `$0.10→${Number(formatUnits(q10.expectedOut, 18)).toExponential(3)} (${q10.expectedOutShares.toFixed(6)} sh) dev ${pct(q10.priceDeviationPct)} | ` +
        `$1.00→${Number(formatUnits(q100.expectedOut, 18)).toExponential(3)} dev ${pct(q100.priceDeviationPct)} | ` +
        `implied $${q100.impliedPriceUsd.toFixed(2)} vs RH $${q100.referencePriceUsd?.toFixed(2) ?? "n/a"} | ` +
        `gas ${gas ? `${gas.gas} ≈ $${gas.costUsd.toFixed(5)}` : "n/a"} | ${simTxt}`,
      );
    } catch (e) {
      rows.push(`${sym.padEnd(6)} ERROR ${(e as Error).message.slice(0, 160)}`);
    }
  }
  console.log(rows.join("\n"));

  // USDG-input routes (if the wallet ever holds USDG): v3 single-hop vs v4, both simulated with approvals.
  console.log("\nUSDG-input routes ($0.50), simulated incl. approvals from a fresh wallet:");
  for (const sym of ["NVDA", "AAPL", "GOOGL", "TSLA"]) {
    const t = all.find((a) => a.symbol === sym);
    if (!t) continue;
    for (const protocol of ["v3", "v4"] as const) {
      const q = await rh.quoteBuy({ tokenAddress: t.address, usdAmount: 0.5 }, { inputAsset: "USDG", protocol, maxDeviationPct: 1000 });
      if (!q) { console.log(`  ${sym} ${protocol}: no pool`); continue; }
      const sim = await rh.simulateBuy(q, { slippageBps: 100 });
      console.log(`  ${sym} ${q.route.padEnd(32)} out ${formatUnits(q.expectedOut, 18)} dev ${pct(q.priceDeviationPct)} | ${sim.ok ? `sim OK (gas ${sim.gasUsed.join("/")}) out=${sim.amountOut === q.expectedOut ? "exact" : sim.amountOut}` : `SIM FAIL ${sim.error}`}`);
    }
  }

  if (gasSample) {
    const gp = Number(gasSample.gasPriceWei) / 1e9;
    console.log(`\nGas: one ETH→stock swap ≈ ${gasSample.gas} gas @ ${gp.toFixed(4)} gwei = ${formatUnits(gasSample.costWei, 18)} ETH ≈ $${gasSample.costUsd.toFixed(5)} (worst case in this run)`);
  }
  console.log(`Liquid (≤5% over RH price, simulation OK): ${liquid.join(", ") || "none"}`);

  // AgentKit wiring (read-only): builds the wallet provider + actions and runs stock_token_balance.
  if (process.env.AGENT_PRIVATE_KEY && !process.argv.includes("--no-agentkit")) {
    try {
      const ak = await import("../src/lib/rh/agentkit");
      const kit = await ak.getAgentKit();
      console.log(`\nAgentKit actions: ${kit.getActions().map((a) => a.name).join(", ")}`);
      console.log(`stock_token_balance(NVDA): ${await ak.runAgentAction("stock_token_balance", { symbol: "NVDA" })}`);
    } catch (e) {
      console.log(`AgentKit smoke test failed: ${(e as Error).message}`);
    }
  }
}

main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
