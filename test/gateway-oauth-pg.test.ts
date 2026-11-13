import assert from "node:assert/strict";
import test from "node:test";
import { buildGateway } from "../src/gateway/app.js";
import { pkceChallenge, randomToken } from "../src/gateway/google.js";
import { createWallet } from "../src/gateway/wallets.js";
import { gatewayConfig, ORIGIN, signedInAccount } from "./gateway-fixtures.js";
import { migratedSchema, TEST_DATABASE_URL } from "./pg-schema.js";

const REDIRECT = "http://127.0.0.1:33418/callback";
const LIMITS = { chains: ["base"], actions: ["swap"], maxTxUsd: 20, dailyUsd: 40 };
const CIMD = "https://client.example/oauth/metadata.json";

async function harness(documents: Record<string, unknown> = {}, now: () => number = Date.now) {
  const { pool, drop } = await migratedSchema();
  const fetches: string[] = [];
  const fetchDocument = async (url: string) => {
    fetches.push(url);
    if (!(url in documents)) throw new Error("no such document");
    return JSON.stringify(documents[url]);
  };
  const app = await buildGateway({ config: gatewayConfig(), pool, logger: false, keys: { key: async () => null }, fetchDocument, executor: null, now });
  const user = await signedInAccount(pool);
  const created = await createWallet(pool, user.accountId, { label: "main", level: "enclave" });
  const walletId = "walletId" in created ? created.walletId : "";
  const form = (url: string, fields: Record<string, string>) =>
    app.inject({ method: "POST", url, headers: { "content-type": "application/x-www-form-urlencoded" }, payload: new URLSearchParams(fields).toString() });
  const authorize = async (clientId: string, extra: Record<string, string> = {}) => {
    const verifier = randomToken(48);
    const query = new URLSearchParams({ response_type: "code", client_id: clientId, redirect_uri: REDIRECT, code_challenge: pkceChallenge(verifier), code_challenge_method: "S256", state: "st-1", resource: `${ORIGIN}/mcp`, ...extra });
    const reply = await app.inject({ method: "GET", url: `/oauth/authorize?${query}` });
    return { reply, verifier };
  };
  const connect = async (clientId: string) => {
    const { reply, verifier } = await authorize(clientId);
    const request = new URL(String(reply.headers.location), ORIGIN).searchParams.get("request") as string;
    const approved = await app.inject({ method: "POST", url: `/api/oauth/requests/${request}/approve`, headers: user.headers, payload: { walletId, name: "Claude", limits: LIMITS } });
    const code = new URL(approved.json().redirect).searchParams.get("code") as string;
    return { request, code, verifier, approved };
  };
  const mcp = (token: string) => app.inject({ method: "POST", url: "/mcp", headers: { authorization: `Bearer ${token}` }, payload: { jsonrpc: "2.0", id: 1, method: "tools/list" } });
  return { app, pool, user, walletId, form, authorize, connect, mcp, fetches, drop: async () => (await app.close(), await drop()) };
}

async function register(form: (url: string, fields: Record<string, string>) => Promise<unknown>, app: Awaited<ReturnType<typeof harness>>["app"]) {
  void form;
  const reply = await app.inject({ method: "POST", url: "/oauth/register", payload: { client_name: "Claude Code", redirect_uris: [REDIRECT] } });
  assert.equal(reply.statusCode, 201);
  return reply.json().client_id as string;
}

test("discovery metadata names the MCP resource, a path-free issuer, PKCE S256, and CIMD", { skip: !TEST_DATABASE_URL }, async () => {
  const { app, drop } = await harness();
  try {
    const resource = (await app.inject({ method: "GET", url: "/.well-known/oauth-protected-resource/mcp" })).json();
    assert.deepEqual([resource.resource, resource.authorization_servers], [`${ORIGIN}/mcp`, [ORIGIN]]);
    const server = await app.inject({ method: "GET", url: "/.well-known/oauth-authorization-server" });
    assert.equal(server.headers["access-control-allow-origin"], "*");
    const body = server.json();
    assert.equal(body.issuer, ORIGIN);
    assert.deepEqual(body.code_challenge_methods_supported, ["S256"]);
    assert.equal(body.client_id_metadata_document_supported, true);
    assert.equal(body.authorization_response_iss_parameter_supported, true);
    assert.equal((await app.inject({ method: "OPTIONS", url: "/oauth/token" })).statusCode, 204);
  } finally {
    await drop();
  }
});

