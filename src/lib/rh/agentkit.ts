/**
 * Coinbase AgentKit wired to the Stockback agent wallet on Robinhood Chain (4663).
 *
 * - ViemWalletProvider over a defineChain Robinhood Chain; AgentKit is the wallet that signs and sends every buy.
 * - A custom ActionProvider with `buy_stock_token` and `stock_token_balance`.
 * - AgentKit's analytics are neutralized: the provider constructor fires an un-awaited POST to cca-lite.coinbase.com
 *   (wallet address included) that becomes an unhandled rejection when it fails, and decorated actions fire another
 *   one per invocation. We override trackInitialization and implement getActions() directly (no decorator).
 *
 * Server-only. Import lazily (`await import("@/lib/rh/agentkit")`) from route handlers; consider adding
 * "@coinbase/agentkit" to next.config serverExternalPackages if bundling complains.
 */
import { ActionProvider, AgentKit, ViemWalletProvider, type Action, type Network } from "@coinbase/agentkit";
import { createWalletClient, http, type Address, type Hex } from "viem";
import { nonceManager, privateKeyToAccount } from "viem/accounts";
// AgentKit validates/serializes action schemas with zod v3; zod 4's "zod/v3" entry is the real v3 runtime.
import { z } from "zod/v3";
import {
  RH_RPC_URL,
  executeBuy,
  findStockToken,
  getStockBalance,
  getWalletState,
  quoteBuy,
  robinhoodChain,
} from "./swap";

/** ViemWalletProvider without the constructor-time analytics call. */
class QuietViemWalletProvider extends ViemWalletProvider {}
Object.defineProperty(QuietViemWalletProvider.prototype, "trackInitialization", { value: () => {}, writable: true, configurable: true });

let _provider: QuietViemWalletProvider | undefined;
let _agentKit: Promise<AgentKit> | undefined;

/** The agent wallet as an AgentKit EVM wallet provider (singleton; one nonce stream per process). */
export function getAgentWalletProvider(): ViemWalletProvider {
  if (_provider) return _provider;
  const pk = process.env.AGENT_PRIVATE_KEY;
  if (!pk || !/^(0x)?[0-9a-fA-F]{64}$/.test(pk)) throw new Error("AGENT_PRIVATE_KEY is not set");
  const account = privateKeyToAccount((pk.startsWith("0x") ? pk : `0x${pk}`) as Hex, { nonceManager });
  const expected = process.env.AGENT_ADDRESS;
  if (expected && expected.toLowerCase() !== account.address.toLowerCase()) {
    throw new Error("AGENT_PRIVATE_KEY does not match AGENT_ADDRESS");
  }
  const walletClient = createWalletClient({ account, chain: robinhoodChain, transport: http(RH_RPC_URL, { timeout: 20_000, retryCount: 2 }) });
  // AgentKit pins its own viem (2.38.x); the client is runtime-compatible, only the type declarations differ.
  _provider = new QuietViemWalletProvider(walletClient as unknown as ConstructorParameters<typeof ViemWalletProvider>[0], {
    rpcUrl: RH_RPC_URL,
    gasLimitMultiplier: 1.3, // on top of eth_estimateGas (which already includes Arbitrum L1 data gas)
    feePerGasMultiplier: 1.1,
  });
  return _provider;
}

// ---------------------------------------------------------------------------------------------------------------
// Actions
// ---------------------------------------------------------------------------------------------------------------

const buySchema = z.object({
  symbol: z.string().optional().describe("Stock ticker, e.g. NVDA. Either symbol or tokenAddress is required."),
  tokenAddress: z.string().regex(/^0x[0-9a-fA-F]{40}$/).optional().describe("Stock token contract on Robinhood Chain."),
  usdAmount: z.number().positive().max(5).describe("USD to spend (e.g. 0.05 - 0.50)."),
  slippageBps: z.number().int().min(10).max(500).default(100).describe("Max slippage in basis points (default 100 = 1%)."),
  idempotencyKey: z.string().optional().describe("Same key never buys twice (e.g. receiptId:symbol)."),
});

const balanceSchema = z.object({
  symbol: z.string().optional().describe("Stock ticker, e.g. NVDA."),
  tokenAddress: z.string().regex(/^0x[0-9a-fA-F]{40}$/).optional().describe("Stock token contract on Robinhood Chain."),
});

