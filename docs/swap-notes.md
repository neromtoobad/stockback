# Robinhood Chain swap notes (Stockback)

Verified read-only on 2026-09-26, a Saturday. The tools used were eth_call, the Uniswap quoters, and `eth_simulateV1`/`eth_estimateGas` with state overrides. No transaction was sent. ETH was about $2,689 on-chain. Gas price was about 0.0285 gwei, with a priority fee of 0.

## Recommended funding (~$1 budget)

**Bridge native ETH only.** Do not bridge USDG or WETH.

- Send ~0.0004 ETH (about $1.07) from **Base or Arbitrum** with Relay (relay.link, destination Robinhood Chain, native ETH). The recipient is the agent `0xFd0687766F839a976690a83781339d219E866fE2`.
- Relay quote for 0.0004 ETH: you receive 0.0003915 ETH (about $1.05), fill time about 1 s.
  - Total fee: about $0.023 (2.1%).
  - The fee is made up of relayer $0.020, relayer gas $0.003 and origin gas $0.002.

Other ~$1 routes quoted through Relay:

| From → to | Cost | Note |
|---|---|---|
| Base / Arbitrum ETH → RH ETH | **2.1–2.2%** | best |
| Base / Arbitrum USDC → RH ETH | 2.6% | |
| BSC USDT → RH ETH | 2.7% | best from BSC |
| BSC BNB → RH ETH | 5.9% | |
| Any → RH **USDG** | 6.0–6.4% | avoid |

Why ETH only:
- Every buy is **one transaction with no approvals**. The agent sends ETH as `msg.value` to SwapRouter02, which wraps it to WETH and swaps WETH → (USDG) → STOCK.
- The same ETH also pays gas.

`executeBuy` refuses to spend the last ~0.0000227 ETH (about $0.06), which it keeps as a gas reserve. Of about $1.05 that arrives, you can spend about $0.99 minus gas. That is enough for **~5 buys of $0.10–0.15** or 2–3 multi-ticker baskets. Bridging $2 instead of $1 gives much more headroom for the demo.

## Gas per swap (eth_estimateGas, including Arbitrum L1 data; the L1 part is only ~360 gas)

| Route | Gas | Cost |
|---|---|---|
| ETH → STOCK, direct WETH pool (NVDA, AAPL, GOOGL, AMD, COIN, DELL, DJT, GLD, INDA, INTC, MU, SNDK, TTWO, BULL) | ~197–204k | **≈ $0.015** |
| ETH → USDG → STOCK (two hops, most tickers) | ~307–310k | **≈ $0.024** |
| Basket: 3 tickers in one tx (`executeBasket`) | ~657k | ≈ $0.050 (~19% less than 3 separate txs) |
| USDG input, v3 (only if the wallet ever holds USDG) | ~171k, plus a one-time approve of 58k | |
| USDG input, v4 | ~186k, plus one-time approvals of 58k and 48k | |

**Minimum sensible trade:** there is no technical minimum. Quotes and simulations at $0.10 match exactly, and the tokens have 18 dp. Gas is $0.015–0.024 per transaction, so:
- Use at least **$0.10 per transaction** (gas is then 15–24% of the trade). $0.20 or more is better.
- In a basket, each leg should be at least $0.05.

## Liquid tickers

Criteria: implied price within ±5% of Robinhood's `/rhj/prices`, and at most 1% extra price impact at $1. That leaves 59 of 195 registry tokens; 97 have some route. The list is also exported as `LIQUID_TICKERS_SNAPSHOT`. Re-run it with `npx tsx scripts/probe-swap.ts --all`.

AAPL AMC AMD AMZN ASML AVGO BA BABA BB BE BULL CCL CEG COIN COST CRCL DELL DJT F FIG GLD GLXY GME GOOGL IBM INDA INTC LLY LMT LULU META MRNA MRVL MSFT MU NET NFLX NVDA ON PATH PENG PLTR POET QCOM QQQ QUBT RCAT SGOV SHOP SKHY SLV SNDK SNOW SPY TSLA TTWO UPS USO VTI

- **Receipt-friendly names:**
  - Amazon AMZN, Costco COST, Lululemon LULU, Netflix NFLX, Apple AAPL, Google GOOGL, Meta META
  - Microsoft MSFT, Ford F, UPS, Boeing BA, Carnival CCL, AMC, GameStop GME, Shopify SHOP (Shopify-store receipts)
  - Take-Two TTWO, Tesla TSLA, Nvidia NVDA, Eli Lilly LLY / Moderna MRNA (pharmacy), fuel → USO, gold → GLD
