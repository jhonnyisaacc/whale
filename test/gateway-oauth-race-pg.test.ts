import assert from "node:assert/strict";
import test from "node:test";
import type pg from "pg";
import type { AgentLimits } from "../src/gateway/policy.js";
import { buildGateway } from "../src/gateway/app.js";
import { pkceChallenge, randomToken } from "../src/gateway/google.js";
import { authenticateBearer } from "../src/gateway/agents.js";
import { approveRequest, createRequest, denyRequest, exchangeCode, refreshTokens, revokeToken } from "../src/gateway/oauth-store.js";
import { createWallet } from "../src/gateway/wallets.js";
import { gatewayConfig, ORIGIN, signedInAccount } from "./gateway-fixtures.js";
import { migratedSchema, TEST_DATABASE_URL } from "./pg-schema.js";

const REDIRECT = "http://127.0.0.1:33418/callback";
const LIMITS: AgentLimits = { chains: ["base"], actions: ["swap"], maxTxUsd: 20, dailyUsd: 40 };
const RESOURCE = `${ORIGIN}/mcp`;

function held(pool: pg.Pool, marker: string) {
  let open!: () => void;
  const gate = new Promise<void>((resolve) => (open = resolve));
  let reached!: (pid: number) => void;
  const pid = new Promise<number>((resolve) => (reached = resolve));
  const gated = {
    connect: async () => {
      const client = await pool.connect();
      const query = client.query.bind(client) as (...args: unknown[]) => Promise<unknown>;
      const release = client.release.bind(client);
      Object.assign(client, {
        query: async (...args: unknown[]) => {
          if (typeof args[0] === "string" && args[0].includes(marker)) {
            const self = (await query("SELECT pg_backend_pid() AS pid")) as { rows: { pid: number }[] };
            reached(self.rows[0]?.pid as number);
            await gate;
          }
          return query(...args);
        },
        release: (...args: unknown[]) => {
          Object.assign(client, { query, release });
          return (release as (...a: unknown[]) => unknown)(...args);
        },
      });
      return client;
    },
  } as unknown as pg.Pool;
  const blocking = async () => {
    const holder = await pid;
    for (let tries = 0; tries < 200; tries++) {
      const waiting = await pool.query("SELECT 1 FROM pg_stat_activity WHERE $1 = ANY(pg_blocking_pids(pid))", [holder]);
      if (waiting.rowCount) return;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    throw new Error("nothing ever waited on the held transaction");
  };
  return { pool: gated, reached: pid, blocking, open };
}

async function setup() {
  const { pool, drop } = await migratedSchema();
  const app = await buildGateway({ config: gatewayConfig(), pool, logger: false, keys: { key: async () => null }, fetchDocument: async () => { throw new Error("no documents"); }, executor: null });
  const user = await signedInAccount(pool);
  const created = await createWallet(pool, user.accountId, { label: "main", level: "enclave" });
  const walletId = "walletId" in created ? created.walletId : "";
  const registered = await app.inject({ method: "POST", url: "/oauth/register", payload: { client_name: "Claude Code", redirect_uris: [REDIRECT] } });
  const clientId = registered.json().client_id as string;
  const oauthClient = { id: clientId, kind: "registered" as const, name: "Claude Code", redirectUris: [REDIRECT] };
  const request = async () => {
    const verifier = randomToken(48);
    const id = await createRequest(pool, { clientId, redirectUri: REDIRECT, codeChallenge: pkceChallenge(verifier), state: null, resource: RESOURCE }, oauthClient);
    return { id, verifier };
  };
  const approve = (target: pg.Pool, id: string) => approveRequest(target, { requestId: id, accountId: user.accountId, walletId, name: "Claude", limits: LIMITS, issuer: ORIGIN });
  const liveCredentials = async () =>
    (await pool.query<{ n: number }>("SELECT count(*)::int AS n FROM agent_credentials WHERE kind <> 'api_key' AND revoked_at IS NULL")).rows[0]?.n;
  return { pool, clientId, oauthClient, request, approve, liveCredentials, drop: async () => (await app.close(), await drop()) };
}

test("a client deleted between resolution and request insertion is restored atomically", { skip: !TEST_DATABASE_URL }, async () => {
  const { pool, clientId, oauthClient, request, drop } = await setup();
  try {
    await pool.query("UPDATE oauth_clients SET created_at = now() - interval '2 days' WHERE id = $1", [clientId]);
    await pool.query("DELETE FROM oauth_clients WHERE id = $1", [clientId]);
    const { id } = await request();
    const pending = await pool.query("SELECT client_id FROM oauth_requests WHERE id = $1", [id]);
    assert.deepEqual(pending.rows[0], { client_id: clientId });
    assert.equal((await pool.query("SELECT 1 FROM oauth_clients WHERE id = $1", [clientId])).rowCount, 1);
  } finally {
    await drop();
  }
});

test("a rotated refresh token replayed during a legitimate refresh leaves no credential of the family live", { skip: !TEST_DATABASE_URL }, async () => {
  const { pool, clientId, request, approve, liveCredentials, drop } = await setup();
  try {
    const { id, verifier } = await request();
    const code = new URL((await approve(pool, id)) as string).searchParams.get("code") as string;
    const first = await exchangeCode(pool, { code, clientId, redirectUri: REDIRECT, verifier, resource: RESOURCE });
    assert.ok("refresh_token" in first);
    const second = await refreshTokens(pool, { refreshToken: first.refresh_token, clientId });
    assert.ok("refresh_token" in second);

    const legit = held(pool, "INSERT INTO agent_credentials");
    const refreshing = refreshTokens(legit.pool, { refreshToken: second.refresh_token, clientId });
    await legit.reached;
    const replay = refreshTokens(pool, { refreshToken: first.refresh_token, clientId });
    await legit.blocking();
    legit.open();
    const [third, replayed] = await Promise.all([refreshing, replay]);

    assert.deepEqual(replayed, { error: "invalid_grant" });
    assert.ok("refresh_token" in third);
    assert.equal(await liveCredentials(), 0);
    assert.deepEqual(await refreshTokens(pool, { refreshToken: third.refresh_token, clientId }), { error: "invalid_grant" });
  } finally {
    await drop();
  }
});

test("a replayed code during a legitimate refresh leaves no credential of the family live", { skip: !TEST_DATABASE_URL }, async () => {
  const { pool, clientId, request, approve, liveCredentials, drop } = await setup();
  try {
    const { id, verifier } = await request();
    const code = new URL((await approve(pool, id)) as string).searchParams.get("code") as string;
    const exchange = { code, clientId, redirectUri: REDIRECT, verifier, resource: RESOURCE };
    const first = await exchangeCode(pool, exchange);
    assert.ok("refresh_token" in first);

    const legit = held(pool, "INSERT INTO agent_credentials");
    const refreshing = refreshTokens(legit.pool, { refreshToken: first.refresh_token, clientId });
    await legit.reached;
    const replay = exchangeCode(pool, exchange);
    await legit.blocking();
    legit.open();
    const [second, replayed] = await Promise.all([refreshing, replay]);

    assert.deepEqual(replayed, { error: "invalid_grant" });
    assert.ok("refresh_token" in second);
    assert.equal(await liveCredentials(), 0);
  } finally {
    await drop();
  }
});

test("revoking a refresh token during its own refresh leaves no credential of the family live", { skip: !TEST_DATABASE_URL }, async () => {
  const { pool, clientId, request, approve, liveCredentials, drop } = await setup();
  try {
    const { id, verifier } = await request();
    const code = new URL((await approve(pool, id)) as string).searchParams.get("code") as string;
    const first = await exchangeCode(pool, { code, clientId, redirectUri: REDIRECT, verifier, resource: RESOURCE });
    assert.ok("refresh_token" in first);

    const legit = held(pool, "INSERT INTO agent_credentials");
    const refreshing = refreshTokens(legit.pool, { refreshToken: first.refresh_token, clientId });
    await legit.reached;
    const revoking = revokeToken(pool, first.refresh_token);
    await legit.blocking();
    legit.open();
    const [second] = await Promise.all([refreshing, revoking]);

    assert.ok("refresh_token" in second);
    assert.equal(await liveCredentials(), 0);
    assert.equal(await authenticateBearer(pool, second.access_token, RESOURCE), null);
    assert.deepEqual(await refreshTokens(pool, { refreshToken: second.refresh_token, clientId }), { error: "invalid_grant" });
  } finally {
    await drop();
  }
});

test("deny racing approve on one request lets exactly one of them win", { skip: !TEST_DATABASE_URL }, async () => {
  const { pool, request, approve, drop } = await setup();
  try {
    const { id } = await request();
    const approving = held(pool, "INSERT INTO oauth_codes");
    const approved = approve(approving.pool, id);
    await approving.reached;
    const denied = denyRequest(pool, id, ORIGIN);
    await approving.blocking();
    approving.open();

    const redirect = new URL((await approved) as string);
    assert.ok(redirect.searchParams.get("code"));
    assert.equal(await denied, null);
    assert.equal(await approve(pool, id), null);
  } finally {
    await drop();
  }
});
