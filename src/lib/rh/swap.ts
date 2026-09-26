/**
 * Robinhood Chain (id 4663) execution layer for Stockback: quote and buy slivers of Robinhood stock tokens.
 *
 * Funding model: the agent wallet holds ONLY native ETH (bridging ETH costs ~2% via Relay; bridging into USDG ~6%).
 * Default route is a single transaction, no approvals:
 *   ETH --(msg.value, auto-wrapped by SwapRouter02)--> WETH --v3 0.01%--> USDG --v3 fee--> STOCK
 * (or a direct WETH/STOCK v3 pool when that quotes better). If the wallet holds USDG, a USDG-input route is used
 * instead (v3 SwapRouter02 with a one-time ERC-20 approve, or v4 UniversalRouter with one-time Permit2 approvals).
 *
 * Server-only (reads AGENT_PRIVATE_KEY through ./agentkit when executing). Quotes are read-only.
 */
import {
  createPublicClient,
  decodeEventLog,
  defineChain,
  encodeAbiParameters,
  encodeFunctionData,
  encodePacked,
  formatUnits,
  getAddress,
  http,
  maxUint160,
  maxUint256,
  parseAbi,
  parseUnits,
  zeroAddress,
  type Address,
  type Hex,
  type PublicClient,
} from "viem";

// ---------------------------------------------------------------------------------------------------------------
// Chain + addresses
// ---------------------------------------------------------------------------------------------------------------

export const RH_RPC_URL = process.env.RH_RPC_URL || "https://rpc.mainnet.chain.robinhood.com";
export const RH_EXPLORER = "https://robinhoodchain.blockscout.com";

export const robinhoodChain = defineChain({
  id: 4663,
  name: "Robinhood Chain",
  nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
  rpcUrls: { default: { http: [RH_RPC_URL] } },
  blockExplorers: { default: { name: "Blockscout", url: RH_EXPLORER } },
  contracts: { multicall3: { address: "0xcA11bde05977b3631167028862bE2a173976CA11" } },
});

export const RH = {
  USDG: "0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168",
  WETH: "0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73",
  v3Factory: "0x1f7d7550B1b028f7571E69A784071F0205FD2EfA",
  v3QuoterV2: "0x33e885eD0Ec9bF04EcfB19341582aADCb4c8A9E7",
  v3SwapRouter02: "0xCaf681a66D020601342297493863E78C959E5cb2",
  v4PoolManager: "0x8366a39CC670B4001A1121B8F6A443A643e40951",
  v4Quoter: "0x8Dc178eFB8111BB0973Dd9d722ebeFF267c98F94",
  universalRouter: "0x8876789976dEcBfCbBbe364623C63652db8C0904",
  permit2: "0x000000000022D473030F116dDEE9F6B43aC78BA3",
} as const satisfies Record<string, Address>;

/**
 * Snapshot 2026-09-26 of `npx tsx scripts/probe-swap.ts --all`: tokens whose ETH-input route prices within 5% of
 * Robinhood's quote with <= 1% extra impact at $1. Use it to constrain the purchase->company mapping; quoteBuy() is
 * the live source of truth (returns null when a route is not liquid). Not listed at all on Robinhood Chain as of this
 * snapshot: KO, PEP, SBUX, MCD, WMT, UBER, NKE, DIS, HD, TGT, CMG, SPOT.
 */
export const LIQUID_TICKERS_SNAPSHOT = [
  "AAPL", "AMC", "AMD", "AMZN", "ASML", "AVGO", "BA", "BABA", "BB", "BE", "BULL", "CCL", "CEG", "COIN", "COST", "CRCL",
  "DELL", "DJT", "F", "FIG", "GLD", "GLXY", "GME", "GOOGL", "IBM", "INDA", "INTC", "LLY", "LMT", "LULU", "META", "MRNA",
  "MRVL", "MSFT", "MU", "NET", "NFLX", "NVDA", "ON", "PATH", "PENG", "PLTR", "POET", "QCOM", "QQQ", "QUBT", "RCAT",
  "SGOV", "SHOP", "SKHY", "SLV", "SNDK", "SNOW", "SPY", "TSLA", "TTWO", "UPS", "USO", "VTI",
] as const;

const V3_FEES = [100, 500, 3000, 10000] as const;
const V4_TIERS = [[100, 1], [500, 10], [3000, 60], [10000, 200]] as const;
const USDG_DECIMALS = 6;

// ---------------------------------------------------------------------------------------------------------------
// ABIs
// ---------------------------------------------------------------------------------------------------------------

const erc20Abi = parseAbi([
  "function balanceOf(address) view returns (uint256)",
  "function allowance(address owner, address spender) view returns (uint256)",
  "function approve(address spender, uint256 amount) returns (bool)",
  "function decimals() view returns (uint8)",
  "function symbol() view returns (string)",
  "event Transfer(address indexed from, address indexed to, uint256 value)",
]);
/** ERC-8056 (scaled UI amounts): Robinhood stock tokens track splits/dividends through a multiplier (1e18-scaled). */
const erc8056Abi = parseAbi([
  "function uiMultiplier() view returns (uint256)",
  "function balanceOfUI(address) view returns (uint256)",
]);
const v3FactoryAbi = parseAbi(["function getPool(address,address,uint24) view returns (address)"]);
const v3PoolAbi = parseAbi(["function liquidity() view returns (uint128)"]);
const quoterV2Abi = parseAbi([
  "function quoteExactInput(bytes path, uint256 amountIn) returns (uint256 amountOut, uint160[] sqrtPriceX96AfterList, uint32[] initializedTicksCrossedList, uint256 gasEstimate)",
]);
const swapRouter02Abi = parseAbi([
  "function exactInput((bytes path, address recipient, uint256 amountIn, uint256 amountOutMinimum) params) payable returns (uint256 amountOut)",
  "function multicall(uint256 deadline, bytes[] data) payable returns (bytes[])",
]);
const v4QuoterAbi = parseAbi([
  "function quoteExactInputSingle(((address currency0, address currency1, uint24 fee, int24 tickSpacing, address hooks) poolKey, bool zeroForOne, uint128 exactAmount, bytes hookData) params) returns (uint256 amountOut, uint256 gasEstimate)",
]);
const permit2Abi = parseAbi([
  "function allowance(address owner, address token, address spender) view returns (uint160 amount, uint48 expiration, uint48 nonce)",
  "function approve(address token, address spender, uint160 amount, uint48 expiration)",
]);
const universalRouterAbi = parseAbi(["function execute(bytes commands, bytes[] inputs, uint256 deadline) payable"]);

