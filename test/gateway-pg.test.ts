import assert from "node:assert/strict";
import test from "node:test";
import type { FastifyInstance } from "fastify";
import { buildGateway } from "../src/gateway/app.js";
import type { GatewayConfig } from "../src/gateway/config.js";
import { CLIENT_ID, goodClaims, rsaKeys, signIdToken } from "./google-fixtures.js";
import { migratedSchema, TEST_DATABASE_URL } from "./pg-schema.js";

const ORIGIN = "https://whale.example";

function config(): GatewayConfig {
  return {
    publicUrl: new URL(ORIGIN),
    port: 0,
    databaseUrl: "unused",
    google: { clientId: CLIENT_ID, clientSecret: "google-secret" },
    secret: Buffer.alloc(32, 3),
    trustProxyHops: 0,
  };
}

function setCookies(headers: Record<string, unknown>): string[] {
  const raw = headers["set-cookie"];
  return Array.isArray(raw) ? raw.map(String) : raw ? [String(raw)] : [];
}

function cookieValue(headers: Record<string, unknown>, name: string): string | null {
  const found = setCookies(headers).find((entry) => entry.startsWith(`${name}=`));
  return found ? (found.split(";")[0] as string).slice(name.length + 1) : null;
}

async function gatewayWithGoogle(sub = "1100") {
  const { pool, drop } = await migratedSchema();
  const { publicKey, privateKey } = rsaKeys();
  let nonce = "";
  const tokenBodies: string[] = [];
  const fetchImpl = (async (_url: string | URL | Request, init?: RequestInit) => {
    tokenBodies.push(String(init?.body ?? ""));
    const now = Date.now();
    return new Response(JSON.stringify({ id_token: signIdToken(privateKey, goodClaims(now, { sub, nonce })) }));
  }) as typeof fetch;
  const app = await buildGateway({ config: config(), pool, fetchImpl, keys: { key: async () => publicKey }, logger: false });
  const start = async (returnTo = "/wallets") => {
    const reply = await app.inject({ method: "GET", url: `/auth/google/start?return_to=${encodeURIComponent(returnTo)}` });
    const location = new URL(String(reply.headers.location));
    nonce = location.searchParams.get("nonce") ?? "";
    return { reply, location, login: cookieValue(reply.headers, "__Host-whale_login") as string };
  };
  return { app, pool, drop, start, tokenBodies };
}

async function signedIn(app: FastifyInstance, start: () => Promise<{ location: URL; login: string }>): Promise<string> {
  const { location, login } = await start();
  const callback = await app.inject({
    method: "GET",
    url: `/auth/google/callback?code=c1&state=${location.searchParams.get("state")}`,
    headers: { cookie: `__Host-whale_login=${login}` },
  });
  return cookieValue(callback.headers, "__Host-whale_session") as string;
}

test("Google sign-in creates one account, opens a session, and logout closes it", { skip: !TEST_DATABASE_URL }, async () => {
  const { app, pool, drop, start, tokenBodies } = await gatewayWithGoogle();
  try {
    const { reply, location, login } = await start("/connect?request=r1");
    assert.equal(reply.statusCode, 302);
    assert.equal(location.origin + location.pathname, "https://accounts.google.com/o/oauth2/v2/auth");
    assert.equal(location.searchParams.get("redirect_uri"), `${ORIGIN}/auth/google/callback`);
    assert.equal(location.searchParams.get("code_challenge_method"), "S256");
    assert.match(setCookies(reply.headers)[0] ?? "", /HttpOnly; Secure; SameSite=Lax/);

    const callback = await app.inject({
      method: "GET",
      url: `/auth/google/callback?code=c1&state=${location.searchParams.get("state")}`,
      headers: { cookie: `__Host-whale_login=${login}` },
    });
    assert.equal(callback.statusCode, 302);
    assert.equal(callback.headers.location, "/connect?request=r1");
    assert.match(tokenBodies[0] ?? "", /code_verifier=/);
    const session = cookieValue(callback.headers, "__Host-whale_session") as string;
    assert.ok(session);
    assert.equal(cookieValue(callback.headers, "__Host-whale_login"), "");

    const me = await app.inject({ method: "GET", url: "/api/me", headers: { cookie: `__Host-whale_session=${session}` } });
    assert.equal(me.statusCode, 200);
    assert.equal(me.json().email, "ana@example.com");
    assert.equal(me.headers["cache-control"], "no-store");
    assert.equal(me.headers["x-frame-options"], "DENY");

    await signedIn(app, start);
    const accounts = await pool.query("SELECT count(*)::int AS n FROM accounts");
    assert.equal(accounts.rows[0].n, 1);
    const events = await pool.query("SELECT action FROM audit_events ORDER BY id");
    assert.deepEqual(events.rows.map((row) => row.action), ["account.created", "account.signed_in"]);

    const crossSite = await app.inject({ method: "POST", url: "/auth/logout", headers: { cookie: `__Host-whale_session=${session}`, origin: "https://evil.example" } });
    assert.equal(crossSite.statusCode, 403);
    const logout = await app.inject({ method: "POST", url: "/auth/logout", headers: { cookie: `__Host-whale_session=${session}`, origin: ORIGIN } });
    assert.equal(logout.statusCode, 204);
    const after = await app.inject({ method: "GET", url: "/api/me", headers: { cookie: `__Host-whale_session=${session}` } });
    assert.equal(after.statusCode, 401);
  } finally {
    await app.close();
    await drop();
  }
});

test("the callback refuses a missing login cookie, a wrong state, a denial, and an open redirect", { skip: !TEST_DATABASE_URL }, async () => {
  const { app, drop, start } = await gatewayWithGoogle();
  try {
    const { location, login } = await start("https://evil.example");
    const state = location.searchParams.get("state");
    const noCookie = await app.inject({ method: "GET", url: `/auth/google/callback?code=c1&state=${state}` });
    assert.equal(noCookie.headers.location, "/login?error=expired");
    const wrongState = await app.inject({ method: "GET", url: "/auth/google/callback?code=c1&state=forged", headers: { cookie: `__Host-whale_login=${login}` } });
    assert.equal(wrongState.headers.location, "/login?error=state");
    const denied = await app.inject({ method: "GET", url: `/auth/google/callback?error=access_denied&state=${state}`, headers: { cookie: `__Host-whale_login=${login}` } });
    assert.equal(denied.headers.location, "/login?error=denied");
    const ok = await app.inject({ method: "GET", url: `/auth/google/callback?code=c1&state=${state}`, headers: { cookie: `__Host-whale_login=${login}` } });
    assert.equal(ok.headers.location, "/");
  } finally {
    await app.close();
    await drop();
  }
});

test("a closed account cannot sign in and an idle session expires", { skip: !TEST_DATABASE_URL }, async () => {
  const { app, pool, drop, start } = await gatewayWithGoogle("2200");
  try {
    const session = await signedIn(app, start);
    await pool.query("UPDATE sessions SET last_seen_at = now() - interval '13 hours'");
    const idle = await app.inject({ method: "GET", url: "/api/me", headers: { cookie: `__Host-whale_session=${session}` } });
    assert.equal(idle.statusCode, 401);
    await pool.query("UPDATE accounts SET status = 'closed'");
    const { location, login } = await start();
    const refused = await app.inject({
      method: "GET",
      url: `/auth/google/callback?code=c1&state=${location.searchParams.get("state")}`,
      headers: { cookie: `__Host-whale_login=${login}` },
    });
    assert.equal(refused.headers.location, "/login?error=closed");
  } finally {
    await app.close();
    await drop();
  }
});
