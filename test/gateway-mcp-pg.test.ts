import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import test from "node:test";
import { createAgent } from "../src/gateway/agents.js";
import { buildGateway } from "../src/gateway/app.js";
import type { ExecutorClient } from "../src/gateway/executor-client.js";
import { createWallet } from "../src/gateway/wallets.js";
import type { HostedRequest } from "../src/hosted-commands.js";
import { gatewayConfig, ORIGIN, signedInAccount } from "./gateway-fixtures.js";
import { migratedSchema, TEST_DATABASE_URL } from "./pg-schema.js";

const USDC = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";
const WETH = "0x4200000000000000000000000000000000000006";
const OWN = "0x9999999999999999999999999999999999999999";
const COLD = "0x2222222222222222222222222222222222222222";

async function harness() {
  const { pool, drop } = await migratedSchema();
  const sent: HostedRequest[] = [];
  const executor: ExecutorClient = { run: async (request) => (sent.push(request), { kind: "swap", status: "would_swap", quote: { buyAmount: "42" } }) };
  const app = await buildGateway({ config: gatewayConfig(), pool, logger: false, keys: { key: async () => null }, executor });
  const { accountId } = await signedInAccount(pool);
  const created = await createWallet(pool, accountId, { label: "main", level: "enclave" });
  const walletId = "walletId" in created ? created.walletId : "";
  await pool.query("INSERT INTO wallet_addresses (wallet_id, family, address) VALUES ($1, 'evm', $2)", [walletId, OWN]);
  const policy = await pool.query("SELECT document FROM policies WHERE wallet_id = $1", [walletId]);
  const document = { ...policy.rows[0].document, actions: ["swap", "transfer"], destinations: [{ family: "evm", address: COLD, label: "cold" }] };
  await pool.query("UPDATE policies SET document = $2 WHERE wallet_id = $1", [walletId, JSON.stringify(document)]);
  const agent = await createAgent(pool, { accountId, walletId, name: "bot", limits: { chains: ["base"], actions: ["swap", "transfer"], maxTxUsd: 20, dailyUsd: 40 } });
  if ("refused" in agent) throw new Error(agent.refused);
  const { apiKey, agentId } = agent;
  const rpc = (body: unknown, headers: Record<string, string> = {}, remoteAddress = "127.0.0.1") =>
    app.inject({ method: "POST", url: "/mcp", remoteAddress, headers: { authorization: `Bearer ${apiKey}`, accept: "application/json, text/event-stream", ...headers }, payload: body as Record<string, unknown> });
  const call = async (name: string, args: Record<string, unknown>) => (await rpc({ jsonrpc: "2.0", id: 7, method: "tools/call", params: { name, arguments: args } })).json().result;
  return { app, pool, sent, rpc, call, agentId, accountId, apiKey, drop: async () => (await app.close(), await drop()) };
}

test("MCP over HTTP authenticates the agent, negotiates the version, and refuses foreign origins", { skip: !TEST_DATABASE_URL }, async () => {
  const { app, rpc, apiKey, drop } = await harness();
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
    for (const payload of ["{\"jsonrpc\": \"2.0\", \"id\": 1,", ""]) {
      const garbled = await app.inject({ method: "POST", url: "/mcp", headers: { authorization: `Bearer ${apiKey}`, "content-type": "application/json" }, payload });
      assert.equal(garbled.statusCode, 400);
      assert.deepEqual(garbled.json(), { jsonrpc: "2.0", id: null, error: { code: -32700, message: "parse error" } });
    }
    assert.equal((await rpc({ jsonrpc: "2.0", id: 2, method: "resources/list" })).json().error.code, -32601);
    const tools = (await rpc({ jsonrpc: "2.0", id: 3, method: "tools/list" })).json().result.tools.map((tool: { name: string }) => tool.name);
    assert.deepEqual(tools, ["wallet_status", "deposit_address", "balance", "quote", "swap", "transfer"]);
    assert.equal((await app.inject({ method: "GET", url: "/mcp" })).statusCode, 405);
  } finally {
    await drop();
  }
});

test("hosted tools stay inside the agent's limits and the wallet policy before reaching the executor", { skip: !TEST_DATABASE_URL }, async () => {
  const { pool, sent, call, rpc, app, agentId, accountId, drop } = await harness();
  try {
    const status = JSON.parse((await call("wallet_status", {})).content[0].text);
    assert.equal(status.mode, "dry_run");
    assert.deepEqual(status.limits.chains, ["base"]);
    assert.equal(JSON.parse((await call("deposit_address", { chain: "base" })).content[0].text).address, OWN);

    const swap = await call("swap", { chain: "base", sellToken: USDC, buyToken: WETH, sellAmount: "1000000", idempotencyKey: "swap-0001" });
    assert.equal(swap.isError, false);
    assert.equal(sent[0]?.command.kind, "swap");
    assert.equal(sent[0]?.accountId, accountId);
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

test("/mcp throttles one IP that rotates random keys and one agent that rotates IPs", { skip: !TEST_DATABASE_URL }, async () => {
  const { app, rpc, drop } = await harness();
  try {
    const ping = { jsonrpc: "2.0", id: 1, method: "ping" };
    const rotatingKeys: number[] = [];
    for (let index = 0; index < 130; index += 1) {
      const key = `whale_${randomBytes(6).toString("hex")}_${randomBytes(32).toString("base64url").slice(0, 43)}`;
      const response = await app.inject({ method: "POST", url: "/mcp", remoteAddress: "203.0.113.7", headers: { authorization: `Bearer ${key}` }, payload: ping });
      rotatingKeys.push(response.statusCode);
    }
    assert.deepEqual([...new Set(rotatingKeys.slice(0, 120))], [401]);
    assert.deepEqual([...new Set(rotatingKeys.slice(120))], [429]);

    const rotatingIps: number[] = [];
    for (let index = 0; index < 121; index += 1) rotatingIps.push((await rpc(ping, {}, `198.51.100.${index}`)).statusCode);
    assert.deepEqual([...new Set(rotatingIps.slice(0, 120))], [200]);
    assert.equal(rotatingIps[120], 429);
  } finally {
    await drop();
  }
});

test("/mcp gives every tenant behind one egress IP its own budget", { skip: !TEST_DATABASE_URL }, async () => {
  const { app, pool, rpc, drop } = await harness();
  try {
    const { accountId } = await signedInAccount(pool);
    const created = await createWallet(pool, accountId, { label: "other", level: "enclave" });
    const walletId = "walletId" in created ? created.walletId : "";
    const other = await createAgent(pool, { accountId, walletId, name: "other", limits: { chains: ["base"], actions: ["swap"], maxTxUsd: 20, dailyUsd: 40 } });
    if ("refused" in other) throw new Error(other.refused);
    const ping = { jsonrpc: "2.0", id: 1, method: "ping" };
    const first: number[] = [];
    for (let index = 0; index < 120; index += 1) first.push((await rpc(ping, {}, "34.1.2.3")).statusCode);
    assert.deepEqual([...new Set(first)], [200]);
    assert.equal((await rpc(ping, { authorization: `Bearer ${other.apiKey}` }, "34.1.2.3")).statusCode, 200);
  } finally {
    await drop();
  }
});
