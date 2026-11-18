import assert from "node:assert/strict";
import test from "node:test";
import { createAgent } from "../src/gateway/agents.js";
import { buildGateway } from "../src/gateway/app.js";
import type { ExecutorClient } from "../src/gateway/executor-client.js";
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
type Request = { approvalId: string; idempotencyKey: string; status: string };

async function harness() {
  const { pool, drop } = await migratedSchema();
  const sent: HostedRequest[] = [];
  const during: (() => Promise<unknown>)[] = [];
  const executor: ExecutorClient = {
    report: async () => ({ state: "not_started" }),
    run: async (request) => {
      await during.shift()?.();
      sent.push(request);
      return { kind: "swap", status: "would_swap", quote: { buyAmount: "42", feeUsd: 0 } };
    },
  };
  const app = await buildGateway({ config: gatewayConfig(), pool, logger: false, keys: { key: async () => null }, executor, turnkey: null, delegation: null });
  const user = await signedInAccount(pool);
  const created = await createWallet(pool, user.accountId, { label: "main", level: "enclave" });
  const walletId = "walletId" in created ? created.walletId : "";
  await pool.query("INSERT INTO wallet_addresses (wallet_id, family, address) VALUES ($1, 'evm', $2)", [walletId, OWN]);
  const policy = await pool.query("SELECT document FROM policies WHERE wallet_id = $1", [walletId]);
  await pool.query("UPDATE policies SET document = $2 WHERE wallet_id = $1", [walletId, JSON.stringify({ ...policy.rows[0].document, actions: ["swap", "transfer"], approvalAboveUsd: 10 })]);
  const limits = { chains: ["base"], actions: ["swap", "transfer"] as ("swap" | "transfer")[], maxTxUsd: 20, dailyUsd: 40 };
  const first = await createAgent(pool, { accountId: user.accountId, walletId, name: "first", limits });
  const second = await createAgent(pool, { accountId: user.accountId, walletId, name: "second", limits });
  if ("refused" in first || "refused" in second) throw new Error("agent refused");
  const authenticator = softAuthenticator({ rpId: "whale.example", origin: ORIGIN });
  const registration = (await app.inject({ method: "POST", url: "/api/passkeys/options", headers: user.headers, payload: {} })).json();
  assert.equal((await app.inject({ method: "POST", url: "/api/passkeys", headers: user.headers, payload: { credential: authenticator.register(registration.challenge), label: "Mac" } })).statusCode, 201);

  const call = async (apiKey: string, name: string, args: Record<string, unknown>): Promise<Reply> => {
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
  const swap = (apiKey: string, key: string, dollars: number) => call(apiKey, "swap", { chain: "base", sellToken: USDC, buyToken: WETH, sellAmount: usdc(dollars), idempotencyKey: key });
  const ask = async (apiKey: string, key: string) => {
    const reply = await swap(apiKey, key, 15);
    assert.equal(reply.body?.status, "approval_required");
    return String(reply.body?.approvalId);
  };
  const open = async (apiKey: string) => {
    const reply = await call(apiKey, "pending_requests", {});
    assert.equal(reply.isError, false, reply.text);
    return (reply.body?.requests as Request[]).map((entry) => entry.idempotencyKey).sort();
  };
  const cancel = (apiKey: string, approvalId: string) => call(apiKey, "cancel_request", { approvalId });
  const owner = async (status: string) => (await app.inject({ method: "GET", url: `/api/approvals?status=${status}`, headers: user.headers })).json().approvals as { id: string; status: string }[];
  const approve = async (approvalId: string) => {
    const approval = (await owner("pending")).find((entry) => entry.id === approvalId) as unknown as { command: unknown };
    const stepUp = (await app.inject({ method: "POST", url: "/api/passkeys/step-up", headers: user.headers, payload: { action: { kind: "approval.approve", approvalId, command: approval.command } } })).json();
    return app.inject({ method: "POST", url: `/api/approvals/${approvalId}/approve`, headers: user.headers, payload: { assertion: authenticator.assert(stepUp.challenge) } });
  };
  const expire = (approvalId: string) => pool.query("UPDATE approvals SET expires_at = now() - interval '1 second' WHERE id = $1", [approvalId]);
  return { app, pool, user, sent, during, first: first.apiKey, second: second.apiKey, swap, ask, open, cancel, owner, approve, expire, drop: async () => (await app.close(), await drop()) };
}

test("an approval request past its hour is listed as expired, not as pending, with no read to update it", { skip: !TEST_DATABASE_URL }, async () => {
  const { first, ask, owner, expire, drop } = await harness();
  try {
    const stale = await ask(first, "stale-request");
    const fresh = await ask(first, "fresh-request");
    await expire(stale);
    assert.deepEqual((await owner("pending")).map((entry) => [entry.id, entry.status]), [[fresh, "pending"]]);
    assert.deepEqual((await owner("expired")).map((entry) => [entry.id, entry.status]), [[stale, "expired"]]);
  } finally {
    await drop();
  }
});

test("pending_requests lists only this agent's open requests", { skip: !TEST_DATABASE_URL }, async () => {
  const { app, user, first, second, ask, open, approve, expire, drop } = await harness();
  try {
    await ask(first, "first-open");
    assert.equal((await approve(await ask(first, "first-approved"))).statusCode, 200);
    await expire(await ask(first, "first-expired"));
    const denied = await ask(first, "first-denied");
    assert.equal((await app.inject({ method: "POST", url: `/api/approvals/${denied}/deny`, headers: user.headers, payload: {} })).statusCode, 200);
    await ask(second, "second-open");
    assert.deepEqual(await open(first), ["first-approved", "first-open"]);
    assert.deepEqual(await open(second), ["second-open"]);
  } finally {
    await drop();
  }
});

test("cancel_request denies an agent's own request with the owner-denial audit and webhook event, and leaves nothing reserved or claimed", { skip: !TEST_DATABASE_URL }, async () => {
  const { app, pool, user, sent, first, ask, open, cancel, owner, approve, drop } = await harness();
  try {
    const hook = await app.inject({ method: "POST", url: "/api/webhooks", headers: user.headers, payload: { url: "https://hooks.example/whale", format: "whale", events: ["approval.denied"] } });
    assert.equal(hook.statusCode, 201);
    const pending = await ask(first, "cancel-pending");
    const approved = await ask(first, "cancel-approved");
    assert.equal((await approve(approved)).statusCode, 200);

    for (const approvalId of [pending, approved]) {
      const cancelled = await cancel(first, approvalId);
      assert.equal(cancelled.isError, false, cancelled.text);
      assert.deepEqual(cancelled.body, { approvalId, status: "denied" });
    }
    assert.deepEqual(await open(first), []);
    assert.deepEqual((await owner("denied")).map((entry) => entry.id).sort(), [pending, approved].sort());
    const events = await pool.query("SELECT e.actor, e.action, e.detail->>'approvalId' AS id, count(d.id)::int AS deliveries FROM audit_events e LEFT JOIN webhook_deliveries d ON d.event_id = e.id WHERE e.action = 'approval.denied' GROUP BY e.id ORDER BY e.id");
    assert.deepEqual(events.rows, [
      { actor: "agent", action: "approval.denied", id: pending, deliveries: 1 },
      { actor: "agent", action: "approval.denied", id: approved, deliveries: 1 },
    ]);
    const held = await pool.query("SELECT (SELECT count(*)::int FROM agent_spends WHERE state = 'reserved') AS reserved, (SELECT count(*)::int FROM approvals WHERE status = 'claimed') AS claimed");
    assert.deepEqual(held.rows[0], { reserved: 0, claimed: 0 });
    assert.equal(sent.length, 0);
  } finally {
    await drop();
  }
});

test("cancel_request refuses a request whose send is already running, and the send still settles", { skip: !TEST_DATABASE_URL }, async () => {
  const { pool, sent, during, first, ask, cancel, swap, approve, drop } = await harness();
  try {
    const approvalId = await ask(first, "cancel-in-flight");
    assert.equal((await approve(approvalId)).statusCode, 200);
    let refused: Reply | null = null;
    during.push(async () => {
      refused = await cancel(first, approvalId);
    });
    assert.equal((await swap(first, "cancel-in-flight", 15)).body?.status, "would_swap");
    assert.equal(refused!.isError, true);
    assert.match(refused!.text, /already running/);
    assert.equal(sent.length, 1);
    const row = await pool.query("SELECT a.status, s.state FROM approvals a JOIN agent_spends s USING (agent_id, idempotency_key) WHERE a.id = $1", [approvalId]);
    assert.deepEqual(row.rows[0], { status: "used", state: "committed" });
  } finally {
    await drop();
  }
});

test("an agent cannot cancel another agent's request", { skip: !TEST_DATABASE_URL }, async () => {
  const { first, second, ask, open, cancel, drop } = await harness();
  try {
    const approvalId = await ask(first, "not-yours");
    const refused = await cancel(second, approvalId);
    assert.equal(refused.isError, true);
    assert.match(refused.text, /no open request/);
    assert.deepEqual(await open(first), ["not-yours"]);
  } finally {
    await drop();
  }
});

test("a retry of a cancelled idempotencyKey answers that it was cancelled instead of waiting on the owner", { skip: !TEST_DATABASE_URL }, async () => {
  const { sent, first, ask, cancel, swap, drop } = await harness();
  try {
    const approvalId = await ask(first, "cancelled-retry");
    assert.equal((await cancel(first, approvalId)).isError, false);
    const retry = await swap(first, "cancelled-retry", 15);
    assert.equal(retry.isError, true);
    assert.match(retry.text, /cancelled/);
    assert.match(retry.text, /new idempotencyKey/);
    assert.equal(sent.length, 0);
  } finally {
    await drop();
  }
});
