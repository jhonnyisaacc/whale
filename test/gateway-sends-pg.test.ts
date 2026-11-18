import assert from "node:assert/strict";
import test from "node:test";
import { createAgent } from "../src/gateway/agents.js";
import { buildGateway } from "../src/gateway/app.js";
import { ExecutorRefused, type ExecutorClient, type SendReport } from "../src/gateway/executor-client.js";
import { settleStaleSends } from "../src/gateway/send-ledger.js";
import { createWallet } from "../src/gateway/wallets.js";
import type { HostedRequest } from "../src/hosted-commands.js";
import { gatewayConfig, ORIGIN, signedInAccount } from "./gateway-fixtures.js";
import { migratedSchema, TEST_DATABASE_URL } from "./pg-schema.js";
import { softAuthenticator } from "./webauthn-fixtures.js";

const USDC = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";
const WETH = "0x4200000000000000000000000000000000000006";
const OWN = "0x9999999999999999999999999999999999999999";
const COLD = "0x1111111111111111111111111111111111111111";
const ETH = "0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee";
const JUNK = "0x2222222222222222222222222222222222222222";
const ONE_ETH = 10n ** 18n;
const eth = (fraction: number) => String(BigInt(Math.round(fraction * 1e6)) * 10n ** 12n);
type QuoteCommand = Extract<HostedRequest["command"], { kind: "quote" }>;
const ethAt = (usdPerEth: number) => (command: QuoteCommand) => (command.sellToken === ETH || command.sellToken === WETH ? (Number(command.sellAmount) / Number(ONE_ETH)) * usdPerEth : null);
const usdc = (dollars: number) => String(Math.round(dollars * 1_000_000));

type Reply = { isError: boolean; text: string; body: Record<string, unknown> | null };

