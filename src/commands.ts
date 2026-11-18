import type { ChainRef, ExecutionReport, Holding, RouteQuote, SwapIntent } from "./domain.js";
import { addressKey, chainByKey } from "./chains.js";
import { pickRoute } from "./routing.js";
import { bridgeRoute, planRebalance, type BridgePolicy, type BridgeQuote, type BridgeRequest, type BridgeRoute, type RebalancePlan } from "./rebalance.js";
import { intentSchema } from "./schemas.js";

export type Asset = {
  chain: ChainRef;
  chainKey: string;
  address: string;
  symbol: string;
  decimals: number | null;
};

export type WalletCommand =
  | { kind: "quote"; sell: Asset; buy: Asset; sellAmount: string; taker: string | null; slippageBps: number; purpose?: "price" }
  | { kind: "swap"; idempotencyKey: string; sell: Asset; buy: Asset; sellAmount: string; slippageBps: number; mode: "dry_run" }
  | { kind: "swap"; idempotencyKey: string; sell: Asset; buy: Asset; sellAmount: string; slippageBps: number; mode: "live"; notionalUsd: number }
  | ({ kind: "bridge" } & BridgeRequest)
  | { kind: "balance"; chainKey: string; address: string }
  | { kind: "transfer"; idempotencyKey: string; asset: Asset; to: string; amount: string; mode: "dry_run" | "live" };

export type WalletResult =
  | { kind: "quote"; status: "quoted"; quote: RouteQuote }
  | { kind: "quote"; status: "skipped"; quote: null; reason: string }
  | { kind: "swap"; report: ExecutionReport }
  | { kind: "swap"; status: "would_swap"; quote: RouteQuote; reason: string }
  | { kind: "swap"; status: "skipped"; quote: null; reason: string }
  | { kind: "bridge"; plan: RebalancePlan; quotes: BridgeQuote[] }
  | { kind: "balance"; holdings: Holding[]; reason?: string }
  | { kind: "transfer"; status: "would_send" | "skipped"; reason: string };

export type CommandDeps = {
  quote?: (command: Extract<WalletCommand, { kind: "quote" }>) => Promise<RouteQuote | null>;
  execute?: (intent: SwapIntent) => Promise<ExecutionReport>;
  swapLimits?: { enabledChainKeys: ReadonlySet<string>; maxSlippageBps: number };
  bridge?: { policy: BridgePolicy; quotes: (route: BridgeRoute) => Promise<BridgeQuote[]> };
  readBalance?: (chainKey: string, address: string) => Promise<{ holdings: Holding[]; reason?: string }>;
  now?: () => number;
};

function liveSwapNotPosted(command: Extract<WalletCommand, { kind: "swap"; mode: "live" }>, now: number): WalletResult {
  return {
    kind: "swap",
    report: {
      idempotencyKey: command.idempotencyKey,
      mode: "live",
      decision: "skipped",
      reason: "live swap was not posted",
      venue: command.buy.chainKey,
      route: null,
      latency: { alertReceivedMs: now },
    },
  };
}

export const DRY_RUN_SWAP_REASON = "dry-run: this is the best signable route Whale quotes now. a live swap quotes again with a price check, so it can take another route or refuse. nothing was signed";

async function dryRunSwap(command: Extract<WalletCommand, { kind: "swap"; mode: "dry_run" }>, deps: CommandDeps): Promise<WalletResult> {
  const skip = (reason: string): WalletResult => ({ kind: "swap", status: "skipped", quote: null, reason });
  const spec = chainByKey(command.sell.chainKey);
  if (!spec) return skip(`unknown chain ${command.sell.chainKey}`);
  if (command.buy.chainKey !== spec.key) return skip(`a swap sells and buys on one chain. use bridge to move between ${spec.key} and ${command.buy.chainKey}`);
  if (spec.aggregator === "none") return skip(`${spec.key} has no swap aggregator`);
  if (!deps.swapLimits) return skip("no swap limits configured");
  const { enabledChainKeys, maxSlippageBps } = deps.swapLimits;
  if (!enabledChainKeys.has(spec.key)) return skip(`chain ${spec.key} is disabled`);
  if (!(command.slippageBps >= 0 && command.slippageBps <= maxSlippageBps)) return skip(`slippage exceeds ${maxSlippageBps} bps`);
  if (!deps.quote) return skip("no quote provider");
  const quote = await deps.quote({
    kind: "quote",
    sell: { ...command.sell, chain: spec.chain },
    buy: { ...command.buy, chain: spec.chain },
    sellAmount: command.sellAmount,
    taker: null,
    slippageBps: command.slippageBps,
  });
  if (!quote) return skip("no quote");
  const route = pickRoute([quote], command.slippageBps);
  if (route.kind === "none") return skip(route.reason);
  return { kind: "swap", status: "would_swap", quote: route, reason: DRY_RUN_SWAP_REASON };
}

