"use client";

import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";
import { SAMPLES, type Sample } from "@/lib/samples";
import { sampleToJpeg, fileToJpeg } from "@/components/receipt-image";
import type { Mapping, Plan, Receipt } from "@/lib/pipeline";
import type { ServTrace } from "@/lib/serv";
import type { Run, Fill } from "@/lib/store";
import TOKENS from "@/data/rh-tokens.json";

const DEFAULT_RULES = `Give me 2% back in stock on every receipt.
Skip alcohol, tobacco and gambling purchases.
Don't buy oil or weapons companies.
If the company isn't available, put it in VTI.
Never more than $1 per receipt.`;

const tokenInfo = new Map((TOKENS as { symbol: string; name: string; address: string }[]).map((t) => [t.symbol, t]));
const EXPLORER = "https://robinhoodchain.blockscout.com";
const AGENT_ADDRESS = process.env.NEXT_PUBLIC_AGENT_ADDRESS ?? "";

type Phase = "idle" | "read" | "map" | "plan" | "buy" | "done" | "error";
const STEPS: { key: Exclude<Phase, "idle" | "done" | "error">; title: string; serv: string }[] = [
  { key: "read", title: "Read the receipt", serv: "vision · JSON schema · prompt guard" },
  { key: "map", title: "Trace who profits", serv: "178-ticker enum · shadow agent" },
  { key: "plan", title: "Apply your rules", serv: "Multipath · math in code" },
  { key: "buy", title: "Buy the stock", serv: "AgentKit wallet · Robinhood Chain" },
];

type PocketData = {
  holdings: { ticker: string; shares: number; cost: number; value: number; receipts: number }[];
  runs: SlimRun[];
  live: SlimRun[];
  stats: { receipts: number; live: number; usd: number };
};
type SlimRun = Pick<Run, "id" | "created_at" | "merchant" | "spend_usd" | "total_usd" | "mode" | "fills" | "flagged">;
type Wallet = { address: string; eth: number; usdg: number; usd: number; holdings: { ticker: string; units: number; usd: number | null }[] };

async function post<T>(url: string, body: unknown): Promise<T> {
  const res = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error((json as { error?: string }).error ?? `HTTP ${res.status}`);
  return json as T;
}

export const usd = (n: number, dp = 2) =>
  n < 0.01 && n > 0 ? `$${n.toFixed(4)}` : `$${n.toLocaleString("en-US", { minimumFractionDigits: dp, maximumFractionDigits: dp })}`;

/* ============================== App ============================== */

