import assert from "node:assert/strict";
import test from "node:test";
import { authenticateApiKey, createAgent } from "../src/gateway/agents.js";
import { buildGateway } from "../src/gateway/app.js";
import type { ExecutorClient } from "../src/gateway/executor-client.js";
import { pkceChallenge, randomToken } from "../src/gateway/google.js";
import { gatewayApp } from "../src/gateway/http.js";
import { registerMcpRoutes } from "../src/gateway/mcp-http.js";
import { freezeWallets, unfreezeAction } from "../src/gateway/policy-changes.js";
import { createWallet } from "../src/gateway/wallets.js";
import type { HostedRequest } from "../src/hosted-commands.js";
import { gatewayConfig, ORIGIN, signedInAccount } from "./gateway-fixtures.js";
import { migratedSchema, TEST_DATABASE_URL } from "./pg-schema.js";
import { softAuthenticator } from "./webauthn-fixtures.js";

const REDIRECT = "http://127.0.0.1:33418/callback";
const LIMITS = { chains: ["base"], actions: ["swap" as const], maxTxUsd: 20, dailyUsd: 40 };
const USDC = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";
const WETH = "0x4200000000000000000000000000000000000006";
const OWN = "0x9999999999999999999999999999999999999999";

async function harness() {
  const { pool, drop } = await migratedSchema();
  const sent: HostedRequest[] = [];
  const executor: ExecutorClient = {
    report: async () => ({ state: "not_started" as const }),
    run: async (request) => {
      sent.push(request);
      return { kind: "swap", status: "would_swap", quote: { buyAmount: "42" } };
    },
  };
  const app = await buildGateway({ config: gatewayConfig(), pool, logger: false, keys: { key: async () => null }, executor, turnkey: null, delegation: null });
  const user = await signedInAccount(pool);
  const authenticator = softAuthenticator({ rpId: "whale.example", origin: ORIGIN });
  const options = (await app.inject({ method: "POST", url: "/api/passkeys/options", headers: user.headers, payload: {} })).json();
  await app.inject({ method: "POST", url: "/api/passkeys", headers: user.headers, payload: { credential: authenticator.register(options.challenge), label: "Mac" } });
  const walletId = (await app.inject({ method: "POST", url: "/api/wallets", headers: user.headers, payload: { label: "main", level: "enclave" } })).json().id as string;
  await pool.query("INSERT INTO wallet_addresses (wallet_id, family, address) VALUES ($1, 'evm', $2)", [walletId, OWN]);
  const form = (url: string, fields: Record<string, string>) =>
    app.inject({ method: "POST", url, headers: { "content-type": "application/x-www-form-urlencoded" }, payload: new URLSearchParams(fields).toString() });
  const clientId = (await app.inject({ method: "POST", url: "/oauth/register", payload: { client_name: "Claude Code", redirect_uris: [REDIRECT] } })).json().client_id as string;
  const approve = async () => {
    const verifier = randomToken(48);
    const query = new URLSearchParams({ response_type: "code", client_id: clientId, redirect_uri: REDIRECT, code_challenge: pkceChallenge(verifier), code_challenge_method: "S256", state: "st-1", resource: `${ORIGIN}/mcp` });
    const authorized = await app.inject({ method: "GET", url: `/oauth/authorize?${query}` });
    const request = new URL(String(authorized.headers.location), ORIGIN).searchParams.get("request") as string;
    const approved = await app.inject({ method: "POST", url: `/api/oauth/requests/${request}/approve`, headers: user.headers, payload: { walletId, name: "Claude", limits: LIMITS } });
    return { approved, verifier };
  };
  const signIn = async () => {
    const { approved, verifier } = await approve();
    const code = new URL(approved.json().redirect).searchParams.get("code") as string;
    return (await form("/oauth/token", { grant_type: "authorization_code", code, redirect_uri: REDIRECT, client_id: clientId, code_verifier: verifier, resource: `${ORIGIN}/mcp` })).json();
  };
  const rpc = (token: string, method: string, params: Record<string, unknown> = {}) =>
    app.inject({ method: "POST", url: "/mcp", headers: { authorization: `Bearer ${token}` }, payload: { jsonrpc: "2.0", id: 1, method, params } });
  const freeze = () => app.inject({ method: "POST", url: `/api/wallets/${walletId}/freeze`, headers: user.headers, payload: {} });
  const unfreeze = async () => {
    const stepUp = (await app.inject({ method: "POST", url: "/api/passkeys/step-up", headers: user.headers, payload: { action: unfreezeAction(walletId) } })).json();
    return app.inject({ method: "POST", url: `/api/wallets/${walletId}/unfreeze`, headers: user.headers, payload: { assertion: authenticator.assert(stepUp.challenge) } });
  };
  return { app, pool, sent, walletId, clientId, form, approve, signIn, rpc, freeze, unfreeze, drop: async () => (await app.close(), await drop()) };
}

