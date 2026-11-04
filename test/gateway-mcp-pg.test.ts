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
const COLD = "0x2222222222222222222222222222222222222222";

async function harness(options: { approvalAboveUsd?: number | null; quoteUsd?: () => number | undefined } = {}) {
  const { pool, drop } = await migratedSchema();
  const sent: HostedRequest[] = [];
  const executor: ExecutorClient = {
    run: async (request) => (sent.push(request), { kind: "swap", status: "would_swap", quote: { buyAmount: "42", feeUsd: 0, netOutputUsd: options.quoteUsd?.() } }),
  };
  const app = await buildGateway({ config: gatewayConfig(), pool, logger: false, keys: { key: async () => null }, executor, turnkey: null, delegation: null });
  const user = await signedInAccount(pool);
  const { accountId } = user;
  const created = await createWallet(pool, accountId, { label: "main", level: "enclave" });
  const walletId = "walletId" in created ? created.walletId : "";
  await pool.query("INSERT INTO wallet_addresses (wallet_id, family, address) VALUES ($1, 'evm', $2)", [walletId, OWN]);
  const policy = await pool.query("SELECT document FROM policies WHERE wallet_id = $1", [walletId]);
  const document = {
    ...policy.rows[0].document,
    actions: ["swap", "transfer"],
    destinations: [{ family: "evm", address: COLD, label: "cold" }],
    approvalAboveUsd: options.approvalAboveUsd === undefined ? null : options.approvalAboveUsd,
  };
  await pool.query("UPDATE policies SET document = $2 WHERE wallet_id = $1", [walletId, JSON.stringify(document)]);
  const { apiKey, agentId } = await createAgent(pool, { accountId, walletId, name: "bot", limits: { chains: ["base"], actions: ["swap", "transfer"], maxTxUsd: 20, dailyUsd: 40 } });
  const rpc = (body: unknown, headers: Record<string, string> = {}) =>
    app.inject({ method: "POST", url: "/mcp", headers: { authorization: `Bearer ${apiKey}`, accept: "application/json, text/event-stream", ...headers }, payload: body as Record<string, unknown> });
  const call = async (name: string, args: Record<string, unknown>) => (await rpc({ jsonrpc: "2.0", id: 7, method: "tools/call", params: { name, arguments: args } })).json().result;
  return { app, pool, user, sent, rpc, call, agentId, drop: async () => (await app.close(), await drop()) };
}

test("MCP over HTTP authenticates the agent, negotiates the version, and refuses foreign origins", { skip: !TEST_DATABASE_URL }, async () => {
  const { app, rpc, drop } = await harness();
  try {
    const anonymous = await app.inject({ method: "POST", url: "/mcp", payload: { jsonrpc: "2.0", id: 1, method: "ping" } });
    assert.equal(anonymous.statusCode, 401);
    assert.match(String(anonymous.headers["www-authenticate"]), /^Bearer resource_metadata="https:\/\/whale\.example\/\.well-known\/oauth-protected-resource\/mcp"$/);
    const forged = await rpc({ jsonrpc: "2.0", id: 1, method: "ping" }, { authorization: "Bearer whale_000000000000_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA" });
    assert.match(String(forged.headers["www-authenticate"]), /error="invalid_token"/);
    assert.equal((await rpc({ jsonrpc: "2.0", id: 1, method: "ping" }, { origin: "https://evil.example" })).statusCode, 403);
    assert.equal((await rpc({ jsonrpc: "2.0", id: 1, method: "ping" }, { origin: ORIGIN })).statusCode, 200);
    assert.equal((await rpc({ jsonrpc: "2.0", id: 1, method: "ping" }, { "mcp-protocol-version": "1999-01-01" })).statusCode, 400);
    const init = await rpc({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "t", version: "1" } } });
    assert.equal(init.json().result.protocolVersion, "2025-06-18");
    const unknown = await rpc({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2030-01-01" } });
    assert.equal(unknown.json().result.protocolVersion, "2026-07-28");
    assert.equal((await rpc({ jsonrpc: "2.0", method: "notifications/initialized" })).statusCode, 202);
    assert.equal((await rpc([{ jsonrpc: "2.0", id: 1, method: "ping" }])).statusCode, 400);
    assert.equal((await rpc({ jsonrpc: "2.0", id: 2, method: "resources/list" })).json().error.code, -32601);
    const tools = (await rpc({ jsonrpc: "2.0", id: 3, method: "tools/list" })).json().result.tools.map((tool: { name: string }) => tool.name);
    assert.deepEqual(tools, ["wallet_status", "deposit_address", "balance", "quote", "swap", "transfer"]);
    assert.equal((await app.inject({ method: "GET", url: "/mcp" })).statusCode, 405);
  } finally {
    await drop();
  }
});