async function harness(options: { approvalAboveUsd: number | null; netOutputUsd?: number; walletDailyUsd?: number; quoteUsd?: (command: QuoteCommand) => number | null }) {
  const { pool, drop } = await migratedSchema();
  const sent: HostedRequest[] = [];
  const quoted: QuoteCommand[] = [];
  const failures: Error[] = [];
  const during: (() => Promise<unknown>)[] = [];
  const journal = new Map<string, unknown>();
  const reports: (SendReport | Error | (() => Promise<SendReport>))[] = [];
  const executor: ExecutorClient = {
    report: async (lookup) => {
      const stored = journal.get(lookup.idempotencyKey);
      const next = reports.shift() ?? (stored === undefined ? { state: "not_started" } : { state: "executed", value: stored });
      if (next instanceof Error) throw next;
      return typeof next === "function" ? next() : next;
    },
    run: async (request) => {
      if (request.command.kind === "quote") {
        quoted.push(request.command);
        const dollars = options.quoteUsd?.(request.command) ?? null;
        return dollars === null ? { kind: "quote", status: "skipped", quote: null, reason: "no quote" } : { kind: "quote", status: "quoted", quote: { buyAmount: usdc(dollars), feeUsd: 0, priceImpactPct: 0 } };
      }
      await during.shift()?.();
      const failure = failures.shift();
      if (failure) throw failure;
      sent.push(request);
      const value = { kind: "swap", status: "would_swap", quote: { buyAmount: "42", feeUsd: 0, netOutputUsd: options.netOutputUsd } };
      if ("idempotencyKey" in request.command) journal.set(request.command.idempotencyKey, value);
      return value;
    },
  };
  const app = await buildGateway({ config: gatewayConfig(), pool, logger: false, keys: { key: async () => null }, executor, turnkey: null, delegation: null });
  const user = await signedInAccount(pool);
  const created = await createWallet(pool, user.accountId, { label: "main", level: "enclave" });
  const walletId = "walletId" in created ? created.walletId : "";
  await pool.query("INSERT INTO wallet_addresses (wallet_id, family, address) VALUES ($1, 'evm', $2)", [walletId, OWN]);
  const policy = await pool.query("SELECT document FROM policies WHERE wallet_id = $1", [walletId]);
  await pool.query("UPDATE policies SET document = $2 WHERE wallet_id = $1", [walletId, JSON.stringify({ ...policy.rows[0].document, actions: ["swap", "transfer"], destinations: [{ family: "evm", address: COLD, label: "cold" }], approvalAboveUsd: options.approvalAboveUsd, ...(options.walletDailyUsd ? { dailyUsd: options.walletDailyUsd } : {}) })]);
  const agent = await createAgent(pool, { accountId: user.accountId, walletId, name: "bot", limits: { chains: ["base"], actions: ["swap", "transfer"], maxTxUsd: 20, dailyUsd: 40 } });
  if ("refused" in agent) throw new Error(agent.refused);
  const authenticator = softAuthenticator({ rpId: "whale.example", origin: ORIGIN });
  const registration = (await app.inject({ method: "POST", url: "/api/passkeys/options", headers: user.headers, payload: {} })).json();
  const added = await app.inject({ method: "POST", url: "/api/passkeys", headers: user.headers, payload: { credential: authenticator.register(registration.challenge), label: "Mac" } });
  assert.equal(added.statusCode, 201);

  const call = async (name: string, args: Record<string, unknown>, apiKey = agent.apiKey): Promise<Reply> => {
    const response = await app.inject({ method: "POST", url: "/mcp", headers: { authorization: `Bearer ${apiKey}`, accept: "application/json, text/event-stream" }, payload: { jsonrpc: "2.0", id: 7, method: "tools/call", params: { name, arguments: args } } });
    const result = response.json().result as { isError: boolean; content: { text: string }[] };
    const text = result.content[0]?.text ?? "";
    let body: Record<string, unknown> | null = null;
    try {
      body = JSON.parse(text) as Record<string, unknown>;
    } catch {
      body = null;
    }
    return { isError: result.isError, text, body };
  };
  const swap = (key: string, dollars: number, sellToken = USDC, apiKey = agent.apiKey) =>
    call("swap", { chain: "base", sellToken, buyToken: sellToken === USDC ? WETH : USDC, sellAmount: sellToken === USDC ? usdc(dollars) : "1000000000000000000", idempotencyKey: key }, apiKey);
  const transfer = (key: string, dollars: number, token = USDC, amount = token.toLowerCase() === USDC.toLowerCase() ? usdc(dollars) : "1000000000000000000") => call("transfer", { chain: "base", token, to: COLD, amount, idempotencyKey: key });
  const approve = async (approvalId: string) => {
    const approval = (await app.inject({ method: "GET", url: "/api/approvals", headers: user.headers })).json().approvals.find((entry: { id: string }) => entry.id === approvalId);
    const stepUp = (await app.inject({ method: "POST", url: "/api/passkeys/step-up", headers: user.headers, payload: { action: { kind: "approval.approve", approvalId, command: approval.command } } })).json();
    return app.inject({ method: "POST", url: `/api/approvals/${approvalId}/approve`, headers: user.headers, payload: { assertion: authenticator.assert(stepUp.challenge) } });
  };
  const sweep = (graceMs = 0) => settleStaleSends(pool, executor, graceMs);
  const approvals = async () => (await pool.query("SELECT count(*)::int AS n FROM approvals")).rows[0].n as number;
  return { app, pool, user, walletId, sent, quoted, approvals, failures, during, reports, sweep, call, swap, transfer, approve, drop: async () => (await app.close(), await drop()) };
}