test("a registered client completes code + PKCE, uses the token on MCP, and replay or refresh reuse revokes the family", { skip: !TEST_DATABASE_URL }, async () => {
  const { app, pool, form, authorize, connect, mcp, user, drop } = await harness();
  try {
    assert.equal((await app.inject({ method: "POST", url: "/oauth/register", payload: { redirect_uris: ["http://evil.example/cb"] } })).statusCode, 400);
    const clientId = await register(form, app);

    assert.equal((await authorize("dcr_unknown_client")).reply.statusCode, 400);
    const wrongRedirect = await authorize(clientId, { redirect_uri: "http://127.0.0.1:1/other" });
    assert.deepEqual([wrongRedirect.reply.statusCode, wrongRedirect.reply.headers.location], [400, undefined]);
    assert.equal((await authorize(clientId, { code_challenge_method: "plain" })).reply.json().error, "invalid_request");
    assert.equal((await authorize(clientId, { resource: "https://other.example/mcp" })).reply.json().error, "invalid_target");

    const pending = await authorize(clientId);
    assert.match(String(pending.reply.headers.location), /^\/connect\?request=[A-Za-z0-9_-]{43}$/);
    const requestId = new URL(String(pending.reply.headers.location), ORIGIN).searchParams.get("request");
    const info = (await app.inject({ method: "GET", url: `/oauth/requests/${requestId}` })).json();
    assert.deepEqual(info.client, { name: "Claude Code", id: clientId, redirectHost: "127.0.0.1:33418", localhost: true });
    assert.equal((await app.inject({ method: "POST", url: `/api/oauth/requests/${requestId}/approve`, headers: { origin: ORIGIN }, payload: {} })).statusCode, 401);
    const tooWide = await app.inject({ method: "POST", url: `/api/oauth/requests/${requestId}/approve`, headers: user.headers, payload: { walletId: (await pool.query("SELECT id FROM wallets")).rows[0].id, name: "x", limits: { ...LIMITS, maxTxUsd: 900, dailyUsd: 900 } } });
    assert.equal(tooWide.json().error, "limits_outside_policy");

    const burned = await connect(clientId);
    assert.equal(new URL(burned.approved.json().redirect).searchParams.get("iss"), ORIGIN);
    const badVerifier = await form("/oauth/token", { grant_type: "authorization_code", code: burned.code, redirect_uri: REDIRECT, client_id: clientId, code_verifier: randomToken(48) });
    assert.equal(badVerifier.json().error, "invalid_grant");
    const afterBurn = await form("/oauth/token", { grant_type: "authorization_code", code: burned.code, redirect_uri: REDIRECT, client_id: clientId, code_verifier: burned.verifier });
    assert.equal(afterBurn.json().error, "invalid_grant");

    const { code, verifier } = await connect(clientId);
    const exchange = (who: string) => form("/oauth/token", { grant_type: "authorization_code", code, redirect_uri: REDIRECT, client_id: who, code_verifier: verifier, resource: `${ORIGIN}/mcp` });
    const tokens = await exchange(clientId);
    assert.equal(tokens.statusCode, 200);
    assert.equal(tokens.headers["cache-control"], "no-store");
    const pair = tokens.json();
    assert.match(pair.access_token, /^wat_[0-9a-f]{16}_/);
    assert.equal((await mcp(pair.access_token)).statusCode, 200);
    assert.equal((await exchange(clientId)).json().error, "invalid_grant");
    assert.equal((await mcp(pair.access_token)).statusCode, 401);

    const fresh = await connect(clientId);
    const second = (await form("/oauth/token", { grant_type: "authorization_code", code: fresh.code, redirect_uri: REDIRECT, client_id: clientId, code_verifier: fresh.verifier })).json();
    const rotated = (await form("/oauth/token", { grant_type: "refresh_token", refresh_token: second.refresh_token, client_id: clientId })).json();
    assert.match(rotated.access_token, /^wat_/);
    assert.equal((await mcp(rotated.access_token)).statusCode, 200);
    assert.equal((await form("/oauth/token", { grant_type: "refresh_token", refresh_token: rotated.refresh_token, client_id: "dcr_other" })).json().error, "invalid_grant");
    const reused = await form("/oauth/token", { grant_type: "refresh_token", refresh_token: second.refresh_token, client_id: clientId });
    assert.equal(reused.json().error, "invalid_grant");
    assert.equal((await mcp(rotated.access_token)).statusCode, 401);

    const last = await connect(clientId);
    const live = (await form("/oauth/token", { grant_type: "authorization_code", code: last.code, redirect_uri: REDIRECT, client_id: clientId, code_verifier: last.verifier })).json();
    await pool.query("UPDATE agent_credentials SET audience = 'https://other.example/mcp' WHERE kind = 'oauth_access' AND revoked_at IS NULL");
    assert.equal((await mcp(live.access_token)).statusCode, 401);
    await pool.query("UPDATE agent_credentials SET audience = $1 WHERE kind = 'oauth_access'", [`${ORIGIN}/mcp`]);
    assert.equal((await mcp(live.access_token)).statusCode, 200);
    assert.equal((await form("/oauth/revoke", { token: live.access_token })).statusCode, 200);
    assert.equal((await mcp(live.access_token)).statusCode, 401);
    assert.equal((await form("/oauth/token", { grant_type: "password", client_id: clientId })).json().error, "unsupported_grant_type");
  } finally {
    await drop();
  }
});