// ---------------------------------------------------------------------------------------------------------------
// Clients + small helpers
// ---------------------------------------------------------------------------------------------------------------

let _client: PublicClient | undefined;
export function rhPublicClient(): PublicClient {
  if (!_client) {
    _client = createPublicClient({
      chain: robinhoodChain,
      transport: http(RH_RPC_URL, { timeout: 15_000, retryCount: 2 }),
      batch: { multicall: { wait: 10 } }, // view reads (pool lookups, balances) go through Multicall3
    }) as PublicClient;
  }
  return _client;
}

/** Agent wallet address: AGENT_ADDRESS (no key needed for reads). */
export function agentAddress(): Address {
  const a = process.env.AGENT_ADDRESS;
  if (!a || !/^0x[0-9a-fA-F]{40}$/.test(a)) throw new Error("AGENT_ADDRESS is not set");
  return getAddress(a);
}

export const explorerTx = (hash: Hex) => `${RH_EXPLORER}/tx/${hash}`;

// Caches the promise (dedupes concurrent calls); failures are evicted so they are retried.
const cache = new Map<string, { at: number; p: Promise<unknown> }>();
function cached<T>(key: string, ttlMs: number, fn: () => Promise<T>): Promise<T> {
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < ttlMs) return hit.p as Promise<T>;
  const p = fn();
  cache.set(key, { at: Date.now(), p });
  p.catch(() => { if (cache.get(key)?.p === p) cache.delete(key); });
  return p;
}

async function mapLimit<T, R>(items: T[], limit: number, fn: (t: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let i = 0;
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (i < items.length) { const k = i++; out[k] = await fn(items[k]); }
  }));
  return out;
}

const lc = (a: string) => a.toLowerCase();
const symOf = (a: Address) => (lc(a) === lc(RH.WETH) ? "WETH" : lc(a) === lc(RH.USDG) ? "USDG" : "STOCK");

// ---------------------------------------------------------------------------------------------------------------
// Robinhood registry + reference prices (public API)
// ---------------------------------------------------------------------------------------------------------------

export interface StockToken {
  symbol: string;
  name: string;
  address: Address;
  decimals: number;
  multiplier: number; // currentMultiplier: 1 token = multiplier shares
  logoUrl: string | null;
}

interface RhjAsset {
  tokenSymbol: string; tokenName: string; tokenDecimals: number; logoUrl?: string; currentMultiplier: string; status: string;
  deployments: { contractAddress: string; chainId: number }[];
}

/** All active Robinhood stock tokens deployed on Robinhood Chain (cached 10 min). */
export async function getStockTokens(): Promise<StockToken[]> {
  return cached("rhj:assets", 10 * 60_000, async () => {
    const res = await fetch("https://api.robinhood.com/rhj/assets", { headers: { "user-agent": "stockback/0.1", accept: "application/json" } });
    if (!res.ok) throw new Error(`Robinhood asset registry HTTP ${res.status}`);
    const j = (await res.json()) as { assets: RhjAsset[] };
    const out: StockToken[] = [];
    for (const a of j.assets) {
      if (a.status !== "ASSET_STATUS_ACTIVE") continue;
      const dep = a.deployments.find((d) => d.chainId === 4663);
      if (!dep) continue;
      out.push({
        symbol: a.tokenSymbol,
        name: a.tokenName.replace(/\s*•\s*Robinhood Token$/, ""),
        address: getAddress(dep.contractAddress),
        decimals: a.tokenDecimals,
        multiplier: Number(a.currentMultiplier || 1),
        logoUrl: a.logoUrl ?? null,
      });
    }
    return out;
  });
}

/** Look up a stock token by ticker ("NVDA") or contract address. */
export async function findStockToken(symbolOrAddress: string): Promise<StockToken | null> {
  const s = symbolOrAddress.trim().toLowerCase();
  const all = await getStockTokens();
  return all.find((t) => t.symbol.toLowerCase() === s || lc(t.address) === s) ?? null;
}

export interface ReferencePrice { bid: number; ask: number; mid: number; isTradingHalt: boolean; generatedAt: string }

/** Robinhood's quote for ONE TOKEN (tokenBid/tokenAsk already include the ERC-8056 multiplier). Cached 30 s. */
export async function getReferencePrice(symbol: string): Promise<ReferencePrice | null> {
  const once = () => cached(`rhj:price:${symbol}`, 30_000, async () => {
    const res = await fetch(`https://api.robinhood.com/rhj/prices/${encodeURIComponent(symbol)}`, { headers: { "user-agent": "stockback/0.1", accept: "application/json" } });
    if (!res.ok) throw new Error(`rhj/prices HTTP ${res.status}`);
    const j = (await res.json()) as { quotes?: { tokenBid?: string; tokenAsk?: string; bid?: string; ask?: string; isTradingHalt?: boolean; generatedAt?: string }[] };
    const q = j.quotes?.[0];
    if (!q) throw new Error("no quote");
    const bid = Number(q.tokenBid ?? q.bid), ask = Number(q.tokenAsk ?? q.ask);
    if (!(bid > 0 && ask > 0)) throw new Error("bad quote");
    return { bid, ask, mid: (bid + ask) / 2, isTradingHalt: !!q.isTradingHalt, generatedAt: q.generatedAt ?? "" };
  });
  try {
    return await once();
  } catch {
    await new Promise((r) => setTimeout(r, 400));
    return once().catch(() => null);
  }
}

// ---------------------------------------------------------------------------------------------------------------
// Pricing primitives
// ---------------------------------------------------------------------------------------------------------------