export default function App() {
  const [phase, setPhase] = useState<Phase>("idle");
  const [error, setError] = useState<string | null>(null);
  const [preview, setPreview] = useState<string | null>(null);
  const [receipt, setReceipt] = useState<Receipt | null>(null);
  const [mapping, setMapping] = useState<Mapping | null>(null);
  const [plan, setPlan] = useState<Plan | null>(null);
  const [run, setRun] = useState<Run | null>(null);
  const [traces, setTraces] = useState<ServTrace[]>([]);
  const [rules, setRules] = useState(DEFAULT_RULES);
  const [panel, setPanel] = useState<"none" | "paste" | "rules">("none");
  const [pasted, setPasted] = useState("");
  const [pocket, setPocket] = useState<PocketData | null>(null);
  const [passcode, setPasscode] = useState("");
  const [elapsed, setElapsed] = useState(0);
  const [activeSample, setActiveSample] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const runRef = useRef<HTMLDivElement>(null);
  const started = useRef(0);

  const busy = phase !== "idle" && phase !== "done" && phase !== "error";

  const loadPocket = useCallback(async () => {
    try {
      const res = await fetch("/api/pocket", { cache: "no-store" });
      if (res.ok) setPocket(await res.json());
    } catch {}
  }, []);

  useEffect(() => {
    loadPocket();
    try {
      const url = new URL(window.location.href);
      const live = url.searchParams.get("live");
      if (live) {
        localStorage.setItem("sb_live", live);
        url.searchParams.delete("live");
        window.history.replaceState(null, "", url.toString());
      }
      setPasscode(localStorage.getItem("sb_live") ?? "");
      const saved = localStorage.getItem("sb_rules");
      if (saved) setRules(saved);
    } catch {}
  }, [loadPocket]);

  useEffect(() => {
    if (!busy) return;
    const t = setInterval(() => setElapsed(Date.now() - started.current), 250);
    return () => clearInterval(t);
  }, [busy]);

  async function start(input: { image?: string; text?: string }, previewUrl: string | null) {
    setError(null);
    setReceipt(null);
    setMapping(null);
    setPlan(null);
    setRun(null);
    setTraces([]);
    setPreview(previewUrl);
    started.current = Date.now();
    setElapsed(0);
    try {
      localStorage.setItem("sb_rules", rules);
    } catch {}
    setTimeout(() => runRef.current?.scrollIntoView({ behavior: "smooth", block: "start" }), 60);

    const tr: ServTrace[] = [];
    try {
      setPhase("read");
      const r = await post<{ receipt: Receipt; trace: ServTrace }>("/api/scan/read", input);
      tr.push(r.trace);
      setTraces([...tr]);
      setReceipt(r.receipt);
      if (!r.receipt.is_receipt) throw new Error("That doesn't look like a receipt. Try a clearer photo or one of the samples.");

      setPhase("map");
      const m = await post<{ mapping: Mapping; trace: ServTrace }>("/api/scan/map", { receipt: r.receipt });
      tr.push(m.trace);
      setTraces([...tr]);
      setMapping(m.mapping);

      setPhase("plan");
      const p = await post<{ plan: Plan; trace: ServTrace }>("/api/scan/plan", { receipt: r.receipt, mapping: m.mapping, rules });
      tr.push(p.trace);
      setTraces([...tr]);
      setPlan(p.plan);

      setPhase("buy");
      const e = await post<{ run: Run }>("/api/scan/execute", {
        receipt: r.receipt,
        mapping: m.mapping,
        plan: p.plan,
        traces: tr,
        passcode: passcode || undefined,
      });
      setRun(e.run);
      setPhase("done");
      loadPocket();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setPhase("error");
    }
  }

  async function runSample(s: Sample) {
    if (busy) return;
    setActiveSample(s.id);
    const jpeg = await sampleToJpeg(s.lines);
    start({ image: jpeg }, jpeg);
  }

  async function onFile(f: File | undefined) {
    if (!f || busy) return;
    setActiveSample(null);
    try {
      const jpeg = await fileToJpeg(f);
      start({ image: jpeg }, jpeg);
    } catch {
      setError("Couldn't read that image. Try a JPG or PNG.");
      setPhase("error");
    }
  }

  const ruleSummary = summarizeRules(rules);

  return (
    <Frame>
      <div className="grid gap-6 p-4 sm:p-7 lg:grid-cols-[1.4fr_1fr] lg:gap-8">
        {/* ---------- left column ---------- */}
        <div className="min-w-0 space-y-6">
          <Intro className="lg:hidden" />

          {/* Scanner card */}
          <section className="glass rounded-[22px] p-5 sm:p-6">
            <div className="flex items-start justify-between">
              <p className="text-xs text-muted">New receipt</p>
              {passcode ? (
                <button
                  className="rounded-full bg-mint/20 px-2.5 py-1 font-mono text-[10px] font-semibold text-gain"
                  title="Owner mode: buys go to the real agent wallet (tiny amounts). Click to switch to simulated."
                  onClick={() => {
                    localStorage.removeItem("sb_live");
                    setPasscode("");
                  }}
                >
                  ● LIVE MODE
                </button>
              ) : null}
            </div>
            <div className="mt-2 grid gap-5 sm:grid-cols-[minmax(0,1fr)_minmax(0,1.9fr)] sm:items-center">
              <div>
                <h2 className="text-[34px] leading-[1.02] font-extrabold tracking-tight">
                  Scan a<br className="hidden sm:block" /> receipt
                </h2>
                <p className="mt-2 text-sm text-muted">Paper receipts, order emails, card statements. Any currency.</p>
              </div>
              <div className="grid grid-cols-3 gap-3">
                <Tile onClick={() => fileRef.current?.click()} disabled={busy} highlight>
                  <span className="text-[11px] leading-tight text-muted">Photo or file</span>
                  <CameraIcon />
                  <span className="text-sm font-bold">Scan</span>
                </Tile>
                <Tile onClick={() => setPanel(panel === "paste" ? "none" : "paste")} disabled={busy} active={panel === "paste"}>
                  <span className="text-[11px] leading-tight text-muted">Order email or statement</span>
                  <PasteIcon />
                  <span className="text-sm font-bold">Paste text</span>
                </Tile>
                <Tile onClick={() => setPanel(panel === "rules" ? "none" : "rules")} active={panel === "rules"}>
                  <span className="text-[11px] leading-tight text-muted">Your rules</span>
                  <span className="text-2xl font-extrabold text-gain">{ruleSummary.rate}</span>
                  <span className="w-full truncate text-[11px] font-semibold">{ruleSummary.rest}</span>
                </Tile>
              </div>
            </div>
            <input ref={fileRef} type="file" accept="image/*" capture="environment" className="hidden" onChange={(e) => onFile(e.target.files?.[0])} />

            {panel === "paste" && (
              <div className="rise mt-5">
                <textarea
                  value={pasted}
                  onChange={(e) => setPasted(e.target.value)}
                  rows={6}
                  placeholder="Paste an order email, receipt or card statement…"
                  className="tile w-full rounded-2xl p-3 font-mono text-sm outline-none focus:ring-2 focus:ring-accent/40"
                />
                <button
                  disabled={busy || !pasted.trim()}
                  onClick={() => {
                    setActiveSample(null);
                    start({ text: pasted }, null);
                  }}
                  className="mt-3 w-full rounded-2xl bg-ink px-4 py-3 font-bold text-white disabled:opacity-40"
                >
                  Get my stock-back
                </button>
              </div>
            )}
            {panel === "rules" && (
              <div className="rise mt-5">
                <textarea
                  value={rules}
                  onChange={(e) => setRules(e.target.value)}
                  rows={6}
                  className="tile w-full rounded-2xl p-3 text-sm outline-none focus:ring-2 focus:ring-accent/40"
                />
                <p className="mt-2 text-xs text-muted">
                  Plain English. SERV reads it like a policy (rate, cap, exclusions, fallback fund). The arithmetic is plain code, never the model.
                </p>
              </div>
            )}

            {/* samples strip on small screens */}
            <div className="mt-5 lg:hidden">
              <p className="mb-2 text-xs text-muted">Or try a sample</p>
              <div className="-mx-1 flex snap-x gap-3 overflow-x-auto px-1 pb-1">
                {SAMPLES.map((s) => (
                  <button
                    key={s.id}
                    disabled={busy}
                    onClick={() => runSample(s)}
                    className="violet w-40 shrink-0 snap-start rounded-2xl p-3 text-left text-white disabled:opacity-60"
                  >
                    <div className="text-base leading-tight font-bold">{s.title}</div>
                    <div className="mt-0.5 text-[11px] text-white/70">{s.tag}</div>
                    <div className="mt-3 inline-flex rounded-md bg-mint px-1.5 py-0.5 text-[11px] font-bold text-ink">Scan →</div>
                  </button>
                ))}
              </div>
            </div>
          </section>

          {/* Run */}
          <div ref={runRef} className="scroll-mt-4" />
          {phase !== "idle" && (
            <RunPanel
              phase={phase}
              preview={preview}
              pasted={pasted}
              elapsed={elapsed}
              busy={busy}
              receipt={receipt}
              mapping={mapping}
              plan={plan}
              run={run}
              traces={traces}
              error={error}
            />
          )}

          <PocketCard pocket={pocket} ruleSummary={ruleSummary} />
          <div className="grid gap-6 xl:grid-cols-2">
            <WalletCard pocket={pocket} />
            <MoneyCard />
          </div>
        </div>

        {/* ---------- right column ---------- */}
        <div className="min-w-0 space-y-6">
          <Intro className="hidden lg:block" />
          <div className="hidden space-y-3 lg:block">
            {SAMPLES.map((s, i) => (
              <SampleCard key={s.id} s={s} defaultOpen={i === 0} busy={busy} active={activeSample === s.id && busy} onRun={() => runSample(s)} />
            ))}
          </div>
        </div>
      </div>
      <HowItWorks />
    </Frame>
  );
}

