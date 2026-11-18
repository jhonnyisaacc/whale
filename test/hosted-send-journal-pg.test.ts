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
import { closeSpendPools } from "../src/spend.js";
import { gatewayConfig, signedInAccount } from "./gateway-fixtures.js";
import { migratedSchema, TEST_DATABASE_URL } from "./pg-schema.js";

const USDC = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";
const WETH = "0x4200000000000000000000000000000000000006";
const OWN = "0x9999999999999999999999999999999999999999";
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
  const depsFor = async (): Promise<CommandDeps> => ({
    quote: async (item) => {
      quotes.push(item.sellAmount);
      await gates.shift()?.wait();
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
    if (holdNext[0] === path) {
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
  await pool.query("UPDATE policies SET document = $2 WHERE wallet_id = $1", [walletId, JSON.stringify({ ...policy.rows[0].document, actions: ["swap", "transfer"], approvalAboveUsd: null })]);
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
  const spend = async (key: string) => (await pool.query<{ state: string }>("SELECT state FROM agent_spends WHERE idempotency_key = $1", [key])).rows[0]?.state;
  const sweep = () => settleStaleSends(pool, executor, 0);
  const ids = { accountId: user.accountId, walletId, agentId: agent.agentId };
  return { pool, ids, quotes, gates, held, holdNext, deliver, executor, swap, spend, sweep, drop: async () => (await app.close(), await executorApp.close(), await drop()) };
}

test("the sweeper keeps a reservation the executor has recorded as started, so a slow send is still counted when it lands", { skip: !TEST_DATABASE_URL }, async () => {
  const { quotes, gates, swap, spend, sweep, drop } = await harness();
  try {
    const slow = gate();
    gates.push(slow);
    const running = swap("slow-send", 15);
    await slow.entered;
    assert.equal(await spend("slow-send"), "reserved");
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
