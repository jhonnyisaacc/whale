import assert from "node:assert/strict";
import test from "node:test";
import { combineHopImpact, pickRoute, planRoutes } from "../src/routing.js";
import { buildPairMap } from "../src/pairs.js";
import type { Pool } from "../src/domain.js";

const quoteAssets = { solana: [{ address: "sol", symbol: "SOL", decimals: 9 }] };

const pools: Pool[] = [
  {
    poolAddress: "sol-pool",
    dex: "raydium",
    chainKey: "solana",
    baseSymbol: "MPLX",
    baseAddress: "mplx",
    quoteSymbol: "SOL",
    quoteAddress: "sol",
    liquidityUsd: 2_000_000,
    priceUsd: 0.2,
    baseDecimals: 6,
  },
];

test("plans an aggregator hop from USDC and an explicit two hop through SOL", () => {
  const plans = planRoutes({
    tokenSymbol: "MPLX",
    tokenAddress: "mplx",
    pairMap: buildPairMap(pools),
    holdings: [
      { symbol: "USDC", address: "usdc", amount: 20, usd: 20, native: false },
      { symbol: "SOL", address: "sol", amount: 1, usd: 150, native: true },
    ],
    minNativeReserve: 0.05,
    notionalUsd: 5,
    quoteAssets,
  });
  assert.ok(plans.some((plan) => plan.kind === "aggregator" && plan.id === "agg:USDC"));
  assert.ok(plans.some((plan) => plan.kind === "two_hop" && plan.id === "two:USDC:SOL"));
});

test("native gas reserve removes a dust SOL balance from the plan", () => {
  const plans = planRoutes({
    tokenSymbol: "MPLX",
    tokenAddress: "mplx",
    pairMap: buildPairMap(pools),
    holdings: [{ symbol: "SOL", address: "sol", amount: 0.01, usd: 1.5, native: true }],
    minNativeReserve: 0.02,
    notionalUsd: 5,
    quoteAssets,
  });
  assert.equal(plans.length, 0);
});

test("the picker keeps the lower impact inside the slippage cap", () => {
  const picked = pickRoute(
    [
      { planId: "expensive", kind: "aggregator", hops: ["USDC->MPLX"], priceImpactPct: 1.4, feeUsd: 0.01, buyAmount: "1" },
      { planId: "two", kind: "two_hop", hops: ["USDC->SOL", "SOL->MPLX"], priceImpactPct: 0.4, feeUsd: 0.02, buyAmount: "2" },
    ],
    100,
  );
  assert.equal("planId" in picked ? picked.planId : "", "two");
  const none = pickRoute(
    [{ planId: "wide", kind: "aggregator", hops: ["USDC->MPLX"], priceImpactPct: 2, feeUsd: 0.01, buyAmount: "1" }],
    100,
  );
  assert.equal("kind" in none ? none.kind : "", "none");
});

test("a sized holding becomes base units and leaves the native reserve", () => {
  const plans = planRoutes({
    tokenSymbol: "MPLX",
    tokenAddress: "mplx",
    pairMap: buildPairMap(pools),
    holdings: [
      { symbol: "USDC", address: "usdc", amount: 20, usd: 20, native: false, decimals: 6 },
      { symbol: "SOL", address: "sol", amount: 1, usd: 100, native: true, decimals: 9 },
    ],
    minNativeReserve: 0.5,
    notionalUsd: 5,
    quoteAssets,
  });
  const usdc = plans.find((plan) => plan.kind === "aggregator" && plan.id === "agg:USDC");
  const sol = plans.find((plan) => plan.kind === "aggregator" && plan.id === "agg:SOL");
  assert.equal(usdc && usdc.kind === "aggregator" ? usdc.hop.sellAmount : "", "5000000");
  assert.equal(sol && sol.kind === "aggregator" ? sol.hop.sellAmount : "", "50000000");
  const dust = planRoutes({
    tokenSymbol: "MPLX",
    tokenAddress: "mplx",
    pairMap: buildPairMap(pools),
    holdings: [{ symbol: "SOL", address: "sol", amount: 1, usd: 20, native: true, decimals: 9 }],
    minNativeReserve: 0.8,
    notionalUsd: 5,
    quoteAssets,
  });
  assert.equal(dust.length, 0);
});

test("two hop impact compounds", () => {
  const impact = combineHopImpact(1, 1);
  assert.ok(Math.abs(impact - 1.99) < 1e-9);
});
