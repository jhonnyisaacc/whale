import { holdingsForTrade, type BalanceReader } from "./balances.js";
import type { ChainRef, ExecutionReport, HyperliquidMarket, Latency, RouteLeg, RouteQuote, SendResult, SwapIntent, TxRecord } from "./domain.js";
import { chainByKey } from "./chains.js";
import { checkLimits, type LimitConfig } from "./limits.js";
import { stamp } from "./latency.js";
import type { PriceOf } from "./prices.js";
import { spendDay, type SpendScope } from "./spend.js";
import { pickRoute } from "./routing.js";
import { buildLeverage, buildOrder, cappedLimitPx, orderSize, wirePrice, type HyperliquidAction } from "./hyperliquid.js";
import { keepScreened, publicRoute, quotePlan } from "./executor/quotes.js";
import { liveTierBlocked, sendBlock, type SupportTier } from "./support.js";

export type HopQuote = {
  priceImpactPct: number | null;
  feeUsd: number;
  buyAmount: string;
  raw?: unknown;
  prepared?: { to: string | null; data: string | null; value: string };
  provider?: string;
  gasUsd?: number;
  netOutputUsd?: number;
  signable?: boolean;
  note?: string;
  quotedAtMs?: number;
  taker?: string | null;
};

export type SendRequest = {
  kind: "evm" | "solana" | "hypercore";
  description: string;
  chain: ChainRef;
  legs: RouteLeg[];
  hyperliquidActions: HyperliquidAction[];
  provider?: string;
};

export class BroadcastError extends Error {
  constructor(
    message: string,
    readonly broadcast: boolean,
  ) {
    super(message);
  }
}

export type ExecutorDeps = {
  config: LimitConfig;
  mode: "dry_run" | "live";
  spentTodayUsd: number;
  quoteHop: (
    hop: { sellAddress: string; buyAddress: string; sellAmount: string; chain: ChainRef; sellDecimals?: number },
    context: { spentUsd: number; priceUsd: number | null; decimals: number | null },
  ) => Promise<HopQuote>;
  markPrice: (coin: string) => Promise<number | null>;
  send: (action: SendRequest, onTx: (tx: TxRecord) => Promise<void>) => Promise<SendResult>;
  recordTx?: (idempotencyKey: string | null, tx: TxRecord) => Promise<void>;
  szDecimals?: (market: HyperliquidMarket) => Promise<number | null>;
  recordSpend?: (idempotencyKey: string, usd: number, scope?: SpendScope) => Promise<"inserted" | "exists" | "reserved" | "cap">;
  commitSpend?: (idempotencyKey: string) => Promise<void>;
  releaseSpend?: (idempotencyKey: string) => Promise<void>;
  now?: () => number;
  killSwitchEnabled?: () => Promise<boolean>;
  screenToken?: (token: { chainKey: string; chain: ChainRef; contract: string }) => Promise<"allow" | "deny">;
  supportTierFor?: (chainKey: string) => SupportTier;
  readTokenDecimals?: (token: { chainKey: string; chain: ChainRef; address: string }) => Promise<number | null>;
  readBalance?: BalanceReader | null;
  priceOf?: PriceOf | null;
  state?: ExecutorState;
  spendScope?: SpendScope;
};

// Reports are per mode.
export type ExecutorState = {
  reports: Record<ExecutorDeps["mode"], Map<string, ExecutionReport>>;
  spent: { day: string; usd: number };
  flagged: Set<string>;
};

export function createExecutorState(): ExecutorState {
  return { reports: { dry_run: new Map(), live: new Map() }, spent: { day: "", usd: 0 }, flagged: new Set() };
}

const defaultState = createExecutorState();

export function stateOf(deps: ExecutorDeps): ExecutorState {
  return deps.state ?? defaultState;
}

function reportsOf(deps: ExecutorDeps): Map<string, ExecutionReport> {
  return stateOf(deps).reports[deps.mode];
}

const flaggedTokens = new Set<string>();

export function resetTokenFlags(): void {
  flaggedTokens.clear();
}

export function resetExecutorState(state?: ExecutorState): void {
  const target = state ?? defaultState;
  target.reports.dry_run.clear();
  target.reports.live.clear();
  target.spent = { day: "", usd: 0 };
  target.flagged.clear();
  flaggedTokens.clear();
}