- **Not tokenized:** KO, PEP, SBUX, MCD, WMT, UBER, NKE, DIS, HD, TGT, CMG, SPOT. Map them to SPY, VTI or QQQ, or to a sector proxy.
- **Listed but no usable pool:** for example ELF, CELH, KSS, UNH, CSCO, ORCL, ZM. JNJ and PFE exist but are 18–45% over the reference price. XOM and ANET collapse at $1.

Sample prices for $0.10 (implied vs Robinhood mid):

| Ticker | Deviation |
|---|---|
| NVDA | −0.16% |
| AAPL | −0.03% |
| GOOGL | −0.2% |
| AMZN | −0.4% |
| META | +0.17% |
| MSFT | −1.2% |
| SPY | +0.6% |
| QQQ | −0.7% |
| NFLX | +0.3% |
| LULU | +0.4% |
| COST | −3.6% |
| TSLA | +4.9% (weekend pool premium) |

## API (src/lib/rh/swap.ts, src/lib/rh/agentkit.ts)

- `quoteBuy({ tokenAddress, usdAmount }, opts?)` returns `BuyQuote | null`.
  - The input is ETH unless the wallet already holds enough USDG (`opts.inputAsset` overrides this).
  - It picks the best v3 path (WETH→USDG→X or WETH→X), or the best v3/v4 pool for USDG input.
  - It returns `null` if there is no route, or if the implied price is more than `maxDeviationPct` (default 5) above Robinhood's price. If Robinhood's price is unavailable, it checks impact against a 1/20-size quote instead.
- `executeBuy({ quote, slippageBps, idempotencyKey?, maxGasUsd? })`:
  - Re-quotes the exact route and refuses if the price moved beyond slippage. Quotes older than 5 minutes are rejected.
  - Checks balance plus the gas reserve, sends any missing max approvals (none for ETH input), and checks gas.
  - Sends through **AgentKit's ViemWalletProvider** (gas limit ×1.3) and parses `amountOut` from the Transfer logs.
  - Sends are serialized in-process. If a key has already sent a transaction, a retry returns the same result and never buys twice.
- `executeBasket({ quotes, slippageBps, idempotencyKey? })` buys N ETH-input tickers in one multicall transaction. It is all-or-nothing.
- `getWalletState()`, `getStockBalance(token)` (ERC-8056 `balanceOfUI`), `getStockTokens()`, `findStockToken(sym)`, `getReferencePrice(sym)`.
- `simulateBuy(quote)` and `estimateSwapGas(quote)` are read-only checks of the exact calldata.
- `serializeQuote` / `deserializeQuote`: quotes contain bigints.
- `getAgentKit()` provides the actions `buy_stock_token` and `stock_token_balance`. `runAgentAction(name, args)`, `getAgentWalletProvider()`.

Wiring for the `src/lib/rh/bridge.ts` stub:

```ts
const t = await findStockToken(ticker); if (!t) return null;
const q = await quoteBuy({ tokenAddress: t.address, usdAmount: usd });          // onchainQuote → { route: q.route, units: q.expectedOutShares }
const r = await executeBuy({ quote: q, slippageBps: 100, idempotencyKey: `${receiptId}:${ticker}` });
// onchainBuy → { txHash: r.txHash, route: q.route, units: Number(formatUnits(r.amountOut ?? 0n, 18)) * t.multiplier }
```

## Caveats

- **Weekend and off-hours:** pools trade 24/7, but the Robinhood reference is the last session's price, so premiums of ±5% appear (TSLA). Tickers near the 5% line can flip to `null`. Pass `maxDeviationPct` to relax the limit.
- **AgentKit:**
  - It pins its own viem (2.38.3). The top-level viem 2.56.9 stays, and the wallet client is cast at construction. This is runtime-compatible and was verified.
  - Analytics are disabled: `trackInitialization` is overridden, and the action provider implements `getActions()` itself, so the decorator that makes a per-call analytics POST is never used. A smoke test saw 0 unhandled rejections.
  - Import AgentKit only from Node-runtime route handlers. If the Next build fails on it, add `serverExternalPackages: ["@coinbase/agentkit"]` to `next.config.ts`.
- **Idempotency and nonce ordering are in-memory only.** Run a single executor instance. To survive restarts, persist `idempotencyKey` values (for example in Postgres).
- **Public RPC:** `https://rpc.mainnet.chain.robinhood.com` serves eth_call, eth_estimateGas with overrides, and eth_simulateV1. Multicall3 is at the canonical address.
- **Geofence:** according to t1000's notes, Robinhood's app excludes US, UK, CA and CH residents from stock tokens. The contracts themselves are permissionless.
- **tsx** is not a devDependency; `npx tsx` fetches it on first use.
