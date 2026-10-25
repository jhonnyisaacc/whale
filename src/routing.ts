import { holdingFitsChain } from "./balances.js";
import { addressKey, quoteAssetOf, type QuoteAsset, type QuoteAssets } from "./chains.js";
import type { Holding, Hop, PairMap, Pool, RoutePlan, RouteQuote } from "./domain.js";

export function spendableAmount(holding: Holding, minNativeReserve: number): number {
  if (!holding.native) return holding.amount;
  return Math.max(0, holding.amount - minNativeReserve);
}

export function sellBaseUnits(human: number, decimals: number): string {
  if (!Number.isInteger(decimals) || decimals < 0 || decimals > 18 || !(human > 0)) return "0";
  const scaled = human.toFixed(decimals);
  if (scaled.startsWith("-") || scaled.includes("e") || scaled.includes("E")) return "0";
  const [whole, frac = ""] = scaled.split(".");
  if (whole === undefined) return "0";
  return BigInt(`${whole}${frac}`).toString();
}

function sizedHuman(holding: Holding, minNativeReserve: number, notionalUsd: number): number {
  const spendable = spendableAmount(holding, minNativeReserve);
  if (!(spendable > 0) || !(holding.amount > 0) || !(holding.usd > 0)) return 0;
  const spendableUsd = holding.usd * (spendable / holding.amount);
  if (!Number.isFinite(spendableUsd) || spendableUsd + 1e-8 < notionalUsd) return 0;
  return spendable * (notionalUsd / spendableUsd);
}

function hop(holding: Holding, human: number, buySymbol: string, buyAddress: string): Hop {
  const decimals = holding.decimals;
  return {
    sellSymbol: holding.symbol.toUpperCase(),
    sellAddress: holding.address,
    buySymbol: buySymbol.toUpperCase(),
    buyAddress,
    sellAmount: typeof decimals === "number" ? sellBaseUnits(human, decimals) : "0",
    ...(typeof decimals === "number" ? { sellDecimals: decimals } : {}),
  };
}

function deepestAllowedQuote(pairMap: PairMap, quoteAssets: QuoteAssets): { pool: Pool; asset: QuoteAsset } | null {
  for (const pool of pairMap.pools) {
    const asset = quoteAssetOf(quoteAssets, pool.chainKey, pool.quoteAddress);
    if (asset) return { pool, asset };
  }
  return null;
}

export function planRoutes(input: {
  tokenSymbol: string;
  tokenAddress: string;
  pairMap: PairMap;
  holdings: readonly Holding[];
  minNativeReserve: number;
  notionalUsd: number;
  quoteAssets: QuoteAssets;
  chainKey?: string;
}): RoutePlan[] {
  const plans: RoutePlan[] = [];
  const via = deepestAllowedQuote(input.pairMap, input.quoteAssets);
  for (const holding of input.holdings) {
    if (input.chainKey && holding.native && !holdingFitsChain(holding, input.chainKey)) continue;
    if (input.chainKey && holding.chainKey && holding.chainKey !== input.chainKey) continue;
    const human = sizedHuman(holding, input.minNativeReserve, input.notionalUsd);
    if (!(human > 0)) continue;
    const direct = hop(holding, human, input.tokenSymbol, input.tokenAddress);
    plans.push({ id: `agg:${direct.sellSymbol}`, kind: "aggregator", hop: direct });
    if (!via) continue;
    const quote = via.asset.symbol.toUpperCase();
    const chainKey = via.pool.chainKey;
    if (quote === direct.sellSymbol || addressKey(chainKey, holding.address) === addressKey(chainKey, via.asset.address)) continue;
    plans.push({
      id: `two:${direct.sellSymbol}:${quote}`,
      kind: "two_hop",
      first: hop(holding, human, quote, via.asset.address),
      second: {
        sellSymbol: quote,
        sellAddress: via.asset.address,
        buySymbol: direct.buySymbol,
        buyAddress: direct.buyAddress,
        sellAmount: "0",
        sellDecimals: via.asset.decimals,
      },
      quotePriceUsd: via.pool.quotePriceUsd ?? null,
      quoteDecimals: via.asset.decimals,
    });
  }
  return plans;
}

export function combineHopImpact(firstPct: number, secondPct: number): number {
  const a = firstPct / 100;
  const b = secondPct / 100;
  return (1 - (1 - a) * (1 - b)) * 100;
}

function compareBuy(left: string, right: string): number {
  if (/^\d+$/.test(left) && /^\d+$/.test(right)) {
    const a = BigInt(left);
    const b = BigInt(right);
    if (a === b) return 0;
    return a > b ? 1 : -1;
  }
  return left.localeCompare(right);
}

export function pickRoute(quotes: readonly RouteQuote[], slippageCapBps: number, executionReserveBps = 0): RouteQuote | { kind: "none"; reason: string } {
  const capPct = Math.max(0, slippageCapBps - executionReserveBps) / 100;
  const ok = quotes.filter((quote) => quote.priceImpactPct <= capPct && quote.feeUsd >= 0 && quote.signable !== false);
  if (ok.length === 0) return { kind: "none", reason: "no route inside the slippage cap" };
  ok.sort((a, b) => {
    if (a.netOutputUsd !== undefined && b.netOutputUsd !== undefined && a.netOutputUsd !== b.netOutputUsd) return b.netOutputUsd - a.netOutputUsd;
    return a.priceImpactPct - b.priceImpactPct || a.feeUsd - b.feeUsd || (a.feeRank ?? 0) - (b.feeRank ?? 0) || compareBuy(b.buyAmount, a.buyAmount);
  });
  return ok[0];
}
