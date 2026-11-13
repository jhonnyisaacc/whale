import assert from "node:assert/strict";
import test from "node:test";
import { authenticateApiKey } from "../src/gateway/agents.js";
import { buildGateway } from "../src/gateway/app.js";
import { createWallet } from "../src/gateway/wallets.js";
import { gatewayConfig, signedInAccount } from "./gateway-fixtures.js";
import { migratedSchema, TEST_DATABASE_URL } from "./pg-schema.js";

const LIMITS = { chains: ["base"], actions: ["swap"], maxTxUsd: 20, dailyUsd: 40 };

async function harness() {
  const { pool, drop } = await migratedSchema();
  const app = await buildGateway({ config: gatewayConfig(), pool, logger: false, keys: { key: async () => null } });
  return { app, pool, drop: async () => (await app.close(), await drop()) };
}

test("a signed-in user creates a wallet with the default policy and an agent with a one-time API key", { skip: !TEST_DATABASE_URL }, async () => {
  const { app, pool, drop } = await harness();
  try {
    const { headers } = await signedInAccount(pool);
    const created = await app.inject({ method: "POST", url: "/api/wallets", headers, payload: { label: "main", level: "enclave" } });
    assert.equal(created.statusCode, 201);
    const wallet = created.json();
    assert.equal(wallet.status, "pending");
    assert.equal(wallet.live, false);
    assert.equal(wallet.policy.maxTxUsd, 50);

    const unavailable = await app.inject({ method: "POST", url: "/api/wallets", headers, payload: { label: "x", level: "smart_account" } });
    assert.deepEqual([unavailable.statusCode, unavailable.json().error], [409, "level_unavailable"]);

    const tooWide = await app.inject({ method: "POST", url: `/api/wallets/${wallet.id}/agents`, headers, payload: { name: "bot", limits: { ...LIMITS, maxTxUsd: 500, dailyUsd: 500 } } });
    assert.deepEqual([tooWide.statusCode, tooWide.json().error], [400, "limits_outside_policy"]);

    const agent = await app.inject({ method: "POST", url: `/api/wallets/${wallet.id}/agents`, headers, payload: { name: "bot", limits: LIMITS } });
    assert.equal(agent.statusCode, 201);
    const { agentId, apiKey } = agent.json();
    const context = await authenticateApiKey(pool, apiKey);
    assert.equal(context?.agentId, agentId);
    assert.deepEqual(context?.limits, LIMITS);
    assert.equal(await authenticateApiKey(pool, apiKey.slice(0, -1) + (apiKey.endsWith("A") ? "B" : "A")), null);

    const stored = await pool.query("SELECT secret_hash FROM agent_credentials");
    assert.equal(JSON.stringify(stored.rows).includes(apiKey.split("_")[2]), false);

    const listed = await app.inject({ method: "GET", url: `/api/wallets/${wallet.id}/agents`, headers });
    assert.equal(listed.json().agents[0].keyPrefixes[0], `${apiKey.split("_").slice(0, 2).join("_")}_`);
    assert.equal(JSON.stringify(listed.json()).includes(apiKey), false);

    const rotated = await app.inject({ method: "POST", url: `/api/agents/${agentId}/rotate`, headers, payload: {} });
    const newKey = rotated.json().apiKey;
    assert.equal(await authenticateApiKey(pool, apiKey), null);
    assert.equal((await authenticateApiKey(pool, newKey))?.agentId, agentId);

    const revoked = await app.inject({ method: "POST", url: `/api/agents/${agentId}/revoke`, headers, payload: {} });
    assert.equal(revoked.statusCode, 204);
    assert.equal(await authenticateApiKey(pool, newKey), null);

    const actions = await pool.query("SELECT action FROM audit_events ORDER BY id");
    assert.deepEqual(actions.rows.map((row) => row.action), ["wallet.created", "agent.created", "agent.key_rotated", "agent.revoked"]);
  } finally {
    await drop();
  }
});

