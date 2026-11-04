import assert from "node:assert/strict";
import test from "node:test";
import { loadGatewayConfig } from "../src/gateway/config.js";
import { googleKeys, pkceChallenge, verifyGoogleIdToken, type KeySource } from "../src/gateway/google.js";
import { readCookie, safeReturnTo } from "../src/gateway/http.js";
import { sealer } from "../src/gateway/seal.js";
import { CLIENT_ID, goodClaims, rsaKeys, signIdToken } from "./google-fixtures.js";

const NOW = Date.UTC(2026, 10, 3, 12);

test("PKCE challenge matches the RFC 7636 example", () => {
  assert.equal(pkceChallenge("dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk"), "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM");
});

test("a Google ID token is accepted only with the right key, issuer, audience, time, and nonce", async () => {
  const { publicKey, privateKey } = rsaKeys();
  const other = rsaKeys();
  const keys: KeySource = { key: async (kid) => (kid === "k1" ? publicKey : null) };
  const check = (token: string) => verifyGoogleIdToken(token, { clientId: CLIENT_ID, nonce: "n1", keys, now: NOW });
  assert.deepEqual(await check(signIdToken(privateKey, goodClaims(NOW))), { sub: "1100", email: "ana@example.com" });
  assert.deepEqual(await check(signIdToken(privateKey, goodClaims(NOW, { email_verified: false }))), { sub: "1100", email: null });
  await assert.rejects(check(signIdToken(other.privateKey, goodClaims(NOW))), /signature is invalid/);
  await assert.rejects(check(signIdToken(privateKey, goodClaims(NOW), { alg: "none", kid: "k1" })), /Invalid input|expected/);
  await assert.rejects(check(signIdToken(privateKey, goodClaims(NOW), { alg: "RS256", kid: "k9" })), /key is unknown/);
  await assert.rejects(check(signIdToken(privateKey, goodClaims(NOW, { iss: "https://evil.example" }))), /issuer/);
  await assert.rejects(check(signIdToken(privateKey, goodClaims(NOW, { aud: "other.apps.googleusercontent.com" }))), /audience/);
  await assert.rejects(check(signIdToken(privateKey, goodClaims(NOW, { azp: "other" }))), /audience/);
  await assert.rejects(check(signIdToken(privateKey, goodClaims(NOW, { exp: NOW / 1000 - 120 }))), /expired/);
  await assert.rejects(check(signIdToken(privateKey, goodClaims(NOW, { iat: NOW / 1000 + 600 }))), /future/);
  await assert.rejects(check(signIdToken(privateKey, goodClaims(NOW, { nonce: "replayed" }))), /nonce/);
  await assert.rejects(check("a.b"), /malformed/);
});

test("Google keys refetch on an unknown kid at most once a minute", async () => {
  const { publicKey } = rsaKeys();
  const jwk = { ...publicKey.export({ format: "jwk" }), kid: "k1" };
  let calls = 0;
  let clock = NOW;
  const fetchImpl = (async () => {
    calls += 1;
    return new Response(JSON.stringify({ keys: [jwk] }), { headers: { "cache-control": "public, max-age=3600" } });
  }) as typeof fetch;
  const keys = googleKeys(fetchImpl, () => clock);
  assert.ok(await keys.key("k1"));
  assert.equal(await keys.key("forged"), null);
  assert.equal(await keys.key("forged"), null);
  assert.equal(calls, 1);
  clock += 61_000;
  assert.equal(await keys.key("forged"), null);
  assert.equal(calls, 2);
});

test("sealed values open only for their purpose, untampered, and before expiry", () => {
  const secret = Buffer.alloc(32, 7);
  const login = sealer(secret, "google-login");
  const token = login.seal({ state: "s" }, 1000, NOW);
  assert.deepEqual(login.open(token, NOW), { state: "s" });
  assert.equal(login.open(token, NOW + 1000), null);
  assert.equal(sealer(secret, "other").open(token, NOW), null);
  assert.equal(sealer(Buffer.alloc(32, 8), "google-login").open(token, NOW), null);
  const raw = Buffer.from(token, "base64url");
  raw[raw.length - 1] ^= 1;
  assert.equal(login.open(raw.toString("base64url"), NOW), null);
  assert.equal(login.open("short", NOW), null);
});

test("return_to keeps same-origin paths only, and cookies parse by exact name", () => {
  for (const bad of ["https://evil.example", "//evil.example", "/\\evil.example", "javascript:alert(1)", "/a\nb", 42, undefined, `/${"a".repeat(600)}`]) {
    assert.equal(safeReturnTo(bad), "/", String(bad));
  }
  assert.equal(safeReturnTo("/connect?request=abc"), "/connect?request=abc");
  assert.equal(readCookie("a=1; __Host-whale_session=tok; b=2", "__Host-whale_session"), "tok");
  assert.equal(readCookie("x__Host-whale_session=tok", "__Host-whale_session"), null);
});

test("gateway boot refuses signing credentials, closed flags, plain http, and short secrets", () => {
  const base = {
    GATEWAY_PUBLIC_URL: "https://whale.example",
    DATABASE_URL: "postgres://x",
    GOOGLE_CLIENT_ID: CLIENT_ID,
    GOOGLE_CLIENT_SECRET: "secret",
    GATEWAY_SECRET: Buffer.alloc(32, 1).toString("base64url"),
  };
  assert.equal(loadGatewayConfig(base).publicUrl.origin, "https://whale.example");
  assert.equal(loadGatewayConfig({ ...base, GATEWAY_PUBLIC_URL: "http://localhost:5173" }).publicUrl.origin, "http://localhost:5173");
  assert.throws(() => loadGatewayConfig({ ...base, TURNKEY_API_PRIVATE_KEY: "k" }), /holds no signing credential/);
  assert.throws(() => loadGatewayConfig({ ...base, WHALE_BROADCAST: "true" }), /holds no signing credential/);
  assert.throws(() => loadGatewayConfig({ ...base, HOSTED_LIVE: "true" }), /closed/);
  assert.throws(() => loadGatewayConfig({ ...base, GATEWAY_PUBLIC_URL: "http://whale.example" }), /https/);
  assert.throws(() => loadGatewayConfig({ ...base, GATEWAY_PUBLIC_URL: "https://whale.example/app" }), /bare origin/);
  assert.throws(() => loadGatewayConfig({ ...base, GATEWAY_SECRET: "c2hvcnQ" }), /32 random bytes/);
  assert.throws(() => loadGatewayConfig({ ...base, GOOGLE_CLIENT_ID: "abc" }), /not a Google OAuth client id/);
});
