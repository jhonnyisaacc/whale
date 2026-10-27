import type { ChainRef, ExecutionReport, Holding, RouteQuote, SwapIntent } from "./domain.js";
import { planRebalance, type BridgeQuote, type RebalancePlan } from "./rebalance.js";
import { intentSchema } from "./schemas.js";

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
  | { kind: "swap"; idempotencyKey: string; sell: Asset; buy: Asset; sellAmount: string; slippageBps: number; mode: "live"; notionalUsd: number }
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
  | { kind: "balance"; holdings: Holding[]; reason?: string }
  | { kind: "transfer"; status: "would_send" | "skipped"; reason: string };

export type CommandDeps = {
  quote?: (command: Extract<WalletCommand, { kind: "quote" }>) => Promise<RouteQuote | null>;
  execute?: (intent: SwapIntent) => Promise<ExecutionReport>;
  readBalance?: (chainKey: string, address: string) => Promise<{ holdings: Holding[]; reason?: string }>;
  now?: () => number;
};

function swapReport(
  command: Extract<WalletCommand, { kind: "swap" }>,
  now: number,
  mode: "dry_run" | "live",
  reason: string,
): WalletResult {
  return {
    kind: "swap",
    report: {
      idempotencyKey: command.idempotencyKey,
      mode,
      decision: "skipped",
      reason,
      venue: command.buy.chainKey,
      route: null,
      latency: { alertReceivedMs: now },
    },
  };
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
    if (command.mode !== "live") return swapReport(command, now, "dry_run", "nothing was broadcast");
    if (!deps.execute) return swapReport(command, now, "live", "live swap was not posted");
    return { kind: "swap", report: await deps.execute(swapIntent(command, now)) };
  }
  if (command.kind === "bridge") {
    // TODO: real bridge support should request a quote and broadcast the winner. This path only ranks quotes the caller already has, and broadcast stays false.
    return { kind: "bridge", plan: planRebalance(command) };
  }
  if (command.kind === "balance") {
    if (!deps.readBalance) return { kind: "balance", holdings: [] };
    const read = await deps.readBalance(command.chainKey, command.address);
    const address = command.address.toLowerCase();
    const holdings = read.holdings.filter((row) => row.chainKey === command.chainKey && row.address.toLowerCase() === address);
    return read.reason ? { kind: "balance", holdings, reason: read.reason } : { kind: "balance", holdings };
  }
  // TODO: local keystore signing exists for dry-run. Live mode still refuses raw keys in loadManagedSigner, so a live transfer stays skipped.
  if (command.mode === "live") {
    return { kind: "transfer", status: "skipped", reason: "live local signing is not wired" };
  }
  return { kind: "transfer", status: "would_send", reason: `dry-run transfer of ${command.amount} to ${command.to}. nothing was broadcast` };
}
