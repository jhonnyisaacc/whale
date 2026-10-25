import type { ChainRef, ExecutionReport, Holding, RouteQuote, SwapIntent } from "./domain.js";
import { planRebalance, type BridgeQuote, type RebalancePlan } from "./rebalance.js";

export type Asset = {
  chain: ChainRef;
  chainKey: string;
  address: string;
  symbol: string;
  decimals: number | null;
};

export type WalletCommand =
  | { kind: "quote"; sell: Asset; buy: Asset; sellAmount: string; taker: string | null; slippageBps: number }
  | { kind: "swap"; idempotencyKey: string; sell: Asset; buy: Asset; sellAmount: string; slippageBps: number; mode: "dry_run" }
  | {
      kind: "bridge";
      quotes: readonly BridgeQuote[];
      maxBridgeUsd: number;
      maxFeeBps: number;
      spentBridgeUsd: number;
      dailyBridgeCap: number;
      ownAddresses: readonly string[];
      allowlist: readonly string[];
    }
  | { kind: "balance"; chainKey: string; address: string }
  | { kind: "transfer"; idempotencyKey: string; asset: Asset; to: string; amount: string; mode: "dry_run" | "live" };

export type WalletResult =
  | { kind: "quote"; status: "quoted"; quote: RouteQuote }
  | { kind: "quote"; status: "skipped"; quote: null; reason: string }
  | { kind: "swap"; report: ExecutionReport }
  | { kind: "bridge"; plan: RebalancePlan }
  | { kind: "balance"; holdings: Holding[] }
  | { kind: "transfer"; status: "would_send" | "skipped"; reason: string };

export type CommandDeps = {
  quote?: (command: Extract<WalletCommand, { kind: "quote" }>) => Promise<RouteQuote | null>;
  execute?: (intent: SwapIntent) => Promise<ExecutionReport>;
  readBalance?: (chainKey: string, address: string) => Promise<Holding[]>;
  now?: () => number;
};

function skippedSwap(command: Extract<WalletCommand, { kind: "swap" }>, reason: string, now: number): WalletResult {
  return {
    kind: "swap",
    report: {
      idempotencyKey: command.idempotencyKey,
      mode: "dry_run",
      decision: "skipped",
      reason,
      venue: command.buy.chainKey,
      route: null,
      latency: { alertReceivedMs: now },
    },
  };
}

function swapIntent(command: Extract<WalletCommand, { kind: "swap" }>, now: number): SwapIntent {
  const sellAmount = Number(command.sellAmount);
  return {
    idempotencyKey: command.idempotencyKey,
    side: "buy",
    notionalUsd: 0,
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
        decimals: command.sell.decimals ?? undefined,
        chainKey: command.sell.chainKey,
      },
    ],
    hyperliquid: null,
    receivedAtMs: now,
  };
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
    if (!deps.execute) return skippedSwap(command, "no quote provider", now);
    return { kind: "swap", report: await deps.execute(swapIntent(command, now)) };
  }
  if (command.kind === "bridge") {
    // TODO: real bridge support should request a quote and broadcast the winner. This path only ranks quotes the caller already has, and broadcast stays false.
    return { kind: "bridge", plan: planRebalance(command) };
  }
  if (command.kind === "balance") {
    if (!deps.readBalance) return { kind: "balance", holdings: [] };
    const rows = await deps.readBalance(command.chainKey, command.address);
    const address = command.address.toLowerCase();
    return {
      kind: "balance",
      holdings: rows.filter((row) => row.chainKey === command.chainKey && row.address.toLowerCase() === address),
    };
  }
  // TODO: local keystore signing exists for dry-run. Live mode still refuses raw keys in loadManagedSigner, so a live transfer stays skipped.
  if (command.mode === "live") {
    return { kind: "transfer", status: "skipped", reason: "live local signing is not wired" };
  }
  return { kind: "transfer", status: "would_send", reason: `dry-run transfer of ${command.amount} to ${command.to}. nothing was broadcast` };
}