function summarizeRules(rules: string) {
  const rate = rules.match(/(\d+(?:\.\d+)?)\s*%/)?.[1];
  const fb = rules.match(/\b(VTI|SPY|QQQ|SCHD|SGOV|GLD)\b/)?.[1];
  const cap = rules.match(/\$\s?(\d+(?:\.\d+)?)/)?.[1];
  return { rate: rate ? `${rate}%` : "1%", rest: [fb && `→ ${fb}`, cap && `cap $${cap}`].filter(Boolean).join(" · ") || "plain English" };
}

/* ============================== frame ============================== */

export function Frame({ children }: { children: React.ReactNode }) {
  return (
    <div className="sm:px-6 sm:py-8">
      <div className="app-frame mx-auto max-w-[1320px] overflow-hidden shadow-[0_40px_80px_-30px_rgba(40,36,120,0.55)] sm:rounded-[32px]">
        <TopBar />
        {children}
        <Footer />
      </div>
    </div>
  );
}

function TopBar() {
  const [tape, setTape] = useState<{ symbol: string; price: number }[]>([]);
  useEffect(() => {
    fetch("/api/tape")
      .then((r) => (r.ok ? r.json() : []))
      .then(setTape)
      .catch(() => {});
  }, []);
  const items = tape.length ? [...tape, ...tape] : [];
  return (
    <header className="flex items-center gap-4 bg-ink px-4 py-4 text-white sm:px-7 sm:py-5">
      <Link href="/" className="flex shrink-0 items-center gap-2.5">
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img src="/icon.svg" alt="" className="h-9 w-9" />
        <span className="text-xl font-extrabold tracking-tight">stockback</span>
      </Link>
      <div className="relative mx-2 hidden min-w-0 flex-1 overflow-hidden [mask-image:linear-gradient(90deg,transparent,#000_8%,#000_92%,transparent)] md:block">
        <div className="marquee flex w-max gap-8 text-[13px] whitespace-nowrap">
          {items.map((t, i) => (
            <span key={i} className="flex items-center gap-2">
              <b className="font-bold">{t.symbol}</b>
              <span className="text-white/70">{t.price.toFixed(2)}</span>
              <span className="text-[8px] text-mint">●</span>
              <span className="text-white/25">|</span>
            </span>
          ))}
        </div>
      </div>
      <nav className="ml-auto flex shrink-0 items-center gap-2 text-sm sm:gap-4">
        <Link href="/#pocket" className="hidden text-white/80 hover:text-white sm:inline">
          Pocket
        </Link>
        <Link href="/#how" className="hidden text-white/80 hover:text-white sm:inline">
          How it works
        </Link>
        <a
          href={`${EXPLORER}/address/${AGENT_ADDRESS}`}
          target="_blank"
          rel="noreferrer"
          className="flex items-center gap-2 rounded-full bg-white/10 py-1 pr-3 pl-1 hover:bg-white/15"
        >
          <span className="flex h-7 w-7 items-center justify-center rounded-full bg-mint font-mono text-[10px] font-bold text-ink">AK</span>
          <span className="font-mono text-xs">{AGENT_ADDRESS ? `${AGENT_ADDRESS.slice(0, 6)}…${AGENT_ADDRESS.slice(-4)}` : "agent"}</span>
        </a>
      </nav>
    </header>
  );
}

function Intro({ className = "" }: { className?: string }) {
  return (
    <div className={className}>
      <h1 className="text-[34px] leading-[1.05] font-extrabold tracking-tight sm:text-[40px]">
        Every receipt buys you
        <br /> a piece of the company.
      </h1>
      <p className="mt-3 max-w-md text-[15px] leading-relaxed text-muted">
        SERV Reasoning works out who actually profits from each thing you bought, applies <em>your</em> rules, and an agent wallet buys
        a sliver of those companies as stock tokens on Robinhood Chain.
      </p>
    </div>
  );
}

/* ============================== right column ============================== */

