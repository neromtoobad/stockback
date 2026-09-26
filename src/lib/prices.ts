// Live stock-token quotes from Robinhood's public tokenization API (one call returns all 195).
export type Quote = { symbol: string; bid: number; ask: number; mid: number; high: number; low: number; halted: boolean; at: string };

let cache: { at: number; quotes: Map<string, Quote> } | null = null;

export async function allQuotes(): Promise<Map<string, Quote>> {
  if (cache && Date.now() - cache.at < 60_000) return cache.quotes;
  const res = await fetch("https://api.robinhood.com/rhj/prices", { signal: AbortSignal.timeout(8000), cache: "no-store" });
  if (!res.ok) throw new Error(`Robinhood prices HTTP ${res.status}`);
  const json = (await res.json()) as {
    quotes: { tokenSymbol: string; tokenBid?: string; tokenAsk?: string; bid: string; ask: string; dailyHigh?: string; dailyLow?: string; isTradingHalt: boolean; generatedAt: string }[];
  };
  const quotes = new Map<string, Quote>();
  for (const q of json.quotes) {
    const bid = Number(q.tokenBid ?? q.bid);
    const ask = Number(q.tokenAsk ?? q.ask);
    quotes.set(q.tokenSymbol, { symbol: q.tokenSymbol, bid, ask, mid: (bid + ask) / 2, high: Number(q.dailyHigh ?? 0), low: Number(q.dailyLow ?? 0), halted: q.isTradingHalt, at: q.generatedAt });
  }
  cache = { at: Date.now(), quotes };
  return quotes;
}

export async function quotesFor(symbols: string[]): Promise<Record<string, Quote>> {
  const all = await allQuotes();
  return Object.fromEntries(symbols.flatMap((s) => (all.has(s) ? [[s, all.get(s)!]] : [])));
}