function tokenKey(chainKey: string, address: string): string {
  return `${chainKey}:${address.toLowerCase()}`;
}

export function tokenFlagged(chainKey: string, address: string): boolean {
  return flaggedTokens.has(tokenKey(chainKey, address));
}

export function spentToday(state: ExecutorState | string, day?: string): number {
  const target = typeof state === "string" ? defaultState : state;
  const when = typeof state === "string" ? state : (day as string);
  return target.spent.day === when ? target.spent.usd : 0;
}

export function restoreSpent(state: ExecutorState | number, usd: number | string, day?: string): void {
  if (typeof state === "object") state.spent = { day: day as string, usd: usd as number };
  else defaultState.spent = { day: usd as string, usd: state };
}

function today(deps: ExecutorDeps): string {
  return spendDay(new Date((deps.now ?? Date.now)()), deps.config.spendTimezone ?? "UTC");
}

function addSpent(deps: ExecutorDeps, usd: number): void {
  const day = today(deps);
  stateOf(deps).spent = { day, usd: spentToday(stateOf(deps), day) + usd };
}

function skipped(intent: SwapIntent, latency: Latency, reason: string, venue: string, mode: "dry_run" | "live"): ExecutionReport {
  return {
    idempotencyKey: intent.idempotencyKey,
    mode,
    decision: "skipped",
    reason,
    venue,
    route: null,
    latency,
  };
}

async function commitLive(
  intent: SwapIntent,
  deps: ExecutorDeps,
  latency: Latency,
  venueKey: string,
  route: RouteQuote | null,
  request: SendRequest,
  reason: string,
  now: () => number,
): Promise<ExecutionReport> {
  reportsOf(deps).set(intent.idempotencyKey, skipped(intent, latency, "send in progress", venueKey, deps.mode));
  if (deps.recordSpend) {
    try {
      const status = await deps.recordSpend(intent.idempotencyKey, intent.notionalUsd, deps.spendScope);
      if (status === "cap") {
        reportsOf(deps).delete(intent.idempotencyKey);
        const scope = deps.spendScope ? ` or strategy ${deps.spendScope.strategyId} cap ${deps.spendScope.capUsd} USD` : "";
        return skipped(intent, latency, `daily cap ${deps.config.dailyUsdCap} USD${scope}`, venueKey, deps.mode);
      }
      if (status === "exists") {
        const report = skipped(intent, latency, "duplicate spend", venueKey, deps.mode);
        reportsOf(deps).set(intent.idempotencyKey, report);
        return report;
      }
    } catch (error) {
      reportsOf(deps).delete(intent.idempotencyKey);
      const message = error instanceof Error ? error.message : "spend journal failed";
      return skipped(intent, latency, message, venueKey, deps.mode);
    }
  }
  const key = intent.idempotencyKey;
  const onTx = async (tx: TxRecord) => {
    if (tx.outcome === "pending" && latency.sentMs === undefined) latency = stamp(latency, "sentMs", now());
    await deps.recordTx?.(key, tx);
    if (tx.outcome === "landed" && request.kind !== "hypercore") await deps.commitSpend?.(key);
  };
  let result: SendResult;
  try {
    latency = stamp(latency, "signedMs", now());
    result = await deps.send(request, onTx);
  } catch (error) {
    const broadcast = error instanceof BroadcastError && error.broadcast;
    const message = error instanceof Error ? error.message : "send failed";
    if (!broadcast) {
      await deps.releaseSpend?.(key)?.catch(() => undefined);
      reportsOf(deps).delete(key);
      return skipped(intent, latency, message, venueKey, deps.mode);
    }
    addSpent(deps, intent.notionalUsd);
    const report = skipped(intent, latency, message, venueKey, deps.mode);
    reportsOf(deps).set(key, report);
    return report;
  }
  const landed = result.txs.some((tx) => tx.outcome === "landed");
  const filled = result.venue === "hypercore" ? result.fill !== null : landed;
  const pending = result.venue === "chain" && !landed && result.txs.some((tx) => tx.outcome === "pending");
  if (!filled && !pending) {
    await deps.releaseSpend?.(key)?.catch(() => undefined);
    reportsOf(deps).delete(key);
    const why = result.venue === "chain" ? `transaction ${result.outcome}` : "hyperliquid order not filled";
    return { ...skipped(intent, latency, result.note ? `${why}: ${result.note}` : why, venueKey, deps.mode), txs: result.txs };
  }
  addSpent(deps, intent.notionalUsd);
  if (filled) {
    await deps.commitSpend?.(key)?.catch(() => undefined);
    latency = stamp(latency, "confirmedMs", now());
  }
  const notes = [reason];
  if (pending) notes.push("unconfirmed");
  if (result.venue === "chain" && result.held) notes.push(`holding ${result.held.amount} of ${result.held.token}${result.note ? `: ${result.note}` : ""}`);
  if (result.venue === "chain" && result.shortfall) {
    const last = request.legs[request.legs.length - 1];
    if (last) { stateOf(deps).flagged.add(tokenKey(venueKey, last.buyAddress)); flaggedTokens.add(tokenKey(venueKey, last.buyAddress)); }
    notes.push("received less than the minimum output, token flagged");
  }
  const report: ExecutionReport = {
    idempotencyKey: key,
    mode: "live",
    decision: "sent",
    reason: notes.join("; "),
    venue: venueKey,
    route: publicRoute(route),
    latency,
    txs: result.txs,
  };
  if (result.venue === "chain" && result.held) report.held = result.held;
  if (result.venue === "hypercore" && result.fill) report.fill = result.fill;
  reportsOf(deps).set(key, report);
  return report;
}