function swapIntent(command: Extract<WalletCommand, { kind: "swap"; mode: "live" }>, now: number): SwapIntent {
  const sellAmount = Number(command.sellAmount);
  return intentSchema.parse({
    idempotencyKey: command.idempotencyKey,
    side: "buy",
    notionalUsd: command.notionalUsd,
    slippageBps: command.slippageBps,
    token: {
      symbol: command.buy.symbol,
      address: command.buy.address,
      decimals: command.buy.decimals,
      chain: command.buy.chain,
      chainKey: command.buy.chainKey,
      pairMap: { pools: [], top: null },
    },
    holdings: [
      {
        symbol: command.sell.symbol,
        address: command.sell.address,
        amount: Number.isFinite(sellAmount) ? sellAmount : 0,
        usd: 0,
        native: false,
        ...(command.sell.decimals === null ? {} : { decimals: command.sell.decimals }),
        chainKey: command.sell.chainKey,
      },
    ],
    hyperliquid: null,
    receivedAtMs: now,
  });
}

export async function run(command: WalletCommand, deps: CommandDeps = {}): Promise<WalletResult> {
  const now = deps.now?.() ?? Date.now();
  if (command.kind === "quote") {
    if (!deps.quote) return { kind: "quote", status: "skipped", quote: null, reason: "no quote provider" };
    const quote = await deps.quote(command);
    if (!quote) return { kind: "quote", status: "skipped", quote: null, reason: "no quote" };
    return { kind: "quote", status: "quoted", quote };
  }
  if (command.kind === "swap") {
    if (command.mode === "dry_run") return dryRunSwap(command, deps);
    if (!deps.execute) return liveSwapNotPosted(command, now);
    return { kind: "swap", report: await deps.execute(swapIntent(command, now)) };
  }
  if (command.kind === "bridge") {
    const skip = (reason: string): WalletResult => ({ kind: "bridge", plan: { kind: "skip", reason, quote: null }, quotes: [] });
    if (!deps.bridge) return skip("no bridge route provider");
    const { policy } = deps.bridge;
    const resolved = bridgeRoute(command, policy);
    if (resolved.kind === "refused") return skip(resolved.reason);
    const quotes = [...(await deps.bridge.quotes(resolved.route))].sort((a, b) => a.feeUsd - b.feeUsd);
    const plan = planRebalance({
      quotes,
      maxBridgeUsd: policy.maxBridgeUsd,
      maxFeeBps: policy.maxFeeBps,
      spentBridgeUsd: 0,
      dailyBridgeCap: policy.dailyBridgeCap,
      ownAddresses: policy.allowlist,
      allowlist: policy.allowlist,
    });
    return { kind: "bridge", plan, quotes };
  }
  if (command.kind === "balance") {
    if (!deps.readBalance) throw new Error(`no balance reader configured for ${command.chainKey}`);
    const read = await deps.readBalance(command.chainKey, command.address);
    const address = addressKey(command.chainKey, command.address);
    const holdings = read.holdings.filter((row) => row.chainKey === command.chainKey && addressKey(command.chainKey, row.address) === address);
    return read.reason ? { kind: "balance", holdings, reason: read.reason } : { kind: "balance", holdings };
  }
  // TODO: local keystore signing exists for dry-run. Live mode still refuses raw keys in loadManagedSigner, so a live transfer stays skipped.
  if (command.mode === "live") {
    return { kind: "transfer", status: "skipped", reason: "live local signing is not wired" };
  }
  return { kind: "transfer", status: "would_send", reason: `dry-run transfer of ${command.amount} to ${command.to}. nothing was broadcast` };
}