function v3Path(tokens: Address[], fees: number[]): Hex {
  const types: ("address" | "uint24")[] = [];
  const values: (Address | number)[] = [];
  tokens.forEach((t, i) => {
    types.push("address"); values.push(t);
    if (i < fees.length) { types.push("uint24"); values.push(fees[i]); }
  });
  return encodePacked(types, values);
}

async function quoteV3Path(path: Hex, amountIn: bigint): Promise<{ amountOut: bigint; gasEstimate: bigint } | null> {
  try {
    const { result } = await rhPublicClient().simulateContract({
      address: RH.v3QuoterV2, abi: quoterV2Abi, functionName: "quoteExactInput", args: [path, amountIn],
    });
    return result[0] > 0n ? { amountOut: result[0], gasEstimate: result[3] } : null;
  } catch {
    return null;
  }
}

/** ETH price in USDG from the deepest WETH/USDG v3 pool (0.01%). Cached 60 s. */
export async function getEthUsd(): Promise<number> {
  return cached("eth:usd", 60_000, async () => {
    const one = parseUnits("0.01", 18);
    const q = (await quoteV3Path(v3Path([RH.WETH, RH.USDG], [100]), one)) ?? (await quoteV3Path(v3Path([RH.WETH, RH.USDG], [500]), one));
    if (!q) throw new Error("Could not price ETH on Robinhood Chain");
    return Number(formatUnits(q.amountOut, USDG_DECIMALS)) / 0.01;
  });
}

/** Existing v3 pools (with liquidity) between `base` and `token`. Cached 10 min. */
async function v3Fees(base: Address, token: Address): Promise<number[]> {
  return cached(`v3pools:${lc(base)}:${lc(token)}`, 10 * 60_000, async () => {
    const c = rhPublicClient();
    const res = await Promise.all(V3_FEES.map(async (fee) => {
      try {
        const pool = await c.readContract({ address: RH.v3Factory, abi: v3FactoryAbi, functionName: "getPool", args: [base, token, fee] });
        if (pool === zeroAddress) return null;
        const liq = await c.readContract({ address: pool, abi: v3PoolAbi, functionName: "liquidity" });
        return liq > 0n ? fee : null;
      } catch {
        return null;
      }
    }));
    return res.filter((f): f is (typeof V3_FEES)[number] => f !== null);
  });
}

// ---------------------------------------------------------------------------------------------------------------
// Quotes
// ---------------------------------------------------------------------------------------------------------------

export type InputAsset = "ETH" | "USDG";

export type BuyRoute =
  | { kind: "v3"; router: Address; path: Hex; tokens: Address[]; fees: number[] }
  | {
      kind: "v4";
      router: Address;
      poolKey: { currency0: Address; currency1: Address; fee: number; tickSpacing: number; hooks: Address };
      zeroForOne: boolean;
    };

export interface BuyQuote {
  tokenAddress: Address;
  symbol: string;
  inputAsset: InputAsset;
  /** ERC-20 actually pulled by the router (WETH for ETH input: the router wraps msg.value). */
  inputToken: Address;
  inputDecimals: number;
  amountIn: bigint; // raw units of the input asset (wei for ETH, 6-dp for USDG)
  amountInUsd: number;
  expectedOut: bigint; // raw stock-token units (18 dp)
  expectedOutShares: number; // expectedOut * uiMultiplier (what Robinhood's UI shows as shares)
  route: string; // human readable, e.g. "ETH → USDG → NVDA · Uniswap v3 0.01% / 0.05%"
  protocol: "v3" | "v4";
  exec: BuyRoute;
  impliedPriceUsd: number; // USD paid per whole token at the quote
  referencePriceUsd: number | null; // Robinhood API mid per token
  priceDeviationPct: number | null; // (implied / reference - 1) * 100: fees + price impact + pool premium
  ethUsd: number;
  quotedAt: number; // ms epoch
}

export interface QuoteOptions {
  /** "auto" (default): USDG if the agent wallet holds enough USDG for this buy, otherwise ETH. */
  inputAsset?: InputAsset | "auto";
  /** Reject routes whose implied price is more than this % above Robinhood's reference (default 5). */
  maxDeviationPct?: number;
  /** Restrict to one protocol (testing / debugging). */
  protocol?: "v3" | "v4";
}

const feeLabel = (fee: number) => `${(fee / 10_000).toString()}%`;

async function tokenMeta(tokenAddress: Address): Promise<{ symbol: string; multiplier: number }> {
  const reg = await findStockToken(tokenAddress).catch(() => null);
  if (reg) return { symbol: reg.symbol, multiplier: reg.multiplier };
  return cached(`meta:${lc(tokenAddress)}`, 3600_000, async () => {
    const c = rhPublicClient();
    const [symbol, mult] = await Promise.all([
      c.readContract({ address: tokenAddress, abi: erc20Abi, functionName: "symbol" }).catch(() => "TOKEN"),
      c.readContract({ address: tokenAddress, abi: erc8056Abi, functionName: "uiMultiplier" }).catch(() => 10n ** 18n),
    ]);
    return { symbol: String(symbol).replace(/^rh/, ""), multiplier: Number(formatUnits(mult, 18)) };
  });
}

