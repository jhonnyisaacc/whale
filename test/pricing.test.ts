import assert from "node:assert/strict";
import test from "node:test";
import { QUOTE_ASSETS, chainByKey } from "../src/chains.js";
import { loadConfig } from "../src/config.js";
import type { Holding, Pool, SwapIntent } from "../src/domain.js";
import { execute, resetExecutorState, spentToday, type ExecutorDeps } from "../src/executor.js";
import { buildPairMap } from "../src/pairs.js";
import { coingeckoLoader, createPriceCache } from "../src/prices.js";
import { planRoutes } from "../src/routing.js";
import { screenToken } from "../src/screening.js";
import { spendDay } from "../src/spend.js";
import { landedSend } from "./fixtures.js";

const BASE_USDC = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";
const BASE_WETH = "0x4200000000000000000000000000000000000006";
const FAKE_USDC = "0x9999999999999999999999999999999999999999";
const TOKEN = "0xdddddddddddddddddddddddddddddddddddddddd";

function basePool(quoteSymbol: string, quoteAddress: string, liquidityUsd: number): Pool {
  return {
    poolAddress: `${quoteAddress}-pool`,
    dex: "uniswap",
    chainKey: "base",
    baseSymbol: "TKN",
    baseAddress: TOKEN,
    quoteSymbol,
    quoteAddress,
    liquidityUsd,
    priceUsd: 0.5,
    baseDecimals: 6,
    quotePriceUsd: 2000,
  };
}

const usdcHolding: Holding = { symbol: "USDC", address: BASE_USDC, amount: 20, usd: 20, native: false, decimals: 6, chainKey: "base" };

const counterfeit = basePool("USDC", FAKE_USDC, 50_000_000);
const real = basePool("WETH", BASE_WETH.toLowerCase(), 120_000);

test("a pool quoting counterfeit USDC is dropped and the two-hop goes through the allowlisted WETH", () => {
  const plans = planRoutes({
    tokenSymbol: "TKN",
    tokenAddress: TOKEN,
    pairMap: buildPairMap([counterfeit, real]),
    holdings: [usdcHolding],
    minNativeReserve: 0,
    notionalUsd: 5,
    quoteAssets: QUOTE_ASSETS,
    chainKey: "base",
  });
  const twoHop = plans.find((plan) => plan.kind === "two_hop");
  assert.ok(twoHop && twoHop.kind === "two_hop");
  assert.equal(twoHop.first.buyAddress, BASE_WETH);
  assert.equal(twoHop.second.sellAddress, BASE_WETH);
  assert.ok(plans.every((plan) => (plan.kind === "two_hop" ? plan.first.buyAddress !== FAKE_USDC : plan.hop.buyAddress === TOKEN)));
});

test("quote decimals and symbol come from the allowlist by address, not the pool's self-reported symbol", () => {
  const mislabeled = basePool("USDC", BASE_WETH, 500_000);
  const plans = planRoutes({
    tokenSymbol: "TKN",
    tokenAddress: TOKEN,
    pairMap: buildPairMap([mislabeled]),
    holdings: [usdcHolding],
    minNativeReserve: 0,
    notionalUsd: 5,
    quoteAssets: QUOTE_ASSETS,
    chainKey: "base",
  });
  const twoHop = plans.find((plan) => plan.kind === "two_hop");
  assert.ok(twoHop && twoHop.kind === "two_hop");
  assert.equal(twoHop.quoteDecimals, 18);
  assert.equal(twoHop.id, "two:USDC:WETH");
});

test("QUOTE_ASSET_ALLOWLIST_JSON replaces one chain's list and rejects a malformed address", () => {
  const config = loadConfig({ QUOTE_ASSET_ALLOWLIST_JSON: JSON.stringify({ base: [{ address: BASE_USDC, symbol: "USDC", decimals: 6 }] }) });
  assert.deepEqual(config.quoteAssets.base, [{ address: BASE_USDC, symbol: "USDC", decimals: 6 }]);
  assert.equal(config.quoteAssets.solana, QUOTE_ASSETS.solana);
  assert.throws(() => loadConfig({ QUOTE_ASSET_ALLOWLIST_JSON: JSON.stringify({ base: [{ address: "usdc", symbol: "USDC", decimals: 6 }] }) }), /invalid asset/);
  assert.throws(() => loadConfig({ QUOTE_ASSET_ALLOWLIST_JSON: JSON.stringify({ nowhere: [] }) }), /invalid entry/);
});

