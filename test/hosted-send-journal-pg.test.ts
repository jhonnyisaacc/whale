import assert from "node:assert/strict";
import { after } from "node:test";
import test from "node:test";
import type { CommandDeps } from "../src/commands.js";
import { registerHostedRoutes } from "../src/executor-server/hosted.js";
import { createAgent } from "../src/gateway/agents.js";
import { buildGateway } from "../src/gateway/app.js";
import { executorClient, ExecutorRefused } from "../src/gateway/executor-client.js";
import { settleStaleSends } from "../src/gateway/send-ledger.js";
import { createWallet } from "../src/gateway/wallets.js";
import { buildApp } from "../src/http.js";
import { closeSpendPools, poolFor } from "../src/spend.js";
import { gatewayConfig, signedInAccount } from "./gateway-fixtures.js";
import { migratedSchema, TEST_DATABASE_URL } from "./pg-schema.js";

const USDC = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";
const WETH = "0x4200000000000000000000000000000000000006";
const OWN = "0x9999999999999999999999999999999999999999";
const COLD = "0x1111111111111111111111111111111111111111";
const ETH = "0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee";
const USD_PER_ETH = 3000;
const HOSTED_TOKEN = "h".repeat(40);

after(() => closeSpendPools());

type Gate = { entered: Promise<void>; open: () => void; wait: () => Promise<void> };

function gate(): Gate {
  let enter = () => undefined as void;
  let open = () => undefined as void;
  const entered = new Promise<void>((resolve) => (enter = resolve));
  const opened = new Promise<void>((resolve) => (open = resolve));
  return { entered, open, wait: async () => (enter(), await opened) };
}

async function harness(options: { executorNow?: () => number } = {}) {
  const { pool, drop } = await migratedSchema();
  const quotes: string[] = [];
  const gates: Gate[] = [];
  const quoteFailures: Error[] = [];
  const pricing = { quotes: 0, up: true };
  const depsFor = async (): Promise<CommandDeps> => ({
    quote: async (item) => {
      if (item.sell.address === ETH && item.buy.address === USDC) {
        pricing.quotes += 1;
        if (!pricing.up) return null;
        const buyAmount = String((BigInt(item.sellAmount) * BigInt(USD_PER_ETH * 1_000_000)) / 10n ** 18n);
        return { planId: "zeroex", kind: "aggregator", hops: [], priceImpactPct: 0.1, feeUsd: 0, buyAmount, chain: item.sell.chain, chainKey: item.sell.chainKey };
      }
      quotes.push(item.sellAmount);
      await gates.shift()?.wait();
      const failure = quoteFailures.shift();
      if (failure) throw failure;
      return { planId: "zeroex", kind: "aggregator", hops: [], priceImpactPct: 0.1, feeUsd: 0, buyAmount: "42", chain: item.sell.chain, chainKey: item.sell.chainKey };
    },
  });
  const executorApp = await buildApp({ authTokens: ["executor-token-123456"], logger: false });
  const routeOptions = { token: HOSTED_TOKEN, depsFor, databaseUrl: TEST_DATABASE_URL as string, ...(options.executorNow ? { now: options.executorNow } : {}) };
  registerHostedRoutes(executorApp, routeOptions);
  const held: { path: string; init: RequestInit }[] = [];
  const holdNext: string[] = [];
  const deliver = async (path: string, init: RequestInit) => {
    const reply = await executorApp.inject({ method: "POST", url: path, headers: init.headers as Record<string, string>, payload: String(init.body) });
    return new Response(reply.body, { status: reply.statusCode });
  };
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    const path = new URL(String(input)).pathname;
    const kind = (JSON.parse(String(init?.body)) as { command?: { kind?: string } }).command?.kind;
    if (holdNext[0] === path && kind !== "quote") {
      holdNext.shift();
      held.push({ path, init: init as RequestInit });
      throw new Error("The operation was aborted due to timeout");
    }
    return deliver(path, init as RequestInit);
  }) as typeof fetch;
  const executor = executorClient({ url: new URL("http://executor.internal:8080"), token: HOSTED_TOKEN }, fetchImpl);
  const app = await buildGateway({ config: gatewayConfig(), pool, logger: false, keys: { key: async () => null }, executor, turnkey: null, delegation: null });
  const user = await signedInAccount(pool);
  const created = await createWallet(pool, user.accountId, { label: "main", level: "enclave" });
  const walletId = "walletId" in created ? created.walletId : "";
  await pool.query("INSERT INTO wallet_addresses (wallet_id, family, address) VALUES ($1, 'evm', $2)", [walletId, OWN]);
  const policy = await pool.query("SELECT document FROM policies WHERE wallet_id = $1", [walletId]);
  await pool.query("UPDATE policies SET document = $2 WHERE wallet_id = $1", [walletId, JSON.stringify({ ...policy.rows[0].document, actions: ["swap", "transfer"], destinations: [{ family: "evm", address: COLD, label: "cold" }], approvalAboveUsd: null })]);
  const agent = await createAgent(pool, { accountId: user.accountId, walletId, name: "bot", limits: { chains: ["base"], actions: ["swap", "transfer"], maxTxUsd: 20, dailyUsd: 40 } });
  if ("refused" in agent) throw new Error(agent.refused);
  const swap = async (key: string, dollars: number) => {
    const response = await app.inject({
      method: "POST",
      url: "/mcp",
      headers: { authorization: `Bearer ${agent.apiKey}`, accept: "application/json, text/event-stream" },
      payload: { jsonrpc: "2.0", id: 7, method: "tools/call", params: { name: "swap", arguments: { chain: "base", sellToken: USDC, buyToken: WETH, sellAmount: String(dollars * 1_000_000), idempotencyKey: key } } },
    });
    const result = response.json().result as { isError: boolean; content: { text: string }[] };
    return { isError: result.isError, text: result.content[0]?.text ?? "" };
  };
  const transfer = async (key: string, amount: string) => {
    const response = await app.inject({
      method: "POST",
      url: "/mcp",
      headers: { authorization: `Bearer ${agent.apiKey}`, accept: "application/json, text/event-stream" },
      payload: { jsonrpc: "2.0", id: 8, method: "tools/call", params: { name: "transfer", arguments: { chain: "base", token: ETH, to: COLD, amount, idempotencyKey: key } } },
    });
    const result = response.json().result as { isError: boolean; content: { text: string }[] };
    return { isError: result.isError, text: result.content[0]?.text ?? "" };
  };
  const journaled = async (key: string) =>
    (await (await poolFor(TEST_DATABASE_URL as string)).query<{ state: string }>("SELECT state FROM hosted_sends WHERE agent_id = $1 AND idempotency_key = $2", [agent.agentId, key])).rows.map((row) => row.state);
  const spent = async (key: string) => (await pool.query<{ usd: number; state: string }>("SELECT usd, state FROM agent_spends WHERE idempotency_key = $1", [key])).rows;
  const spend = async (key: string) => (await pool.query<{ state: string }>("SELECT state FROM agent_spends WHERE idempotency_key = $1", [key])).rows[0]?.state;
  const sweep = () => settleStaleSends(pool, executor, 0);
  const ids = { accountId: user.accountId, walletId, agentId: agent.agentId };
  return { pool, ids, executorApp, quotes, gates, quoteFailures, pricing, held, holdNext, deliver, executor, swap, transfer, journaled, spent, spend, sweep, drop: async () => (await app.close(), await executorApp.close(), await drop()) };
}