/** Best route for spending ~usdAmount of the wallet's input asset on `tokenAddress`. null when no liquid route. */
export async function quoteBuy(
  { tokenAddress, usdAmount }: { tokenAddress: `0x${string}`; usdAmount: number },
  opts: QuoteOptions = {},
): Promise<BuyQuote | null> {
  if (!(usdAmount > 0)) throw new Error("usdAmount must be > 0");
  const token = getAddress(tokenAddress);
  const [meta, ethUsd] = await Promise.all([tokenMeta(token), getEthUsd()]);
  const ref = await getReferencePrice(meta.symbol);

  let inputAsset: InputAsset = opts.inputAsset === "ETH" || opts.inputAsset === "USDG" ? opts.inputAsset : "ETH";
  if (!opts.inputAsset || opts.inputAsset === "auto") {
    const usdgBal = await rhPublicClient()
      .readContract({ address: RH.USDG, abi: erc20Abi, functionName: "balanceOf", args: [agentAddress()] })
      .catch(() => 0n);
    inputAsset = usdgBal >= parseUnits(usdAmount.toFixed(USDG_DECIMALS), USDG_DECIMALS) ? "USDG" : "ETH";
  }

  type Cand = { amountOut: bigint; exec: BuyRoute; route: string };
  const cands: Cand[] = [];
  let amountIn: bigint;

  if (inputAsset === "ETH") {
    amountIn = parseUnits((usdAmount / ethUsd).toFixed(18), 18);
    const [wethUsdgFees, usdgTokFees, wethTokFees] = await Promise.all([
      v3Fees(RH.WETH, RH.USDG), v3Fees(RH.USDG, token), v3Fees(RH.WETH, token),
    ]);
    const hop1 = wethUsdgFees.includes(100) ? [100] : wethUsdgFees.slice(0, 2);
    const paths: { tokens: Address[]; fees: number[] }[] = [
      ...hop1.flatMap((f1) => usdgTokFees.map((f2) => ({ tokens: [RH.WETH, RH.USDG, token] as Address[], fees: [f1, f2] }))),
      ...wethTokFees.map((f) => ({ tokens: [RH.WETH, token] as Address[], fees: [f] })),
    ];
    await mapLimit(paths, 4, async (p) => {
      const path = v3Path(p.tokens, p.fees);
      const q = await quoteV3Path(path, amountIn);
      if (!q) return;
      const names = ["ETH", ...p.tokens.slice(1, -1).map(symOf), meta.symbol];
      cands.push({
        amountOut: q.amountOut,
        exec: { kind: "v3", router: RH.v3SwapRouter02, path, tokens: p.tokens, fees: p.fees },
        route: `${names.join(" → ")} · Uniswap v3 ${p.fees.map(feeLabel).join(" / ")}`,
      });
    });
  } else {
    amountIn = parseUnits(usdAmount.toFixed(USDG_DECIMALS), USDG_DECIMALS);
    const usdgTokFees = await v3Fees(RH.USDG, token);
    const [c0, c1] = lc(RH.USDG) < lc(token) ? [RH.USDG as Address, token] : [token, RH.USDG as Address];
    const zeroForOne = lc(c0) === lc(RH.USDG);
    await Promise.all([
      ...usdgTokFees.map(async (fee) => {
        const path = v3Path([RH.USDG, token], [fee]);
        const q = await quoteV3Path(path, amountIn);
        if (q) cands.push({ amountOut: q.amountOut, exec: { kind: "v3", router: RH.v3SwapRouter02, path, tokens: [RH.USDG, token], fees: [fee] }, route: `USDG → ${meta.symbol} · Uniswap v3 ${feeLabel(fee)}` });
      }),
      ...V4_TIERS.map(async ([fee, tickSpacing]) => {
        const poolKey = { currency0: c0, currency1: c1, fee, tickSpacing, hooks: zeroAddress as Address };
        try {
          const { result } = await rhPublicClient().simulateContract({
            address: RH.v4Quoter, abi: v4QuoterAbi, functionName: "quoteExactInputSingle",
            args: [{ poolKey, zeroForOne, exactAmount: amountIn, hookData: "0x" }],
          });
          if (result[0] > 0n) cands.push({ amountOut: result[0], exec: { kind: "v4", router: RH.universalRouter, poolKey, zeroForOne }, route: `USDG → ${meta.symbol} · Uniswap v4 ${feeLabel(fee)}` });
        } catch { /* no pool at this tier */ }
      }),
    ]);
  }

  if (opts.protocol) cands.splice(0, cands.length, ...cands.filter((c) => c.exec.kind === opts.protocol));
  if (!cands.length) return null;
  // Prefer v3 on ties: no Permit2 round trips.
  cands.sort((a, b) => (b.amountOut === a.amountOut ? (a.exec.kind === "v3" ? -1 : 1) : b.amountOut > a.amountOut ? 1 : -1));
  const best = cands[0];

  const amountInUsd = inputAsset === "ETH" ? Number(formatUnits(amountIn, 18)) * ethUsd : Number(formatUnits(amountIn, USDG_DECIMALS));
  const outTokens = Number(formatUnits(best.amountOut, 18));
  const impliedPriceUsd = amountInUsd / outTokens;
  const priceDeviationPct = ref ? (impliedPriceUsd / ref.mid - 1) * 100 : null;
  const maxDev = opts.maxDeviationPct ?? 5;
  if (priceDeviationPct !== null && priceDeviationPct > maxDev) return null;
  if (priceDeviationPct === null) {
    // No reference price: guard against thin pools by comparing with a 1/20-size quote on the same route.
    const small = await requote({ exec: best.exec, amountIn: amountIn / 20n });
    if (small && small > 0n) {
      const impact = (Number(small) * 20 / Number(best.amountOut) - 1) * 100;
      if (impact > maxDev) return null;
    }
  }

  return {
    tokenAddress: token,
    symbol: meta.symbol,
    inputAsset,
    inputToken: inputAsset === "ETH" ? RH.WETH : RH.USDG,
    inputDecimals: inputAsset === "ETH" ? 18 : USDG_DECIMALS,
    amountIn,
    amountInUsd,
    expectedOut: best.amountOut,
    expectedOutShares: outTokens * meta.multiplier,
    route: best.route,
    protocol: best.exec.kind,
    exec: best.exec,
    impliedPriceUsd,
    referencePriceUsd: ref?.mid ?? null,
    priceDeviationPct,
    ethUsd,
    quotedAt: Date.now(),
  };
}