test("a swap is priced by what it sells, so a bad quote cannot slip a large sell past the cap or the threshold", { skip: !TEST_DATABASE_URL }, async () => {
  for (const netOutputUsd of [0.5, 0, -3]) {
    const { sent, swap, drop } = await harness({ approvalAboveUsd: 10, netOutputUsd });
    try {
      const huge = await swap(`huge-${netOutputUsd}`, 1_000_000);
      assert.equal(huge.isError, true, `a 1,000,000 USDC sell netting ${netOutputUsd} USD is refused`);
      assert.match(huge.text, /1000000\.00 USD, above this agent's 20\.00 USD per-transaction cap/);
      const held = await swap(`held-${netOutputUsd}`, 15);
      assert.equal(held.body?.status, "approval_required");
      assert.equal(held.body?.estimateUsd, 15);
      const unpriced = await swap(`weth-${netOutputUsd}`, 0, WETH);
      assert.equal(unpriced.isError, true);
      assert.match(unpriced.text, /Whale could not price/);
      assert.equal(sent.length, 0);
    } finally {
      await drop();
    }
  }
});

test("an approved send that waited past its hour is refused, not spent", { skip: !TEST_DATABASE_URL }, async () => {
  const { pool, sent, swap, approve, drop } = await harness({ approvalAboveUsd: 10 });
  try {
    const asked = await swap("stale-approval", 15);
    const approvalId = String(asked.body?.approvalId);
    assert.equal((await approve(approvalId)).statusCode, 200);
    await pool.query("UPDATE approvals SET created_at = created_at - interval '30 days', decided_at = decided_at - interval '30 days', expires_at = expires_at - interval '30 days' WHERE id = $1", [approvalId]);
    const late = await swap("stale-approval", 15);
    assert.equal(late.isError, true);
    assert.match(late.text, /expired/);
    assert.equal(sent.length, 0);
  } finally {
    await drop();
  }
});

test("an executor that refuses a send releases the approval at once for the retry, and a retry of the spent approval gets the stored answer", { skip: !TEST_DATABASE_URL }, async () => {
  const { app, user, sent, failures, swap, approve, drop } = await harness({ approvalAboveUsd: 10 });
  try {
    const asked = await swap("refused-by-executor", 15);
    assert.equal((await approve(String(asked.body?.approvalId))).statusCode, 200);
    failures.push(new ExecutorRefused("executor answered 429"));
    const failed = await swap("refused-by-executor", 15);
    assert.equal(failed.isError, true);
    assert.match(failed.text, /refused the send \(executor answered 429\)\. Nothing was spent/);
    const retried = await swap("refused-by-executor", 15);
    assert.equal(retried.body?.status, "would_swap");
    assert.equal(sent.length, 1);
    assert.equal((await swap("refused-by-executor", 15)).body?.status, "would_swap", "a retry of the spent approval gets the stored answer and does not run again");
    assert.deepEqual((await app.inject({ method: "GET", url: "/api/approvals?status=pending", headers: user.headers })).json().approvals, []);
    assert.equal(sent.length, 1);
  } finally {
    await drop();
  }
});

test("an executor that does not answer leaves the spend reserved and the approval claimed until the sweeper settles them from the executor's report", { skip: !TEST_DATABASE_URL }, async () => {
  const { pool, sent, failures, reports, sweep, swap, approve, drop } = await harness({ approvalAboveUsd: 10 });
  const state = async (key: string) => ({
    spend: (await pool.query("SELECT state FROM agent_spends WHERE idempotency_key = $1", [key])).rows[0]?.state,
    approval: (await pool.query("SELECT status FROM approvals WHERE idempotency_key = $1", [key])).rows[0]?.status,
  });
  try {
    for (const [key, report, settled] of [
      ["lost-before-broadcast", { state: "not_started" }, { spend: "released", approval: "approved" }],
      ["lost-after-broadcast", { state: "executed", value: { status: "sent" } }, { spend: "committed", approval: "used" }],
    ] as const) {
      const asked = await swap(key, 15);
      assert.equal((await approve(String(asked.body?.approvalId))).statusCode, 200);
      failures.push(new Error("executor answered 502"));
      const lost = await swap(key, 15);
      assert.equal(lost.isError, true);
      assert.match(lost.text, /may have happened/);
      assert.deepEqual(await state(key), { spend: "reserved", approval: "claimed" });
      assert.equal((await swap(key, 15)).body?.status, "settling", "a retry does not reach the executor while the send is unsettled");
      reports.push(report);
      assert.equal(await sweep(), 1);
      assert.deepEqual(await state(key), settled);
    }
    assert.equal(sent.length, 0);
    assert.equal((await swap("lost-before-broadcast", 15)).body?.status, "would_swap", "a released approval can still be used");
    reports.push({ state: "executed", value: { status: "sent" } });
    const replayed = await swap("lost-after-broadcast", 15);
    assert.deepEqual(replayed.body, { status: "sent" }, "a retry after the sweeper committed the send gets the executor's answer, not a request for a new key");
    assert.equal(sent.length, 1);
    const total = await pool.query("SELECT sum(usd)::float8 AS usd FROM agent_spends WHERE state = 'committed'");
    assert.equal(total.rows[0].usd, 30);
  } finally {
    await drop();
  }
});

test("a reservation the sweeper cannot confirm stays reserved and still counts toward the daily cap", { skip: !TEST_DATABASE_URL }, async () => {
  const { pool, failures, reports, sweep, swap, drop } = await harness({ approvalAboveUsd: null });
  try {
    failures.push(new Error("The operation was aborted due to timeout"));
    assert.match((await swap("timed-out", 19)).text, /may have happened/);
    reports.push(new Error("executor answered 503"));
    assert.equal(await sweep(), 0);
    assert.equal((await pool.query("SELECT state FROM agent_spends WHERE idempotency_key = 'timed-out'")).rows[0].state, "reserved");
    assert.equal((await swap("after-timeout", 19)).body?.status, "would_swap");
    assert.match((await swap("over-with-reserved", 3)).text, /about 41\.00 USD, above this agent's 40\.00 USD daily cap/);
  } finally {
    await drop();
  }
});

test("the sweeper leaves a reservation younger than its grace, and one re-reserved after its snapshot, in place", { skip: !TEST_DATABASE_URL }, async () => {
  const { pool, failures, reports, sweep, swap, approve, drop } = await harness({ approvalAboveUsd: 10 });
  const state = async (key: string) => ({
    spend: (await pool.query("SELECT state FROM agent_spends WHERE idempotency_key = $1", [key])).rows[0]?.state,
    approval: (await pool.query("SELECT status FROM approvals WHERE idempotency_key = $1", [key])).rows[0]?.status,
  });
  try {
    const asked = await swap("re-reserved", 15);
    assert.equal((await approve(String(asked.body?.approvalId))).statusCode, 200);
    failures.push(new Error("executor answered 502"));
    assert.match((await swap("re-reserved", 15)).text, /may have happened/);
    reports.push({ state: "not_started" });
    assert.equal(await sweep(60_000), 0, "a reservation younger than the grace is not asked about");
    assert.deepEqual(await state("re-reserved"), { spend: "reserved", approval: "claimed" });
    await pool.query("UPDATE agent_spends SET reserved_at = now() - interval '2 minutes'");
    await pool.query("UPDATE approvals SET claimed_at = now() - interval '2 minutes'");
    reports.length = 0;
    reports.push(async () => {
      await pool.query("UPDATE agent_spends SET reserved_at = now()");
      await pool.query("UPDATE approvals SET claimed_at = now()");
      return { state: "not_started" };
    });
    assert.equal(await sweep(60_000), 0, "a send re-reserved while the sweeper waited on the executor is not released from the old snapshot");
    assert.deepEqual(await state("re-reserved"), { spend: "reserved", approval: "claimed" });
  } finally {
    await drop();
  }
});

test("an agent's swaps stop at its daily cap, and the wallet's daily cap covers all its agents", { skip: !TEST_DATABASE_URL }, async () => {
  const { pool, user, walletId, swap, drop } = await harness({ approvalAboveUsd: null, walletDailyUsd: 50 });
  try {
    const statuses: unknown[] = [];
    for (let index = 1; index <= 6; index += 1) {
      const reply = await swap(`daily-${index}`, 9.99);
      statuses.push(reply.isError ? reply.text : reply.body?.status);
    }
    assert.deepEqual(statuses.slice(0, 4), ["would_swap", "would_swap", "would_swap", "would_swap"]);
    for (const refused of statuses.slice(4)) assert.match(String(refused), /above this agent's 40\.00 USD daily cap/);
    assert.equal((await swap("daily-1", 9.99)).body?.status, "would_swap", "a retry of a counted swap is not counted twice");

    const other = await createAgent(pool, { accountId: user.accountId, walletId, name: "other", limits: { chains: ["base"], actions: ["swap"], maxTxUsd: 20, dailyUsd: 40 } });
    if ("refused" in other) throw new Error(other.refused);
    assert.equal((await swap("other-1", 9.99, USDC, other.apiKey)).body?.status, "would_swap");
    assert.match((await swap("other-2", 9.99, USDC, other.apiKey)).text, /above the wallet's 50\.00 USD daily cap/);
  } finally {
    await drop();
  }
});

test("a swap Whale cannot price is refused with that reason, with no approval and no executor call, threshold or not", { skip: !TEST_DATABASE_URL }, async () => {
  for (const approvalAboveUsd of [null, 10]) {
    const { sent, quoted, approvals, swap, drop } = await harness({ approvalAboveUsd });
    try {
      const unpriced = await swap(`weth-${approvalAboveUsd}`, 0, WETH);
      assert.equal(unpriced.isError, true);
      assert.match(unpriced.text, /the swap sells a token Whale could not price on base, so Whale refused it\. No approval was requested and nothing was sent/);
      assert.equal(quoted.length > 0, true, "Whale asked for a quote before refusing");
      assert.equal(await approvals(), 0);
      assert.equal(sent.length, 0);
    } finally {
      await drop();
    }
  }
});

test("a swap that sells a native or other token is priced by selling it into USDC, not by the route the agent asked for", { skip: !TEST_DATABASE_URL }, async () => {
  const { sent, quoted, approvals, call, drop } = await harness({ approvalAboveUsd: null, netOutputUsd: 0.01, quoteUsd: ethAt(3000) });
  try {
    const swap = (key: string, amount: string, slippageBps: number) => call("swap", { chain: "base", sellToken: ETH, buyToken: JUNK, sellAmount: amount, slippageBps, idempotencyKey: key });
    const big = await swap("eth-big", ONE_ETH.toString(), 1);
    assert.equal(big.isError, true);
    assert.match(big.text, /the swap sells about 3000\.00 USD, above this agent's 20\.00 USD per-transaction cap/);
    assert.ok(quoted.every((command) => command.buyToken === USDC && command.slippageBps === 50 && command.taker === OWN), "the pricing quote ignores the agent's buy token and slippage");
    const small = await swap("eth-small", eth(0.005), 1);
    assert.equal(small.body?.status, "would_swap");
    assert.equal(await approvals(), 0);
    assert.equal(sent.length, 1);
  } finally {
    await drop();
  }
});

test("approving an approval past its hour answers 409 and leaves nothing to spend", { skip: !TEST_DATABASE_URL }, async () => {
  const { pool, sent, swap, approve, drop } = await harness({ approvalAboveUsd: 10 });
  try {
    const asked = await swap("late-approve", 15);
    const approvalId = String(asked.body?.approvalId);
    await pool.query("UPDATE approvals SET expires_at = now() - interval '1 second' WHERE id = $1", [approvalId]);
    assert.equal((await approve(approvalId)).statusCode, 409);
    const row = await pool.query("SELECT status, decided_at FROM approvals WHERE id = $1", [approvalId]);
    assert.deepEqual(row.rows[0], { status: "pending", decided_at: null });
    assert.match((await swap("late-approve", 15)).text, /expired/);
    assert.equal(sent.length, 0);
  } finally {
    await drop();
  }
});

const spends = async (pool: { query: (sql: string) => Promise<{ rows: unknown[] }> }) =>
  (await pool.query("SELECT idempotency_key, usd, to_char(day, 'YYYY-MM-DD') AS day FROM agent_spends ORDER BY created_at")).rows;

test("an idempotencyKey already spent on one swap cannot carry a different swap past the per-agent or the wallet cap", { skip: !TEST_DATABASE_URL }, async () => {
  for (const walletDailyUsd of [undefined, 30]) {
    const { pool, sent, swap, drop } = await harness({ approvalAboveUsd: null, walletDailyUsd });
    try {
      assert.equal((await swap("reuse-key", 1)).body?.status, "would_swap");
      for (const dollars of [19.99, 19.98, 19.97, 19.96, 19.95]) {
        const reused = await swap("reuse-key", dollars);
        assert.equal(reused.isError, true, `selling ${dollars} USDC under a used key is refused`);
        assert.match(reused.text, /already used for a different command/);
      }
      assert.equal(sent.length, 1);
      assert.deepEqual(await spends(pool), [{ idempotency_key: "reuse-key", usd: 1, day: new Date().toISOString().slice(0, 10) }]);
    } finally {
      await drop();
    }
  }
});

test("a key spent on an earlier UTC day refuses a different swap, and a retry of the same swap stays counted on its first day", { skip: !TEST_DATABASE_URL }, async () => {
  const { pool, sent, swap, drop } = await harness({ approvalAboveUsd: null });
  try {
    assert.equal((await swap("yesterday-key", 19)).body?.status, "would_swap");
    await pool.query("UPDATE agent_spends SET day = day - 1");
    const yesterday = new Date(Date.now() - 86_400_000).toISOString().slice(0, 10);
    const reused = await swap("yesterday-key", 19.99);
    assert.equal(reused.isError, true);
    assert.match(reused.text, /already used for a different command/);
    assert.equal((await swap("yesterday-key", 19)).body?.status, "would_swap");
    assert.equal(sent.length, 1, "the retry reads the stored answer and does not run again");
    assert.deepEqual(await spends(pool), [{ idempotency_key: "yesterday-key", usd: 19, day: yesterday }]);
  } finally {
    await drop();
  }
});

test("a key spent on a small swap cannot be approved for a larger one and recorded at the small price", { skip: !TEST_DATABASE_URL }, async () => {
  const { pool, sent, swap, drop } = await harness({ approvalAboveUsd: 10 });
  try {
    assert.equal((await swap("approved-reuse", 1)).body?.status, "would_swap");
    const larger = await swap("approved-reuse", 15);
    assert.equal(larger.isError, true);
    assert.match(larger.text, /already used for a different command/);
    assert.equal((await pool.query("SELECT count(*)::int AS n FROM approvals")).rows[0].n, 0);
    assert.equal(sent.length, 1);
    assert.deepEqual(await spends(pool), [{ idempotency_key: "approved-reuse", usd: 1, day: new Date().toISOString().slice(0, 10) }]);
  } finally {
    await drop();
  }
});

test("an approval claimed before it expires is honored when it expires while the executor runs, and the send is counted", { skip: !TEST_DATABASE_URL }, async () => {
  const { pool, sent, during, swap, approve, drop } = await harness({ approvalAboveUsd: 10 });
  try {
    const asked = await swap("expires-mid-run", 15);
    assert.equal((await approve(String(asked.body?.approvalId))).statusCode, 200);
    during.push(() => pool.query("UPDATE approvals SET expires_at = now() - interval '1 second' WHERE idempotency_key = 'expires-mid-run'"));
    const ran = await swap("expires-mid-run", 15);
    assert.equal(ran.isError, false, "the agent is not told denied for a send the executor carried out");
    assert.equal(ran.body?.status, "would_swap");
    assert.equal(sent.length, 1);
    assert.deepEqual((await pool.query("SELECT usd, state FROM agent_spends WHERE idempotency_key = 'expires-mid-run'")).rows, [{ usd: 15, state: "committed" }]);
    assert.equal((await pool.query("SELECT 1 FROM audit_events WHERE action = 'mcp.swap_planned' AND detail->>'idempotencyKey' = 'expires-mid-run'")).rowCount, 1);
    assert.equal((await swap("expires-mid-run", 15)).body?.status, "would_swap", "a retry of the spent approval gets the stored answer and does not run again");
  } finally {
    await drop();
  }
});

test("a burst of retries of one approval reaches the executor once, answers every caller, and leaves the pool free", { skip: !TEST_DATABASE_URL }, async () => {
  const { pool, sent, during, swap, approve, drop } = await harness({ approvalAboveUsd: 10 });
  try {
    const asked = await swap("burst", 15);
    assert.equal((await approve(String(asked.body?.approvalId))).statusCode, 200);
    let release: () => void = () => undefined;
    const held = new Promise<void>((resolve) => (release = resolve));
    let entered: () => void = () => undefined;
    const inside = new Promise<void>((resolve) => (entered = resolve));
    during.push(async () => (entered(), await held));
    const first = swap("burst", 15);
    await inside;
    const others = await Promise.race([Promise.all(Array.from({ length: 5 }, () => swap("burst", 15))), new Promise<null>((resolve) => setTimeout(() => resolve(null), 8000))]);
    assert.ok(others, "every concurrent caller got an answer while the first send was in flight");
    for (const reply of others) assert.equal(reply.body?.status, "settling");
    release();
    assert.equal((await first).body?.status, "would_swap");
    assert.equal(sent.length, 1);
    assert.equal((await swap("burst", 15)).body?.status, "would_swap", "a retry of the spent approval gets the stored answer and does not run again");
    assert.equal(pool.waitingCount, 0);
  } finally {
    await drop();
  }
});

test("two concurrent swaps that each fit the daily cap but not together execute exactly once", { skip: !TEST_DATABASE_URL }, async () => {
  const { pool, sent, during, swap, drop } = await harness({ approvalAboveUsd: null });
  try {
    assert.equal((await swap("race-0", 15)).body?.status, "would_swap");
    let arrived = 0;
    let release: () => void = () => undefined;
    const both = new Promise<void>((resolve) => (release = resolve));
    const hold = async () => {
      arrived += 1;
      if (arrived === 2) release();
      await Promise.race([both, new Promise((resolve) => setTimeout(resolve, 1000))]);
    };
    during.push(hold, hold);
    const replies = await Promise.all([swap("race-a", 15), swap("race-b", 15)]);
    assert.equal(sent.length, 2, "the first swap and exactly one of the racing pair reached the executor");
    assert.equal(replies.filter((reply) => !reply.isError).length, 1);
    assert.match(replies.find((reply) => reply.isError)?.text ?? "", /above this agent's 40\.00 USD daily cap/);
    const total = await pool.query("SELECT sum(usd)::float8 AS usd FROM agent_spends");
    assert.equal(total.rows[0].usd, 30);
  } finally {
    await drop();
  }
});

test("a transfer with no approval threshold is refused over the per-transaction cap and over the daily cap", { skip: !TEST_DATABASE_URL }, async () => {
  const { sent, transfer, drop } = await harness({ approvalAboveUsd: null });
  try {
    assert.match((await transfer("xfer-huge", 25)).text, /the transfer moves about 25\.00 USD, above this agent's 20\.00 USD per-transaction cap/);
    assert.equal((await transfer("xfer-1", 19)).isError, false);
    assert.equal((await transfer("xfer-2", 19)).isError, false);
    assert.match((await transfer("xfer-3", 3)).text, /the transfer would take today's total to about 41\.00 USD, above this agent's 40\.00 USD daily cap/);
    assert.equal(sent.length, 2);
  } finally {
    await drop();
  }
});

test("an approved transfer counts toward the daily total, so a later swap gets no headroom it should not have", { skip: !TEST_DATABASE_URL }, async () => {
  const { pool, sent, swap, transfer, approve, drop } = await harness({ approvalAboveUsd: 10 });
  try {
    const asked = await transfer("xfer-approved", 15);
    assert.equal(asked.body?.status, "approval_required");
    assert.equal(asked.body?.estimateUsd, 15);
    assert.equal((await approve(String(asked.body?.approvalId))).statusCode, 200);
    assert.equal((await transfer("xfer-approved", 15)).isError, false);
    assert.deepEqual((await pool.query("SELECT usd, state FROM agent_spends WHERE idempotency_key = 'xfer-approved'")).rows, [{ usd: 15, state: "committed" }]);
    assert.equal((await swap("swap-after-transfer", 10)).body?.status, "would_swap");
    assert.equal((await swap("swap-after-transfer-2", 9)).body?.status, "would_swap");
    assert.match((await swap("swap-over", 7)).text, /about 41\.00 USD, above this agent's 40\.00 USD daily cap/);
    assert.equal(sent.length, 3);
  } finally {
    await drop();
  }
});

test("a transfer Whale cannot price is refused with that reason, with no approval and no executor call", { skip: !TEST_DATABASE_URL }, async () => {
  for (const approvalAboveUsd of [null, 10]) {
    const { sent, approvals, transfer, drop } = await harness({ approvalAboveUsd, quoteUsd: ethAt(3000) });
    try {
      const unpriced = await transfer(`xfer-junk-${approvalAboveUsd}`, 0, JUNK);
      assert.equal(unpriced.isError, true);
      assert.match(unpriced.text, /the transfer moves a token Whale could not price on base, so Whale refused it\. No approval was requested and nothing was sent/);
      assert.equal(await approvals(), 0);
      assert.equal(sent.length, 0);
    } finally {
      await drop();
    }
  }
});

test("a native-asset transfer is priced and counted against the daily cap", { skip: !TEST_DATABASE_URL }, async () => {
  const { pool, sent, approvals, transfer, drop } = await harness({ approvalAboveUsd: null, quoteUsd: ethAt(3000) });
  try {
    assert.equal((await transfer("eth-1", 0, ETH, eth(0.005))).isError, false);
    assert.equal((await transfer("eth-2", 0, ETH, eth(0.005))).isError, false);
    assert.deepEqual((await pool.query("SELECT usd, state FROM agent_spends WHERE idempotency_key LIKE 'eth-%' ORDER BY idempotency_key")).rows, [{ usd: 15, state: "committed" }, { usd: 15, state: "committed" }]);
    assert.match((await transfer("eth-3", 0, ETH, eth(0.005))).text, /the transfer would take today's total to about 45\.00 USD, above this agent's 40\.00 USD daily cap/);
    assert.equal(await approvals(), 0);
    assert.equal(sent.length, 2);
  } finally {
    await drop();
  }
});

test("a native-asset transfer over the per-transaction cap is refused, with no approval, threshold or not", { skip: !TEST_DATABASE_URL }, async () => {
  for (const approvalAboveUsd of [null, 10]) {
    const { sent, approvals, transfer, drop } = await harness({ approvalAboveUsd, quoteUsd: ethAt(3000) });
    try {
      assert.match((await transfer(`eth-over-${approvalAboveUsd}`, 0, ETH, eth(0.01))).text, /the transfer moves about 30\.00 USD, above this agent's 20\.00 USD per-transaction cap/);
      assert.equal(await approvals(), 0);
      assert.equal(sent.length, 0);
    } finally {
      await drop();
    }
  }
});

test("a retry of a send already committed is not priced again, so a quote outage cannot call it unsent", { skip: !TEST_DATABASE_URL }, async () => {
  let quotes = true;
  const { pool, sent, quoted, reports, transfer, drop } = await harness({ approvalAboveUsd: null, quoteUsd: (command) => (quotes ? ethAt(3000)(command) : null) });
  try {
    assert.equal((await transfer("eth-retry", 0, ETH, eth(0.005))).isError, false);
    quotes = false;
    const asked = quoted.length;
    reports.push({ state: "executed", value: { kind: "transfer", status: "would_send" } });
    const retried = await transfer("eth-retry", 0, ETH, eth(0.005));
    assert.equal(retried.isError, false, retried.text);
    assert.equal(retried.body?.status, "would_send");
    assert.equal(quoted.length, asked);
    assert.equal(sent.length, 1, "the retry reads the executor's record and does not run the send again");
    assert.deepEqual((await pool.query("SELECT usd, state FROM agent_spends WHERE idempotency_key = 'eth-retry'")).rows, [{ usd: 15, state: "committed" }]);
  } finally {
    await drop();
  }
});

test("with no approval threshold, no send of any kind creates an approval", { skip: !TEST_DATABASE_URL }, async () => {
  const { approvals, swap, transfer, drop } = await harness({ approvalAboveUsd: null, quoteUsd: ethAt(3000) });
  try {
    await swap("none-usdc", 15);
    await swap("none-usdc-over", 25);
    await swap("none-weth", 0, WETH);
    await swap("none-junk", 0, JUNK);
    await transfer("none-xfer", 15);
    await transfer("none-xfer-over", 25);
    await transfer("none-eth", 0, ETH, eth(0.005));
    await transfer("none-eth-over", 0, ETH, eth(1));
    await transfer("none-junk-xfer", 0, JUNK);
    assert.equal(await approvals(), 0);
  } finally {
    await drop();
  }
});

test("with a threshold, a priced send asks only above it", { skip: !TEST_DATABASE_URL }, async () => {
  const { sent, approvals, transfer, drop } = await harness({ approvalAboveUsd: 10, quoteUsd: ethAt(3000) });
  try {
    assert.equal((await transfer("under-threshold", 5)).isError, false);
    assert.equal((await transfer("eth-under-threshold", 0, ETH, eth(0.003))).isError, false);
    const asked = await transfer("eth-over-threshold", 0, ETH, eth(0.005));
    assert.equal(asked.body?.status, "approval_required");
    assert.equal(asked.body?.estimateUsd, 15);
    assert.equal(await approvals(), 1);
    assert.equal(sent.length, 2);
  } finally {
    await drop();
  }
});

test("a large amount that moves a thin market is priced at the market's small-trade rate, not the lower rate its own size gets", { skip: !TEST_DATABASE_URL }, async () => {
  const thin = (command: QuoteCommand) => (command.sellToken === ETH ? Math.min((Number(command.sellAmount) / Number(ONE_ETH)) * 3000, 15) : null);
  const { sent, approvals, transfer, drop } = await harness({ approvalAboveUsd: null, quoteUsd: thin });
  try {
    const big = await transfer("eth-thin", 0, ETH, ONE_ETH.toString());
    assert.equal(big.isError, true);
    assert.match(big.text, /the transfer moves about 3000\.00 USD, above this agent's 20\.00 USD per-transaction cap/);
    assert.equal(await approvals(), 0);
    assert.equal(sent.length, 0);
  } finally {
    await drop();
  }
});

test("a transfer over the per-transaction cap is refused before the owner is asked, and a lowercase stablecoin address is priced the same", { skip: !TEST_DATABASE_URL }, async () => {
  const { pool, sent, transfer, drop } = await harness({ approvalAboveUsd: 10 });
  try {
    assert.match((await transfer("xfer-over-threshold-wallet", 25)).text, /the transfer moves about 25\.00 USD, above this agent's 20\.00 USD per-transaction cap/);
    assert.equal((await pool.query("SELECT count(*)::int AS n FROM approvals")).rows[0].n, 0);
    assert.match((await transfer("xfer-lowercase", 25, USDC.toLowerCase())).text, /per-transaction cap/);
    for (const amount of ["1.5", "-5000000", "0", "abc"]) {
      const bad = await transfer(`xfer-bad-${amount.length}`, 0, USDC, amount);
      assert.equal(bad.isError, true, amount);
      assert.match(bad.text, /arguments do not match/, amount);
    }
    assert.equal((await pool.query("SELECT count(*)::int AS n FROM approvals")).rows[0].n, 0);
    assert.equal(sent.length, 0);
  } finally {
    await drop();
  }
});