test("the sweeper keeps a reservation the executor has recorded as started, so a slow send is still counted when it lands", { skip: !TEST_DATABASE_URL }, async () => {
  const { executorApp, quotes, gates, swap, spend, sweep, drop } = await harness();
  try {
    const slow = gate();
    gates.push(slow);
    const running = swap("slow-send", 15);
    await slow.entered;
    assert.equal(await spend("slow-send"), "reserved");
    assert.equal(executorApp.drain.inFlight, 1, "a shutdown waits for the started send inside the drain window");
    assert.equal(await sweep(), 0, "a send the executor has started is not settled");
    assert.equal(await spend("slow-send"), "reserved", "the reservation is not released while the executor runs the send");
    slow.open();
    const reply = await running;
    assert.equal(reply.isError, false, reply.text);
    assert.equal(await spend("slow-send"), "committed", "the send that landed is counted against the caps");
    assert.deepEqual(quotes, ["15000000"]);
  } finally {
    await drop();
  }
});

test("a request that reaches the executor after the sweeper released its reservation is refused and never runs", { skip: !TEST_DATABASE_URL }, async () => {
  const { quotes, held, holdNext, deliver, swap, spend, sweep, drop } = await harness();
  try {
    holdNext.push("/hosted/commands");
    assert.match((await swap("late-send", 15)).text, /may have happened/);
    assert.equal(await spend("late-send"), "reserved");
    assert.equal(await sweep(), 1);
    assert.equal(await spend("late-send"), "released");
    const late = held[0] as { path: string; init: RequestInit };
    const reply = await deliver(late.path, late.init);
    assert.equal(reply.status, 403, await reply.clone().text());
    assert.deepEqual(quotes, [], "the late request reached no quote or sender");
    const retry = await swap("late-send", 15);
    assert.equal(retry.isError, false, retry.text);
    assert.equal(await spend("late-send"), "committed", "a retry after the release is a new request and runs once");
    assert.deepEqual(quotes, ["15000000"]);
  } finally {
    await drop();
  }
});