async function resolveToken(args: { symbol?: string; tokenAddress?: string }): Promise<{ address: Address; symbol: string }> {
  const t = await findStockToken(args.tokenAddress ?? args.symbol ?? "");
  if (t) return { address: t.address, symbol: t.symbol };
  if (args.tokenAddress) return { address: args.tokenAddress as Address, symbol: args.symbol ?? "TOKEN" };
  throw new Error(`No Robinhood stock token for ${args.symbol ?? "(missing symbol)"}`);
}

/** Action shape built against zod/v3 types (AgentKit's Action is typed against its own nested zod copy). */
type StockbackAction<S extends z.ZodTypeAny> = { name: string; description: string; schema: S; invoke: (args: z.input<S>) => Promise<string> };

const jsonSafe = (v: unknown) => JSON.stringify(v, (_k, x) => (typeof x === "bigint" ? x.toString() : x));

/** Stockback's AgentKit action provider (plain getActions(), so no per-invocation analytics). */
export class StockbackActionProvider extends ActionProvider<ViemWalletProvider> {
  constructor() {
    super("stockback", []);
  }

  supportsNetwork(network: Network): boolean {
    return network.protocolFamily === "evm" && String(network.chainId) === String(robinhoodChain.id);
  }

  getActions(walletProvider: ViemWalletProvider): Action[] {
    const buy: StockbackAction<typeof buySchema> = {
      name: "buy_stock_token",
      description:
        "Buy a small USD amount of a Robinhood stock token (e.g. NVDA) on Robinhood Chain from the agent wallet. " +
        "Quotes the best Uniswap route, then approves (if needed) and swaps. Returns tx hash and tokens received.",
      schema: buySchema,
      invoke: async (raw) => {
        const args = buySchema.parse(raw);
        const token = await resolveToken(args);
        const quote = await quoteBuy({ tokenAddress: token.address, usdAmount: args.usdAmount });
        if (!quote) return jsonSafe({ ok: false, symbol: token.symbol, error: "No liquid route for this token right now." });
        try {
          const res = await executeBuy({ quote, slippageBps: args.slippageBps, idempotencyKey: args.idempotencyKey, signer: walletProvider });
          return jsonSafe({ ok: true, symbol: quote.symbol, route: quote.route, usdSpent: quote.amountInUsd, expectedOut: quote.expectedOut, ...res });
        } catch (e) {
          const err = e as Error & { txHash?: string };
          return jsonSafe({ ok: false, symbol: quote.symbol, route: quote.route, error: err.message, txHash: err.txHash });
        }
      },
    };
    const bal: StockbackAction<typeof balanceSchema> = {
      name: "stock_token_balance",
      description: "Get the agent wallet's balance of a Robinhood stock token (ERC-8056 balanceOfUI = shares), plus ETH/USDG.",
      schema: balanceSchema,
      invoke: async (raw) => {
        const args = balanceSchema.parse(raw);
        const token = await resolveToken(args);
        const owner = walletProvider.getAddress() as Address;
        const [b, w] = await Promise.all([getStockBalance(token.address, owner), getWalletState(owner)]);
        return jsonSafe({ symbol: b.symbol, token: b.token, raw: b.raw, balanceOfUI: b.ui, shares: b.shares, valueUsd: b.valueUsd, eth: w.ethFormatted, usdg: w.usdgFormatted });
      },
    };
    return [buy, bal] as unknown as Action[];
  }
}

export const stockbackActionProvider = () => new StockbackActionProvider();

/** AgentKit instance (singleton) with the Robinhood Chain wallet and Stockback actions. */
export function getAgentKit(): Promise<AgentKit> {
  if (!_agentKit) {
    _agentKit = AgentKit.from({
      walletProvider: getAgentWalletProvider(),
      actionProviders: [stockbackActionProvider()],
    }).catch((e) => {
      _agentKit = undefined;
      throw e;
    });
  }
  return _agentKit;
}

/** Convenience: invoke an AgentKit action by name (e.g. from an API route or a SERV tool call). */
export async function runAgentAction(name: "buy_stock_token" | "stock_token_balance", args: Record<string, unknown>): Promise<string> {
  const kit = await getAgentKit();
  const action = kit.getActions().find((a) => a.name === name || a.name.endsWith(`_${name}`));
  if (!action) throw new Error(`AgentKit action ${name} not found`);
  return action.invoke(args);
}
