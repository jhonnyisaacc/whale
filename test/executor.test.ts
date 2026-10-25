import assert from "node:assert/strict";
import test from "node:test";
import { landedSend } from "./fixtures.js";
import { spendDay } from "../src/spend.js";
import { execute, resetExecutorState, spentToday, authorizeWithdraw, type ExecutorDeps } from "../src/executor.js";
import type { SwapIntent } from "../src/domain.js";
import { buildPairMap } from "../src/pairs.js";
import type { LimitConfig } from "../src/limits.js";

const limits: LimitConfig = {
  maxUsdPerTrade: 5,
  dailyUsdCap: 25,
  maxSlippageBps: 100,
  slippageHardMaxBps: 300,
  maxLeverage: 1,
  minLiquidityUsd: 75_000,
  killSwitch: false,
  enabledChainKeys: new Set(["solana", "hypercore"]),
};

function intent(notional = 5): SwapIntent {
  return {
    idempotencyKey: `id-${notional}-${Math.random()}`,
    side: "buy",
    notionalUsd: notional,
    slippageBps: 50,
    token: {
      symbol: "MPLX",
      address: "mplx",
      decimals: 6,
      chain: { kind: "solana" },
      chainKey: "solana",
      pairMap: buildPairMap([
        {
          poolAddress: "p",
          dex: "raydium",
          chainKey: "solana",
          baseSymbol: "MPLX",
          baseAddress: "mplx",
          quoteSymbol: "SOL",
          quoteAddress: "So11111111111111111111111111111111111111112",
          liquidityUsd: 2_000_000,
          priceUsd: 0.2,
          baseDecimals: 6,
        },
      ]),
    },
    holdings: [
      { symbol: "USDC", address: "usdc", amount: 20, usd: 20, native: false },
      { symbol: "SOL", address: "sol", amount: 1, usd: 150, native: true },
    ],
    hyperliquid: { coin: "MPLX", assetIndex: 4, market: "perp", maxLeverage: 5 },
    receivedAtMs: 1_000,
  };
}

function deps(sends: string[]): ExecutorDeps {
  return {
    config: limits,
    mode: "dry_run",
    spentTodayUsd: 0,
    quoteHop: async (hop) => ({
      priceImpactPct: hop.sellAddress === "usdc" ? 0.2 : 0.8,
      feeUsd: 0.01,
      buyAmount: "10",
    }),
    markPrice: async () => 1,
    szDecimals: async () => 2,
    send: async (action) => {
      sends.push(action.kind);
      return landedSend();
    },
    now: () => 1_050,
  };
}

test("dry-run logs the buy and does not send or spend the daily cap", async () => {
  resetExecutorState();
  const sends: string[] = [];
  const report = await execute(intent(), deps(sends));
  assert.equal(report.decision, "would_send");
  assert.equal(report.mode, "dry_run");
  assert.equal(sends.length, 0);
  assert.equal(spentToday(spendDay()), 0);
  assert.ok(report.latency.quotedMs !== undefined);
  const again = await execute({ ...intent(), idempotencyKey: report.idempotencyKey }, deps(sends));
  assert.equal(again, report);
});

test("a thin spot pool falls back to a 1x hypercore plan without sending", async () => {
  resetExecutorState();
  const thin = intent();
  thin.token.pairMap = buildPairMap([{ ...thin.token.pairMap.pools[0], liquidityUsd: 100 }]);
  const sends: string[] = [];
  const report = await execute(thin, deps(sends));
  assert.equal(report.venue, "hypercore");
  assert.equal(report.decision, "would_send");
  assert.match(report.reason, /leverage 1/);
  assert.equal(sends.length, 0);
});

test("the second hop sells the amount the first hop bought", async () => {
  resetExecutorState();
  const seen: string[] = [];
  const report = await execute(intent(), {
    ...deps([]),
    quoteHop: async (hop) => {
      seen.push(`${hop.sellAddress}:${hop.sellAmount}`);
      if (hop.sellAddress === "usdc") return { priceImpactPct: 0.2, feeUsd: 0.01, buyAmount: "900000" };
      return { priceImpactPct: 0.3, feeUsd: 0.02, buyAmount: "10" };
    },
  });
  assert.equal(report.decision, "would_send");
  assert.ok(seen.includes("So11111111111111111111111111111111111111112:900000"));
});

test("withdraw only allows the configured address", () => {
  assert.equal(authorizeWithdraw("0xabc", ["0xAbC"]).ok, true);
  assert.equal(authorizeWithdraw("0xdef", ["0xabc"]).ok, false);
});