test("hosted tools stay inside the agent's limits and the wallet policy before reaching the executor", { skip: !TEST_DATABASE_URL }, async () => {
  const { pool, sent, call, rpc, app, agentId, drop } = await harness();
  try {
    const status = JSON.parse((await call("wallet_status", {})).content[0].text);
    assert.equal(status.mode, "dry_run");
    assert.deepEqual(status.limits.chains, ["base"]);
    assert.equal(JSON.parse((await call("deposit_address", { chain: "base" })).content[0].text).address, OWN);

    const swap = await call("swap", { chain: "base", sellToken: USDC, buyToken: WETH, sellAmount: "1000000", idempotencyKey: "swap-0001" });
    assert.equal(swap.isError, false);
    assert.equal(sent[0]?.command.kind, "swap");
    assert.equal(sent[0]?.command.kind === "swap" && sent[0].command.taker, OWN);
    assert.equal(sent[0]?.command.kind === "swap" && sent[0].command.slippageBps, 50);

    const denials: [string, Record<string, unknown>, RegExp][] = [
      ["quote", { chain: "arbitrum", sellToken: USDC, buyToken: WETH, sellAmount: "1" }, /outside this agent's chains/],
      ["quote", { chain: "base", sellToken: USDC, buyToken: WETH, sellAmount: "1", slippageBps: 500 }, /slippage/],
      ["transfer", { chain: "base", token: USDC, to: WETH, amount: "1", idempotencyKey: "xfer-0001" }, /destination list/],
      ["swap", { chain: "base", sellToken: USDC, buyToken: WETH, sellAmount: "1" }, /idempotencyKey/],
      ["balance", { chain: "solana" }, /no address on that chain/],
      ["teleport", {}, /unknown tool/],
    ];
    for (const [name, args, reason] of denials) {
      const result = await call(name, args);
      assert.equal(result.isError, true, name);
      assert.match(result.content[0].text, reason);
    }
    assert.equal(sent.length, 1);
    const transfer = await call("transfer", { chain: "base", token: USDC, to: COLD.toUpperCase().replace("0X", "0x"), amount: "1", idempotencyKey: "xfer-0002" });
    assert.equal(transfer.isError, false);
    assert.equal(sent.length, 2);

    const actions = await pool.query("SELECT action, detail->>'tool' AS tool FROM audit_events WHERE actor = 'agent' ORDER BY id");
    assert.deepEqual(actions.rows.map((row) => row.action), ["mcp.swap_planned", "mcp.denied", "mcp.denied", "mcp.denied", "mcp.transfer_planned"]);

    await pool.query("UPDATE agents SET revoked_at = now() WHERE id = $1", [agentId]);
    assert.equal((await rpc({ jsonrpc: "2.0", id: 9, method: "tools/list" })).statusCode, 401);
    void app;
  } finally {
    await drop();
  }
});

test("sends above the threshold wait for a passkey approval of that exact command, and the cap still refuses", { skip: !TEST_DATABASE_URL }, async () => {
  let price: number | undefined = 15;
  const { app, pool, user, sent, call, drop } = await harness({ approvalAboveUsd: 10, quoteUsd: () => price });
  try {
    const authenticator = softAuthenticator({ rpId: "whale.example", origin: ORIGIN });
    const options = (await app.inject({ method: "POST", url: "/api/passkeys/options", headers: user.headers, payload: {} })).json();
    await app.inject({ method: "POST", url: "/api/passkeys", headers: user.headers, payload: { credential: authenticator.register(options.challenge), label: "Mac" } });
    const swap = { chain: "base", sellToken: USDC, buyToken: WETH, sellAmount: "15000000", idempotencyKey: "swap-big-1" };
    const asked = JSON.parse((await call("swap", swap)).content[0].text);
    assert.equal(asked.status, "approval_required");
    assert.equal(asked.estimateUsd, 15);
    assert.equal(JSON.parse((await call("swap", swap)).content[0].text).status, "approval_pending");
    const conflict = await call("swap", { ...swap, sellAmount: "1" });
    assert.equal(conflict.isError, true);

    const pending = (await app.inject({ method: "GET", url: "/api/approvals?status=pending", headers: user.headers })).json().approvals;
    assert.equal(pending.length, 1);
    const approval = pending[0];
    assert.equal((await app.inject({ method: "POST", url: `/api/approvals/${approval.id}/approve`, headers: user.headers, payload: {} })).statusCode, 428);
    const stepUp = (await app.inject({ method: "POST", url: "/api/passkeys/step-up", headers: user.headers, payload: { action: { kind: "approval.approve", approvalId: approval.id, command: approval.command } } })).json();
    const approved = await app.inject({ method: "POST", url: `/api/approvals/${approval.id}/approve`, headers: user.headers, payload: { assertion: authenticator.assert(stepUp.challenge) } });
    assert.deepEqual(approved.json(), { status: "approved" });

    const before = sent.length;
    const planned = await call("swap", swap);
    assert.equal(planned.isError, false);
    assert.equal(JSON.parse(planned.content[0].text).status, "would_swap");
    assert.equal(sent.length, before + 1);
    const reused = JSON.parse((await call("swap", swap)).content[0].text);
    assert.equal(reused.status, "approval_required", "an approval is spent once; the same key asks again");

    price = 25;
    const tooBig = await call("swap", { ...swap, idempotencyKey: "swap-big-2" });
    assert.match(tooBig.content[0].text, /above this agent's 20\.00 USD per-transaction cap/);

    const transfer = JSON.parse((await call("transfer", { chain: "base", token: USDC, to: COLD, amount: "1", idempotencyKey: "xfer-1" })).content[0].text);
    assert.equal(transfer.status, "approval_required");
    const transferApproval = (await app.inject({ method: "GET", url: "/api/approvals?status=pending", headers: user.headers })).json().approvals.find((entry: { kind: string }) => entry.kind === "transfer");
    assert.deepEqual((await app.inject({ method: "POST", url: `/api/approvals/${transferApproval.id}/deny`, headers: user.headers, payload: {} })).json(), { status: "denied" });
    const refused = await call("transfer", { chain: "base", token: USDC, to: COLD, amount: "1", idempotencyKey: "xfer-1" });
    assert.match(refused.content[0].text, /denied/);

    const activity = (await app.inject({ method: "GET", url: "/api/activity", headers: user.headers })).json().events;
    assert.ok(activity.some((event: { action: string; agentName: string }) => event.action === "approval.approved"));
    assert.ok(activity.some((event: { action: string; agentName: string | null }) => event.action === "approval.requested" && event.agentName === "bot"));
    const older = (await app.inject({ method: "GET", url: `/api/activity?before=${activity[activity.length - 1].id}`, headers: user.headers })).json().events;
    assert.ok(older.every((event: { id: number }) => event.id < activity[activity.length - 1].id));
    const other = await signedInAccount(pool);
    assert.equal((await app.inject({ method: "POST", url: `/api/approvals/${approval.id}/deny`, headers: other.headers, payload: {} })).statusCode, 404);
    assert.deepEqual((await app.inject({ method: "GET", url: "/api/activity", headers: other.headers })).json().events, []);
  } finally {
    await drop();
  }
});