test("one account cannot see or touch another account's wallets and agents", { skip: !TEST_DATABASE_URL }, async () => {
  const { app, pool, drop } = await harness();
  try {
    const alice = await signedInAccount(pool);
    const bob = await signedInAccount(pool);
    const wallet = (await app.inject({ method: "POST", url: "/api/wallets", headers: alice.headers, payload: { label: "main", level: "enclave" } })).json();
    const { agentId, apiKey } = (await app.inject({ method: "POST", url: `/api/wallets/${wallet.id}/agents`, headers: alice.headers, payload: { name: "bot", limits: LIMITS } })).json();

    assert.deepEqual((await app.inject({ method: "GET", url: "/api/wallets", headers: bob.headers })).json(), { wallets: [] });
    assert.equal((await app.inject({ method: "GET", url: `/api/wallets/${wallet.id}/agents`, headers: bob.headers })).statusCode, 404);
    assert.equal((await app.inject({ method: "POST", url: `/api/wallets/${wallet.id}/agents`, headers: bob.headers, payload: { name: "x", limits: LIMITS } })).statusCode, 404);
    assert.equal((await app.inject({ method: "POST", url: `/api/agents/${agentId}/revoke`, headers: bob.headers, payload: {} })).statusCode, 404);
    assert.equal((await app.inject({ method: "POST", url: `/api/agents/${agentId}/rotate`, headers: bob.headers, payload: {} })).statusCode, 404);
    assert.equal((await app.inject({ method: "GET", url: "/api/wallets/not-a-uuid/agents", headers: bob.headers })).statusCode, 404);
    assert.ok(await authenticateApiKey(pool, apiKey));

    await pool.query("UPDATE wallets SET status = 'frozen'");
    assert.equal(await authenticateApiKey(pool, apiKey), null);
    await pool.query("UPDATE wallets SET status = 'active'");
    await pool.query("UPDATE accounts SET status = 'frozen' WHERE id = $1", [alice.accountId]);
    assert.equal(await authenticateApiKey(pool, apiKey), null);
    assert.equal((await app.inject({ method: "GET", url: "/api/wallets" })).statusCode, 401);
  } finally {
    await drop();
  }
});

test("an account holds at most ten wallets", { skip: !TEST_DATABASE_URL }, async () => {
  const { app, pool, drop } = await harness();
  try {
    const { accountId, headers } = await signedInAccount(pool);
    for (let index = 0; index < 10; index += 1) assert.ok("walletId" in (await createWallet(pool, accountId, { label: `w${index}`, level: "enclave" })));
    const eleventh = await app.inject({ method: "POST", url: "/api/wallets", headers, payload: { label: "w10", level: "enclave" } });
    assert.deepEqual([eleventh.statusCode, eleventh.json().error], [409, "wallet_limit"]);
  } finally {
    await drop();
  }
});

test("a chain a later build drops is dropped from stored policies and limits, never widened, and a broken document refuses the key", { skip: !TEST_DATABASE_URL }, async () => {
  const { app, pool, drop } = await harness();
  try {
    const { headers } = await signedInAccount(pool);
    const wallet = (await app.inject({ method: "POST", url: "/api/wallets", headers, payload: { label: "main", level: "enclave" } })).json();
    const { apiKey } = (await app.inject({ method: "POST", url: `/api/wallets/${wallet.id}/agents`, headers, payload: { name: "bot", limits: LIMITS } })).json();
    const kept = { chain: "base", address: "0x1111111111111111111111111111111111111111" };
    const gone = { chain: "dogechain", address: "0x2222222222222222222222222222222222222222" };
    await pool.query("UPDATE policies SET document = document || jsonb_build_object('chains', $1::jsonb, 'tokenAllowlist', $2::jsonb)", [
      JSON.stringify(["base", "dogechain"]),
      JSON.stringify([kept, gone]),
    ]);
    await pool.query("UPDATE agents SET limits = limits || jsonb_build_object('chains', $1::jsonb)", [JSON.stringify(["base", "dogechain"])]);

    const listed = await app.inject({ method: "GET", url: "/api/wallets", headers });
    assert.equal(listed.statusCode, 200);
    assert.deepEqual(listed.json().wallets[0].policy.chains, ["base"]);
    assert.deepEqual(listed.json().wallets[0].policy.tokenAllowlist, [kept]);
    const context = await authenticateApiKey(pool, apiKey);
    assert.deepEqual(context?.limits.chains, ["base"]);
    assert.deepEqual(context?.policy.chains, ["base"]);

    await pool.query("UPDATE policies SET document = document || jsonb_build_object('chains', $1::jsonb, 'tokenAllowlist', $2::jsonb)", [JSON.stringify(["dogechain"]), JSON.stringify([gone])]);
    const emptied = (await app.inject({ method: "GET", url: "/api/wallets", headers })).json().wallets[0].policy;
    assert.deepEqual([emptied.chains, emptied.tokenAllowlist], [[], []]);

    await pool.query("UPDATE agents SET limits = '{\"chains\": \"base\"}'");
    assert.equal(await authenticateApiKey(pool, apiKey), null);
  } finally {
    await drop();
  }
});

test("an agent cannot be created on a frozen wallet", { skip: !TEST_DATABASE_URL }, async () => {
  const { app, pool, drop } = await harness();
  try {
    const { headers } = await signedInAccount(pool);
    const wallet = (await app.inject({ method: "POST", url: "/api/wallets", headers, payload: { label: "main", level: "enclave" } })).json();
    await pool.query("UPDATE wallets SET status = 'frozen'");
    const refused = await app.inject({ method: "POST", url: `/api/wallets/${wallet.id}/agents`, headers, payload: { name: "bot", limits: LIMITS } });
    assert.deepEqual([refused.statusCode, refused.json().error], [409, "wallet_frozen"]);
    assert.equal((await pool.query("SELECT id FROM agents")).rowCount, 0);
  } finally {
    await drop();
  }
});