function liveIntent(key: string, holdings: Holding[] = [usdcHolding]): SwapIntent {
  return {
    idempotencyKey: key,
    side: "buy",
    notionalUsd: 5,
    slippageBps: 100,
    token: { symbol: "TKN", address: TOKEN, decimals: 6, chain: { kind: "evm", chainId: 8453 }, chainKey: "base", pairMap: buildPairMap([real]) },
    holdings,
    hyperliquid: null,
    receivedAtMs: 0,
  };
}

function liveDeps(overrides: Partial<ExecutorDeps>, sold: string[]): ExecutorDeps {
  const config = loadConfig({ RPC_URL_8453: "http://fake.invalid", DAILY_USD_CAP: "5" });
  return {
    config: { ...config, enabledChainKeys: new Set(["base"]), minExecutionSlippageBps: 0 },
    mode: "live",
    spentTodayUsd: 0,
    quoteHop: async (hop) => {
      if (hop.buyAddress === TOKEN && hop.sellAddress === BASE_USDC) sold.push(hop.sellAmount);
      return hop.buyAddress === TOKEN && hop.sellAddress === BASE_USDC
        ? { priceImpactPct: 0, feeUsd: 0, buyAmount: "10000000", signable: true }
        : { priceImpactPct: null, feeUsd: 0, buyAmount: "0" };
    },
    markPrice: async () => null,
    send: async () => landedSend(),
    readBalance: async () => 20,
    ...overrides,
  };
}

test("a stale holding price skips the trade instead of sizing from the last price", async () => {
  resetExecutorState();
  let clock = 0;
  const cache = createPriceCache(async () => new Map([[`base:${BASE_USDC.toLowerCase()}`, 1]]), 90_000, () => clock);
  await cache.refresh();
  assert.equal(cache.priceOf(usdcHolding), 1);
  clock = 90_001;
  assert.equal(cache.priceOf(usdcHolding), null);
  const sold: string[] = [];
  const report = await execute(liveIntent("stale"), liveDeps({ priceOf: (holding) => cache.priceOf(holding) }, sold));
  assert.equal(report.decision, "skipped");
  assert.equal(report.reason, "holding price stale");
  assert.deepEqual(sold, []);
});

test("the live price, not the declared usd hint, sizes the sell", async () => {
  resetExecutorState();
  const sold: string[] = [];
  await execute(liveIntent("par"), liveDeps({ priceOf: () => 1 }, sold));
  resetExecutorState();
  await execute(liveIntent("depeg"), liveDeps({ priceOf: () => 0.5 }, sold));
  assert.deepEqual(sold, ["5000000", "10000000"]);
});

test("the in-memory daily spend resets at the spend-day boundary", async () => {
  resetExecutorState();
  let now = Date.parse("2026-10-21T23:59:00.000Z");
  const deps = liveDeps({ priceOf: () => 1, now: () => now }, []);
  const first = await execute(liveIntent("day-one"), deps);
  assert.equal(first.decision, "sent");
  assert.equal(spentToday("2026-10-21"), 5);
  const capped = await execute(liveIntent("day-one-again"), deps);
  assert.equal(capped.decision, "skipped");
  assert.equal(capped.reason, "daily cap 5 USD");
  now = Date.parse("2026-10-22T00:01:00.000Z");
  assert.equal(spentToday(spendDay(new Date(now))), 0);
  const next = await execute(liveIntent("day-two"), deps);
  assert.equal(next.decision, "sent");
  assert.equal(spentToday("2026-10-22"), 5);
});

