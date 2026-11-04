import assert from "node:assert/strict";
import test from "node:test";
import { authenticateApiKey, createAgent } from "../src/gateway/agents.js";
import { buildGateway } from "../src/gateway/app.js";
import { applyDueChanges, unfreezeAction, WIDEN_DELAY_MS, widenAction } from "../src/gateway/policy-changes.js";
import { DEFAULT_POLICY } from "../src/gateway/policy.js";
import { gatewayConfig, signedInAccount } from "./gateway-fixtures.js";
import { migratedSchema, TEST_DATABASE_URL } from "./pg-schema.js";
import { softAuthenticator } from "./webauthn-fixtures.js";

const RP = { rpId: "whale.example", origin: "https://whale.example" };

async function harness() {
  const { pool, drop } = await migratedSchema();
  let clock = Date.UTC(2026, 10, 3, 12);
  const app = await buildGateway({ config: gatewayConfig(), pool, logger: false, keys: { key: async () => null }, executor: null, now: () => clock, turnkey: null, delegation: null });
  const user = await signedInAccount(pool);
  const authenticator = softAuthenticator(RP);
  const options = (await app.inject({ method: "POST", url: "/api/passkeys/options", headers: user.headers, payload: {} })).json();
  await app.inject({ method: "POST", url: "/api/passkeys", headers: user.headers, payload: { credential: authenticator.register(options.challenge), label: "Mac" } });
  const wallet = (await app.inject({ method: "POST", url: "/api/wallets", headers: user.headers, payload: { label: "main", level: "enclave" } })).json();
  const approve = async (action: unknown) => {
    const stepUp = (await app.inject({ method: "POST", url: "/api/passkeys/step-up", headers: user.headers, payload: { action } })).json();
    return authenticator.assert(stepUp.challenge);
  };
  const put = (payload: unknown) => app.inject({ method: "PUT", url: `/api/wallets/${wallet.id}/policy`, headers: user.headers, payload: payload as Record<string, unknown> });
  return { app, pool, user, wallet, approve, put, advance: (ms: number) => (clock += ms), now: () => clock, drop: async () => (await app.close(), await drop()) };
}

test("narrowing applies at once; widening needs a passkey for that exact document and waits a day", { skip: !TEST_DATABASE_URL }, async () => {
  const { app, pool, user, wallet, approve, put, advance, now, drop } = await harness();
  try {
    const narrowed = await put({ baseVersion: 1, document: { ...DEFAULT_POLICY, maxTxUsd: 10 } });
    assert.deepEqual(narrowed.json(), { status: "applied", version: 2 });
    assert.equal((await put({ baseVersion: 1, document: DEFAULT_POLICY })).statusCode, 409);

    const wider = { ...DEFAULT_POLICY, maxTxUsd: 80, dailyUsd: 200 };
    assert.equal((await put({ baseVersion: 2, document: wider })).statusCode, 428);
    const wrong = await put({ baseVersion: 2, document: wider, assertion: await approve(widenAction(wallet.id, 2, { ...wider, maxTxUsd: 90 })) });
    assert.equal(wrong.statusCode, 403);
    const scheduled = await put({ baseVersion: 2, document: wider, assertion: await approve(widenAction(wallet.id, 2, wider)) });
    assert.equal(scheduled.statusCode, 202);
    assert.equal(scheduled.json().effectiveAt, new Date(now() + WIDEN_DELAY_MS).toISOString());

    advance(WIDEN_DELAY_MS - 60_000);
    assert.equal(await applyDueChanges(pool, now()), 0);
    assert.equal((await app.inject({ method: "GET", url: `/api/wallets/${wallet.id}/policy/pending`, headers: user.headers })).json().pending.document.maxTxUsd, 80);
    advance(120_000);
    assert.equal(await applyDueChanges(pool, now()), 1);
    const listed = (await app.inject({ method: "GET", url: "/api/wallets", headers: user.headers })).json().wallets[0];
    assert.deepEqual([listed.policyVersion, listed.policy.maxTxUsd], [3, 80]);

    const again = { ...wider, chains: [...wider.chains, "optimism"] };
    await put({ baseVersion: 3, document: again, assertion: await approve(widenAction(wallet.id, 3, again)) });
    assert.equal((await put({ baseVersion: 3, document: { ...wider, maxTxUsd: 5 } })).json().status, "applied");
    advance(WIDEN_DELAY_MS + 1);
    assert.equal(await applyDueChanges(pool, now()), 0);
    assert.equal((await app.inject({ method: "DELETE", url: `/api/wallets/${wallet.id}/policy/pending`, headers: user.headers })).statusCode, 404);

    const third = { ...wider, maxTxUsd: 6 };
    const thirdReply = await put({ baseVersion: 4, document: third, assertion: await approve(widenAction(wallet.id, 4, third)) });
    assert.equal(thirdReply.statusCode, 202, thirdReply.body);
    assert.equal((await app.inject({ method: "DELETE", url: `/api/wallets/${wallet.id}/policy/pending`, headers: user.headers })).statusCode, 204);
    const actions = (await pool.query("SELECT action FROM audit_events WHERE action LIKE 'policy.%' ORDER BY id")).rows.map((row) => row.action);
    assert.deepEqual(actions, ["policy.narrowed", "policy.widen_requested", "policy.widened", "policy.widen_requested", "policy.narrowed", "policy.widen_requested", "policy.widen_cancelled"]);
  } finally {
    await drop();
  }
});

test("freezing stops every agent at once, and unfreezing takes a passkey", { skip: !TEST_DATABASE_URL }, async () => {
  const { app, pool, user, wallet, approve, drop } = await harness();
  try {
    const { apiKey } = await createAgent(pool, { accountId: user.accountId, walletId: wallet.id, name: "bot", limits: { chains: ["base"], actions: ["swap"], maxTxUsd: 10, dailyUsd: 20 } });
    assert.ok(await authenticateApiKey(pool, apiKey));
    assert.deepEqual((await app.inject({ method: "POST", url: `/api/wallets/${wallet.id}/freeze`, headers: user.headers, payload: {} })).json(), { status: "frozen" });
    assert.equal(await authenticateApiKey(pool, apiKey), null);
    const forged = await app.inject({ method: "POST", url: `/api/wallets/${wallet.id}/unfreeze`, headers: user.headers, payload: { assertion: await approve(unfreezeAction("00000000-0000-4000-8000-000000000000")) } });
    assert.equal(forged.statusCode, 403);
    const thawed = await app.inject({ method: "POST", url: `/api/wallets/${wallet.id}/unfreeze`, headers: user.headers, payload: { assertion: await approve(unfreezeAction(wallet.id)) } });
    assert.deepEqual(thawed.json(), { status: "unfrozen" });
    assert.ok(await authenticateApiKey(pool, apiKey));
    assert.deepEqual((await app.inject({ method: "POST", url: "/api/account/freeze", headers: user.headers, payload: {} })).json(), { frozen: 1 });
    assert.equal(await authenticateApiKey(pool, apiKey), null);
    const other = await signedInAccount(pool);
    assert.equal((await app.inject({ method: "POST", url: `/api/wallets/${wallet.id}/freeze`, headers: other.headers, payload: {} })).statusCode, 404);
  } finally {
    await drop();
  }
});
