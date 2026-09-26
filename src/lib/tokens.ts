import raw from "@/data/rh-tokens.json";

export type RhToken = {
  symbol: string;
  name: string;
  address: `0x${string}`;
  logo: string | null;
  multiplier: string | null;
};

export const TOKENS = raw as RhToken[];

// Funds, not companies. Brand mapping never targets these; they are only fallbacks.
export const FUNDS = new Set([
  "BND", "EWT", "EWY", "GLD", "INDA", "QQQ", "SCHD", "SGOV", "SHY", "SLV",
  "SMH", "SOXX", "SPMO", "SPY", "USO", "VTI", "XLK",
]);

export const COMPANY_TICKERS = TOKENS.filter((t) => !FUNDS.has(t.symbol)).map((t) => t.symbol);
export const ALL_TICKERS = TOKENS.map((t) => t.symbol);
export const FALLBACK_CHOICES = ["VTI", "SPY", "QQQ", "SCHD", "SGOV", "GLD"] as const;

const bySymbol = new Map(TOKENS.map((t) => [t.symbol, t]));
export function token(symbol: string): RhToken | undefined {
  return bySymbol.get(symbol);
}

export function companyCatalog(): string {
  return TOKENS.filter((t) => !FUNDS.has(t.symbol))
    .map((t) => `${t.symbol} — ${t.name}`)
    .join("\n");
}
