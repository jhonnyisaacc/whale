import assert from "node:assert/strict";
import test from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import pg from "pg";
import { authenticateApiKey, createAgent } from "../src/gateway/agents.js";
import { buildGateway } from "../src/gateway/app.js";
import { applyDueChanges, unfreezeAction, WIDEN_DELAY_MS, widenAction } from "../src/gateway/policy-changes.js";
import { DEFAULT_POLICY } from "../src/gateway/policy.js";
import { gatewayConfig, signedInAccount } from "./gateway-fixtures.js";
import { migratedSchema, TEST_DATABASE_URL } from "./pg-schema.js";
import { softAuthenticator } from "./webauthn-fixtures.js";

const RP = { rpId: "whale.example", origin: "https://whale.example" };

async function harness(setup: { processClock?: boolean } = {}) {
  const { pool, drop } = await migratedSchema();
  let clock = Date.UTC(2026, 10, 3, 12);
  const now = setup.processClock ? undefined : () => clock;
  const app = await buildGateway({ config: gatewayConfig(), pool, logger: false, keys: { key: async () => null }, executor: null, now, turnkey: null, delegation: null });
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

async function holdLock(pool: pg.Pool, sql: string, params: unknown[]) {
  const holder = await pool.connect();
  await holder.query("BEGIN");
  await holder.query(sql, params);
  const pid = (await holder.query<{ pid: number }>("SELECT pg_backend_pid() AS pid")).rows[0]?.pid as number;
  const watcher = new pg.Client({ connectionString: TEST_DATABASE_URL });
  await watcher.connect();
  const queued = async (count: number) => {
    const found = await watcher.query<{ n: number }>(
      `WITH RECURSIVE queue(pid) AS (SELECT $1::int UNION SELECT a.pid FROM pg_stat_activity a JOIN queue q ON q.pid = ANY(pg_blocking_pids(a.pid)))
       SELECT count(*)::int - 1 AS n FROM queue`,
      [pid],
    );
    return (found.rows[0]?.n ?? 0) >= count;
  };
  const waitingBehind = async (count: number, unless?: () => boolean) => {
    for (let tries = 0; tries < 1500; tries += 1) {
      if (unless?.() || (await queued(count))) return;
      await delay(10);
    }
    await release();
    throw new Error(`fewer than ${count} transactions queued behind the held lock`);
  };
  let released = false;
  const release = async () => {
    if (released) return;
    released = true;
    await holder.query("COMMIT");
    holder.release();
    await watcher.end();
  };
  return { waitingBehind, release };
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
    const agent = await createAgent(pool, { accountId: user.accountId, walletId: wallet.id, name: "bot", limits: { chains: ["base"], actions: ["swap"], maxTxUsd: 10, dailyUsd: 20 } });
    if ("refused" in agent) throw new Error(agent.refused);
    const { apiKey } = agent;
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

test("a narrowing that races the sweep waits for it instead of deadlocking", { skip: !TEST_DATABASE_URL }, async () => {
  const { app, pool, user, wallet, approve, put, advance, now, drop } = await harness();
  try {
    const wider = { ...DEFAULT_POLICY, maxTxUsd: 80 };
    assert.equal((await put({ baseVersion: 1, document: wider, assertion: await approve(widenAction(wallet.id, 1, wider)) })).statusCode, 202);
    advance(WIDEN_DELAY_MS + 1);
    const lock = await holdLock(pool, "SELECT 1 FROM policy_changes WHERE status = 'pending' FOR UPDATE", []);
    const sweep = applyDueChanges(pool, now());
    await lock.waitingBehind(1);
    const narrowing = put({ baseVersion: 1, document: { ...DEFAULT_POLICY, maxTxUsd: 10 } });
    await lock.waitingBehind(2);
    await lock.release();
    assert.equal(await sweep, 1);
    const narrowed = await narrowing;
    assert.equal(narrowed.statusCode, 409, narrowed.body);
    assert.equal(narrowed.json().error, "stale");
    assert.deepEqual((await put({ baseVersion: 2, document: { ...wider, maxTxUsd: 10 } })).json(), { status: "applied", version: 3 });
    const listed = (await app.inject({ method: "GET", url: "/api/wallets", headers: user.headers })).json().wallets[0];
    assert.deepEqual([listed.policyVersion, listed.policy.maxTxUsd], [3, 10]);
  } finally {
    await drop();
  }
});

test("two widenings that race answer one 202 and one 409", { skip: !TEST_DATABASE_URL }, async () => {
  const { pool, wallet, approve, put, drop } = await harness();
  try {
    const first = { ...DEFAULT_POLICY, maxTxUsd: 60 };
    assert.equal((await put({ baseVersion: 1, document: first, assertion: await approve(widenAction(wallet.id, 1, first)) })).statusCode, 202);
    const [a, b] = [{ ...DEFAULT_POLICY, maxTxUsd: 70 }, { ...DEFAULT_POLICY, maxTxUsd: 80 }];
    const [approveA, approveB] = [await approve(widenAction(wallet.id, 1, a)), await approve(widenAction(wallet.id, 1, b))];
    const lock = await holdLock(pool, "SELECT 1 FROM policy_changes WHERE status = 'pending' FOR UPDATE", []);
    const earlier = put({ baseVersion: 1, document: a, assertion: approveA });
    await lock.waitingBehind(1);
    const later = put({ baseVersion: 1, document: b, assertion: approveB });
    await lock.waitingBehind(2);
    await lock.release();
    const [winner, loser] = [await earlier, await later];
    assert.equal(winner.statusCode, 202, winner.body);
    assert.equal(loser.statusCode, 409, loser.body);
    assert.equal(loser.json().error, "conflict");
    const pending = await pool.query("SELECT document->>'maxTxUsd' AS max FROM policy_changes WHERE status = 'pending'");
    assert.deepEqual(pending.rows.map((row) => Number(row.max)), [70]);
  } finally {
    await drop();
  }
});

test("freezing cancels a pending widening, so it never applies after unfreezing", { skip: !TEST_DATABASE_URL }, async () => {
  const { app, pool, user, wallet, approve, put, advance, now, drop } = await harness();
  try {
    const wider = { ...DEFAULT_POLICY, maxTxUsd: 80 };
    const scheduled = await put({ baseVersion: 1, document: wider, assertion: await approve(widenAction(wallet.id, 1, wider)) });
    assert.equal(scheduled.statusCode, 202);
    assert.equal((await app.inject({ method: "POST", url: `/api/wallets/${wallet.id}/freeze`, headers: user.headers, payload: {} })).statusCode, 200);
    assert.equal((await app.inject({ method: "GET", url: `/api/wallets/${wallet.id}/policy/pending`, headers: user.headers })).json().pending, null);
    const thawed = await app.inject({ method: "POST", url: `/api/wallets/${wallet.id}/unfreeze`, headers: user.headers, payload: { assertion: await approve(unfreezeAction(wallet.id)) } });
    assert.equal(thawed.statusCode, 200);
    advance(WIDEN_DELAY_MS + 1);
    assert.equal(await applyDueChanges(pool, now()), 0);
    const listed = (await app.inject({ method: "GET", url: "/api/wallets", headers: user.headers })).json().wallets[0];
    assert.deepEqual([listed.policyVersion, listed.policy.maxTxUsd], [1, DEFAULT_POLICY.maxTxUsd]);
    const cancelled = await pool.query("SELECT detail FROM audit_events WHERE action = 'policy.widen_cancelled'");
    assert.deepEqual(cancelled.rows.map((row) => row.detail), [{ changeId: scheduled.json().changeId, reason: "frozen" }]);
  } finally {
    await drop();
  }
});

test("a frozen wallet refuses a widening, even one approved with a passkey", { skip: !TEST_DATABASE_URL }, async () => {
  const { app, pool, user, wallet, approve, put, advance, now, drop } = await harness();
  try {
    assert.equal((await app.inject({ method: "POST", url: `/api/wallets/${wallet.id}/freeze`, headers: user.headers, payload: {} })).statusCode, 200);
    const wider = { ...DEFAULT_POLICY, maxTxUsd: 80 };
    const refused = await put({ baseVersion: 1, document: wider, assertion: await approve(widenAction(wallet.id, 1, wider)) });
    assert.deepEqual([refused.statusCode, refused.json().error], [409, "wallet_frozen"], refused.body);
    assert.equal((await app.inject({ method: "GET", url: `/api/wallets/${wallet.id}/policy/pending`, headers: user.headers })).json().pending, null);
    advance(WIDEN_DELAY_MS + 1);
    assert.equal(await applyDueChanges(pool, now()), 0);
    const listed = (await app.inject({ method: "GET", url: "/api/wallets", headers: user.headers })).json().wallets[0];
    assert.deepEqual([listed.status, listed.policyVersion, listed.policy.maxTxUsd], ["frozen", 1, DEFAULT_POLICY.maxTxUsd]);
  } finally {
    await drop();
  }
});

for (const scope of ["wallet", "account"] as const) {
  test(`${scope === "wallet" ? "a wallet" : "an account"} freeze that races a widening still cancels it`, { skip: !TEST_DATABASE_URL }, async () => {
    const { app, pool, user, wallet, approve, put, advance, now, drop } = await harness();
    const key = Math.floor(Math.random() * 2 ** 31);
    try {
      await pool.query(`CREATE FUNCTION hold_widen() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN PERFORM pg_advisory_xact_lock(${key}); RETURN NEW; END $$`);
      await pool.query("CREATE TRIGGER hold_widen BEFORE INSERT ON audit_events FOR EACH ROW WHEN (NEW.action = 'policy.widen_requested') EXECUTE FUNCTION hold_widen()");
      const wider = { ...DEFAULT_POLICY, maxTxUsd: 80 };
      const assertion = await approve(widenAction(wallet.id, 1, wider));
      const lock = await holdLock(pool, "SELECT pg_advisory_xact_lock($1)", [key]);
      const widening = put({ baseVersion: 1, document: wider, assertion });
      await lock.waitingBehind(1);
      let frozeFirst = false;
      const url = scope === "wallet" ? `/api/wallets/${wallet.id}/freeze` : "/api/account/freeze";
      const freezing = app.inject({ method: "POST", url, headers: user.headers, payload: {} }).then((reply) => ((frozeFirst = true), reply));
      await lock.waitingBehind(2, () => frozeFirst);
      await lock.release();
      const [widened, frozen] = [await widening, await freezing];
      assert.equal(frozen.statusCode, 200, frozen.body);
      assert.equal(widened.statusCode, 202, widened.body);
      assert.equal((await app.inject({ method: "GET", url: `/api/wallets/${wallet.id}/policy/pending`, headers: user.headers })).json().pending, null);
      advance(WIDEN_DELAY_MS + 1);
      assert.equal(await applyDueChanges(pool, now()), 0);
      const listed = (await app.inject({ method: "GET", url: "/api/wallets", headers: user.headers })).json().wallets[0];
      assert.deepEqual([listed.status, listed.policyVersion, listed.policy.maxTxUsd], ["frozen", 1, DEFAULT_POLICY.maxTxUsd]);
      const cancelled = await pool.query("SELECT detail FROM audit_events WHERE action = 'policy.widen_cancelled'");
      assert.deepEqual(cancelled.rows.map((row) => row.detail), [{ changeId: widened.json().changeId, reason: "frozen" }]);
    } finally {
      await drop();
    }
  });
}

test("the sweep cancels a due widening on a frozen wallet instead of applying it", { skip: !TEST_DATABASE_URL }, async () => {
  const { app, pool, user, wallet, advance, now, drop } = await harness();
  try {
    assert.equal((await app.inject({ method: "POST", url: `/api/wallets/${wallet.id}/freeze`, headers: user.headers, payload: {} })).statusCode, 200);
    const inserted = await pool.query<{ id: string }>(
      "INSERT INTO policy_changes (wallet_id, base_version, document, direction, effective_at, requested_at) VALUES ($1, 1, $2, 'widen', $3, $3) RETURNING id",
      [wallet.id, JSON.stringify({ ...DEFAULT_POLICY, maxTxUsd: 80 }), new Date(now())],
    );
    advance(WIDEN_DELAY_MS + 1);
    assert.equal(await applyDueChanges(pool, now()), 0);
    const listed = (await app.inject({ method: "GET", url: "/api/wallets", headers: user.headers })).json().wallets[0];
    assert.deepEqual([listed.status, listed.policyVersion, listed.policy.maxTxUsd], ["frozen", 1, DEFAULT_POLICY.maxTxUsd]);
    const change = await pool.query("SELECT status FROM policy_changes WHERE id = $1", [inserted.rows[0]?.id]);
    assert.equal(change.rows[0]?.status, "cancelled");
    const cancelled = await pool.query("SELECT actor, detail FROM audit_events WHERE action = 'policy.widen_cancelled'");
    assert.deepEqual(cancelled.rows, [{ actor: "system", detail: { changeId: inserted.rows[0]?.id, reason: "frozen" } }]);
  } finally {
    await drop();
  }
});

test("the widening delay runs on the database clock, so a skewed replica cannot shorten it", { skip: !TEST_DATABASE_URL }, async (t) => {
  const { pool, wallet, approve, put, drop } = await harness({ processClock: true });
  const day = 24 * 60 * 60 * 1000;
  try {
    const wider = { ...DEFAULT_POLICY, maxTxUsd: 80 };
    const assertion = await approve(widenAction(wallet.id, 1, wider));
    t.mock.timers.enable({ apis: ["Date"], now: Date.now() - day });
    const scheduled = await put({ baseVersion: 1, document: wider, assertion });
    t.mock.timers.reset();
    assert.equal(scheduled.statusCode, 202, scheduled.body);
    const databaseNow = (await pool.query<{ now: Date }>("SELECT now()")).rows[0]?.now.getTime() as number;
    assert.ok(Math.abs(Date.parse(scheduled.json().effectiveAt) - (databaseNow + WIDEN_DELAY_MS)) < 60_000, scheduled.body);
    t.mock.timers.enable({ apis: ["Date"], now: Date.now() + day + 60_000 });
    const applied = await applyDueChanges(pool);
    t.mock.timers.reset();
    assert.equal(applied, 0);
    assert.equal((await pool.query("SELECT 1 FROM policy_changes WHERE status = 'pending'")).rows.length, 1);
  } finally {
    t.mock.timers.reset();
    await drop();
  }
});

test("reading the pending change, which runs the sweep, is rate limited", { skip: !TEST_DATABASE_URL }, async () => {
  const { app, user, wallet, drop } = await harness();
  try {
    const read = () => app.inject({ method: "GET", url: `/api/wallets/${wallet.id}/policy/pending`, headers: user.headers });
    for (let index = 0; index < 30; index += 1) assert.equal((await read()).statusCode, 200);
    const limited = await read();
    assert.equal(limited.statusCode, 429);
    assert.deepEqual(limited.json(), { error: "rate_limit" });
  } finally {
    await drop();
  }
});

test("a chain this build dropped from a stored policy still reads, a narrowing applies at once, and a widening still needs a passkey and the delay", { skip: !TEST_DATABASE_URL }, async () => {
  const { app, pool, user, wallet, approve, put, advance, now, drop } = await harness();
  const addDropped = (table: "policies" | "policy_changes", tokens: unknown = null) =>
    pool.query(`UPDATE ${table} SET document = document || jsonb_build_object('chains', (document->'chains') || '["dogechain"]'::jsonb, 'tokenAllowlist', $1::jsonb)`, [JSON.stringify(tokens)]);
  try {
    await addDropped("policies");
    const narrowed = await put({ baseVersion: 1, document: { ...DEFAULT_POLICY, maxTxUsd: 10 } });
    assert.deepEqual(narrowed.json(), { status: "applied", version: 2 });

    await addDropped("policies", [{ chain: "dogechain", address: "0x2222222222222222222222222222222222222222" }]);
    assert.equal((await put({ baseVersion: 2, document: { ...DEFAULT_POLICY, maxTxUsd: 10 } })).statusCode, 428);
    const wider = { ...DEFAULT_POLICY, maxTxUsd: 40, tokenAllowlist: [] };
    assert.equal((await put({ baseVersion: 2, document: wider })).statusCode, 428);
    const scheduled = await put({ baseVersion: 2, document: wider, assertion: await approve(widenAction(wallet.id, 2, wider)) });
    assert.equal(scheduled.statusCode, 202, scheduled.body);
    assert.equal(scheduled.json().effectiveAt, new Date(now() + WIDEN_DELAY_MS).toISOString());

    await addDropped("policy_changes", []);
    const pending = await app.inject({ method: "GET", url: `/api/wallets/${wallet.id}/policy/pending`, headers: user.headers });
    assert.equal(pending.statusCode, 200, pending.body);
    assert.deepEqual(pending.json().pending.document.chains, DEFAULT_POLICY.chains);

    advance(WIDEN_DELAY_MS + 1);
    assert.equal(await applyDueChanges(pool, now()), 1);
    const listed = (await app.inject({ method: "GET", url: "/api/wallets", headers: user.headers })).json().wallets[0];
    assert.deepEqual([listed.policyVersion, listed.policy.maxTxUsd, listed.policy.chains], [3, 40, DEFAULT_POLICY.chains]);
  } finally {
    await drop();
  }
});
