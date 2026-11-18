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
const usdc = (dollars: number) => String(Math.round(dollars * 1_000_000));

type Reply = { isError: boolean; text: string; body: Record<string, unknown> | null };

async function harness(options: { approvalAboveUsd: number | null; netOutputUsd?: number; walletDailyUsd?: number }) {
  const { pool, drop } = await migratedSchema();
  const sent: HostedRequest[] = [];
  const failures: Error[] = [];
  const during: (() => Promise<unknown>)[] = [];
  const reports: (SendReport | Error | (() => Promise<SendReport>))[] = [];
  const executor: ExecutorClient = {
    report: async () => {
      const next = reports.shift() ?? { executed: false };
      if (next instanceof Error) throw next;
      return typeof next === "function" ? next() : next;
    },
    run: async (request) => {
      await during.shift()?.();
      const failure = failures.shift();
      if (failure) throw failure;
      sent.push(request);
      return { kind: "swap", status: "would_swap", quote: { buyAmount: "42", feeUsd: 0, netOutputUsd: options.netOutputUsd } };
    },
  };
  const app = await buildGateway({ config: gatewayConfig(), pool, logger: false, keys: { key: async () => null }, executor, turnkey: null, delegation: null });
  const user = await signedInAccount(pool);
  const created = await createWallet(pool, user.accountId, { label: "main", level: "enclave" });
  const walletId = "walletId" in created ? created.walletId : "";
  await pool.query("INSERT INTO wallet_addresses (wallet_id, family, address) VALUES ($1, 'evm', $2)", [walletId, OWN]);
  const policy = await pool.query("SELECT document FROM policies WHERE wallet_id = $1", [walletId]);
  await pool.query("UPDATE policies SET document = $2 WHERE wallet_id = $1", [walletId, JSON.stringify({ ...policy.rows[0].document, actions: ["swap", "transfer"], approvalAboveUsd: options.approvalAboveUsd, ...(options.walletDailyUsd ? { dailyUsd: options.walletDailyUsd } : {}) })]);
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
  const approve = async (approvalId: string) => {
    const approval = (await app.inject({ method: "GET", url: "/api/approvals", headers: user.headers })).json().approvals.find((entry: { id: string }) => entry.id === approvalId);
    const stepUp = (await app.inject({ method: "POST", url: "/api/passkeys/step-up", headers: user.headers, payload: { action: { kind: "approval.approve", approvalId, command: approval.command } } })).json();
    return app.inject({ method: "POST", url: `/api/approvals/${approvalId}/approve`, headers: user.headers, payload: { assertion: authenticator.assert(stepUp.challenge) } });
  };
  const sweep = (graceMs = 0) => settleStaleSends(pool, executor, graceMs);
  return { app, pool, user, walletId, sent, failures, during, reports, sweep, call, swap, approve, drop: async () => (await app.close(), await drop()) };
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
      assert.equal(unpriced.body?.status, "approval_required");
      assert.equal(unpriced.body?.estimateUsd, null);
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

test("an executor that refuses a send releases the approval at once for the retry, and a spent approval says so", { skip: !TEST_DATABASE_URL }, async () => {
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
    assert.match((await swap("refused-by-executor", 15)).text, /already used/);
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
      ["lost-before-broadcast", { executed: false }, { spend: "released", approval: "approved" }],
      ["lost-after-broadcast", { executed: true, value: { status: "sent" } }, { spend: "committed", approval: "used" }],
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
    assert.match((await swap("lost-after-broadcast", 15)).text, /already used/);
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
    reports.push({ executed: false });
    assert.equal(await sweep(60_000), 0, "a reservation younger than the grace is not asked about");
    assert.deepEqual(await state("re-reserved"), { spend: "reserved", approval: "claimed" });
    await pool.query("UPDATE agent_spends SET reserved_at = now() - interval '2 minutes'");
    await pool.query("UPDATE approvals SET claimed_at = now() - interval '2 minutes'");
    reports.length = 0;
    reports.push(async () => {
      await pool.query("UPDATE agent_spends SET reserved_at = now()");
      await pool.query("UPDATE approvals SET claimed_at = now()");
      return { executed: false };
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

test("with no approval threshold, a swap Whale cannot price still waits for the owner instead of skipping the caps", { skip: !TEST_DATABASE_URL }, async () => {
  const { sent, swap, drop } = await harness({ approvalAboveUsd: null });
  try {
    const unpriced = await swap("weth-no-threshold", 0, WETH);
    assert.equal(unpriced.isError, false);
    assert.equal(unpriced.body?.status, "approval_required");
    assert.equal(unpriced.body?.estimateUsd, null);
    assert.equal((await swap("usdc-no-threshold", 5)).body?.status, "would_swap");
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
    assert.equal(sent.length, 2);
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
    assert.match((await swap("expires-mid-run", 15)).text, /already used/);
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
    assert.match((await swap("burst", 15)).text, /already used/);
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
