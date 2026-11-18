import assert from "node:assert/strict";
import test from "node:test";
import { execute, resetExecutorState, type ExecutorDeps } from "../src/executor.js";
import { dexscreenerLiquidity } from "../src/executor/liquidity.js";
import { createExecutor } from "../src/executor-server.js";
import { loadConfig } from "../src/config.js";
import { buildPairMap } from "../src/pairs.js";
import type { PairMap, SwapIntent } from "../src/domain.js";

const contract = "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const usdc = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";

function pairMap(liquidityUsd: number): PairMap {
  return buildPairMap([
    { poolAddress: "pool", dex: "uniswap", chainKey: "base", baseSymbol: "TKN", baseAddress: contract, quoteSymbol: "USDC", quoteAddress: usdc, liquidityUsd, priceUsd: 0.5, baseDecimals: 6 },
  ]);
}

function swap(key: string, pairs: PairMap): SwapIntent {
  return {
    idempotencyKey: key,
    side: "buy",
    notionalUsd: 5,
    slippageBps: 50,
    token: { symbol: "TKN", address: contract, decimals: 6, chain: { kind: "evm", chainId: 8453 }, chainKey: "base", pairMap: pairs },
    holdings: [{ symbol: "USDC", address: usdc, amount: 20, usd: 20, native: false, decimals: 6, chainKey: "base" }],
    hyperliquid: null,
    receivedAtMs: 0,
  };
}

function deps(mode: ExecutorDeps["mode"], sends: string[], whaleLiquidity?: number | null): ExecutorDeps {
  const base: ExecutorDeps = {
    config: {
      maxUsdPerTrade: 5,
      dailyUsdCap: 25,
      maxSlippageBps: 100,
      slippageHardMaxBps: 300,
      maxLeverage: 1,
      minLiquidityUsd: 75_000,
      killSwitch: false,
      enabledChainKeys: new Set(["base"]),
    },
    mode,
    spentTodayUsd: 0,
    quoteHop: async () => ({ priceImpactPct: 0.1, feeUsd: 0.01, buyAmount: "10", signable: true }),
    markPrice: async () => null,
    send: async (request) => {
      sends.push(request.description);
      return { venue: "chain", outcome: "landed", txs: [{ chainKey: "base", txHash: "0x01", from: "owner", to: "router", value: "0", outcome: "landed" }], held: null, shortfall: false };
    },
    readBalance: async () => 20,
    priceOf: () => 1,
    now: () => 1_050,
  };
  if (whaleLiquidity === undefined) return base;
  return Object.assign(base, { liquidityOf: async () => whaleLiquidity });
}

test("a live intent whose caller sends no pair data is refused as liquidity unknown", async () => {
  resetExecutorState();
  const sends: string[] = [];
  const report = await execute(swap("no-pairs", { pools: [], top: null }), deps("live", sends));
  assert.equal(report.decision, "skipped");
  assert.equal(report.reason, "liquidity unknown");
  assert.deepEqual(sends, []);
});

test("a live intent with inflated caller liquidity is checked against Whale's own figure", async () => {
  resetExecutorState();
  const sends: string[] = [];
  const report = await execute(swap("inflated", pairMap(1_000_000_000)), deps("live", sends, 100));
  assert.equal(report.decision, "skipped");
  assert.equal(report.reason, "liquidity below 75000 USD");
  assert.deepEqual(sends, []);
});

test("a live intent fails closed when Whale's own lookup has no figure", async () => {
  resetExecutorState();
  const sends: string[] = [];
  const report = await execute(swap("lookup-failed", pairMap(2_000_000)), deps("live", sends, null));
  assert.equal(report.decision, "skipped");
  assert.equal(report.reason, "liquidity unknown");
  assert.deepEqual(sends, []);
});

test("a live intent with no caller pair data sends when Whale's own figure is deep enough", async () => {
  resetExecutorState();
  const sends: string[] = [];
  const report = await execute(swap("own-figure", { pools: [], top: null }), deps("live", sends, 2_000_000));
  assert.equal(report.decision, "sent");
  assert.equal(sends.length, 1);
});

