import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { fetchHyperliquidMid } from "../src/clients.js";
import type { SwapIntent } from "../src/domain.js";
import { execute, resetExecutorState, type ExecutorDeps } from "../src/executor.js";
import { fetchHyperMarket, perpMarket, perpMetaSchema, resetHyperMeta, spotMarket, spotMetaSchema } from "../src/hyperliquid-markets.js";
import { buildPairMap } from "../src/pairs.js";

type Captured = { captured: string; request: { type: string }; body: unknown };

function captured(type: "meta" | "spotMeta" | "allMids"): Captured {
  return JSON.parse(readFileSync(new URL(`../../test/fixtures/hyperliquid-markets/${type}.json`, import.meta.url), "utf8")) as Captured;
}

const mainnet = { meta: captured("meta"), spotMeta: captured("spotMeta"), allMids: captured("allMids") };
const HL = "https://hl.invalid";

function mainnetInfo(asked: string[], status = 200): typeof fetch {
  return async (_input, init) => {
    const { type } = JSON.parse(String(init?.body)) as { type: keyof typeof mainnet };
    asked.push(type);
    return new Response(JSON.stringify(mainnet[type].body), { status });
  };
}

function intent(symbol: string, hyperliquid: SwapIntent["hyperliquid"]): SwapIntent {
  return {
    idempotencyKey: `hl-${symbol}-${JSON.stringify(hyperliquid)}`,
    side: "buy",
    notionalUsd: 5,
    slippageBps: 50,
    token: {
      symbol,
      address: "mint",
      decimals: 6,
      chain: { kind: "solana" },
      chainKey: "solana",
      pairMap: buildPairMap([{ poolAddress: "p", dex: "raydium", chainKey: "solana", baseSymbol: symbol, baseAddress: "mint", quoteSymbol: "SOL", quoteAddress: "So11111111111111111111111111111111111111112", liquidityUsd: 100, priceUsd: 1, baseDecimals: 6 }]),
    },
    holdings: [{ symbol: "USDC", address: "usdc", amount: 20, usd: 20, native: false, decimals: 6, chainKey: "solana" }],
    hyperliquid,
    receivedAtMs: 1_000,
  };
}

function dryDeps(sends: string[], marks: string[], status = 200): ExecutorDeps {
  const info = mainnetInfo([], status);
  return {
    config: { maxUsdPerTrade: 5, dailyUsdCap: 25, maxSlippageBps: 100, slippageHardMaxBps: 300, maxLeverage: 1, minLiquidityUsd: 75_000, killSwitch: false, enabledChainKeys: new Set(["solana", "hypercore"]) },
    mode: "dry_run",
    spentTodayUsd: 0,
    liquidityOf: async () => 100,
    quoteHop: async () => ({ priceImpactPct: 0.2, feeUsd: 0.01, buyAmount: "10" }),
    markPrice: (midKey) => {
      marks.push(midKey);
      return fetchHyperliquidMid(HL, midKey, info);
    },
    hyperMarket: (query) => fetchHyperMarket(HL, query, info),
    send: async () => {
      sends.push("send");
      return { venue: "hypercore", txs: [], fill: null };
    },
    now: () => 1_050,
  };
}

test("the captured mainnet universe resolves perp and spot markets by token name", () => {
  const meta = perpMetaSchema.parse(mainnet.meta.body);
  const spot = spotMetaSchema.parse(mainnet.spotMeta.body);
  assert.deepEqual(perpMarket(meta, "BTC"), { coin: "BTC", market: "perp", assetIndex: 0, szDecimals: 5, maxLeverage: 40, midKey: "BTC" });
  assert.deepEqual(perpMarket(meta, "HYPE"), { coin: "HYPE", market: "perp", assetIndex: 159, szDecimals: 2, maxLeverage: 10, midKey: "HYPE" });
  assert.deepEqual(spotMarket(spot, "HYPE"), { coin: "HYPE", market: "spot", assetIndex: 10_107, szDecimals: 2, maxLeverage: 1, midKey: "@107" });
  assert.deepEqual(spotMarket(spot, "PURR"), { coin: "PURR", market: "spot", assetIndex: 10_000, szDecimals: 0, maxLeverage: 1, midKey: "PURR/USDC" });
  assert.equal(perpMarket(meta, "MATIC"), null, "a delisted perp has no market");
  assert.equal(perpMarket(meta, "hype"), null, "names match exactly");
  assert.equal(perpMarket(meta, "NOTALISTEDCOIN"), null);
  assert.equal(spotMarket(spot, "NOTALISTEDCOIN"), null);
});

