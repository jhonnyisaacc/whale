import { QUOTE_ASSETS, chainByKey, feeRankOf } from "../chains.js";
import type { RaceQuote, RouteLeg, RoutePlan, RouteQuote, SwapIntent } from "../domain.js";
import { combineHopImpact, planRoutes } from "../routing.js";
import { acceptDecimals, cachedTokenDecimals, rememberTokenDecimals } from "../token-decimals.js";
import type { ExecutorDeps, HopQuote } from "../executor.js";

function raceQuoteOf(hop: { sellAmount: string }, quote: HopQuote): RaceQuote | undefined {
  if (quote.raw === undefined || !quote.provider || quote.quotedAtMs === undefined || quote.signable === false) return undefined;
  return { provider: quote.provider, raw: quote.raw, quotedAtMs: quote.quotedAtMs, sellAmount: hop.sellAmount, taker: quote.taker ?? null };
}

function legOf(
  hop: { sellAddress: string; buyAddress: string; sellAmount: string },
  context: { spentUsd: number; priceUsd: number | null; decimals: number | null },
  impactPct: number,
  quote?: RaceQuote,
): RouteLeg {
  return {
    sellAddress: hop.sellAddress,
    buyAddress: hop.buyAddress,
    sellAmount: hop.sellAmount,
    spentUsd: context.spentUsd,
    priceUsd: context.priceUsd,
    decimals: context.decimals,
    impactPct,
    ...(quote ? { quote } : {}),
  };
}


function decorate(quote: RouteQuote, token: SwapIntent["token"]): RouteQuote {
  return { ...quote, chainKey: token.chainKey, feeRank: feeRankOf(token.chainKey), chain: token.chain };
}

async function buyDecimals(token: SwapIntent["token"], deps: ExecutorDeps): Promise<number | null> {
  const known = acceptDecimals(token.decimals);
  if (known !== null) {
    rememberTokenDecimals(token.chainKey, token.address, known);
    return known;
  }
  const cached = cachedTokenDecimals(token.chainKey, token.address);
  if (cached !== null) return cached;
  if (!deps.readTokenDecimals) return null;
  try {
    const read = acceptDecimals(await deps.readTokenDecimals({ chainKey: token.chainKey, chain: token.chain, address: token.address }));
    if (read === null) return null;
    rememberTokenDecimals(token.chainKey, token.address, read);
    return read;
  } catch {
    return null;
  }
}

async function quoteOnePlan(
  intent: SwapIntent,
  token: SwapIntent["token"],
  plan: RoutePlan,
  context: { spentUsd: number; priceUsd: number | null; decimals: number | null },
  deps: ExecutorDeps,
): Promise<RouteQuote | null> {
  if (plan.kind === "aggregator") {
    const hop = await deps.quoteHop({ ...plan.hop, chain: token.chain }, context);
    if (hop.priceImpactPct === null) return null;
    return decorate({
      planId: plan.id,
      kind: "aggregator",
      hops: [`${plan.hop.sellSymbol}->${plan.hop.buySymbol}`],
      priceImpactPct: hop.priceImpactPct,
      feeUsd: hop.feeUsd,
      buyAmount: hop.buyAmount,
      legs: [legOf(plan.hop, context, hop.priceImpactPct, raceQuoteOf(plan.hop, hop))],
      provider: hop.provider,
      netOutputUsd: hop.netOutputUsd,
      gasUsd: hop.gasUsd,
      signable: hop.signable,
      note: hop.note,
    }, token);
  }
  const firstContext =
    plan.quotePriceUsd !== null && plan.quoteDecimals !== null
      ? { spentUsd: intent.notionalUsd, priceUsd: plan.quotePriceUsd, decimals: plan.quoteDecimals }
      : { spentUsd: intent.notionalUsd, priceUsd: null, decimals: null };
  const first = await deps.quoteHop({ ...plan.first, chain: token.chain }, firstContext);
  if (first.priceImpactPct === null || !/^[1-9][0-9]*$/.test(first.buyAmount)) return null;
  let secondSpent = intent.notionalUsd;
  if (plan.quotePriceUsd !== null && plan.quoteDecimals !== null) {
    const received = Number(first.buyAmount) / 10 ** plan.quoteDecimals;
    if (Number.isFinite(received) && received > 0) secondSpent = received * plan.quotePriceUsd;
  }
  const second = await deps.quoteHop(
    { ...plan.second, sellAmount: first.buyAmount, chain: token.chain },
    { spentUsd: secondSpent, priceUsd: context.priceUsd, decimals: context.decimals },
  );
  if (second.priceImpactPct === null) return null;
  const gasUsd = (first.gasUsd ?? 0) + (second.gasUsd ?? 0);
  const routeImpact = combineHopImpact(first.priceImpactPct, second.priceImpactPct);
  const netOutputUsd = second.netOutputUsd === undefined ? undefined : second.netOutputUsd - first.feeUsd - (first.gasUsd ?? 0);
  return decorate({
    planId: plan.id,
    kind: "two_hop",
    hops: [`${plan.first.sellSymbol}->${plan.first.buySymbol}`, `${plan.second.sellSymbol}->${plan.second.buySymbol}`],
    priceImpactPct: routeImpact,
    feeUsd: first.feeUsd + second.feeUsd,
    buyAmount: second.buyAmount,
    gasUsd,
    netOutputUsd,
    provider: second.provider ?? first.provider,
    signable: first.signable !== false && second.signable !== false,
    note: second.note ?? first.note,
    legs: [
      legOf(plan.first, firstContext, first.priceImpactPct, raceQuoteOf(plan.first, first)),
      legOf({ ...plan.second, sellAmount: first.buyAmount }, { spentUsd: intent.notionalUsd, priceUsd: context.priceUsd, decimals: context.decimals }, routeImpact),
    ],
  }, token);
}