test("a dry-run intent with no pair data still quotes", async () => {
  resetExecutorState();
  const sends: string[] = [];
  const report = await execute(swap("dry-no-pairs", { pools: [], top: null }), deps("dry_run", sends));
  assert.equal(report.decision, "would_send");
  assert.deepEqual(sends, []);
});

const weth = "0x4200000000000000000000000000000000000006";
const fake = "0xffffffffffffffffffffffffffffffffffffffff";

function pair(chainId: string, base: string, quote: string, usd: number | undefined) {
  return { chainId, pairAddress: `${base}-${quote}-${usd}`, baseToken: { address: base, symbol: "B" }, quoteToken: { address: quote, symbol: "Q" }, ...(usd === undefined ? {} : { liquidity: { usd } }) };
}

function dexscreener(body: unknown, seen: string[], status = 200): typeof fetch {
  return async (input) => {
    seen.push(String(input));
    return new Response(JSON.stringify(body), { status });
  };
}

const config = loadConfig({ EXECUTOR_AUTH_TOKEN: "0123456789abcdef", RESOLVER_AUTH_TOKEN: "resolver-token-123456" });

test("Whale's own figure counts only pools of the token against a known quote asset on the same chain", async () => {
  const seen: string[] = [];
  const pairs = [
    pair("base", contract, fake, 900_000_000),
    pair("ethereum", contract, usdc, 800_000_000),
    pair("base", fake, usdc, 700_000_000),
    pair("base", contract, usdc, 40_000),
    pair("base", weth, contract.toUpperCase().replace("0X", "0x"), 60_000),
    pair("base", contract, weth, undefined),
  ];
  const liquidityOf = dexscreenerLiquidity(config, dexscreener(pairs, seen));
  assert.equal(await liquidityOf({ chainKey: "base", address: contract }), 60_000);
  assert.deepEqual(seen, [`https://api.dexscreener.com/token-pairs/v1/base/${contract}`]);
});

test("Whale's own figure is unknown when the lookup fails or the chain has no DexScreener slug", async () => {
  const seen: string[] = [];
  assert.equal(await dexscreenerLiquidity(config, dexscreener({ error: "rate limited" }, seen, 429))({ chainKey: "base", address: contract }), null);
  assert.equal(await dexscreenerLiquidity(config, dexscreener({ not: "a list" }, seen))({ chainKey: "base", address: contract }), null);
  assert.equal(await dexscreenerLiquidity(config, dexscreener([], seen))({ chainKey: "monad", address: contract }), null);
  assert.equal(await dexscreenerLiquidity(config, dexscreener([], seen))({ chainKey: "base", address: contract }), 0);
  assert.equal(seen.length, 3);
});

test("Whale's own figure is cached for the liquidity refresh window", async () => {
  const seen: string[] = [];
  let clock = 0;
  const liquidityOf = dexscreenerLiquidity(config, dexscreener([pair("base", contract, usdc, 100_000)], seen), () => clock);
  assert.equal(await liquidityOf({ chainKey: "base", address: contract }), 100_000);
  clock = config.liquidityRefreshMs;
  assert.equal(await liquidityOf({ chainKey: "base", address: contract.toUpperCase().replace("0X", "0x") }), 100_000);
  assert.equal(seen.length, 1);
  clock = config.liquidityRefreshMs + 1;
  await liquidityOf({ chainKey: "base", address: contract });
  assert.equal(seen.length, 2);
});

test("the executor process checks live liquidity with its own DexScreener lookup", async (t) => {
  resetExecutorState();
  const seen: string[] = [];
  t.mock.method(globalThis, "fetch", dexscreener([pair("base", contract, usdc, 100)], seen));
  const live = loadConfig({ EXECUTOR_AUTH_TOKEN: "0123456789abcdef", RESOLVER_AUTH_TOKEN: "resolver-token-123456", WHALE_BROADCAST: "true", ENABLED_CHAINS: "base", TOKEN_SCREENING: "false" });
  const sends: string[] = [];
  const report = await createExecutor(live, null, null).execute(swap("process", pairMap(1_000_000_000)), { ...deps("live", sends), config: live });
  assert.equal(report.reason, "liquidity below 75000 USD");
  assert.deepEqual(sends, []);
  assert.deepEqual(seen, [`https://api.dexscreener.com/token-pairs/v1/base/${contract}`]);
});
