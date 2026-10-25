import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import pg from "pg";
import type { TxOutcome, TxRecord } from "../src/domain.js";
import { acquireExecutorLock, backfillStrategyIds, closeSpendPools, commitSpend, listingKey, reconcileReserved, recordSpend, recordTx, releaseSpend } from "../src/spend.js";

const url = process.env.TEST_DATABASE_URL;

function tx(txHash: string, outcome: TxOutcome): TxRecord {
  return { chainKey: "base", txHash, from: "0xowner", to: "0xrouter", value: "0", outcome };
}

test("spend journal records tx hashes and boot reconciliation settles aged reservations", { skip: !url }, async () => {
  const databaseUrl = url as string;
  const run = randomUUID();
  const key = (name: string) => `${run}:${name}`;
  const day = "2026-10-21";
  const client = new pg.Client({ connectionString: databaseUrl });
  await client.connect();
  try {
    for (const name of ["landed", "dead", "unknown", "nohash", "fresh", "replaced"]) {
      assert.equal(await recordSpend(databaseUrl, key(name), 1, day), "reserved");
    }
    assert.equal(await recordSpend(databaseUrl, key("landed"), 1, day), "exists");
    await recordTx(databaseUrl, key("landed"), tx(`${run}:a`, "pending"));
    await recordTx(databaseUrl, key("dead"), tx(`${run}:b`, "pending"));
    await recordTx(databaseUrl, key("unknown"), tx(`${run}:c`, "pending"));
    await recordTx(databaseUrl, key("fresh"), tx(`${run}:d`, "pending"));
    await recordTx(databaseUrl, key("replaced"), tx(`${run}:e1`, "pending"));
    await recordTx(databaseUrl, key("replaced"), tx(`${run}:e2`, "pending"));
    await recordTx(databaseUrl, key("replaced"), tx(`${run}:e1`, "expired"));
    const replaced = await client.query("SELECT tx_hash, outcome FROM spend_journal WHERE idempotency_key = $1", [key("replaced")]);
    assert.deepEqual(replaced.rows[0], { tx_hash: `${run}:e2`, outcome: "pending" });
    const audit = await client.query("SELECT outcome FROM signed_tx WHERE tx_hash = $1", [`${run}:e1`]);
    assert.equal(audit.rows[0]?.outcome, "expired");
    await client.query(
      "INSERT INTO spend_journal (idempotency_key, usd, spent_on, status, reserved_at) VALUES ($1, 1, $2::date, 'reserved', NULL)",
      [key("legacy"), day],
    );
    await client.query("UPDATE spend_journal SET reserved_at = now() - interval '1 hour' WHERE idempotency_key = ANY($1)", [
      ["landed", "dead", "unknown", "nohash", "replaced"].map(key),
    ]);
    const outcomes: Record<string, TxOutcome> = { [`${run}:a`]: "landed", [`${run}:b`]: "expired", [`${run}:c`]: "pending", [`${run}:e2`]: "landed" };
    const seen: string[] = [];
    await reconcileReserved(databaseUrl, 10, async (aged) => outcomes[aged.txHash] ?? null, (entry) => {
      if (entry.idempotencyKey.startsWith(run)) seen.push(entry.idempotencyKey);
    });
    const rows = await client.query<{ idempotency_key: string; status: string }>("SELECT idempotency_key, status FROM spend_journal WHERE idempotency_key LIKE $1", [`${run}:%`]);
    const status = Object.fromEntries(rows.rows.map((row) => [row.idempotency_key.slice(run.length + 1), row.status]));
    assert.deepEqual(status, {
      landed: "committed",
      dead: "released",
      unknown: "reserved",
      nohash: "released",
      fresh: "reserved",
      replaced: "committed",
      legacy: "reserved",
    });
    assert.equal(seen.includes(key("fresh")), false);
    assert.equal(await recordSpend(databaseUrl, key("dead"), 1, day), "reserved");
    const rereserved = await client.query("SELECT tx_hash, reserved_at IS NOT NULL AS stamped FROM spend_journal WHERE idempotency_key = $1", [key("dead")]);
    assert.deepEqual(rereserved.rows[0], { tx_hash: null, stamped: true });
    await commitSpend(databaseUrl, key("dead"));
    await releaseSpend(databaseUrl, key("dead"));
    const settled = await client.query("SELECT status FROM spend_journal WHERE idempotency_key = $1", [key("dead")]);
    assert.equal(settled.rows[0]?.status, "committed");
  } finally {
    await client.query("DELETE FROM spend_journal WHERE idempotency_key LIKE $1", [`${run}:%`]);
    await client.query("DELETE FROM signed_tx WHERE tx_hash LIKE $1", [`${run}:%`]);
    await client.end();
    await closeSpendPools();
  }
});