function flagged(deps: ExecutorDeps, chainKey: string, address: string): boolean {
  return stateOf(deps).flagged.has(tokenKey(chainKey, address)) || tokenFlagged(chainKey, address);
}

function blockReport(intent: SwapIntent, deps: ExecutorDeps, latency: Latency, venue: string, reason: string): ExecutionReport {
  const report = skipped(intent, latency, reason, venue, deps.mode);
  reportsOf(deps).set(intent.idempotencyKey, report);
  return report;
}

type CandidateQuotes = { quotes: RouteQuote[]; unsized: boolean; unread: string | null; sized: boolean; crashed?: unknown };

async function quoteCandidate(intent: SwapIntent, token: SwapIntent["token"], deps: ExecutorDeps): Promise<CandidateQuotes> {
  const none: CandidateQuotes = { quotes: [], unsized: false, unread: null, sized: false };
  const allowed = checkLimits(deps.config, {
    notionalUsd: intent.notionalUsd,
    slippageBps: intent.slippageBps,
    leverage: 1,
    spentTodayUsd: deps.spentTodayUsd + spentToday(stateOf(deps), today(deps)),
    chain: token.chain,
    chainKey: token.chainKey,
    liquidityUsd: token.pairMap.top?.liquidityUsd ?? null,
  });
  if (!allowed.ok) return none;
  if (flagged(deps, token.chainKey, token.address)) return none;
  if (deps.mode === "live" && chainByKey(token.chainKey)?.liveSend === "disabled") return none;
  if (liveTierBlocked(deps.mode, deps.supportTierFor, token.chainKey)) return none;
  try {
    let quoted = intent;
    if (deps.mode === "live") {
      const sized = await holdingsForTrade(true, intent.holdings, deps.readBalance ?? null, token.chainKey, deps.priceOf ?? null);
      if (!sized.ok) return { ...none, unread: sized.reason };
      quoted = { ...intent, holdings: sized.holdings };
    }
    const planned = await quotePlan(quoted, token, deps);
    return { quotes: planned.quotes, unsized: planned.unsized, unread: null, sized: deps.mode === "live" };
  } catch (error) {
    return { ...none, crashed: error };
  }
}

