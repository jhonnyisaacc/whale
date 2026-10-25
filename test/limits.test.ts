import assert from "node:assert/strict";
import test from "node:test";
import { checkLimits, type LimitConfig } from "../src/limits.js";

const config: LimitConfig = {
  maxUsdPerTrade: 5,
  dailyUsdCap: 25,
  maxSlippageBps: 100,
  slippageHardMaxBps: 300,
  maxLeverage: 1,
  minLiquidityUsd: 75_000,
  killSwitch: false,
  enabledChainKeys: new Set(["solana", "base", "hypercore"]),
};

test("a trade above 5 USD is rejected", () => {
  const decision = checkLimits(config, {
    notionalUsd: 6,
    slippageBps: 50,
    leverage: 1,
    spentTodayUsd: 0,
    chain: { kind: "solana" },
    chainKey: "solana",
    liquidityUsd: 100_000,
  });
  assert.equal(decision.ok, false);
});

test("the daily cap rejects the next trade", () => {
  const decision = checkLimits(config, {
    notionalUsd: 5,
    slippageBps: 50,
    leverage: 1,
    spentTodayUsd: 21,
    chain: { kind: "evm", chainId: 8453 },
    chainKey: "base",
    liquidityUsd: 100_000,
  });
  assert.equal(decision.ok, false);
});

test("kill switch, disabled chain, slippage, and leverage all reject", () => {
  assert.equal(checkLimits({ ...config, killSwitch: true }, {
    notionalUsd: 1, slippageBps: 1, leverage: 1, spentTodayUsd: 0, chain: { kind: "solana" }, chainKey: "solana", liquidityUsd: 100_000,
  }).ok, false);
  assert.equal(checkLimits(config, {
    notionalUsd: 1, slippageBps: 1, leverage: 1, spentTodayUsd: 0, chain: { kind: "evm", chainId: 1 }, chainKey: "ethereum", liquidityUsd: 100_000,
  }).ok, false);
  assert.equal(checkLimits(config, {
    notionalUsd: 1, slippageBps: 250, leverage: 1, spentTodayUsd: 0, chain: { kind: "solana" }, chainKey: "solana", liquidityUsd: 100_000,
  }).ok, false);
  assert.equal(checkLimits(config, {
    notionalUsd: 1, slippageBps: 10, leverage: 3, spentTodayUsd: 0, chain: { kind: "hypercore", market: "perp" }, chainKey: "hypercore", liquidityUsd: null,
  }).ok, false);
});