function SampleCard({ s, defaultOpen, busy, active, onRun }: { s: Sample; defaultOpen: boolean; busy: boolean; active: boolean; onRun: () => void }) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <div className="violet relative overflow-hidden rounded-[20px] px-5 py-4 text-white">
      <Wave className="pointer-events-none absolute inset-x-0 bottom-0 h-20 w-full opacity-40" seed={s.id} />
      <div className="relative flex items-start justify-between gap-3">
        <div className="min-w-0">
          <h3 className="text-[20px] leading-tight font-bold">{s.title}</h3>
          <p className="text-[13px] text-white/70">{s.blurb}</p>
        </div>
        <button onClick={() => setOpen((v) => !v)} className="mt-1 shrink-0 font-mono text-[11px] text-white/70 hover:text-white">
          {open ? "less ▲" : "more ▼"}
        </button>
      </div>
      <div className="relative mt-3 flex items-center gap-3">
        <span className="rounded-md bg-mint px-2.5 py-1 text-base font-extrabold text-ink">{s.tag}</span>
        <button
          onClick={onRun}
          disabled={busy}
          aria-label={`Scan the ${s.title} sample`}
          className="ml-auto flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-white text-accent shadow-lg transition hover:scale-105 disabled:opacity-60"
        >
          {active ? <Spinner /> : <ArrowIcon />}
        </button>
      </div>
      {open && (
        <ul className="rise relative mt-4 grid grid-cols-2 gap-x-4 gap-y-2.5">
          {s.facts.map((f) => (
            <li key={f} className="flex items-start gap-2 text-[13px] leading-snug">
              <span className="mt-1 h-2.5 w-2.5 shrink-0 rounded-full bg-mint ring-2 ring-white/40" />
              {f}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function WalletCard({ pocket }: { pocket: PocketData | null }) {
  const [wallet, setWallet] = useState<Wallet | null>(null);
  useEffect(() => {
    fetch("/api/wallet", { cache: "no-store" })
      .then((r) => (r.ok ? r.json() : null))
      .then(setWallet)
      .catch(() => {});
  }, [pocket?.stats.live]);
  const address = wallet?.address || AGENT_ADDRESS;
  const fills = (pocket?.live ?? []).flatMap((r) => r.fills.filter((f) => f.tx_hash).map((f) => ({ ...f, merchant: r.merchant })));
  return (
    <section id="wallet" className="scroll-mt-6 rounded-[20px] bg-ink p-5 text-white">
      <div className="flex items-start justify-between gap-3">
        <div>
          <p className="text-[11px] text-white/50">Agent wallet · Coinbase AgentKit</p>
          <h3 className="mt-1 text-[22px] leading-tight font-bold">Live on Robinhood Chain</h3>
        </div>
        {address && (
          <a href={`${EXPLORER}/address/${address}`} target="_blank" rel="noreferrer" className="shrink-0 rounded-full bg-white/10 px-3 py-1.5 font-mono text-[11px] hover:bg-white/15">
            {address.slice(0, 6)}…{address.slice(-4)} ↗
          </a>
        )}
      </div>
      <div className="mt-4 grid grid-cols-3 gap-2">
        <DarkStat label="ETH (gas + buys)" value={wallet ? wallet.eth.toFixed(5) : "…"} />
        <DarkStat label="Wallet value" value={wallet ? usd(wallet.usd + wallet.holdings.reduce((s, h) => s + (h.usd ?? 0), 0)) : "…"} />
        <DarkStat label="Live buys" value={String(fills.length)} />
      </div>
      {wallet?.holdings.length ? (
        <div className="mt-3 flex flex-wrap gap-1.5">
          {wallet.holdings.map((h) => (
            <span key={h.ticker} className="rounded-full bg-white/10 px-2.5 py-1 font-mono text-[11px]">
              {h.units.toPrecision(3)} {h.ticker}
            </span>
          ))}
        </div>
      ) : null}
      {fills.length > 0 ? (
        <ul className="mt-4 divide-y divide-white/10 text-sm">
          {fills.slice(0, 6).map((f, i) => (
            <li key={`${f.tx_hash}-${i}`} className="flex items-center justify-between gap-3 py-2">
              <span className="min-w-0 truncate">
                <b>{f.ticker}</b> <span className="text-white/50">from {f.merchant}</span>
              </span>
              <a className="shrink-0 font-mono text-[11px] text-mint underline-offset-2 hover:underline" href={`${EXPLORER}/tx/${f.tx_hash}`} target="_blank" rel="noreferrer">
                {usd(f.usd, 2)} · tx ↗
              </a>
            </li>
          ))}
        </ul>
      ) : (
        <p className="mt-4 text-[13px] text-white/50">The owner&apos;s scans run live here with tiny amounts. Visitors&apos; scans are simulated at live on-chain quotes.</p>
      )}
    </section>
  );
}

function DarkStat({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-xl bg-white/[0.07] px-3 py-2.5">
      <div className="text-[10px] leading-tight text-white/50">{label}</div>
      <div className="mt-1 font-mono text-sm font-semibold">{value}</div>
    </div>
  );
}

function MoneyCard() {
  return (
    <section className="violet relative overflow-hidden rounded-[20px] p-5 text-white">
      <Wave className="pointer-events-none absolute inset-x-0 bottom-0 h-24 w-full opacity-30" seed="money" />
      <h3 className="relative text-[22px] font-bold">How Stockback earns</h3>
      <div className="relative mt-4 grid gap-2">
        {[
          ["1%", "fee on every stock-back buy"],
          ["3×", "brand-paid boosts turn customers into shareholders"],
          ["Pro", "auto-import from email receipts and statements"],
        ].map(([k, v]) => (
          <div key={k} className="flex items-center gap-3 rounded-xl bg-white/[0.12] p-2.5">
            <div className="w-12 shrink-0 rounded-md bg-mint py-0.5 text-center text-base font-extrabold text-ink">{k}</div>
            <p className="text-[13px] leading-snug text-white/90">{v}</p>
          </div>
        ))}
      </div>
    </section>
  );
}

/* ============================== pocket ============================== */

function PocketCard({ pocket, ruleSummary }: { pocket: PocketData | null; ruleSummary: { rate: string; rest: string } }) {
  const [open, setOpen] = useState(true);
  const [tab, setTab] = useState<"holdings" | "receipts">("holdings");
  const holdings = pocket?.holdings ?? [];
  const runs = pocket?.runs ?? [];
  const value = holdings.reduce((s, h) => s + h.value, 0);
  const cost = holdings.reduce((s, h) => s + h.cost, 0);
  const pnl = cost > 0 ? (value / cost - 1) * 100 : 0;
  const chron = [...runs].reverse();
  let acc = 0;
  const earnedSeries = [0, ...chron.map((r) => (acc += r.total_usd))];
  const spendSeries = [0, ...chron.map((r) => r.spend_usd)];
  const spent = runs.reduce((s, r) => s + r.spend_usd, 0);

  return (
    <section id="pocket" className="glass scroll-mt-6 rounded-[22px] p-5 sm:p-6">
      <div className="flex items-start justify-between">
        <p className="text-xs text-muted">Connected pocket</p>
        <button
          onClick={() => setOpen((v) => !v)}
          aria-label="Toggle holdings"
          className="flex h-9 w-9 items-center justify-center rounded-full bg-white shadow-md transition hover:scale-105"
        >
          <Chevron up={open} />
        </button>
      </div>
      <div className="mt-1 grid gap-5 sm:grid-cols-[minmax(0,1fr)_minmax(0,1.9fr)] sm:items-center">
        <div>
          <h2 className="text-[34px] leading-[1.02] font-extrabold tracking-tight">
            Stock-back
            <br className="hidden sm:block" /> portfolio
          </h2>
          <p className="mt-2 text-sm text-muted">
            {ruleSummary.rate} back{ruleSummary.rest ? ` · ${ruleSummary.rest}` : ""}
          </p>
          <p className="mt-3 text-[11px] text-muted">
            This device · {runs.length} receipt{runs.length === 1 ? "" : "s"}
          </p>
        </div>
        <div className="grid grid-cols-3 gap-3">
          <div className="tile flex flex-col rounded-2xl p-3">
            <span className="text-[11px] leading-tight text-muted">Portfolio value</span>
            <span className="mt-2 text-xl font-extrabold text-gain">{usd(value, value < 1 ? 3 : 2)}</span>
            <Sparkline values={earnedSeries} className="mt-auto h-8 w-full" />
          </div>
          <div className="tile flex flex-col rounded-2xl p-3">
            <span className="text-[11px] leading-tight text-muted">Spending tracked</span>
            <span className="mt-2 text-xl font-extrabold text-gain">{usd(spent, 0)}</span>
            <Sparkline values={spendSeries} className="mt-auto h-8 w-full" />
          </div>
          <div className="flex flex-col gap-3">
            <div className="tile rounded-2xl p-3">
              <span className="text-[11px] text-muted">Companies owned</span>
              <div className="text-lg font-extrabold">{holdings.length}</div>
            </div>
            <div className="tile rounded-2xl p-3">
              <span className="text-[11px] text-muted">Since first scan</span>
              <div className={`text-lg font-extrabold ${pnl >= 0 ? "text-gain" : "text-warn"}`}>
                {pnl >= 0 ? "+" : ""}
                {pnl.toFixed(2)}%
              </div>
            </div>
          </div>
        </div>
      </div>

      {open && (
        <div className="rise mt-6">
          <div className="flex gap-6 border-b border-line text-sm">
            {(["holdings", "receipts"] as const).map((t) => (
              <button key={t} onClick={() => setTab(t)} className={`-mb-px pb-2 capitalize ${tab === t ? "border-b-2 border-ink font-bold" : "text-muted"}`}>
                {t}
              </button>
            ))}
          </div>
          {tab === "holdings" &&
            (holdings.length === 0 ? (
              <p className="py-8 text-center text-sm text-muted">Scan a receipt and your first shares show up here.</p>
            ) : (
              <div className="mt-4 grid gap-3 sm:grid-cols-2">
                {holdings.map((h) => (
                  <div key={h.ticker} className="tile flex items-center gap-3 rounded-2xl p-3">
                    <Mono t={h.ticker} size={38} />
                    <div className="min-w-0 flex-1">
                      <div className="flex items-baseline justify-between gap-2">
                        <span className="font-bold">{h.ticker}</span>
                        <span className="font-mono text-sm">{usd(h.value, 4)}</span>
                      </div>
                      <div className="flex items-baseline justify-between gap-2 text-[11px] text-muted">
                        <span className="truncate">{tokenInfo.get(h.ticker)?.name}</span>
                        <span className="shrink-0 font-mono">{h.shares.toPrecision(3)} sh</span>
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            ))}
          {tab === "receipts" &&
            (runs.length === 0 ? (
              <p className="py-8 text-center text-sm text-muted">No receipts yet.</p>
            ) : (
              <ul className="mt-2 divide-y divide-line">
                {runs.slice(0, 10).map((r) => (
                  <li key={r.id}>
                    <a href={`/r/${r.id}`} className="flex items-center justify-between gap-3 py-2.5 text-sm hover:opacity-80">
                      <div className="min-w-0">
                        <div className="truncate font-semibold">{r.merchant}</div>
                        <div className="text-[11px] text-muted">{new Date(r.created_at).toLocaleString()}</div>
                      </div>
                      <div className="flex shrink-0 items-center gap-2">
                        {r.flagged && <span className="rounded-full bg-warn/15 px-2 py-0.5 text-[10px] font-semibold text-warn">injection blocked</span>}
                        {r.mode === "live" && <span className="rounded-full bg-mint/25 px-2 py-0.5 text-[10px] font-semibold text-gain">live</span>}
                        <span className="flex -space-x-1.5">
                          {r.fills.slice(0, 4).map((f) => (
                            <span key={f.ticker} className="rounded-full ring-2 ring-white">
                              <Mono t={f.ticker} size={22} />
                            </span>
                          ))}
                        </span>
                        <span className="w-14 text-right font-mono text-xs">{usd(r.total_usd, 2)}</span>
                      </div>
                    </a>
                  </li>
                ))}
              </ul>
            ))}
        </div>
      )}
    </section>
  );
}

/* ============================== run ============================== */

function RunPanel(props: {
  phase: Phase;
  preview: string | null;
  pasted: string;
  elapsed: number;
  busy: boolean;
  receipt: Receipt | null;
  mapping: Mapping | null;
  plan: Plan | null;
  run: Run | null;
  traces: ServTrace[];
  error: string | null;
}) {
  const { phase, preview, pasted, elapsed, busy, receipt, mapping, plan, run, traces, error } = props;
  const idx = STEPS.findIndex((x) => x.key === phase);
  return (
    <section className="glass rounded-[22px] p-5 sm:p-6">
      <div className="flex items-center gap-4">
        <div className="relative h-20 w-16 shrink-0 overflow-hidden rounded-xl bg-[#8a7b66]">
          {preview ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img src={preview} alt="Your receipt" className="h-full w-full object-cover object-top" />
          ) : (
            <pre className="h-full w-full overflow-hidden bg-white p-1 font-mono text-[5px] leading-tight text-[#23201b]">{pasted}</pre>
          )}
          {phase === "read" && <div className="scanline pointer-events-none absolute inset-x-0 top-0 h-5 bg-gradient-to-b from-transparent via-mint/70 to-transparent" />}
        </div>
        <div className="min-w-0 flex-1">
          <p className="text-xs text-muted">{busy ? "SERV is working" : phase === "error" ? "Stopped" : "Done"}</p>
          <h2 className="truncate text-2xl font-extrabold tracking-tight">{receipt?.merchant || "Reading receipt…"}</h2>
          <p className="font-mono text-xs text-muted">
            {(elapsed / 1000).toFixed(1)}s{receipt ? ` · ${receipt.currency} ${receipt.total.toLocaleString()} · ${receipt.items.length} items` : ""}
          </p>
        </div>
        {run && run.fills.length > 0 && (
          <div className="hidden shrink-0 text-right sm:block">
            <p className="text-[11px] text-muted">Stock-back</p>
            <p className="text-2xl font-extrabold text-gain">+{usd(run.total_usd)}</p>
          </div>
        )}
      </div>

      <div className="mt-5 space-y-3">
        {STEPS.map((s, i) => {
          const state =
            phase === "done" ? "done" : phase === "error" ? (i < traces.length ? "done" : i === traces.length ? "error" : "todo") : i < idx ? "done" : i === idx ? "active" : "todo";
          return (
            <StepCard key={s.key} n={i + 1} title={s.title} serv={s.serv} state={state} trace={traces[i]}>
              {s.key === "read" && receipt && <ReadResult receipt={receipt} />}
              {s.key === "map" && mapping && receipt && <MapResult mapping={mapping} receipt={receipt} />}
              {s.key === "plan" && plan && <PlanResult plan={plan} />}
              {s.key === "buy" && run && plan && <BuyResult run={run} plan={plan} />}
              {state === "error" && error && <p className="text-sm text-warn">{error}</p>}
            </StepCard>
          );
        })}
        {traces.length > 0 && <Trace traces={traces} />}
      </div>
    </section>
  );
}

export function StepCard(props: { n: number; title: string; serv: string; state: string; trace?: ServTrace; children?: React.ReactNode }) {
  const { n, title, serv, state, trace, children } = props;
  return (
    <div className={`tile rounded-2xl p-4 transition ${state === "active" ? "ring-2 ring-accent/50" : ""} ${state === "todo" ? "opacity-50" : ""}`}>
      <div className="flex items-start gap-3">
        <div
          className={`mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-full text-xs font-bold ${
            state === "done" ? "bg-mint text-ink" : state === "active" ? "bg-accent text-white" : state === "error" ? "bg-warn text-white" : "bg-chip text-muted"
          }`}
        >
          {state === "done" ? "✓" : state === "error" ? "!" : state === "active" ? <Spinner small /> : n}
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-baseline justify-between gap-x-3">
            <h3 className="font-bold">{title}</h3>
            <span className="font-mono text-[10.5px] text-muted">
              {trace ? `${(trace.latencyMs / 1000).toFixed(1)}s · ` : ""}
              {n < 4 ? "SERV · " : ""}
              {serv}
            </span>
          </div>
          {children && <div className="rise mt-3">{children}</div>}
        </div>
      </div>
    </div>
  );
}

export function ReadResult({ receipt }: { receipt: Receipt }) {
  return (
    <div className="space-y-3">
      <div className="flex flex-wrap gap-1.5 text-[13px]">
        <Chip strong>{receipt.merchant || "Unknown merchant"}</Chip>
        {receipt.date && <Chip>{receipt.date}</Chip>}
        <Chip>
          {receipt.currency} {receipt.total.toLocaleString()}
        </Chip>
        <Chip>{receipt.items.length} items</Chip>
        {receipt.payment_method && <Chip>{receipt.payment_method}</Chip>}
      </div>
      {receipt.unusual_text && (
        <div className="rounded-xl border border-warn/30 bg-warn/10 p-3">
          <p className="text-sm font-bold text-warn">Prompt injection caught and ignored</p>
          <p className="mt-1 font-mono text-xs break-words text-muted">“{receipt.unusual_text}”</p>
          <p className="mt-1 text-xs text-muted">Printed text is treated as data. Your rules, cap and wallet are untouched.</p>
        </div>
      )}
    </div>
  );
}

function hue(t: string) {
  let h = 0;
  for (const c of t) h = (h * 31 + c.charCodeAt(0)) % 360;
  return h;
}

export function Mono({ t, size = 36 }: { t: string; size?: number }) {
  return (
    <span
      aria-hidden
      className="inline-flex shrink-0 items-center justify-center rounded-full font-mono font-bold text-white"
      style={{
        width: size,
        height: size,
        fontSize: Math.max(8, size * 0.28),
        background: `linear-gradient(145deg, hsl(${hue(t)} 60% 58%), hsl(${(hue(t) + 30) % 360} 55% 42%))`,
      }}
    >
      {t.slice(0, 4)}
    </span>
  );
}

export function TickerChip({ t, muted }: { t: string; muted?: boolean }) {
  return (
    <span className={`inline-flex items-center gap-1.5 rounded-full py-0.5 pr-2 pl-0.5 font-mono text-xs font-bold ${muted ? "bg-chip text-muted" : "bg-ink text-white"}`}>
      <span className="h-4 w-4 rounded-full" style={{ background: `hsl(${hue(t)} 60% 55%)` }} />
      {t}
    </span>
  );
}

export function MapResult({ mapping, receipt }: { mapping: Mapping; receipt: Receipt }) {
  const rows = [
    { label: receipt.merchant || "Store", kind: "store", o: mapping.merchant },
    ...(mapping.platform.owner_company ? [{ label: receipt.payment_method || "Platform", kind: "platform", o: mapping.platform }] : []),
    ...mapping.items.map((m) => ({ label: receipt.items[m.item_index]?.description ?? m.brand, kind: m.brand || "unbranded", o: m })),
  ];
  return (
    <ul className="divide-y divide-line text-sm">
      {rows.map((r, i) => (
        <li key={i} className="flex items-center justify-between gap-3 py-2">
          <div className="min-w-0">
            <div className="truncate font-semibold">{r.label}</div>
            <div className="truncate text-xs text-muted">
              <span className="font-mono">{r.kind}</span>
              {r.o.owner_company ? ` → ${r.o.owner_company}` : ""}
            </div>
          </div>
          <div className="shrink-0 text-right">
            {r.o.rh_ticker !== "NONE" ? (
              <TickerChip t={r.o.rh_ticker} />
            ) : (
              <span className="font-mono text-[11px] text-muted">{r.o.owner_public_ticker ? `${r.o.owner_public_ticker} · not on chain` : "no listed owner"}</span>
            )}
          </div>
        </li>
      ))}
    </ul>
  );
}

export function PlanResult({ plan }: { plan: Plan }) {
  const blocked = plan.companies.filter((c) => !c.allowed);
  return (
    <div className="space-y-3">
      <div className="flex flex-wrap gap-1.5 text-[13px]">
        <Chip strong>{plan.params.rate_percent}% back</Chip>
        <Chip>{plan.params.cap_usd_per_receipt ? `cap ${usd(plan.params.cap_usd_per_receipt)}/receipt` : "no cap"}</Chip>
        <Chip>fallback {plan.params.fallback_ticker === "NONE" ? "none" : plan.params.fallback_ticker}</Chip>
        {plan.currency !== "USD" && (
          <Chip>
            1 {plan.currency} = ${plan.fx_rate.toPrecision(3)}
          </Chip>
        )}
      </div>
      <ul className="divide-y divide-line text-sm">
        {plan.lines.map((l) => (
          <li key={l.item_index} className="grid grid-cols-[1fr_auto] gap-x-3 py-2">
            <div className="min-w-0">
              <div className={`truncate font-semibold ${l.via === "skipped" ? "text-muted line-through" : ""}`}>{l.description}</div>
              <div className="truncate text-xs text-muted">{l.note}</div>
            </div>
            <div className="flex items-center gap-2 text-right">
              {l.boost > 1 && <span className="rounded-md bg-mint px-1.5 py-0.5 text-[10px] font-extrabold text-ink">{l.boost}× boost</span>}
              {l.target ? <TickerChip t={l.target} muted={l.via === "fallback"} /> : <span className="font-mono text-xs text-muted">skipped</span>}
              <span className="w-14 font-mono text-xs">{l.stockback_usd ? usd(l.stockback_usd) : "—"}</span>
            </div>
          </li>
        ))}
      </ul>
      {blocked.length > 0 && <p className="text-xs text-muted">Blocked by your rules: {blocked.map((b) => `${b.ticker} (${b.why})`).join(", ")}</p>}
      {plan.capped && <p className="text-xs text-muted">Scaled down to your cap of {usd(plan.params.cap_usd_per_receipt)}.</p>}
    </div>
  );
}

export function BuyResult({ run, plan }: { run: Run; plan: Plan }) {
  const names = run.fills.map((f) => tokenInfo.get(f.ticker)?.name ?? f.ticker);
  const list = names.length > 1 ? `${names.slice(0, -1).join(", ")} and ${names.at(-1)}` : names[0];
  return (
    <div className="space-y-4">
      {names.length ? (
        <div className="violet relative overflow-hidden rounded-2xl p-4 text-white">
          <Wave className="pointer-events-none absolute inset-x-0 bottom-0 h-16 w-full opacity-40" seed={run.id} />
          <p className="relative text-xs text-white/75">
            {usd(run.total_usd)} of stock from a {usd(plan.spend_usd)} receipt
          </p>
          <p className="relative mt-1 text-xl leading-snug font-extrabold">You now own a piece of {list}.</p>
        </div>
      ) : (
        <p className="text-sm text-muted">Nothing on this receipt earned stock-back under your rules.</p>
      )}
      <ul className="space-y-2">
        {run.fills.map((f) => (
          <FillRow key={f.ticker} f={f} />
        ))}
      </ul>
      <ShareBar run={run} names={names} />
      <p className="text-xs text-muted">
        Stockback fee {usd(plan.fee_usd, 4)} (1%).{" "}
        {run.mode === "simulated"
          ? "Simulated: priced with a live on-chain Uniswap quote on Robinhood Chain (or Robinhood's token price where no pool exists). No transaction sent."
          : "Executed from the AgentKit wallet on Robinhood Chain (scaled down to the demo budget)."}
      </p>
    </div>
  );
}

function ShareBar({ run, names }: { run: Run; names: string[] }) {
  const [copied, setCopied] = useState(false);
  if (!names.length) return null;
  const url = () => `${window.location.origin}/r/${run.id}`;
  const who = names.length > 1 ? `${names.slice(0, -1).join(", ")} and ${names.at(-1)}` : names[0];
  const text = `My ${run.merchant} receipt just bought me a piece of ${who} 🧾→📈 Stock-back on Robinhood Chain, reasoned by @openservai SERV.`;
  return (
    <div className="flex flex-wrap gap-2">
      <a href={`/r/${run.id}`} className="tile rounded-full px-3.5 py-1.5 text-sm font-semibold">
        Receipt page
      </a>
      <button className="tile rounded-full px-3.5 py-1.5 text-sm font-semibold" onClick={() => navigator.clipboard?.writeText(url()).then(() => setCopied(true))}>
        {copied ? "Link copied" : "Copy link"}
      </button>
      <button
        onClick={() => window.open(`https://x.com/intent/tweet?text=${encodeURIComponent(text)}&url=${encodeURIComponent(url())}`, "_blank", "noopener")}
        className="rounded-full bg-ink px-3.5 py-1.5 text-sm font-semibold text-white"
      >
        Share on X
      </button>
    </div>
  );
}

export function FillRow({ f }: { f: Fill }) {
  const info = tokenInfo.get(f.ticker);
  return (
    <li className="tile flex items-center gap-3 rounded-2xl p-3">
      <Mono t={f.ticker} />
      <div className="min-w-0 flex-1">
        <div className="flex items-baseline justify-between gap-2">
          <span className="font-bold">
            {f.ticker} <span className="font-normal text-muted">{info?.name}</span>
          </span>
          <span className="font-mono text-sm font-semibold text-gain">+{usd(f.usd, 4)}</span>
        </div>
        <div className="flex items-baseline justify-between gap-2 text-[11px] text-muted">
          <span className="truncate">{f.error ? `failed: ${f.error}` : f.route}</span>
          <span className="shrink-0 font-mono">{f.shares ? `${f.shares.toPrecision(3)} sh` : ""}</span>
        </div>
      </div>
      {f.tx_hash ? (
        <a href={`${EXPLORER}/tx/${f.tx_hash}`} target="_blank" rel="noreferrer" className="shrink-0 rounded-md bg-mint px-2 py-1 text-[10px] font-extrabold text-ink">
          LIVE TX ↗
        </a>
      ) : (
        <span className="shrink-0 rounded-md bg-chip px-2 py-1 text-[10px] font-semibold text-muted">SIM</span>
      )}
    </li>
  );
}

export function Trace({ traces }: { traces: ServTrace[] }) {
  const [open, setOpen] = useState(false);
  const total = traces.reduce((s, t) => s + t.latencyMs, 0);
  return (
    <div className="tile rounded-2xl p-4">
      <button className="flex w-full items-center justify-between" onClick={() => setOpen((v) => !v)}>
        <span className="text-sm font-bold">Under the hood</span>
        <span className="font-mono text-xs text-muted">
          {traces.length} SERV calls · {(total / 1000).toFixed(1)}s {open ? "▲" : "▼"}
        </span>
      </button>
      {open && (
        <div className="rise mt-3 overflow-x-auto">
          <table className="w-full text-left font-mono text-xs">
            <thead className="text-muted">
              <tr>
                <th className="py-1 pr-3 font-normal">step</th>
                <th className="py-1 pr-3 font-normal">model</th>
                <th className="py-1 pr-3 font-normal">SERV features</th>
                <th className="py-1 pr-3 font-normal">tokens in/out</th>
                <th className="py-1 font-normal">time</th>
              </tr>
            </thead>
            <tbody>
              {traces.map((t) => (
                <tr key={t.step} className="border-t border-line">
                  <td className="py-1.5 pr-3">{t.step}</td>
                  <td className="py-1.5 pr-3">{t.model}</td>
                  <td className="py-1.5 pr-3">{t.features.join(", ")}</td>
                  <td className="py-1.5 pr-3">
                    {t.promptTokens ?? "?"}/{t.completionTokens ?? "?"}
                  </td>
                  <td className="py-1.5">{(t.latencyMs / 1000).toFixed(1)}s</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

/* ============================== how it works ============================== */

function HowItWorks() {
  const steps = [
    ["Read", "Vision → strict JSON. Text printed to trick an AI is quarantined, never obeyed.", "prompt guard"],
    ["Trace", "Brand → parent → one of 178 companies that exist as Robinhood Chain tokens.", "shadow agent"],
    ["Rules", "Your plain-English policy becomes parameters. Waterfall, boosts, cap and fee are plain code.", "Multipath"],
    ["Buy", "A Coinbase AgentKit wallet swaps ETH into the stock tokens on Uniswap, one basket tx per receipt.", "Robinhood Chain"],
  ];
  return (
    <section id="how" className="scroll-mt-6 px-4 pb-8 sm:px-7">
      <div className="glass rounded-[22px] p-5 sm:p-6">
        <div className="flex flex-wrap items-end justify-between gap-2">
          <div>
            <p className="text-xs text-muted">How it works</p>
            <h2 className="text-[28px] leading-tight font-extrabold tracking-tight">Judgment in SERV. Money in code.</h2>
          </div>
          <p className="max-w-md text-sm text-muted">
            Stock-back rewards have been US-only for years. Robinhood Chain stock tokens are built for everyone else, so a Lagos grocery run
            can own a piece of Apple.
          </p>
        </div>
        <div className="mt-5 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          {steps.map(([t, d, tag], i) => (
            <div key={t} className="tile flex flex-col rounded-2xl p-4">
              <div className="flex items-center justify-between">
                <span className="text-lg font-extrabold">
                  {i + 1}. {t}
                </span>
                <span className="rounded-md bg-mint/30 px-1.5 py-0.5 font-mono text-[10px] font-semibold text-gain">{tag}</span>
              </div>
              <p className="mt-2 text-[13px] leading-relaxed text-muted">{d}</p>
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}

/* ============================== bits ============================== */

export function Chip({ children, strong }: { children: React.ReactNode; strong?: boolean }) {
  return <span className={`rounded-full px-2.5 py-1 font-semibold ${strong ? "bg-ink text-white" : "bg-chip text-ink"}`}>{children}</span>;
}

export function Footer() {
  return (
    <footer className="border-t border-line px-4 py-6 text-xs text-muted sm:px-7">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <span>Stockback · built on SERV Reasoning for the OpenServ SERV Hackathon</span>
        <span>Stock tokens aren&apos;t available to US persons and some other regions. Not investment advice. Demo brand boosts are illustrative.</span>
      </div>
    </footer>
  );
}

function Tile({ children, onClick, disabled, active, highlight }: { children: React.ReactNode; onClick?: () => void; disabled?: boolean; active?: boolean; highlight?: boolean }) {
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      className={`tile flex aspect-[1/1.05] min-w-0 flex-col items-start justify-between rounded-2xl p-3 text-left transition hover:-translate-y-0.5 disabled:opacity-50 ${
        active ? "ring-2 ring-accent/60" : ""
      } ${highlight ? "ring-1 ring-mint/60" : ""}`}
    >
      {children}
    </button>
  );
}

export function Sparkline({ values, className = "" }: { values: number[]; className?: string }) {
  const v = values.length > 1 ? values : [0, 0];
  const max = Math.max(...v);
  const min = Math.min(...v);
  const w = 100;
  const h = 30;
  const pts = v.map((y, i) => [(i / (v.length - 1)) * w, h - 3 - ((y - min) / (max - min || 1)) * (h - 6)]);
  const d = pts.map((p, i) => `${i ? "L" : "M"}${p[0].toFixed(1)},${p[1].toFixed(1)}`).join(" ");
  return (
    <svg viewBox={`0 0 ${w} ${h}`} preserveAspectRatio="none" className={className} aria-hidden>
      <defs>
        <linearGradient id="spark" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor="#5ecba1" stopOpacity="0.45" />
          <stop offset="1" stopColor="#5ecba1" stopOpacity="0" />
        </linearGradient>
      </defs>
      <path d={`${d} L${w},${h} L0,${h} Z`} fill="url(#spark)" />
      <path d={d} fill="none" stroke="#2fae80" strokeWidth="1.8" vectorEffect="non-scaling-stroke" strokeLinejoin="round" />
    </svg>
  );
}

function Wave({ className = "", seed }: { className?: string; seed: string }) {
  const k = hue(seed) / 360;
  const a = 30 + k * 30;
  const b = 50 - k * 25;
  return (
    <svg viewBox="0 0 400 100" preserveAspectRatio="none" className={className} aria-hidden>
      <path d={`M0,${70 - a / 3} C80,${b} 120,${95 - a} 200,${60 - k * 20} S330,${30 + a / 2} 400,${55 - k * 10} L400,100 L0,100 Z`} fill="rgba(255,255,255,0.35)" />
      <path d={`M0,${85 - k * 10} C90,${70 - a / 4} 160,95 240,${75 - k * 15} S350,60 400,${80 - a / 4} L400,100 L0,100 Z`} fill="rgba(255,255,255,0.25)" />
    </svg>
  );
}

function Spinner({ small }: { small?: boolean }) {
  const s = small ? 14 : 20;
  return (
    <svg width={s} height={s} viewBox="0 0 24 24" className="animate-spin" aria-hidden>
      <circle cx="12" cy="12" r="9" fill="none" stroke="currentColor" strokeOpacity="0.25" strokeWidth="3" />
      <path d="M21 12a9 9 0 0 0-9-9" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" />
    </svg>
  );
}

function Chevron({ up }: { up: boolean }) {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#0a0212" strokeWidth="2.6" strokeLinecap="round" strokeLinejoin="round" style={{ transform: up ? "rotate(180deg)" : undefined }}>
      <path d="M6 9l6 6 6-6" />
    </svg>
  );
}

function ArrowIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.6" strokeLinecap="round" strokeLinejoin="round">
      <path d="M5 12h14M13 6l6 6-6 6" />
    </svg>
  );
}

function CameraIcon() {
  return (
    <svg width="30" height="30" viewBox="0 0 24 24" fill="none" stroke="#6569d2" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <path d="M4 8h3l2-3h6l2 3h3a1 1 0 0 1 1 1v9a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V9a1 1 0 0 1 1-1z" />
      <circle cx="12" cy="13" r="3.5" />
    </svg>
  );
}

function PasteIcon() {
  return (
    <svg width="30" height="30" viewBox="0 0 24 24" fill="none" stroke="#6569d2" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <rect x="6" y="4" width="12" height="17" rx="2" />
      <path d="M9 4h6v3H9zM9 11h6M9 15h4" />
    </svg>
  );
}
