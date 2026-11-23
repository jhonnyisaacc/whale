import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { resetProviderGuards } from "../src/aggregators.js";
import { quoteHop } from "../src/clients.js";
import { loadConfig } from "../src/config.js";
import { registerHostedRoutes } from "../src/executor-server/hosted.js";
import { buildApp } from "../src/http.js";
import { callTool, type McpDeps } from "../src/mcp-server.js";
import { closeSpendPools } from "../src/spend.js";

const NATIVE = `0x${"e".repeat(40)}`;
const DOLLAR = `0x${"b".repeat(40)}`;
const TAKER = `0x${"9".repeat(40)}`;
const HOSTED_TOKEN = "h".repeat(40);
const MCP: McpDeps = { executorUrl: "http://127.0.0.1:1", executorAuthToken: null };
const IDS = { accountId: "11111111-1111-4111-8111-111111111111", walletId: "22222222-2222-4222-8222-222222222222", agentId: "33333333-3333-4333-8333-333333333333" };
const ENV = {
  ZEROX_API_KEY: "zeroex-key",
  ONEINCH_API_KEY: "oneinch-key",
  OKX_API_KEY: "okx-key",
  OKX_API_SECRET: "okx-secret",
  OKX_API_PASSPHRASE: "okx-passphrase",
  QUOTE_TIMEOUT_MS: "200",
  QUOTE_DEADLINE_MS: "400",
};
const BASE = { chain: { kind: "evm", chainId: 8453 }, chainKey: "base", symbol: "?", decimals: null } as const;
const QUOTE_ARGS = { sell: { ...BASE, address: NATIVE }, buy: { ...BASE, address: DOLLAR }, sellAmount: "1000000000000000000", taker: TAKER, slippageBps: 50 };

type Answers = Partial<Record<"zeroex" | "kyberswap" | "oneinch" | "okx", string>>;

function answer(host: string, answers: Answers): Response {
  const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200 });
  if (host === "api.0x.org" && answers.zeroex) return json({ buyAmount: answers.zeroex, liquidityAvailable: true });
  if (host === "aggregator-api.kyberswap.com" && answers.kyberswap) return json({ data: { routeSummary: { amountOut: answers.kyberswap, routerAddress: `0x${"a".repeat(40)}` } } });
  if (host === "api.1inch.com" && answers.oneinch) return json({ dstAmount: answers.oneinch });
  if (host === "web3.okx.com" && answers.okx) return json({ code: "0", data: [{ toTokenAmount: answers.okx }] });
  return new Response("{}", { status: 404 });
}

async function withStubs<T>(answers: Answers, body: () => Promise<T>): Promise<T> {
  resetProviderGuards();
  const saved = { ...process.env };
  Object.assign(process.env, ENV);
  const original = globalThis.fetch;
  globalThis.fetch = async (input) => answer(new URL(String(input)).hostname, answers);
  try {
    return await body();
  } finally {
    globalThis.fetch = original;
    for (const key of Object.keys(ENV)) delete process.env[key];
    Object.assign(process.env, saved);
  }
}

const SIGNABLE_AND_LARGER_UNSIGNABLE: Answers = { zeroex: "3000000000", kyberswap: "3050000000", oneinch: "3300000000", okx: "3400000000" };

test("an MCP quote on Base with no price reference returns the largest signable route, never a larger unsignable one", async () => {
  const result = await withStubs(SIGNABLE_AND_LARGER_UNSIGNABLE, () => callTool(MCP, "quote", QUOTE_ARGS));
  assert.equal((result as { status: string }).status, "quoted", JSON.stringify(result));
  const { quote } = result as { quote: { provider: string; buyAmount: string; signable: boolean; priceImpactPct: number | null; note?: string } };
  assert.equal(quote.provider, "kyberswap");
  assert.equal(quote.priceImpactPct, null);
  assert.match(quote.note ?? "", /price impact is unknown/);
  assert.equal(quote.buyAmount, "3050000000");
  assert.equal(quote.signable, true);
});

async function hosted(command: Record<string, unknown>, extra: Record<string, unknown> = {}) {
  const databaseUrl = process.env.TEST_DATABASE_URL ?? null;
  const app = await buildApp({ authTokens: ["executor-token-123456"], logger: false });
  registerHostedRoutes(app, { token: HOSTED_TOKEN, databaseUrl });
  try {
    const response = await withStubs(SIGNABLE_AND_LARGER_UNSIGNABLE, () =>
      app.inject({ method: "POST", url: "/hosted/commands", headers: { authorization: `Bearer ${HOSTED_TOKEN}` }, payload: { ...IDS, ...extra, command } }),
    );
    assert.equal(response.statusCode, 200, response.body);
    return response.json() as { status: string; reason?: string; quote: { provider: string; buyAmount: string; signable: boolean; priceImpactPct: number | null } | null };
  } finally {
    await app.close();
    if (databaseUrl) await closeSpendPools();
  }
}

const HOSTED_QUOTE = { kind: "quote", chainKey: "base", sellToken: NATIVE, buyToken: DOLLAR, sellAmount: "1000000000000000000", slippageBps: 50, taker: TAKER };

test("the hosted MCP quote on Base with no price reference returns the largest signable route", async () => {
  const body = await hosted(HOSTED_QUOTE);
  assert.equal(body.status, "quoted", JSON.stringify(body));
  assert.equal(body.quote?.provider, "kyberswap");
  assert.equal(body.quote?.buyAmount, "3050000000");
  assert.equal(body.quote?.signable, true);
  assert.equal(body.quote?.priceImpactPct, null);
});

test("the hosted dry-run swap on Base reports the largest signable route as the one a live swap would take", { skip: !process.env.TEST_DATABASE_URL }, async () => {
  const body = await hosted({ ...HOSTED_QUOTE, kind: "swap", idempotencyKey: "i109-swap-0001" }, { agentId: randomUUID(), issuedAt: new Date().toISOString() });
  assert.equal(body.status, "would_swap", JSON.stringify(body));
  assert.match(body.reason ?? "", /a live swap quotes again with a price check/);
  assert.equal(body.quote?.provider, "kyberswap");
  assert.equal(body.quote?.signable, true);
});

test("a quote with no price reference never returns a route that only an unsignable provider offers", async () => {
  const result = await withStubs({ oneinch: "3300000000", okx: "3400000000" }, () => callTool(MCP, "quote", QUOTE_ARGS));
  assert.deepEqual(result, { kind: "quote", status: "skipped", quote: null, reason: "no quote" });
});

test("execution's quote race still refuses every route whose price impact it cannot check", async () => {
  const hop = await withStubs(SIGNABLE_AND_LARGER_UNSIGNABLE, () =>
    quoteHop(loadConfig(process.env), { sellAddress: NATIVE, buyAddress: DOLLAR, sellAmount: "1000000000000000000", chain: { kind: "evm", chainId: 8453 }, taker: TAKER }, null),
  );
  assert.equal(hop.buyAmount, "0");
  assert.equal(hop.priceImpactPct, null);
});
