// USD value of 1 unit of a currency. Live rates from open.er-api.com (free, no key),
// cached for an hour, with a static fallback so a rate outage never blocks a receipt.
const STATIC: Record<string, number> = {
  USD: 1, NGN: 1 / 1530, EUR: 1.08, GBP: 1.27, CAD: 0.73, AUD: 0.66, INR: 1 / 84,
  KES: 1 / 129, GHS: 1 / 15.5, ZAR: 1 / 18, CHF: 1.12, JPY: 1 / 148, SGD: 0.75, AED: 0.272,
};

let cache: { at: number; rates: Record<string, number> } | null = null;

async function rates(): Promise<Record<string, number>> {
  if (cache && Date.now() - cache.at < 3_600_000) return cache.rates;
  try {
    const res = await fetch("https://open.er-api.com/v6/latest/USD", { signal: AbortSignal.timeout(4000) });
    const json = (await res.json()) as { result?: string; rates?: Record<string, number> };
    if (json.result === "success" && json.rates) {
      cache = { at: Date.now(), rates: json.rates };
      return json.rates;
    }
  } catch {}
  return {};
}

export async function toUsd(currency: string): Promise<number> {
  const code = (currency || "USD").toUpperCase().trim();
  if (code === "USD") return 1;
  const perUsd = (await rates())[code];
  if (perUsd && perUsd > 0) return 1 / perUsd;
  return STATIC[code] ?? 1;
}