test("an authorize error for a self-registered client renders here and never redirects to its URI", { skip: !TEST_DATABASE_URL }, async () => {
  const { app, authorize, drop } = await harness();
  try {
    const phish = "https://phish.example/login";
    const registered = await app.inject({ method: "POST", url: "/oauth/register", payload: { client_name: "Claude Code", redirect_uris: [phish] } });
    const clientId = registered.json().client_id as string;
    const broken: Record<string, string>[] = [{ code_challenge_method: "plain" }, { response_type: "token" }, { resource: "https://other.example/mcp" }];
    for (const extra of broken) {
      const { reply } = await authorize(clientId, { redirect_uri: phish, ...extra });
      assert.deepEqual([reply.statusCode, reply.headers.location], [400, undefined], JSON.stringify(extra));
    }
    const { reply } = await authorize(clientId, { redirect_uri: phish, code_challenge_method: "plain" });
    assert.equal(reply.json().error, "invalid_request");
  } finally {
    await drop();
  }
});

test("a loopback redirect matches on any port, and nothing else about it may differ", { skip: !TEST_DATABASE_URL }, async () => {
  const { app, authorize, form, user, walletId, drop } = await harness({
    [CIMD]: { client_id: CIMD, client_name: "Cursor", redirect_uris: ["http://127.0.0.1/callback", "https://client.example/cb"] },
  });
  try {
    for (const other of ["http://127.0.0.1:33418/other", "http://localhost:33418/callback", "https://client.example:8443/cb"]) {
      assert.equal((await authorize(CIMD, { redirect_uri: other })).reply.statusCode, 400, other);
    }
    const { reply, verifier } = await authorize(CIMD);
    assert.match(String(reply.headers.location), /^\/connect\?request=/);
    const request = new URL(String(reply.headers.location), ORIGIN).searchParams.get("request") as string;
    const approved = await app.inject({ method: "POST", url: `/api/oauth/requests/${request}/approve`, headers: user.headers, payload: { walletId, name: "Cursor", limits: LIMITS } });
    const back = new URL(approved.json().redirect);
    assert.equal(`${back.origin}${back.pathname}`, REDIRECT);
    const tokens = await form("/oauth/token", { grant_type: "authorization_code", code: back.searchParams.get("code") as string, redirect_uri: REDIRECT, client_id: CIMD, code_verifier: verifier });
    assert.equal(tokens.statusCode, 200);
  } finally {
    await drop();
  }
});