export function publicRoute(route: RouteQuote | null): RouteQuote | null {
  if (!route?.legs) return route;
  return { ...route, legs: route.legs.map(({ quote: _quote, ...leg }) => leg) };
}

type Screened =
  | { ok: false }
  | { ok: true; alternates: NonNullable<SwapIntent["alternates"]>; kept: Array<SwapIntent["token"]> };

export async function keepScreened(intent: SwapIntent, deps: ExecutorDeps): Promise<Screened> {
  const alternates = intent.alternates ?? [];
  if (deps.mode !== "live" || !deps.screenToken) return { ok: true, alternates, kept: [intent.token, ...alternates] };
  const screen = deps.screenToken;
  const verdict = (token: SwapIntent["token"]) => screen({ chainKey: token.chainKey, chain: token.chain, contract: token.address }).catch(() => "deny" as const);
  const [primary, ...rest] = await Promise.all([intent.token, ...alternates].map(verdict));
  const keptAlternates = alternates.filter((_, index) => rest[index] === "allow");
  if (primary !== "allow" && keptAlternates.length === 0) return { ok: false };
  const kept = primary === "allow" ? [intent.token, ...keptAlternates] : keptAlternates;
  return { ok: true, alternates: keptAlternates, kept };
}

export async function quotePlan(intent: SwapIntent, token: SwapIntent["token"], deps: ExecutorDeps): Promise<{ quotes: RouteQuote[]; unsized: boolean }> {
  const spec = chainByKey(token.chainKey);
  const reserve = spec?.minNativeReserve ?? 0;
  const plans = planRoutes({
    tokenSymbol: token.symbol,
    tokenAddress: token.address,
    pairMap: token.pairMap,
    holdings: intent.holdings,
    minNativeReserve: reserve,
    notionalUsd: intent.notionalUsd,
    quoteAssets: deps.config.quoteAssets ?? QUOTE_ASSETS,
    chainKey: token.chainKey,
  });
  const context = {
    spentUsd: intent.notionalUsd,
    priceUsd: intent.token.pairMap.top?.priceUsd ?? null,
    decimals: await buyDecimals(token, deps),
  };
  const quoted = await Promise.all(plans.map((plan) => quoteOnePlan(intent, token, plan, context, deps)));
  const quotes = quoted.filter((quote): quote is RouteQuote => quote !== null);
  const unsized =
    plans.length > 0 &&
    plans.every((plan) => (plan.kind === "aggregator" ? plan.hop.sellAmount === "0" : plan.first.sellAmount === "0"));
  return { quotes, unsized };
}

