import assert from "node:assert/strict";
import test from "node:test";
import { resetProviderGuards } from "../src/aggregators.js";
import { commandDeps } from "../src/command-callers.js";
import { run, type WalletCommand } from "../src/commands.js";
import { loadConfig } from "../src/config.js";
import type { ExecutionReport } from "../src/domain.js";
import { createExecutor, createExecutorApp } from "../src/executor-server.js";

const ROBINHOOD = { kind: "evm" as const, chainId: 4663 };
const WETH = "0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73".toLowerCase();
const STOCK = `0x${"46".repeat(20)}`;
const HELD = `0x${"11".repeat(20)}`;
const ROUTER = `0x${"22".repeat(20)}`;
const ZEROEX_HOST = "api.0x.org";
const KYBER_HOST = "aggregator-api.kyberswap.com";

type Asked = { host: string; path: string; chainId: string | null; sell: string; buy: string };

async function withAggregators<T>(amountFor: (host: string, sell: string, buy: string) => string, body: (asked: Asked[]) => Promise<T>): Promise<T> {
  resetProviderGuards();
  const asked: Asked[] = [];
  const original = globalThis.fetch;
  globalThis.fetch = async (input) => {
    const url = new URL(String(input));
    const sell = (url.searchParams.get("sellToken") ?? url.searchParams.get("tokenIn") ?? "").toLowerCase();
    const buy = (url.searchParams.get("buyToken") ?? url.searchParams.get("tokenOut") ?? "").toLowerCase();
    asked.push({ host: url.hostname, path: url.pathname, chainId: url.searchParams.get("chainId"), sell, buy });
    const amount = amountFor(url.hostname, sell, buy);
    if (url.hostname === ZEROEX_HOST) return new Response(JSON.stringify({ buyAmount: amount, liquidityAvailable: true }), { status: 200 });
    if (url.hostname === KYBER_HOST) return new Response(JSON.stringify({ data: { routeSummary: { amountOut: amount, routerAddress: ROUTER } } }), { status: 200 });
    return new Response("{}", { status: 404 });
  };
  try {
    return await body(asked);
  } finally {
    globalThis.fetch = original;
  }
}

test("a quote on Robinhood Chain asks 0x on chain 4663 and Kyber on its robinhood route and returns the larger output", async () => {
  const env = { ZEROX_API_KEY: "zeroex-key", QUOTE_TIMEOUT_MS: "200", QUOTE_DEADLINE_MS: "400" };
  const command: Extract<WalletCommand, { kind: "quote" }> = {
    kind: "quote",
    sell: { chain: ROBINHOOD, chainKey: "robinhood", address: HELD, symbol: "HELD", decimals: 6 },
    buy: { chain: ROBINHOOD, chainKey: "robinhood", address: STOCK, symbol: "STOCK", decimals: 18 },
    sellAmount: "5000000",
    taker: null,
    slippageBps: 50,
    purpose: "price",
  };
  const amountFor = (host: string) => (host === KYBER_HOST ? "2100000000000000000" : "2000000000000000000");
  await withAggregators(amountFor, async (asked) => {
    const result = await run(command, commandDeps(env, command));
    assert.ok(result.kind === "quote" && result.status === "quoted", `expected a quote, got ${JSON.stringify(result)}`);
    assert.equal(result.quote.buyAmount, "2100000000000000000");
    assert.equal(result.quote.provider, "kyberswap");
    assert.equal(result.quote.chainKey, "robinhood");
    assert.deepEqual(result.quote.chain, ROBINHOOD);
    assert.equal(asked.find((item) => item.host === ZEROEX_HOST)?.chainId, "4663");
    assert.equal(asked.find((item) => item.host === KYBER_HOST)?.path, "/robinhood/api/v1/routes");
  });
});

test("a dry-run swap on Robinhood Chain posted to the executor routes through WETH when the token's pool is quoted in WETH", async () => {
  const bearer = "robinhood-dry-run-bearer";
  const config = loadConfig({ ZEROX_API_KEY: "zeroex-key", EXECUTOR_AUTH_TOKEN: bearer, QUOTE_TIMEOUT_MS: "200", QUOTE_DEADLINE_MS: "400" });
  assert.equal(config.live, false);
  const executor = createExecutor(config, null, null, { secrets: [] });
  const app = await createExecutorApp(config, executor.deps, null, [], []);
  const pool = {
    poolAddress: `0x${"33".repeat(20)}`,
    dex: "uniswap",
    chainKey: "robinhood",
    baseSymbol: "STOCK",
    baseAddress: STOCK,
    quoteSymbol: "WETH",
    quoteAddress: WETH,
    liquidityUsd: 500_000,
    priceUsd: 2,
    baseDecimals: 18,
    quotePriceUsd: 2_500,
  };
  const intent = {
    idempotencyKey: "robinhood-dry-run",
    side: "buy",
    notionalUsd: 5,
    slippageBps: 100,
    token: { symbol: "STOCK", address: STOCK, decimals: 18, chain: ROBINHOOD, chainKey: "robinhood", pairMap: { pools: [pool], top: pool } },
    holdings: [{ symbol: "HELD", address: HELD, amount: 100, usd: 100, native: false, decimals: 6, chainKey: "robinhood" }],
    hyperliquid: null,
    receivedAtMs: 1,
  };
  const amountFor = (_host: string, sell: string, buy: string) => {
    if (buy === WETH) return "2000000000000000";
    if (sell === WETH) return "2500000000000000000";
    return "1000000000000000000";
  };
  try {
    await withAggregators(amountFor, async (asked) => {
      const response = await app.inject({
        method: "POST",
        url: "/execute",
        headers: { authorization: `Bearer ${bearer}`, "content-type": "application/json" },
        payload: intent,
      });
      assert.equal(response.statusCode, 200);
      const report = response.json<ExecutionReport>();
      assert.equal(report.mode, "dry_run");
      assert.equal(report.decision, "would_send", report.reason);
      assert.equal(report.venue, "robinhood");
      assert.equal(report.route?.kind, "two_hop");
      assert.deepEqual(report.route?.hops, ["HELD->WETH", "WETH->STOCK"]);
      assert.equal(report.route?.buyAmount, "2500000000000000000");
      assert.equal(report.txs, undefined);
      const zeroEx = asked.filter((item) => item.host === ZEROEX_HOST);
      assert.ok(zeroEx.length > 0 && zeroEx.every((item) => item.chainId === "4663"));
      const kyber = asked.filter((item) => item.host === KYBER_HOST);
      assert.ok(kyber.length > 0 && kyber.every((item) => item.path === "/robinhood/api/v1/routes"));
    });
  } finally {
    await app.close();
  }
});
