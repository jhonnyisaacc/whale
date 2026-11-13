import assert from "node:assert/strict";
import test from "node:test";
import { buildGateway } from "../src/gateway/app.js";
import { randomBytes } from "node:crypto";
import { addPasskey, MAX_PASSKEYS, newChallenge, registrationOptions, stepUpOptions, verifyStepUp } from "../src/gateway/passkeys.js";
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

test("a credential id that another account already holds is refused with 400", { skip: !TEST_DATABASE_URL }, async () => {
  const { app, pool, user, drop } = await harness();
  try {
    const authenticator = softAuthenticator(RP);
    const add = async (headers: Record<string, string>) => {
      const options = (await app.inject({ method: "POST", url: "/api/passkeys/options", headers, payload: {} })).json();
      return app.inject({ method: "POST", url: "/api/passkeys", headers, payload: { credential: authenticator.register(options.challenge), label: "Shared" } });
    };
    assert.equal((await add(user.headers)).statusCode, 201);
    const other = await signedInAccount(pool);
    const taken = await add(other.headers);
    assert.equal(taken.statusCode, 400);
    assert.equal(taken.json().error, "passkey_rejected");
    const owners = await pool.query("SELECT account_id FROM passkeys");
    assert.deepEqual(owners.rows.map((row) => row.account_id), [user.accountId]);
  } finally {
    await drop();
  }
});

test("used and expired challenges leave the table", { skip: !TEST_DATABASE_URL }, async () => {
  const { app, pool, user, drop } = await harness();
  const rows = async () => Number((await pool.query("SELECT count(*) AS n FROM webauthn_challenges")).rows[0].n);
  try {
    const authenticator = softAuthenticator(RP);
    const options = (await app.inject({ method: "POST", url: "/api/passkeys/options", headers: user.headers, payload: {} })).json();
    assert.equal((await app.inject({ method: "POST", url: "/api/passkeys", headers: user.headers, payload: { credential: authenticator.register(options.challenge), label: "MacBook" } })).statusCode, 201);
    assert.equal(await rows(), 0);

    await newChallenge(pool, user.accountId, "step_up", "stale", Date.now() - 10 * 60 * 1000);
    assert.equal(await rows(), 1);
    const action = { kind: "wallet.unfreeze", walletId: "w1" };
    const stepUp = (await app.inject({ method: "POST", url: "/api/passkeys/step-up", headers: user.headers, payload: { action } })).json();
    assert.equal(await rows(), 1);
    assert.equal(await verifyStepUp(pool, gatewayConfig(), user.accountId, action, authenticator.assert(stepUp.challenge)), true);
    assert.equal(await rows(), 0);
  } finally {
    await drop();
  }
});

const ROUNDS = 10;
const RACERS = 4;

async function racingRegistrations(pool: Awaited<ReturnType<typeof migratedSchema>>["pool"], accountId: string, approver: ReturnType<typeof softAuthenticator> | null) {
  const config = gatewayConfig();
  const attempts = await Promise.all(
    Array.from({ length: RACERS }, async () => {
      const options = await registrationOptions(pool, config, { accountId, email: null });
      const payload = softAuthenticator(RP).register(options.challenge);
      const stepUp = approver ? await stepUpOptions(pool, config, accountId, { kind: "passkey.add", credentialId: payload.id }) : null;
      return { payload, assertion: approver && stepUp ? approver.assert(stepUp.challenge) : null };
    }),
  );
  return Promise.all(attempts.map(({ payload, assertion }, index) => addPasskey(pool, config, { accountId, payload, label: `racer ${index}`, assertion })));
}

test("parallel session-only registrations land exactly one passkey, and the rest keep their challenge and answer step_up_required", { skip: !TEST_DATABASE_URL }, async () => {
  const { pool, drop } = await harness();
  try {
    for (let round = 0; round < ROUNDS; round += 1) {
      const { accountId } = await signedInAccount(pool);
      const results = await racingRegistrations(pool, accountId, null);
      const refusals = results.flatMap((result) => ("refused" in result ? [result.refused] : []));
      assert.deepEqual(refusals, Array(RACERS - 1).fill("step_up_required"), `round ${round}`);
      const live = await pool.query("SELECT count(*)::int AS n FROM passkeys WHERE account_id = $1 AND revoked_at IS NULL", [accountId]);
      assert.equal(live.rows[0].n, 1, `round ${round}`);
      const unused = await pool.query("SELECT count(*)::int AS n FROM webauthn_challenges WHERE account_id = $1 AND purpose = 'register'", [accountId]);
      assert.equal(unused.rows[0].n, RACERS - 1, `round ${round}`);
    }
  } finally {
    await drop();
  }
});

test("parallel stepped-up registrations never take an account past the passkey cap", { skip: !TEST_DATABASE_URL }, async () => {
  const { pool, drop } = await harness();
  try {
    for (let round = 0; round < ROUNDS; round += 1) {
      const { accountId } = await signedInAccount(pool);
      const approver = softAuthenticator(RP, false);
      const options = await registrationOptions(pool, gatewayConfig(), { accountId, email: null });
      assert.ok(!("refused" in (await addPasskey(pool, gatewayConfig(), { accountId, payload: approver.register(options.challenge), label: "approver", assertion: null }))));
      for (let filler = 1; filler < MAX_PASSKEYS - 1; filler += 1) {
        await pool.query("INSERT INTO passkeys (credential_id, account_id, public_key, sign_count, label) VALUES ($1, $2, $3, 0, $4)", [randomBytes(32).toString("base64url"), accountId, randomBytes(77), `filler ${filler}`]);
      }
      const results = await racingRegistrations(pool, accountId, approver);
      assert.equal(results.filter((result) => !("refused" in result)).length, 1, `round ${round}`);
      const live = await pool.query("SELECT count(*)::int AS n FROM passkeys WHERE account_id = $1 AND revoked_at IS NULL", [accountId]);
      assert.equal(live.rows[0].n, MAX_PASSKEYS, `round ${round}`);
    }
  } finally {
    await drop();
  }
});
