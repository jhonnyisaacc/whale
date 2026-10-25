import { quoteAssetOf, type QuoteAssets } from "./chains.js";
import type { PairMap, Pool } from "./domain.js";

export function buildPairMap(pools: readonly Pool[]): PairMap {
  const sorted = pools.slice().sort((a, b) => b.liquidityUsd - a.liquidityUsd);
  return { pools: sorted, top: sorted[0] ?? null };
}

export function allowedPools(pools: readonly Pool[], quoteAssets: QuoteAssets): Pool[] {
  return pools.filter((pool) => quoteAssetOf(quoteAssets, pool.chainKey, pool.quoteAddress) !== undefined);
}