test("revoking a refresh token also stops the access tokens of that grant", { skip: !TEST_DATABASE_URL }, async () => {
  const { app, form, connect, mcp, drop } = await harness();
  try {
    const clientId = await register(form, app);
    const { code, verifier } = await connect(clientId);
    const pair = (await form("/oauth/token", { grant_type: "authorization_code", code, redirect_uri: REDIRECT, client_id: clientId, code_verifier: verifier })).json();
    assert.equal((await mcp(pair.access_token)).statusCode, 200);
    assert.equal((await form("/oauth/revoke", { token: pair.refresh_token })).statusCode, 200);
    assert.equal((await mcp(pair.access_token)).statusCode, 401);
    assert.equal((await form("/oauth/token", { grant_type: "refresh_token", refresh_token: pair.refresh_token, client_id: clientId })).json().error, "invalid_grant");
  } finally {
    await drop();
  }
});

test("a metadata document that fails to load is not fetched again for a minute", { skip: !TEST_DATABASE_URL }, async () => {
  let clock = Date.now();
  const { authorize, fetches, drop } = await harness({}, () => clock);
  try {
    assert.equal((await authorize(CIMD)).reply.statusCode, 400);
    assert.equal((await authorize(CIMD)).reply.statusCode, 400);
    assert.equal(fetches.length, 1);
    clock += 61_000;
    assert.equal((await authorize(CIMD)).reply.statusCode, 400);
    assert.equal(fetches.length, 2);
  } finally {
    await drop();
  }
});

test("two refreshes at once with one token get one pair, and the loser's invalid_grant revokes that pair too", { skip: !TEST_DATABASE_URL }, async () => {
  const { app, form, connect, mcp, drop } = await harness();
  try {
    const clientId = await register(form, app);
    const { code, verifier } = await connect(clientId);
    const pair = (await form("/oauth/token", { grant_type: "authorization_code", code, redirect_uri: REDIRECT, client_id: clientId, code_verifier: verifier })).json();
    const refresh = (token: string) => form("/oauth/token", { grant_type: "refresh_token", refresh_token: token, client_id: clientId });

    const replies = await Promise.all([refresh(pair.refresh_token), refresh(pair.refresh_token)]);
    assert.deepEqual(replies.map((reply) => reply.statusCode).sort(), [200, 400]);
    const winner = replies.find((reply) => reply.statusCode === 200)?.json();
    assert.equal(replies.find((reply) => reply.statusCode === 400)?.json().error, "invalid_grant");
    assert.equal((await mcp(winner.access_token)).statusCode, 401);
    assert.equal((await refresh(winner.refresh_token)).json().error, "invalid_grant");
  } finally {
    await drop();
  }
});

test("a stolen refresh token replayed five seconds after rotation is refused and revokes the legitimate chain", { skip: !TEST_DATABASE_URL }, async () => {
  let clock = Date.now();
  const { app, form, connect, mcp, drop } = await harness({}, () => clock);
  try {
    const clientId = await register(form, app);
    const { code, verifier } = await connect(clientId);
    const stolen = (await form("/oauth/token", { grant_type: "authorization_code", code, redirect_uri: REDIRECT, client_id: clientId, code_verifier: verifier })).json().refresh_token;
    const refresh = (token: string) => form("/oauth/token", { grant_type: "refresh_token", refresh_token: token, client_id: clientId });

    const legit = (await refresh(stolen)).json();
    assert.equal((await mcp(legit.access_token)).statusCode, 200);

    clock += 5_000;
    const replay = await refresh(stolen);
    assert.deepEqual([replay.statusCode, replay.json().error, replay.json().access_token], [400, "invalid_grant", undefined]);
    assert.equal((await mcp(legit.access_token)).statusCode, 401);
    assert.equal((await refresh(legit.refresh_token)).json().error, "invalid_grant");
  } finally {
    await drop();
  }
});