const SWAP = { chain: "base", sellToken: USDC, buyToken: WETH, sellAmount: "1000000", idempotencyKey: "swap-0001" };

test("OAuth refuses to connect a frozen wallet and says how to unfreeze it", { skip: !TEST_DATABASE_URL }, async () => {
  const { pool, walletId, approve, freeze, drop } = await harness();
  try {
    assert.equal((await freeze()).statusCode, 200);
    const { approved } = await approve();
    assert.equal(approved.statusCode, 409);
    assert.equal(approved.json().error, "wallet_frozen");
    assert.match(approved.json().detail, new RegExp(`unfreeze it at ${ORIGIN}/wallets/${walletId}`));
    assert.equal((await pool.query("SELECT count(*)::int AS n FROM agents")).rows[0].n, 0);
  } finally {
    await drop();
  }
});

test("a valid token on a frozen wallet gets a frozen tool error, never invalid_token, and cannot trade", { skip: !TEST_DATABASE_URL }, async () => {
  const { pool, sent, walletId, clientId, form, signIn, rpc, freeze, drop } = await harness();
  try {
    const pair = await signIn();
    assert.equal((await rpc(pair.access_token, "tools/call", { name: "wallet_status", arguments: {} })).json().result.isError, false);
    assert.equal((await freeze()).statusCode, 200);

    for (const method of ["initialize", "ping", "tools/list"]) {
      const reply = await rpc(pair.access_token, method, { protocolVersion: "2025-06-18" });
      assert.deepEqual([method, reply.statusCode, reply.headers["www-authenticate"]], [method, 200, undefined]);
    }
    for (const name of ["wallet_status", "swap", "quote", "transfer", "x402_quote"]) {
      const reply = await rpc(pair.access_token, "tools/call", { name, arguments: SWAP });
      assert.deepEqual([name, reply.statusCode, reply.headers["www-authenticate"]], [name, 200, undefined]);
      const result = reply.json().result;
      assert.equal(result.isError, true, name);
      assert.match(result.content[0].text, /wallet is frozen/);
      assert.match(result.content[0].text, /do not sign in again/);
      assert.match(result.content[0].text, new RegExp(`${ORIGIN}/wallets/${walletId}`));
    }
    assert.equal(sent.length, 0);
    assert.equal((await pool.query("SELECT count(*)::int AS n FROM audit_events WHERE actor = 'agent'")).rows[0].n, 0);

    const refreshed = await form("/oauth/token", { grant_type: "refresh_token", refresh_token: pair.refresh_token, client_id: clientId });
    assert.equal(refreshed.statusCode, 200);
    const swap = await rpc(refreshed.json().access_token, "tools/call", { name: "swap", arguments: SWAP });
    assert.deepEqual([swap.statusCode, swap.json().result.isError], [200, true]);
    assert.equal(sent.length, 0);
  } finally {
    await drop();
  }
});

