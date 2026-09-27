import { mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import path from "node:path";
import postgres from "postgres";
import type { Plan, Receipt, Mapping } from "@/lib/pipeline";
import type { ServTrace } from "@/lib/serv";

export type Fill = {
  ticker: string;
  usd: number;
  fee_usd: number;
  price: number; // USD per share-equivalent at fill/quote time
  shares: number; // share-equivalents (UI units, multiplier-adjusted)
  mode: "live" | "simulated";
  route?: string;
  tx_hash?: string;
  error?: string;
};

export type Run = {
  id: string;
  pocket: string;
  created_at: string;
  merchant: string;
  currency: string;
  spend_usd: number;
  total_usd: number;
  fee_usd: number;
  mode: "live" | "simulated";
  fills: Fill[];
  receipt: Receipt;
  mapping: Mapping;
  plan: Plan;
  traces: ServTrace[];
  flagged: string;
  wallet?: string;
  source?: "pocket" | "house" | "simulated";
};

// Postgres when DATABASE_URL is set (Railway), otherwise a JSON file for local dev.
const sql = process.env.DATABASE_URL ? postgres(process.env.DATABASE_URL, { max: 3, idle_timeout: 20 }) : null;
let ready: Promise<void> | null = null;

function init() {
  if (!sql) return Promise.resolve();
  ready ??= sql`
    create table if not exists runs (
      id text primary key,
      pocket text not null,
      created_at timestamptz not null default now(),
      mode text not null,
      data jsonb not null
    )`.then(() => sql`create index if not exists runs_pocket on runs (pocket, created_at desc)`).then(() => undefined);
  return ready;
}

const FILE = path.join(process.cwd(), ".data", "runs.json");
function readFile(): Run[] {
  if (!existsSync(FILE)) return [];
  return JSON.parse(readFileSync(FILE, "utf8")) as Run[];
}

export async function saveRun(run: Run) {
  if (sql) {
    await init();
    await sql`insert into runs (id, pocket, created_at, mode, data)
      values (${run.id}, ${run.pocket}, ${run.created_at}, ${run.mode}, ${sql.json(run as never)})
      on conflict (id) do update set data = excluded.data, mode = excluded.mode`;
    return;
  }
  mkdirSync(path.dirname(FILE), { recursive: true });
  const runs = readFile().filter((r) => r.id !== run.id);
  runs.push(run);
  writeFileSync(FILE, JSON.stringify(runs, null, 1));
}

export async function runsFor(pocket: string, limit = 50): Promise<Run[]> {
  if (sql) {
    await init();
    const rows = await sql<{ data: Run }[]>`select data from runs where pocket = ${pocket} order by created_at desc limit ${limit}`;
    return rows.map((r) => r.data);
  }
  return readFile().filter((r) => r.pocket === pocket).sort((a, b) => b.created_at.localeCompare(a.created_at)).slice(0, limit);
}

export async function liveRuns(limit = 20): Promise<Run[]> {
  if (sql) {
    await init();
    const rows = await sql<{ data: Run }[]>`select data from runs where mode = 'live' order by created_at desc limit ${limit}`;
    return rows.map((r) => r.data);
  }
  return readFile().filter((r) => r.mode === "live").sort((a, b) => b.created_at.localeCompare(a.created_at)).slice(0, limit);
}

export async function stats(): Promise<{ receipts: number; live: number; usd: number }> {
  if (sql) {
    await init();
    const [row] = await sql<{ receipts: number; live: number; usd: number }[]>`
      select count(*)::int as receipts,
             count(*) filter (where mode = 'live')::int as live,
             coalesce(sum((data->>'total_usd')::numeric), 0)::float as usd
      from runs`;
    return row;
  }
  const runs = readFile();
  return { receipts: runs.length, live: runs.filter((r) => r.mode === "live").length, usd: runs.reduce((s, r) => s + r.total_usd, 0) };
}

export async function getRun(id: string): Promise<Run | null> {
  if (!/^[a-f0-9-]{36}$/.test(id)) return null;
  if (sql) {
    await init();
    const rows = await sql<{ data: Run }[]>`select data from runs where id = ${id}`;
    return rows[0]?.data ?? null;
  }
  return readFile().find((r) => r.id === id) ?? null;
}

/* ---------------- per-pocket agent wallets ---------------- */
export type WalletRow = { pocket: string; address: string; enc_key: string; created_at: string };
let walletsReady: Promise<void> | null = null;
function initWallets() {
  if (!sql) return Promise.resolve();
  walletsReady ??= sql`
    create table if not exists wallets (
      pocket text primary key,
      address text not null unique,
      enc_key text not null,
      created_at timestamptz not null default now()
    )`.then(() => undefined);
  return walletsReady;
}
const WFILE = path.join(process.cwd(), ".data", "wallets.json");
const readWallets = (): WalletRow[] => (existsSync(WFILE) ? (JSON.parse(readFileSync(WFILE, "utf8")) as WalletRow[]) : []);

export async function getWalletRow(pocket: string): Promise<WalletRow | null> {
  if (sql) {
    await initWallets();
    const rows = await sql<WalletRow[]>`select pocket, address, enc_key, created_at::text as created_at from wallets where pocket = ${pocket}`;
    return rows[0] ?? null;
  }
  return readWallets().find((w) => w.pocket === pocket) ?? null;
}

export async function insertWalletRow(row: WalletRow): Promise<WalletRow> {
  if (sql) {
    await initWallets();
    // first writer wins, so two tabs creating at once end up with the same wallet
    await sql`insert into wallets (pocket, address, enc_key) values (${row.pocket}, ${row.address}, ${row.enc_key}) on conflict (pocket) do nothing`;
    return (await getWalletRow(row.pocket))!;
  }
  mkdirSync(path.dirname(WFILE), { recursive: true });
  const all = readWallets();
  const existing = all.find((w) => w.pocket === row.pocket);
  if (existing) return existing;
  all.push(row);
  writeFileSync(WFILE, JSON.stringify(all, null, 1));
  return row;
}