export async function execute(intent: SwapIntent, deps: ExecutorDeps): Promise<ExecutionReport> {
  const existing = reportsOf(deps).get(intent.idempotencyKey);
  if (existing) return existing;
  const now = deps.now ?? Date.now;
  let stopped = false;
  try {
    stopped = (await deps.killSwitchEnabled?.()) === true;
  } catch {
    stopped = true;
  }
  if (stopped) {
    const report = skipped(intent, { alertReceivedMs: intent.receivedAtMs }, "kill switch is on", intent.token.chainKey, deps.mode);
    reportsOf(deps).set(intent.idempotencyKey, report);
    return report;
  }
  if (flagged(deps, intent.token.chainKey, intent.token.address)) {
    const report = skipped(intent, { alertReceivedMs: intent.receivedAtMs }, "token flagged for a transfer shortfall", intent.token.chainKey, deps.mode);
    reportsOf(deps).set(intent.idempotencyKey, report);
    return report;
  }
  const screening = keepScreened(intent, deps);
  const rejected = () => {
    const report = skipped(intent, { alertReceivedMs: intent.receivedAtMs }, "token screening rejected the contract", intent.token.chainKey, deps.mode);
    reportsOf(deps).set(intent.idempotencyKey, report);
    return report;
  };
  let alternates = intent.alternates ?? [];
  if (intent.hyperliquid !== null) {
    const screened = await screening;
    if (!screened.ok) return rejected();
    alternates = screened.alternates;
  }
  let primaryBlocked: string | null = null;
  let latency: Latency = { alertReceivedMs: intent.receivedAtMs };
  latency = stamp(latency, "resolvedMs", now());
  const spec = chainByKey(intent.token.chainKey);
  const liquidity = intent.token.pairMap.top?.liquidityUsd ?? null;
  const liquidAlternate = alternates.some((token) => (token.pairMap.top?.liquidityUsd ?? 0) >= deps.config.minLiquidityUsd);
  const useHyper = intent.hyperliquid !== null && (liquidity === null || liquidity < deps.config.minLiquidityUsd) && !liquidAlternate;
  const venueChain = useHyper ? { kind: "hypercore" as const, market: intent.hyperliquid?.market ?? "perp" } : intent.token.chain;
  const venueKey = useHyper ? "hypercore" : intent.token.chainKey;
  const limits = checkLimits(deps.config, {
    notionalUsd: intent.notionalUsd,
    slippageBps: intent.slippageBps,
    leverage: 1,
    spentTodayUsd: deps.spentTodayUsd + spentToday(stateOf(deps), today(deps)),
    chain: venueChain,
    chainKey: venueKey,
    liquidityUsd: useHyper ? null : liquidity,
  });
  if (!limits.ok && !(limits.reason.startsWith("chain ") && alternates.length > 0)) {
    const report = skipped(intent, latency, limits.reason, venueKey, deps.mode);
    reportsOf(deps).set(intent.idempotencyKey, report);
    return report;
  }
  if (!limits.ok) primaryBlocked = limits.reason;
  const tierOff = liveTierBlocked(deps.mode, deps.supportTierFor, intent.token.chainKey);
  if (deps.mode === "live" && !useHyper && (spec?.liveSend === "disabled" || tierOff)) {
    const other = alternates.some((token) => chainByKey(token.chainKey)?.liveSend !== "disabled" && !liveTierBlocked(deps.mode, deps.supportTierFor, token.chainKey));
    const reason = tierOff ? "chain is not enabled for live sends" : (spec?.gap ?? "live send disabled for this chain");
    if (!other) {
      const report = skipped(intent, latency, reason, venueKey, deps.mode);
      reportsOf(deps).set(intent.idempotencyKey, report);
      return report;
    }
    primaryBlocked = reason;
  }

  if (useHyper && intent.hyperliquid) {
    const market = intent.hyperliquid;
    const [mark, szDecimals] = await Promise.all([deps.markPrice(market.coin), deps.szDecimals ? deps.szDecimals(market).catch(() => null) : Promise.resolve(null)]);
    latency = stamp(latency, "quotedMs", now());
    if (mark === null) {
      const report = skipped(intent, latency, "hyperliquid mark price unverifiable", "hypercore", deps.mode);
      reportsOf(deps).set(intent.idempotencyKey, report);
      return report;
    }
    const isBuy = intent.side === "buy";
    let order;
    try {
      if (szDecimals === null) throw new Error("hyperliquid szDecimals unknown");
      order = buildOrder({
        asset: market.assetIndex,
        isBuy,
        limitPx: wirePrice(cappedLimitPx(mark, isBuy, intent.slippageBps), szDecimals, market.market, isBuy),
        size: orderSize(intent.notionalUsd, mark, szDecimals),
      });
    } catch (error) {
      const report = skipped(intent, latency, error instanceof Error ? error.message : "hyperliquid order sizing failed", "hypercore", deps.mode);
      reportsOf(deps).set(intent.idempotencyKey, report);
      return report;
    }
    const actions: HyperliquidAction[] = market.market === "spot" ? [order] : [buildLeverage(market.assetIndex, 1), order];
    if (deps.mode === "dry_run") {
      const report: ExecutionReport = {
        idempotencyKey: intent.idempotencyKey,
        mode: "dry_run",
        decision: "would_send",
        reason: `hypercore ${intent.hyperliquid.coin} ${market.market === "spot" ? "spot" : "leverage 1 isolated"} limit ${order.orders[0].p} actions ${actions.map((item) => item.type).join(",")}`,
        venue: "hypercore",
        route: null,
        latency,
      };
      reportsOf(deps).set(intent.idempotencyKey, report);
      return report;
    }
    const hyperBlock = sendBlock(deps.mode, deps.supportTierFor, "hypercore", deps.config.enabledChainKeys, false);
    if (hyperBlock) return blockReport(intent, deps, latency, "hypercore", hyperBlock);
    return commitLive(
      intent,
      deps,
      latency,
      "hypercore",
      null,
      {
        kind: "hypercore",
        description: intent.hyperliquid.coin,
        chain: venueChain,
        legs: [],
        hyperliquidActions: actions,
      },
      `hypercore ${intent.hyperliquid.coin}`,
      now,
    );
  }

  const candidates = [intent.token, ...alternates].filter((token) => deps.config.enabledChainKeys.has(token.chainKey));
  const results = await Promise.all(candidates.map((token) => quoteCandidate(intent, token, deps)));
  latency = stamp(latency, "quotedMs", now());
  const screened = await screening;
  if (!screened.ok) return rejected();
  const kept = new Set(screened.kept);
  const allowed = results.filter((_, index) => kept.has(candidates[index] as SwapIntent["token"]));
  const quotes = allowed.flatMap((result) => result.quotes);
  if (quotes.length === 0) {
    const crashed = allowed.find((result) => result.crashed !== undefined);
    if (crashed) throw crashed.crashed;
    const unread = allowed.find((result) => result.unread !== null)?.unread ?? null;
    const sizedAny = allowed.some((result) => result.sized);
    const unsized = allowed.some((result) => result.unsized);
    const fallback = primaryBlocked !== null && screened.alternates.length === 0 ? primaryBlocked : null;
    const reason = fallback ?? (unread !== null && !sizedAny ? unread : unsized ? "holding decimals missing" : "no route inside the slippage cap");
    const report = skipped(intent, latency, reason, venueKey, deps.mode);
    reportsOf(deps).set(intent.idempotencyKey, report);
    return report;
  }
  const picked = pickRoute(quotes, intent.slippageBps, deps.config.minExecutionSlippageBps ?? 0);
  if ("kind" in picked && picked.kind === "none") {
    const report = skipped(intent, latency, picked.reason, venueKey, deps.mode);
    reportsOf(deps).set(intent.idempotencyKey, report);
    return report;
  }
  const route = picked as RouteQuote;
  const routeChain = route.chain ?? intent.token.chain;
  const routeVenue = route.chainKey ?? venueKey;
  const note = route.note ? ` ${route.note}` : "";
  if (deps.mode === "dry_run") {
    const report: ExecutionReport = {
      idempotencyKey: intent.idempotencyKey,
      mode: "dry_run",
      decision: "would_send",
      reason: `${route.kind} ${route.hops.join(" then ")} impact ${route.priceImpactPct}${note}`,
      venue: routeVenue,
      route: publicRoute(route),
      latency,
    };
    reportsOf(deps).set(intent.idempotencyKey, report);
    return report;
  }
  const lastBuy = route.legs?.[route.legs.length - 1]?.buyAddress;
  const finalBlock = sendBlock(deps.mode, deps.supportTierFor, routeVenue, deps.config.enabledChainKeys, lastBuy ? flagged(deps, routeVenue, lastBuy) : false);
  if (finalBlock) return blockReport(intent, deps, latency, routeVenue, finalBlock);
  return commitLive(
    intent,
    deps,
    latency,
    routeVenue,
    route,
    {
      kind: routeChain.kind === "solana" ? "solana" : "evm",
      description: route.planId,
      chain: routeChain,
      legs: route.legs ?? [],
      hyperliquidActions: [],
      provider: route.provider,
    },
    route.planId,
    now,
  );
}

export { decideWithdraw, authorizeWithdraw } from "./executor/withdraw.js";