test("strategy reservations share the global cap and scope by exact strategy id", { skip: !url }, async () => {
  const databaseUrl = url as string;
  const run = randomUUID();
  const year = 2100 + Math.floor(Math.random() * 800);
  const shared = `${year}-01-01`;
  const scoped = `${year}-01-02`;
  try {
    assert.equal(await recordSpend(databaseUrl, `${run}:l1`, 20, shared, 25), "reserved");
    assert.equal(await recordSpend(databaseUrl, `a_c:${run}:1`, 10, shared, 25, { strategyId: "a_c", capUsd: 50 }), "cap", "listing spend counts against a strategy's global cap");
    assert.equal(await recordSpend(databaseUrl, `a_c:${run}:2`, 5, shared, 25, { strategyId: "a_c", capUsd: 50 }), "reserved");
    assert.equal(await recordSpend(databaseUrl, `${run}:l2`, 1, shared, 25), "cap", "strategy spend counts against the listing cap");
    assert.equal(await recordSpend(databaseUrl, `abc:${run}:1`, 5, scoped, 100, { strategyId: "abc", capUsd: 100 }), "reserved");
    assert.equal(await recordSpend(databaseUrl, `a_c:${run}:3`, 5, scoped, 100, { strategyId: "a_c", capUsd: 5 }), "reserved", "'_' does not match another strategy's rows");
    assert.equal(await recordSpend(databaseUrl, `a_c:${run}:4`, 1, scoped, 100, { strategyId: "a_c", capUsd: 5 }), "cap");
  } finally {
    const client = new pg.Client({ connectionString: databaseUrl });
    await client.connect();
    await client.query("DELETE FROM spend_journal WHERE idempotency_key LIKE $1", [`%${run}%`]);
    await client.end();
    await closeSpendPools();
  }
});

test("an upgraded journal backfills strategy ids only for configured strategies, and a replayed ':' alert finds its legacy row", { skip: !url }, async () => {
  const databaseUrl = url as string;
  const schema = `spend_${randomUUID().replaceAll("-", "")}`;
  const scoped = `${databaseUrl}${databaseUrl.includes("?") ? "&" : "?"}options=${encodeURIComponent(`-c search_path=${schema}`)}`;
  const day = "2026-10-21";
  const admin = new pg.Client({ connectionString: databaseUrl });
  await admin.connect();
  try {
    await admin.query(`CREATE SCHEMA ${schema}`);
    await admin.query(`CREATE TABLE ${schema}.spend_journal (idempotency_key text PRIMARY KEY, usd double precision NOT NULL, spent_on date NOT NULL, status text NOT NULL DEFAULT 'committed')`);
    await admin.query(`INSERT INTO ${schema}.spend_journal (idempotency_key, usd, spent_on) VALUES ('copy:1', 1, $1), ('tg:42', 1, $1), ('plain', 1, $1)`, [day]);
    await backfillStrategyIds(scoped, ["copy"]);
    const rows = await admin.query<{ idempotency_key: string; strategy_id: string }>(`SELECT idempotency_key, strategy_id FROM ${schema}.spend_journal`);
    assert.deepEqual(Object.fromEntries(rows.rows.map((row) => [row.idempotency_key, row.strategy_id])), { "copy:1": "copy", "tg:42": "listing", plain: "listing" });
    const column = await admin.query("SELECT is_nullable, column_default FROM information_schema.columns WHERE table_schema = $1 AND table_name = 'spend_journal' AND column_name = 'strategy_id'", [schema]);
    assert.deepEqual(column.rows[0], { is_nullable: "NO", column_default: "'listing'::text" });
    assert.equal(await recordSpend(scoped, listingKey("tg:42"), 1, day), "exists", "the alert reserved under its old key is not spent twice");
    assert.equal(await recordSpend(scoped, listingKey("tg:43"), 1, day), "reserved");
    await closeSpendPools();
    await backfillStrategyIds(scoped, []);
    const again = await admin.query(`SELECT strategy_id FROM ${schema}.spend_journal WHERE idempotency_key = 'copy:1'`);
    assert.equal(again.rows[0]?.strategy_id, "copy", "a reboot leaves backfilled rows alone");
  } finally {
    await closeSpendPools();
    await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
    await admin.end();
  }
});

test("a second executor cannot take the boot lock", { skip: !url }, async () => {
  const release = await acquireExecutorLock(url as string);
  try {
    await assert.rejects(() => acquireExecutorLock(url as string), /second replica/);
  } finally {
    await release();
  }
  const again = await acquireExecutorLock(url as string);
  await again();
});