/** Re-runs the quoter for exactly this quote's route and size (used right before sending). */
export async function requote(quote: Pick<BuyQuote, "exec" | "amountIn">): Promise<bigint | null> {
  if (quote.exec.kind === "v3") return (await quoteV3Path(quote.exec.path, quote.amountIn))?.amountOut ?? null;
  try {
    const { result } = await rhPublicClient().simulateContract({
      address: RH.v4Quoter, abi: v4QuoterAbi, functionName: "quoteExactInputSingle",
      args: [{ poolKey: quote.exec.poolKey, zeroForOne: quote.exec.zeroForOne, exactAmount: quote.amountIn, hookData: "0x" }],
    });
    return result[0];
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------------------------------------------
// Transaction building
// ---------------------------------------------------------------------------------------------------------------

export interface TxRequest { label: string; to: Address; data: Hex; value: bigint }

export const minOutFor = (expectedOut: bigint, slippageBps: number) => (expectedOut * BigInt(10_000 - Math.round(slippageBps))) / 10_000n;

/**
 * Robinhood Chain's UniversalRouter is a fork whose v4 ExactInputSingleParams has an extra `uint256 minHopPriceX36`
 * between amountOutMinimum and hookData (0 = no floor). Stock Uniswap SDK calldata is one word short and reverts.
 */
function encodeV4Swap(route: Extract<BuyRoute, { kind: "v4" }>, tokenIn: Address, tokenOut: Address, amountIn: bigint, minOut: bigint, deadline: bigint): Hex {
  const k = route.poolKey;
  const swap = encodeAbiParameters(
    [{ type: "tuple", components: [
      { type: "tuple", components: [{ type: "address" }, { type: "address" }, { type: "uint24" }, { type: "int24" }, { type: "address" }] },
      { type: "bool" }, { type: "uint128" }, { type: "uint128" }, { type: "uint256" }, { type: "bytes" },
    ] }],
    [[[k.currency0, k.currency1, k.fee, k.tickSpacing, k.hooks], route.zeroForOne, amountIn, minOut, 0n, "0x"]],
  );
  const settleAll = encodeAbiParameters([{ type: "address" }, { type: "uint256" }], [tokenIn, amountIn]);
  const takeAll = encodeAbiParameters([{ type: "address" }, { type: "uint256" }], [tokenOut, minOut]);
  // Actions: SWAP_EXACT_IN_SINGLE (0x06), SETTLE_ALL (0x0c), TAKE_ALL (0x0f). Command: V4_SWAP (0x10).
  const input = encodeAbiParameters([{ type: "bytes" }, { type: "bytes[]" }], ["0x060c0f", [swap, settleAll, takeAll]]);
  return encodeFunctionData({ abi: universalRouterAbi, functionName: "execute", args: ["0x10", [input], deadline] });
}

/** The swap transaction for a quote (no approvals). */
export function buildSwapTx(quote: BuyQuote, { slippageBps, recipient, deadlineSec = 600 }: { slippageBps: number; recipient: Address; deadlineSec?: number }): TxRequest {
  const minOut = minOutFor(quote.expectedOut, slippageBps);
  const deadline = BigInt(Math.floor(Date.now() / 1000) + deadlineSec);
  if (quote.exec.kind === "v3") {
    const swap = encodeFunctionData({
      abi: swapRouter02Abi, functionName: "exactInput",
      args: [{ path: quote.exec.path, recipient, amountIn: quote.amountIn, amountOutMinimum: minOut }],
    });
    return {
      label: `Swap ${quote.route}`,
      to: RH.v3SwapRouter02,
      data: encodeFunctionData({ abi: swapRouter02Abi, functionName: "multicall", args: [deadline, [swap]] }),
      value: quote.inputAsset === "ETH" ? quote.amountIn : 0n,
    };
  }
  return {
    label: `Swap ${quote.route}`,
    to: RH.universalRouter,
    data: encodeV4Swap(quote.exec, quote.inputToken, quote.tokenAddress, quote.amountIn, minOut, deadline),
    value: 0n,
  };
}

const MAX_UINT48 = 2n ** 48n - 1n;

/** Approvals still missing for this quote (empty for ETH-input routes). Always max approvals, so each is one-time. */
export async function buildApprovalTxs(quote: BuyQuote, owner: Address): Promise<TxRequest[]> {
  if (quote.inputAsset === "ETH") return [];
  const c = rhPublicClient();
  const txs: TxRequest[] = [];
  if (quote.exec.kind === "v3") {
    const a = await c.readContract({ address: RH.USDG, abi: erc20Abi, functionName: "allowance", args: [owner, RH.v3SwapRouter02] });
    if (a < quote.amountIn) {
      txs.push({ label: "Approve USDG for Uniswap SwapRouter02 (one-time)", to: RH.USDG, value: 0n, data: encodeFunctionData({ abi: erc20Abi, functionName: "approve", args: [RH.v3SwapRouter02, maxUint256] }) });
    }
    return txs;
  }
  const a = await c.readContract({ address: RH.USDG, abi: erc20Abi, functionName: "allowance", args: [owner, RH.permit2] });
  if (a < quote.amountIn) {
    txs.push({ label: "Approve USDG for Permit2 (one-time)", to: RH.USDG, value: 0n, data: encodeFunctionData({ abi: erc20Abi, functionName: "approve", args: [RH.permit2, maxUint256] }) });
  }
  const [amt, exp] = await c.readContract({ address: RH.permit2, abi: permit2Abi, functionName: "allowance", args: [owner, RH.USDG, RH.universalRouter] });
  if (amt < quote.amountIn || Number(exp) <= Math.floor(Date.now() / 1000) + 60) {
    txs.push({ label: "Permit2: allow UniversalRouter to spend USDG (one-time)", to: RH.permit2, value: 0n, data: encodeFunctionData({ abi: permit2Abi, functionName: "approve", args: [RH.USDG, RH.universalRouter, maxUint160, Number(MAX_UINT48)] }) });
  }
  return txs;
}

// ---------------------------------------------------------------------------------------------------------------
// Read-only simulation (eth_simulateV1 with state overrides) + gas
// ---------------------------------------------------------------------------------------------------------------

export interface SimulationResult {
  ok: boolean;
  amountOut: bigint | null; // stock tokens received by `from` in the simulated swap
  gasUsed: bigint[]; // per simulated call (funding swap first for USDG routes)
  error?: string;
}

/**
 * Simulates the full buy (approvals + swap) from `from` against live state without sending anything. The account's
 * ETH balance is overridden; for USDG routes, the simulation first swaps ETH→USDG so real USDG storage is used.
 */
export async function simulateBuy(quote: BuyQuote, { slippageBps = 100, from = agentAddress() }: { slippageBps?: number; from?: Address } = {}): Promise<SimulationResult> {
  const c = rhPublicClient();
  const calls: { to: Address; data: Hex; value: bigint }[] = [];
  if (quote.inputAsset === "USDG") {
    // Fund: buy ~1.2x amountIn of USDG with ETH via the 0.01% pool, into `from`.
    const ethIn = parseUnits(((Number(formatUnits(quote.amountIn, USDG_DECIMALS)) * 1.2) / quote.ethUsd).toFixed(18), 18);
    const fund = encodeFunctionData({ abi: swapRouter02Abi, functionName: "exactInput", args: [{ path: v3Path([RH.WETH, RH.USDG], [100]), recipient: from, amountIn: ethIn, amountOutMinimum: 0n }] });
    calls.push({ to: RH.v3SwapRouter02, data: fund, value: ethIn });
    // Approvals exactly as executeBuy would send them for a fresh wallet.
    if (quote.exec.kind === "v3") {
      calls.push({ to: RH.USDG, value: 0n, data: encodeFunctionData({ abi: erc20Abi, functionName: "approve", args: [RH.v3SwapRouter02, maxUint256] }) });
    } else {
      calls.push({ to: RH.USDG, value: 0n, data: encodeFunctionData({ abi: erc20Abi, functionName: "approve", args: [RH.permit2, maxUint256] }) });
      calls.push({ to: RH.permit2, value: 0n, data: encodeFunctionData({ abi: permit2Abi, functionName: "approve", args: [RH.USDG, RH.universalRouter, maxUint160, Number(MAX_UINT48)] }) });
    }
  }
  const swap = buildSwapTx(quote, { slippageBps, recipient: from });
  calls.push({ to: swap.to, data: swap.data, value: swap.value });
  try {
    const { results } = await c.simulateCalls({
      account: from,
      calls,
      stateOverrides: [{ address: from, balance: parseUnits("1", 18) }],
    });
    const last = results[results.length - 1];
    const failed = results.find((r) => r.status !== "success");
    let amountOut: bigint | null = null;
    for (const log of last.logs ?? []) {
      if (lc(log.address) !== lc(quote.tokenAddress)) continue;
      try {
        const ev = decodeEventLog({ abi: erc20Abi, data: log.data, topics: log.topics });
        if (ev.eventName === "Transfer" && lc(ev.args.to) === lc(from)) amountOut = (amountOut ?? 0n) + ev.args.value;
      } catch { /* not a Transfer */ }
    }
    return {
      ok: !failed,
      amountOut,
      gasUsed: results.map((r) => r.gasUsed),
      error: failed ? (failed.error?.message ?? "reverted").slice(0, 300) : undefined,
    };
  } catch (e) {
    return { ok: false, amountOut: null, gasUsed: [], error: (e instanceof Error ? e.message : String(e)).slice(0, 300) };
  }
}

export interface GasEstimate { gas: bigint; gasPriceWei: bigint; costWei: bigint; costUsd: number }

/** eth_estimateGas for this quote's swap tx from `from` with an ETH balance override (includes Arbitrum L1 data gas). */
export async function estimateSwapGas(quote: BuyQuote, { from = agentAddress(), slippageBps = 100 }: { from?: Address; slippageBps?: number } = {}): Promise<GasEstimate> {
  const c = rhPublicClient();
  const tx = buildSwapTx(quote, { slippageBps, recipient: from });
  const [gas, gasPriceWei] = await Promise.all([
    c.estimateGas({ account: from, to: tx.to, data: tx.data, value: tx.value, stateOverride: [{ address: from, balance: parseUnits("1", 18) }] }),
    c.getGasPrice(),
  ]);
  const costWei = gas * gasPriceWei;
  return { gas, gasPriceWei, costWei, costUsd: Number(formatUnits(costWei, 18)) * quote.ethUsd };
}

// ---------------------------------------------------------------------------------------------------------------
// Wallet state
// ---------------------------------------------------------------------------------------------------------------

export interface WalletState {
  address: Address;
  eth: bigint;
  usdg: bigint;
  ethFormatted: string;
  usdgFormatted: string;
  ethUsd: number;
  totalUsd: number;
}

export async function getWalletState(address: Address = agentAddress()): Promise<WalletState> {
  const c = rhPublicClient();
  const [eth, usdg, ethUsd] = await Promise.all([
    c.getBalance({ address }),
    c.readContract({ address: RH.USDG, abi: erc20Abi, functionName: "balanceOf", args: [address] }),
    getEthUsd().catch(() => 0),
  ]);
  const ethFormatted = formatUnits(eth, 18), usdgFormatted = formatUnits(usdg, USDG_DECIMALS);
  return { address, eth, usdg, ethFormatted, usdgFormatted, ethUsd, totalUsd: Number(ethFormatted) * ethUsd + Number(usdgFormatted) };
}

export interface StockBalance { token: Address; symbol: string; raw: bigint; ui: bigint; uiMultiplier: bigint; shares: number; valueUsd: number | null }

/** Stock-token balance via ERC-8056 balanceOfUI (falls back to balanceOf * uiMultiplier). */
export async function getStockBalance(tokenAddress: Address, owner: Address = agentAddress()): Promise<StockBalance> {
  const c = rhPublicClient();
  const token = getAddress(tokenAddress);
  const [raw, mult, meta] = await Promise.all([
    c.readContract({ address: token, abi: erc20Abi, functionName: "balanceOf", args: [owner] }),
    c.readContract({ address: token, abi: erc8056Abi, functionName: "uiMultiplier" }).catch(() => 10n ** 18n),
    tokenMeta(token),
  ]);
  const ui = await c.readContract({ address: token, abi: erc8056Abi, functionName: "balanceOfUI", args: [owner] }).catch(() => (raw * mult) / 10n ** 18n);
  const ref = await getReferencePrice(meta.symbol);
  const rawNum = Number(formatUnits(raw, 18));
  return { token, symbol: meta.symbol, raw, ui, uiMultiplier: mult, shares: Number(formatUnits(ui, 18)), valueUsd: ref ? rawNum * ref.mid : null };
}

// ---------------------------------------------------------------------------------------------------------------
// Execution (through the AgentKit wallet provider)
// ---------------------------------------------------------------------------------------------------------------

/** Minimal signer surface; AgentKit's ViemWalletProvider satisfies it. */
export interface BuySigner {
  getAddress(): string;
  sendTransaction(tx: { to: Address; data: Hex; value?: bigint }): Promise<Hex>;
  waitForTransactionReceipt(hash: Hex): Promise<unknown>;
}

export interface ExecuteBuyResult {
  txHash: `0x${string}`;
  amountOut?: bigint;
  approvalTxHashes: Hex[];
  explorerUrl: string;
  gasUsed?: bigint;
  minOut: bigint;
}

export class BuyError extends Error {
  constructor(message: string, public readonly txHash?: Hex, public readonly approvalTxHashes: Hex[] = []) {
    super(message);
    this.name = "BuyError";
  }
}

export interface ExecuteBuyOptions {
  quote: BuyQuote;
  slippageBps: number;
  /** Same key => same result (in-process). Use e.g. `${receiptId}:${symbol}` so a retried request never double-buys. */
  idempotencyKey?: string;
  /** Refuse to send when the estimated swap gas exceeds this (USD). Default 0.05. */
  maxGasUsd?: number;
  /** Defaults to the AgentKit wallet provider from ./agentkit. */
  signer?: BuySigner;
}

const inflight = new Map<string, Promise<unknown>>();
let queue: Promise<unknown> = Promise.resolve();

/** Serialize all sends (one nonce stream) and dedupe by idempotency key. A failure after a tx was sent stays cached. */
function runExclusive<T>(key: string | undefined, fn: () => Promise<T>): Promise<T> {
  if (key && inflight.has(key)) return inflight.get(key) as Promise<T>;
  const run = queue.then(fn);
  queue = run.catch(() => undefined);
  if (key) {
    inflight.set(key, run);
    run.catch((e) => { if (!(e instanceof BuyError && e.txHash)) inflight.delete(key); });
  }
  return run;
}

async function defaultSigner(): Promise<BuySigner> {
  return (await import("./agentkit")).getAgentWalletProvider();
}

/** Sends via the signer (AgentKit), waits, and returns the typed receipt; throws BuyError carrying the hash. */
async function sendAndConfirm(s: BuySigner, tx: { to: Address; data: Hex; value: bigint }, label: string, sent: Hex[]) {
  const hash = await s.sendTransaction({ to: tx.to, data: tx.data, value: tx.value });
  try {
    await s.waitForTransactionReceipt(hash);
  } catch (e) {
    throw new BuyError(`${label}: sent but not confirmed yet (${(e as Error).message?.slice(0, 120)})`, hash, sent);
  }
  const receipt = await rhPublicClient().getTransactionReceipt({ hash });
  if (receipt.status !== "success") throw new BuyError(`${label} reverted`, hash, sent);
  return { hash, receipt };
}

function received(logs: readonly { address: Address; data: Hex; topics: readonly Hex[] }[], token: Address, owner: Address): bigint | undefined {
  let out: bigint | undefined;
  for (const log of logs) {
    if (lc(log.address) !== lc(token)) continue;
    try {
      const ev = decodeEventLog({ abi: erc20Abi, data: log.data, topics: log.topics as [Hex, ...Hex[]] });
      if (ev.eventName === "Transfer" && lc(ev.args.to) === lc(owner)) out = (out ?? 0n) + ev.args.value;
    } catch { /* not a Transfer */ }
  }
  return out;
}

async function checkFresh(quote: BuyQuote, slippageBps: number): Promise<bigint> {
  if (!(slippageBps >= 0 && slippageBps <= 2000)) throw new BuyError("slippageBps must be between 0 and 2000");
  if (Date.now() - quote.quotedAt > 5 * 60_000) throw new BuyError(`${quote.symbol}: quote is older than 5 minutes; re-quote.`);
  const minOut = minOutFor(quote.expectedOut, slippageBps);
  const fresh = await requote(quote);
  if (fresh === null || fresh < minOut) throw new BuyError(`${quote.symbol}: price moved beyond ${slippageBps} bps (fresh ${fresh ?? "none"} < minOut ${minOut}); re-quote.`);
  return minOut;
}

async function checkGas(owner: Address, tx: TxRequest, ethUsd: number, maxGasUsd: number, sent: Hex[]) {
  const c = rhPublicClient();
  const [gas, gasPrice] = await Promise.all([
    c.estimateGas({ account: owner, to: tx.to, data: tx.data, value: tx.value }).catch((e: unknown) => {
      throw new BuyError(`Swap would revert: ${(e instanceof Error ? e.message : String(e)).slice(0, 240)}`, undefined, sent);
    }),
    c.getGasPrice(),
  ]);
  const gasUsd = Number(formatUnits(gas * gasPrice, 18)) * ethUsd;
  if (gasUsd > maxGasUsd) throw new BuyError(`Gas too expensive right now ($${gasUsd.toFixed(4)} > $${maxGasUsd}).`, undefined, sent);
}

/** ETH the wallet must keep for gas: 2x a two-hop swap (+ approvals) at the current gas price. */
async function gasReserveWei(extraTxs: number): Promise<bigint> {
  const gasPrice = await rhPublicClient().getGasPrice();
  return gasPrice * 2n * (400_000n + 80_000n * BigInt(extraTxs));
}

/**
 * Sends approvals (only if missing; always max so they happen once) and the swap from the agent wallet, via AgentKit.
 * Executions are serialized in-process (single nonce stream). Throws BuyError (with txHash when one was sent).
 */
export function executeBuy(opts: ExecuteBuyOptions): Promise<ExecuteBuyResult> {
  return runExclusive(opts.idempotencyKey, () => executeBuyInner(opts));
}

async function executeBuyInner({ quote, slippageBps, maxGasUsd = 0.05, signer }: ExecuteBuyOptions): Promise<ExecuteBuyResult> {
  const minOut = await checkFresh(quote, slippageBps);
  const s = signer ?? (await defaultSigner());
  const owner = getAddress(s.getAddress());
  const c = rhPublicClient();

  // Funds.
  const approvals = await buildApprovalTxs(quote, owner);
  const [ethBal, inBal, reserve] = await Promise.all([
    c.getBalance({ address: owner }),
    quote.inputAsset === "USDG" ? c.readContract({ address: RH.USDG, abi: erc20Abi, functionName: "balanceOf", args: [owner] }) : Promise.resolve(0n),
    gasReserveWei(approvals.length),
  ]);
  if (quote.inputAsset === "ETH" && ethBal < quote.amountIn + reserve) {
    throw new BuyError(`Insufficient ETH: have ${formatUnits(ethBal, 18)}, need ${formatUnits(quote.amountIn + reserve, 18)} (swap + gas reserve).`);
  }
  if (quote.inputAsset === "USDG") {
    if (inBal < quote.amountIn) throw new BuyError(`Insufficient USDG: have ${formatUnits(inBal, 6)}, need ${formatUnits(quote.amountIn, 6)}.`);
    if (ethBal < reserve) throw new BuyError(`Insufficient ETH for gas: have ${formatUnits(ethBal, 18)}.`);
  }

  // Approvals (re-read on-chain every time; max amounts, so they only ever happen once per wallet).
  const approvalTxHashes: Hex[] = [];
  for (const a of approvals) approvalTxHashes.push((await sendAndConfirm(s, a, a.label, approvalTxHashes)).hash);

  // Swap (AgentKit re-estimates gas and applies its 1.3x limit multiplier when sending).
  const swapTx = buildSwapTx(quote, { slippageBps, recipient: owner });
  await checkGas(owner, swapTx, quote.ethUsd, maxGasUsd, approvalTxHashes);
  const { hash, receipt } = await sendAndConfirm(s, swapTx, `Swap ${quote.symbol}`, approvalTxHashes);
  return { txHash: hash, amountOut: received(receipt.logs, quote.tokenAddress, owner), approvalTxHashes, explorerUrl: explorerTx(hash), gasUsed: receipt.gasUsed, minOut };
}

// --- Basket: several ETH-input buys in ONE transaction (SwapRouter02 multicall; ~20% less gas than separate txs) ---

export interface ExecuteBasketResult {
  txHash: `0x${string}`;
  explorerUrl: string;
  gasUsed: bigint;
  legs: { symbol: string; tokenAddress: Address; amountOut?: bigint; minOut: bigint }[];
}

const isEthV3 = (q: BuyQuote) => q.inputAsset === "ETH" && q.exec.kind === "v3";

/** One multicall tx for several ETH-input v3 quotes (msg.value = sum; the router wraps per leg). */
export function buildBasketTx(quotes: BuyQuote[], { slippageBps, recipient, deadlineSec = 600 }: { slippageBps: number; recipient: Address; deadlineSec?: number }): TxRequest {
  if (!quotes.length || !quotes.every(isEthV3)) throw new BuyError("Basket needs ETH-input Uniswap v3 quotes (use executeBuy otherwise).");
  const calls = quotes.map((q) => encodeFunctionData({
    abi: swapRouter02Abi, functionName: "exactInput",
    args: [{ path: (q.exec as Extract<BuyRoute, { kind: "v3" }>).path, recipient, amountIn: q.amountIn, amountOutMinimum: minOutFor(q.expectedOut, slippageBps) }],
  }));
  return {
    label: `Basket: ${quotes.map((q) => q.symbol).join(" + ")}`,
    to: RH.v3SwapRouter02,
    data: encodeFunctionData({ abi: swapRouter02Abi, functionName: "multicall", args: [BigInt(Math.floor(Date.now() / 1000) + deadlineSec), calls] }),
    value: quotes.reduce((a, q) => a + q.amountIn, 0n),
  };
}

/** Buys several stock tokens in one transaction (all-or-nothing). Same idempotency/serialization as executeBuy. */
export function executeBasket(opts: { quotes: BuyQuote[]; slippageBps: number; idempotencyKey?: string; maxGasUsd?: number; signer?: BuySigner }): Promise<ExecuteBasketResult> {
  return runExclusive(opts.idempotencyKey, async () => {
    const { quotes, slippageBps } = opts;
    const minOuts = await Promise.all(quotes.map((q) => checkFresh(q, slippageBps)));
    const s = opts.signer ?? (await defaultSigner());
    const owner = getAddress(s.getAddress());
    const tx = buildBasketTx(quotes, { slippageBps, recipient: owner });
    const [ethBal, reserve] = await Promise.all([rhPublicClient().getBalance({ address: owner }), gasReserveWei(quotes.length)]);
    if (ethBal < tx.value + reserve) throw new BuyError(`Insufficient ETH: have ${formatUnits(ethBal, 18)}, need ${formatUnits(tx.value + reserve, 18)} (basket + gas reserve).`);
    await checkGas(owner, tx, quotes[0].ethUsd, opts.maxGasUsd ?? 0.03 + 0.025 * quotes.length, []);
    const { hash, receipt } = await sendAndConfirm(s, tx, tx.label, []);
    return {
      txHash: hash,
      explorerUrl: explorerTx(hash),
      gasUsed: receipt.gasUsed,
      legs: quotes.map((q, i) => ({ symbol: q.symbol, tokenAddress: q.tokenAddress, amountOut: received(receipt.logs, q.tokenAddress, owner), minOut: minOuts[i] })),
    };
  });
}

// ---------------------------------------------------------------------------------------------------------------
// JSON helpers (BuyQuote carries bigints)
// ---------------------------------------------------------------------------------------------------------------

export function serializeQuote(q: BuyQuote): string {
  return JSON.stringify(q, (_k, v) => (typeof v === "bigint" ? { $big: v.toString() } : v));
}
export function deserializeQuote(s: string): BuyQuote {
  return JSON.parse(s, (_k, v) => (v && typeof v === "object" && typeof v.$big === "string" ? BigInt(v.$big) : v)) as BuyQuote;
}