test("each chain reserves its own native gas, so 20 POL cannot fund a 5 USD buy on Polygon", async () => {
  assert.equal(chainByKey("polygon")?.minNativeReserve, 25);
  assert.equal(chainByKey("base")?.minNativeReserve, 0.001);
  resetExecutorState();
  const pol: Holding = { symbol: "POL", address: "pol", amount: 20, usd: 20, native: true, decimals: 18, chainKey: "polygon" };
  const intent: SwapIntent = {
    ...liveIntent("pol", [pol]),
    token: { ...liveIntent("pol").token, chain: { kind: "evm", chainId: 137 }, chainKey: "polygon", pairMap: buildPairMap([{ ...real, chainKey: "polygon" }]) },
  };
  const quoted: string[] = [];
  const base = liveDeps({}, []);
  const report = await execute(intent, {
    ...base,
    config: { ...base.config, enabledChainKeys: new Set(["polygon"]) },
    mode: "dry_run",
    quoteHop: async (hop) => {
      quoted.push(hop.sellAddress);
      return { priceImpactPct: 0, feeUsd: 0, buyAmount: "1" };
    },
  });
  assert.equal(report.decision, "skipped");
  assert.equal(report.reason, "no route inside the slippage cap");
  assert.deepEqual(quoted, []);
  const funded = await execute({ ...intent, idempotencyKey: "pol-funded", holdings: [{ ...pol, amount: 40, usd: 40 }] }, {
    ...base,
    config: { ...base.config, enabledChainKeys: new Set(["polygon"]) },
    mode: "dry_run",
    quoteHop: async () => ({ priceImpactPct: 0, feeUsd: 0, buyAmount: "1" }),
  });
  assert.equal(funded.decision, "would_send");
});

function screeningFetch(hosts: string[], bodies: string[]): typeof fetch {
  return (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input));
    hosts.push(url.hostname);
    if (typeof init?.body === "string") bodies.push(init.body);
    if (url.hostname === "api.gopluslabs.io") {
      return new Response(JSON.stringify({ code: 1, result: { [TOKEN]: { is_honeypot: "0", cannot_sell_all: "0", buy_tax: "0", sell_tax: "0" } } }), { status: 200 });
    }
    return new Response(JSON.stringify({ result_type: "Benign" }), { status: 200 });
  }) as typeof fetch;
}

test("a chain Blockaid does not cover is screened by GoPlus alone, and a chain GoPlus does not cover is denied", async () => {
  const config = loadConfig({ TOKEN_SCREENING: "true", LISTING_TRADER_LIVE: "true", BLOCKAID_API_KEY: "blockaid-test" });
  const hosts: string[] = [];
  const bodies: string[] = [];
  const uncovered = await screenToken(config, { chainKey: "uncovered", chain: { kind: "evm", chainId: 8453 }, contract: TOKEN }, screeningFetch(hosts, bodies));
  assert.equal(uncovered, "allow");
  assert.deepEqual(hosts, ["api.gopluslabs.io"]);

  hosts.length = 0;
  const monad = await screenToken(config, { chainKey: "monad", chain: { kind: "evm", chainId: 143 }, contract: TOKEN }, screeningFetch(hosts, bodies));
  assert.equal(monad, "allow");
  assert.deepEqual(hosts, ["api.gopluslabs.io", "api.blockaid.io"]);
  assert.equal(JSON.parse(bodies[0] ?? "{}").chain, "monad");

  hosts.length = 0;
  const hyperevm = await screenToken(config, { chainKey: "hyperevm", chain: { kind: "evm", chainId: 999 }, contract: TOKEN }, screeningFetch(hosts, bodies));
  assert.equal(hyperevm, "deny");
  assert.deepEqual(hosts, []);
});

test("the CoinGecko loader prices natives in one call and each contract in its own call", async () => {
  const config = loadConfig({});
  const urls: string[] = [];
  const load = coingeckoLoader(
    config,
    [usdcHolding, { symbol: "ETH", address: "eth", amount: 1, usd: 1, native: true, decimals: 18, chainKey: "base" }],
    (async (input: RequestInfo | URL) => {
      const url = new URL(String(input));
      urls.push(`${url.pathname}?${url.searchParams.get("ids") ?? url.searchParams.get("contract_addresses")}`);
      if (url.pathname.endsWith("/simple/price")) return new Response(JSON.stringify({ ethereum: { usd: 2500 } }), { status: 200 });
      return new Response(JSON.stringify({ [BASE_USDC.toLowerCase()]: { usd: 0.9998 } }), { status: 200 });
    }) as typeof fetch,
  );
  const prices = await load();
  assert.deepEqual(urls.sort(), ["/api/v3/simple/price?ethereum", `/api/v3/simple/token_price/base?${BASE_USDC}`]);
  assert.equal(prices.get("native:ETH"), 2500);
  assert.equal(prices.get(`base:${BASE_USDC.toLowerCase()}`), 0.9998);
});