test("expired OAuth requests, codes, and tokens are deleted a day after they expire", { skip: !TEST_DATABASE_URL }, async () => {
  let clock = Date.now();
  const { app, pool, form, authorize, connect, drop } = await harness({}, () => clock);
  const count = async (table: string) => (await pool.query(`SELECT count(*)::int AS n FROM ${table}`)).rows[0].n as number;
  try {
    const clientId = await register(form, app);
    const { code, verifier } = await connect(clientId);
    await form("/oauth/token", { grant_type: "authorization_code", code, redirect_uri: REDIRECT, client_id: clientId, code_verifier: verifier });
    await authorize(clientId);
    assert.deepEqual([await count("oauth_requests"), await count("oauth_codes"), await count("agent_credentials")], [2, 1, 2]);

    clock += 30 * 24 * 60 * 60 * 1000;
    await authorize(clientId);
    assert.deepEqual([await count("oauth_requests"), await count("oauth_codes"), await count("agent_credentials")], [1, 0, 1]);

    clock += 24 * 60 * 60 * 1000 + 1;
    await authorize(clientId);
    assert.deepEqual([await count("oauth_requests"), await count("oauth_codes"), await count("agent_credentials")], [2, 0, 0]);
  } finally {
    await drop();
  }
});

test("denying a request needs a same-origin session, and the old public deny path is gone", { skip: !TEST_DATABASE_URL }, async () => {
  const { app, form, authorize, user, drop } = await harness();
  try {
    const clientId = await register(form, app);
    const requestId = new URL(String((await authorize(clientId)).reply.headers.location), ORIGIN).searchParams.get("request");
    const pending = async () => (await app.inject({ method: "GET", url: `/oauth/requests/${requestId}` })).statusCode;
    const deny = (url: string, headers: Record<string, string>) => app.inject({ method: "POST", url, headers, payload: {} });

    assert.equal((await deny(`/oauth/requests/${requestId}/deny`, {})).statusCode, 404);
    assert.equal(await pending(), 200);
    assert.equal((await deny(`/api/oauth/requests/${requestId}/deny`, { ...user.headers, origin: "https://evil.example" })).statusCode, 403);
    assert.equal((await deny(`/api/oauth/requests/${requestId}/deny`, { origin: ORIGIN })).statusCode, 401);
    assert.equal(await pending(), 200);

    const denied = await deny(`/api/oauth/requests/${requestId}/deny`, user.headers);
    assert.equal(new URL(denied.json().redirect).searchParams.get("error"), "access_denied");
    assert.equal(await pending(), 404);
  } finally {
    await drop();
  }
});

test("a metadata-document client must name itself by its own URL, and a denial goes back to the client", { skip: !TEST_DATABASE_URL }, async () => {
  const { app, authorize, user, drop } = await harness({
    [CIMD]: { client_id: CIMD, client_name: "Cursor", redirect_uris: [REDIRECT] },
    "https://liar.example/meta.json": { client_id: "https://other.example/meta.json", client_name: "Liar", redirect_uris: [REDIRECT] },
    "https://bad.example/meta.json": { client_id: "https://bad.example/meta.json", client_name: "Bad", redirect_uris: ["http://evil.example/cb"] },
  });
  try {
    assert.equal((await authorize("https://liar.example/meta.json")).reply.statusCode, 400);
    assert.equal((await authorize("https://bad.example/meta.json")).reply.statusCode, 400);
    assert.equal((await authorize("http://client.example/meta.json")).reply.statusCode, 400);
    const ok = await authorize(CIMD);
    const requestId = new URL(String(ok.reply.headers.location), ORIGIN).searchParams.get("request");
    assert.equal((await app.inject({ method: "GET", url: `/oauth/requests/${requestId}` })).json().client.name, "Cursor");
    const denied = await app.inject({ method: "POST", url: `/api/oauth/requests/${requestId}/deny`, headers: user.headers, payload: {} });
    const back = new URL(denied.json().redirect);
    assert.deepEqual([back.searchParams.get("error"), back.searchParams.get("state")], ["access_denied", "st-1"]);
    assert.equal((await app.inject({ method: "GET", url: `/oauth/requests/${requestId}` })).statusCode, 404);
  } finally {
    await drop();
  }
});