test("the executor refuses a hosted send issued longer ago than the sweeper's grace, and the gateway releases it exactly once", { skip: !TEST_DATABASE_URL }, async () => {
  let skewMs = 61_000;
  const { quotes, ids, executor, swap, spend, sweep, drop } = await harness({ executorNow: () => Date.now() + skewMs });
  try {
    const refused = await swap("stale-send", 15);
    assert.match(refused.text, /executor refused the send \(executor answered 403\)/);
    assert.equal(await spend("stale-send"), "released");
    assert.equal(await sweep(), 0, "the sweeper has nothing left to release");
    assert.deepEqual(quotes, []);
    skewMs = 0;
    const command = { kind: "swap" as const, chainKey: "base", sellToken: USDC, buyToken: WETH, sellAmount: "1000000", slippageBps: 50, taker: null, idempotencyKey: "direct-send" };
    const fresh = { ...ids, command, issuedAt: new Date().toISOString() };
    assert.equal(((await executor.run(fresh)) as { status: string }).status, "would_swap");
    const stale = { ...ids, command: { ...command, idempotencyKey: "direct-stale" }, issuedAt: new Date(Date.now() - 61_000).toISOString() };
    await assert.rejects(executor.run(stale), ExecutorRefused);
    const unstamped = { ...ids, command: { ...command, idempotencyKey: "direct-unstamped" } };
    await assert.rejects(executor.run(unstamped), ExecutorRefused);
    assert.deepEqual(quotes, ["1000000"]);
    assert.equal(await swap("stale-send", 15).then((reply) => reply.isError), false, "the released key can run once the clock agrees");
    assert.equal(await spend("stale-send"), "committed");
  } finally {
    await drop();
  }
});

test("a hosted send that fails before it moves anything is reported as not started, so the sweeper releases it", { skip: !TEST_DATABASE_URL }, async () => {
  const { quotes, quoteFailures, swap, spend, sweep, drop } = await harness();
  try {
    quoteFailures.push(new Error("no route"));
    assert.match((await swap("failed-send", 15)).text, /may have happened/);
    assert.equal(await spend("failed-send"), "reserved");
    assert.equal(await sweep(), 1);
    assert.equal(await spend("failed-send"), "released");
    assert.equal((await swap("failed-send", 15)).isError, false, "the retry runs as a new request");
    assert.equal(await spend("failed-send"), "committed");
    assert.deepEqual(quotes, ["15000000", "15000000"]);
  } finally {
    await drop();
  }
});

const halfCent = String(5n * 10n ** 15n);

test("a native-asset transfer priced from Whale's own quote is journaled, held by the sweeper as one send, and counted once at that price", { skip: !TEST_DATABASE_URL }, async () => {
  const { held, holdNext, deliver, transfer, journaled, spent, sweep, drop } = await harness();
  try {
    holdNext.push("/hosted/commands");
    assert.match((await transfer("eth-late", halfCent)).text, /may have happened/);
    assert.deepEqual(await spent("eth-late"), [{ usd: 15, state: "reserved" }], "the transfer is reserved at Whale's price before it runs");
    assert.deepEqual(await journaled("eth-late"), [], "the held request never reached the executor");
    assert.equal(await sweep(), 1);
    assert.deepEqual(await spent("eth-late"), [{ usd: 15, state: "released" }]);
    const late = held[0] as { path: string; init: RequestInit };
    assert.equal((await deliver(late.path, late.init)).status, 403, "the request the sweeper released never runs");
    assert.deepEqual(await journaled("eth-late"), ["refused"]);
    const retry = await transfer("eth-late", halfCent);
    assert.equal(retry.isError, false, retry.text);
    assert.deepEqual(await journaled("eth-late"), ["executed"]);
    assert.deepEqual(await spent("eth-late"), [{ usd: 15, state: "committed" }]);
    assert.match((await transfer("eth-over", String(10n ** 16n))).text, /the transfer moves about 30\.00 USD, above this agent's 20\.00 USD per-transaction cap/);
    assert.deepEqual(await journaled("eth-over"), [], "a transfer over the cap never reaches the journal");
  } finally {
    await drop();
  }
});

test("a send Whale cannot price never reaches the executor's journal or the ledger", { skip: !TEST_DATABASE_URL }, async () => {
  const { pricing, transfer, journaled, spent, drop } = await harness();
  try {
    pricing.up = false;
    const refused = await transfer("eth-unpriced", halfCent);
    assert.match(refused.text, /could not price on base, so Whale refused it/);
    assert.equal(pricing.quotes, 2);
    assert.deepEqual(await journaled("eth-unpriced"), []);
    assert.deepEqual(await spent("eth-unpriced"), []);
  } finally {
    await drop();
  }
});

test("a retry of a committed transfer reaches the executor stamped, gets the journal's stored reply, and is not priced or run again", { skip: !TEST_DATABASE_URL }, async () => {
  const { pricing, transfer, journaled, spent, drop } = await harness();
  try {
    const first = await transfer("eth-again", halfCent);
    assert.equal(first.isError, false, first.text);
    pricing.up = false;
    const asked = pricing.quotes;
    const retry = await transfer("eth-again", halfCent);
    assert.equal(retry.isError, false, retry.text);
    assert.deepEqual(JSON.parse(retry.text), JSON.parse(first.text), "the retry answers with the stored reply");
    assert.equal(pricing.quotes, asked, "the committed retry is not priced again");
    assert.deepEqual(await journaled("eth-again"), ["executed"]);
    assert.deepEqual(await spent("eth-again"), [{ usd: 15, state: "committed" }]);
  } finally {
    await drop();
  }
});
