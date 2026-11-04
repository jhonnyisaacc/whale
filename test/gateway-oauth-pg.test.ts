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

async function harness(documents: Record<string, unknown> = {}) {
  const { pool, drop } = await migratedSchema();
  const fetchDocument = async (url: string) => {
    if (!(url in documents)) throw new Error("no such document");
    return JSON.stringify(documents[url]);
  };
  const app = await buildGateway({ config: gatewayConfig(), pool, logger: false, keys: { key: async () => null }, fetchDocument, executor: null });
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
  return { app, pool, user, walletId, form, authorize, connect, mcp, drop: async () => (await app.close(), await drop()) };
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
    const noPkce = new URL(String((await authorize(clientId, { code_challenge_method: "plain" })).reply.headers.location));
    assert.deepEqual([noPkce.searchParams.get("error"), noPkce.searchParams.get("state"), noPkce.searchParams.get("iss")], ["invalid_request", "st-1", ORIGIN]);
    const otherResource = new URL(String((await authorize(clientId, { resource: "https://other.example/mcp" })).reply.headers.location));
    assert.equal(otherResource.searchParams.get("error"), "invalid_target");

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

test("a metadata-document client must name itself by its own URL, and a denial goes back to the client", { skip: !TEST_DATABASE_URL }, async () => {
  const { app, authorize, drop } = await harness({
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
    const denied = await app.inject({ method: "POST", url: `/oauth/requests/${requestId}/deny`, payload: {} });
    const back = new URL(denied.json().redirect);
    assert.deepEqual([back.searchParams.get("error"), back.searchParams.get("state")], ["access_denied", "st-1"]);
    assert.equal((await app.inject({ method: "GET", url: `/oauth/requests/${requestId}` })).statusCode, 404);
  } finally {
    await drop();
  }
});