test("unfreezing restores the same token with no new consent", { skip: !TEST_DATABASE_URL }, async () => {
  const { pool, sent, signIn, rpc, freeze, unfreeze, drop } = await harness();
  try {
    const pair = await signIn();
    assert.equal((await freeze()).statusCode, 200);
    assert.equal((await rpc(pair.access_token, "tools/call", { name: "swap", arguments: SWAP })).json().result.isError, true);
    assert.deepEqual((await unfreeze()).json(), { status: "unfrozen" });
    const swap = await rpc(pair.access_token, "tools/call", { name: "swap", arguments: SWAP });
    assert.equal(swap.json().result.isError, false);
    assert.equal(sent.length, 1);
    assert.equal((await pool.query("SELECT count(*)::int AS n FROM agents")).rows[0].n, 1);
  } finally {
    await drop();
  }
});

test("a revoked or expired token still gets invalid_token, frozen wallet or not", { skip: !TEST_DATABASE_URL }, async () => {
  const { pool, form, signIn, rpc, freeze, drop } = await harness();
  try {
    const revoked = await signIn();
    const expired = await signIn();
    const agentRevoked = await signIn();
    assert.equal((await form("/oauth/revoke", { token: revoked.refresh_token })).statusCode, 200);
    await pool.query("UPDATE agent_credentials SET expires_at = now() - interval '1 minute' WHERE id = $1", [expired.access_token.split("_")[1]]);
    await pool.query("UPDATE agents SET revoked_at = now() WHERE id = (SELECT agent_id FROM agent_credentials WHERE id = $1)", [agentRevoked.access_token.split("_")[1]]);
    for (const frozen of [false, true]) {
      if (frozen) assert.equal((await freeze()).statusCode, 200);
      for (const token of [revoked.access_token, expired.access_token, agentRevoked.access_token, `wat_${"0".repeat(16)}_${"A".repeat(43)}`]) {
        const reply = await rpc(token, "tools/call", { name: "wallet_status", arguments: {} });
        assert.equal(reply.statusCode, 401);
        assert.match(String(reply.headers["www-authenticate"]), /error="invalid_token"/);
      }
    }
  } finally {
    await drop();
  }
});

test("a freeze that lands after the token check still runs no tool", { skip: !TEST_DATABASE_URL }, async () => {
  const { pool, drop } = await migratedSchema();
  const config = gatewayConfig();
  const app = await gatewayApp(config, { logger: false, secrets: [] });
  try {
    const user = await signedInAccount(pool);
    const created = await createWallet(pool, user.accountId, { label: "main", level: "enclave" });
    const walletId = "walletId" in created ? created.walletId : "";
    await pool.query("INSERT INTO wallet_addresses (wallet_id, family, address) VALUES ($1, 'evm', $2)", [walletId, OWN]);
    const agent = await createAgent(pool, { accountId: user.accountId, walletId, name: "bot", limits: LIMITS });
    if ("refused" in agent) throw new Error(agent.refused);
    const sent: HostedRequest[] = [];
    const executor: ExecutorClient = { report: async () => ({ state: "not_started" as const }), run: async (request) => (sent.push(request), { kind: "swap", status: "would_swap", quote: { buyAmount: "42" } }) };
    const authenticate = async (token: string) => {
      const context = await authenticateApiKey(pool, token);
      await freezeWallets(pool, user.accountId, walletId);
      return context;
    };
    registerMcpRoutes(app, { config, pool, executor, authenticate });
    const reply = await app.inject({ method: "POST", url: "/mcp", headers: { authorization: `Bearer ${agent.apiKey}` }, payload: { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "swap", arguments: SWAP } } });
    assert.equal(reply.statusCode, 200);
    assert.equal(reply.json().result.isError, true);
    assert.match(reply.json().result.content[0].text, /wallet is frozen/);
    assert.equal(sent.length, 0);
  } finally {
    await app.close();
    await drop();
  }
});