test("a dry run plans the perp asset index of the token Hyperliquid lists", async () => {
  resetExecutorState();
  resetHyperMeta();
  const sends: string[] = [];
  const marks: string[] = [];
  const report = await execute(intent("HYPE", { coin: "HYPE", assetIndex: 159, market: "perp", maxLeverage: 10 }), dryDeps(sends, marks));
  assert.equal(report.decision, "would_send");
  assert.match(report.reason, /^hypercore HYPE asset 159 leverage 1 isolated limit \d+(\.\d+)? actions updateLeverage,order$/);
  assert.deepEqual(marks, ["HYPE"]);
  assert.deepEqual(sends, []);
});

test("a dry run prices a spot buy from the spot pair mid, not the perp mid of the same name", async () => {
  resetExecutorState();
  resetHyperMeta();
  const marks: string[] = [];
  const report = await execute(intent("HYPE", { coin: "HYPE", assetIndex: 10_107, market: "spot", maxLeverage: 1 }), dryDeps([], marks));
  assert.equal(report.decision, "would_send");
  assert.match(report.reason, /^hypercore HYPE asset 10107 spot limit /);
  assert.deepEqual(marks, ["@107"]);
});

test("a caller market that is not the token's market is refused before any price read", async () => {
  const cases: Array<[string, SwapIntent["hyperliquid"], string]> = [
    ["HYPE", { coin: "HYPE", assetIndex: 0, market: "perp", maxLeverage: 10 }, "hyperliquid HYPE asset 0 is not the perp market of HYPE, asset 159"],
    ["HYPE", { coin: "BTC", assetIndex: 0, market: "perp", maxLeverage: 40 }, "hyperliquid BTC asset 0 is not the perp market of HYPE, asset 159"],
    ["HYPE", { coin: "HYPE", assetIndex: 159, market: "spot", maxLeverage: 1 }, "hyperliquid HYPE asset 159 is not the spot market of HYPE, asset 10107"],
    ["MATIC", { coin: "MATIC", assetIndex: 3, market: "perp", maxLeverage: 20 }, "MATIC has no hyperliquid perp market"],
    ["NOTALISTEDCOIN", { coin: "BTC", assetIndex: 0, market: "perp", maxLeverage: 40 }, "NOTALISTEDCOIN has no hyperliquid perp market"],
  ];
  for (const [symbol, claim, reason] of cases) {
    resetExecutorState();
    resetHyperMeta();
    const sends: string[] = [];
    const marks: string[] = [];
    const report = await execute(intent(symbol, claim), dryDeps(sends, marks));
    assert.equal(report.decision, "skipped", symbol);
    assert.equal(report.reason, reason);
    assert.equal(report.venue, "hypercore");
    assert.deepEqual(marks, [], "no mark price is read for a refused market");
    assert.deepEqual(sends, []);
  }
});

test("an unreadable universe refuses the hyperliquid route", async () => {
  resetExecutorState();
  resetHyperMeta();
  const failed = await execute(intent("HYPE", { coin: "HYPE", assetIndex: 159, market: "perp", maxLeverage: 10 }), dryDeps([], [], 500));
  assert.equal(failed.reason, "hyperliquid market unverifiable");
  resetHyperMeta();
  const malformed: typeof fetch = async () => new Response(JSON.stringify({ universe: [{ name: "HYPE" }] }), { status: 200 });
  await assert.rejects(fetchHyperMarket(HL, { coin: "HYPE", market: "perp" }, malformed));
});

test("the parsed universe is cached per url for five minutes", async () => {
  resetHyperMeta();
  const asked: string[] = [];
  const info = mainnetInfo(asked);
  await fetchHyperMarket(HL, { coin: "HYPE", market: "perp" }, info, 0);
  await fetchHyperMarket(HL, { coin: "BTC", market: "perp" }, info, 299_999);
  await fetchHyperMarket(HL, { coin: "HYPE", market: "spot" }, info, 299_999);
  await fetchHyperMarket(HL, { coin: "HYPE", market: "perp" }, info, 300_000);
  assert.deepEqual(asked, ["meta", "spotMeta", "meta"]);
});
