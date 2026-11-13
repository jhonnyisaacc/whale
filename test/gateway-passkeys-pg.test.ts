import assert from "node:assert/strict";
import test from "node:test";
import { buildGateway } from "../src/gateway/app.js";
import { verifyStepUp } from "../src/gateway/passkeys.js";
import { gatewayConfig, signedInAccount } from "./gateway-fixtures.js";
import { migratedSchema, TEST_DATABASE_URL } from "./pg-schema.js";
import { softAuthenticator } from "./webauthn-fixtures.js";

const RP = { rpId: "whale.example", origin: "https://whale.example" };

async function harness() {
  const { pool, drop } = await migratedSchema();
  const app = await buildGateway({ config: gatewayConfig(), pool, logger: false, keys: { key: async () => null }, executor: null });
  const user = await signedInAccount(pool);
  return { app, pool, user, drop: async () => (await app.close(), await drop()) };
}

test("a passkey registers once per challenge and approves exactly the action it was asked for", { skip: !TEST_DATABASE_URL }, async () => {
  const { app, pool, user, drop } = await harness();
  try {
    const authenticator = softAuthenticator(RP);
    const options = (await app.inject({ method: "POST", url: "/api/passkeys/options", headers: user.headers, payload: {} })).json();
    assert.equal(options.rp.id, "whale.example");
    assert.deepEqual(options.pubKeyCredParams, [{ type: "public-key", alg: -7 }]);
    assert.equal(options.authenticatorSelection.userVerification, "required");
    const credential = authenticator.register(options.challenge);
    const added = await app.inject({ method: "POST", url: "/api/passkeys", headers: user.headers, payload: { credential, label: "MacBook" } });
    assert.equal(added.statusCode, 201);
    const readd = (await app.inject({ method: "POST", url: "/api/passkeys/step-up", headers: user.headers, payload: { action: { kind: "passkey.add", credentialId: credential.id } } })).json();
    const replay = await app.inject({ method: "POST", url: "/api/passkeys", headers: user.headers, payload: { credential, label: "again", assertion: authenticator.assert(readd.challenge) } });
    assert.match(replay.json().detail, /expired or was already used/);
    const listed = (await app.inject({ method: "GET", url: "/api/passkeys", headers: user.headers })).json().passkeys;
    assert.deepEqual(listed.map((entry: { label: string }) => entry.label), ["MacBook"]);
    const stored = await pool.query("SELECT public_key FROM passkeys");
    assert.ok(Buffer.isBuffer(stored.rows[0].public_key));

    const action = { kind: "policy.widen", walletId: "w1", maxTxUsd: 500 };
    const stepUp = (await app.inject({ method: "POST", url: "/api/passkeys/step-up", headers: user.headers, payload: { action } })).json();
    assert.deepEqual(stepUp.allowCredentials, [{ type: "public-key", id: authenticator.credentialId.toString("base64url") }]);
    const assertion = authenticator.assert(stepUp.challenge);
    assert.match(String(await verifyStepUp(pool, gatewayConfig(), user.accountId, { ...action, maxTxUsd: 5000 }, assertion)), /different action/);
    const second = (await app.inject({ method: "POST", url: "/api/passkeys/step-up", headers: user.headers, payload: { action } })).json();
    const good = authenticator.assert(second.challenge);
    assert.equal(await verifyStepUp(pool, gatewayConfig(), user.accountId, action, good), true);
    assert.match(String(await verifyStepUp(pool, gatewayConfig(), user.accountId, action, good)), /expired, was used/);

    const other = await signedInAccount(pool);
    const theirs = (await app.inject({ method: "POST", url: "/api/passkeys/step-up", headers: other.headers, payload: { action } })).json();
    assert.equal(theirs.error, "no_passkey");
    const counter = await pool.query("SELECT sign_count FROM passkeys");
    assert.equal(Number(counter.rows[0].sign_count), 3);
  } finally {
    await drop();
  }
});

test("a registration from another origin or an unknown challenge is refused", { skip: !TEST_DATABASE_URL }, async () => {
  const { app, user, drop } = await harness();
  try {
    const authenticator = softAuthenticator(RP);
    const options = (await app.inject({ method: "POST", url: "/api/passkeys/options", headers: user.headers, payload: {} })).json();
    const foreign = await app.inject({ method: "POST", url: "/api/passkeys", headers: user.headers, payload: { credential: authenticator.register(options.challenge, { origin: "https://evil.example" }), label: "x" } });
    assert.match(foreign.json().detail, /origin/);
    const unknown = await app.inject({ method: "POST", url: "/api/passkeys", headers: user.headers, payload: { credential: authenticator.register("z".repeat(43)), label: "x" } });
    assert.match(unknown.json().detail, /expired or was already used/);
  } finally {
    await drop();
  }
});

test("a second passkey needs a step-up from an existing passkey bound to the new credential id", { skip: !TEST_DATABASE_URL }, async () => {
  const { app, user, drop } = await harness();
  const register = async (authenticator: ReturnType<typeof softAuthenticator>) => {
    const options = (await app.inject({ method: "POST", url: "/api/passkeys/options", headers: user.headers, payload: {} })).json();
    return authenticator.register(options.challenge);
  };
  const approval = async (authenticator: ReturnType<typeof softAuthenticator>, credentialId: string) => {
    const options = (await app.inject({ method: "POST", url: "/api/passkeys/step-up", headers: user.headers, payload: { action: { kind: "passkey.add", credentialId } } })).json();
    return authenticator.assert(options.challenge);
  };
  try {
    const first = softAuthenticator(RP);
    const added = await app.inject({ method: "POST", url: "/api/passkeys", headers: user.headers, payload: { credential: await register(first), label: "MacBook" } });
    assert.equal(added.statusCode, 201);

    const credential = await register(softAuthenticator(RP));
    const bare = await app.inject({ method: "POST", url: "/api/passkeys", headers: user.headers, payload: { credential, label: "Phone" } });
    assert.equal(bare.statusCode, 428);
    assert.equal(bare.json().error, "step_up_required");

    const elsewhere = await app.inject({ method: "POST", url: "/api/passkeys", headers: user.headers, payload: { credential, label: "Phone", assertion: await approval(first, "c".repeat(43)) } });
    assert.equal(elsewhere.statusCode, 403);
    assert.equal(elsewhere.json().error, "step_up_failed");

    const assertion = await approval(first, credential.id);
    const approved = await app.inject({ method: "POST", url: "/api/passkeys", headers: user.headers, payload: { credential, label: "Phone", assertion } });
    assert.equal(approved.statusCode, 201);

    const third = await register(softAuthenticator(RP));
    const replayed = await app.inject({ method: "POST", url: "/api/passkeys", headers: user.headers, payload: { credential: third, label: "Tablet", assertion } });
    assert.equal(replayed.statusCode, 403);

    const listed = (await app.inject({ method: "GET", url: "/api/passkeys", headers: user.headers })).json().passkeys;
    assert.deepEqual(listed.map((entry: { label: string }) => entry.label), ["MacBook", "Phone"]);
  } finally {
    await drop();
  }
});
