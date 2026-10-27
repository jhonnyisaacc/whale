import type { PairMap, Pool } from "./domain.js";

export function buildPairMap(pools: readonly Pool[]): PairMap {
  const sorted = pools.slice().sort((a, b) => b.liquidityUsd - a.liquidityUsd);
  return { pools: sorted, top: sorted[0] ?? null };
}
