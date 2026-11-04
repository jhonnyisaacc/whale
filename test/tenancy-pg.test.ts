import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import test from "node:test";
import pg from "pg";
import { loadMigrations, migrationLabel, MIGRATIONS_DIR, migrate } from "../src/db/migrate.js";

const url = process.env.TEST_DATABASE_URL;

async function freshSchema(): Promise<{ config: pg.ClientConfig; client: pg.Client; drop: () => Promise<void> }> {
  const schema = `t_${randomBytes(6).toString("hex")}`;
  const admin = new pg.Client({ connectionString: url });
  await admin.connect();
  await admin.query(`CREATE SCHEMA ${schema}`);
  await admin.end();
  const config = { connectionString: url, options: `-c search_path=${schema}` };
  const client = new pg.Client(config);
  await client.connect();
  return {
    config,
    client,
    drop: async () => {
      await client.query(`DROP SCHEMA ${schema} CASCADE`);
      await client.end();
    },
  };
}

test("migrations apply once, even when two runners race", { skip: !url }, async () => {
  const { config, client, drop } = await freshSchema();
  try {
    const [left, right] = await Promise.all([migrate(config, MIGRATIONS_DIR), migrate(config, MIGRATIONS_DIR)]);
    const shipped = loadMigrations(MIGRATIONS_DIR);
    assert.deepEqual([...left, ...right].sort(), shipped.map(migrationLabel));
    assert.ok(left.length === 0 || right.length === 0, "one runner applies everything, the other waits and applies nothing");
    assert.deepEqual(await migrate(config, MIGRATIONS_DIR), []);
    const ledger = await client.query("SELECT version, name FROM schema_migrations ORDER BY version");
    assert.deepEqual(ledger.rows, shipped.map((migration) => ({ version: migration.version, name: migration.name })));
  } finally {
    await drop();
  }
});

test("the tenant schema refuses cross-account links and history rewrites", { skip: !url }, async () => {
  const { config, client, drop } = await freshSchema();
  try {
    await migrate(config, MIGRATIONS_DIR);
    const account = async () => (await client.query<{ id: string }>("INSERT INTO accounts DEFAULT VALUES RETURNING id")).rows[0]?.id as string;
    const alice = await account();
    const bob = await account();
    const wallet = (await client.query<{ id: string }>("INSERT INTO wallets (account_id, label, level) VALUES ($1, 'main', 'enclave') RETURNING id", [alice])).rows[0]?.id;
    await assert.rejects(
      client.query("INSERT INTO agents (account_id, wallet_id, name, limits) VALUES ($1, $2, 'stolen', '{}')", [bob, wallet]),
      /violates foreign key constraint/,
    );
    await client.query("INSERT INTO agents (account_id, wallet_id, name, limits) VALUES ($1, $2, 'bot', '{}')", [alice, wallet]);
    await assert.rejects(
      client.query("INSERT INTO wallets (account_id, label, level, turnkey_sub_org_id) VALUES ($1, 'x', 'self_hosted', 'org')", [alice]),
      /violates check constraint/,
    );
    await assert.rejects(
      client.query("INSERT INTO agent_credentials (id, agent_id, kind, secret_hash) SELECT 'tok', id, 'oauth_access', $1 FROM agents LIMIT 1", [randomBytes(32)]),
      /violates check constraint/,
    );
    await client.query("INSERT INTO audit_events (account_id, wallet_id, actor, action) VALUES ($1, $2, 'user', 'wallet.created')", [alice, wallet]);
    await assert.rejects(client.query("INSERT INTO audit_events (account_id, wallet_id, actor, action) VALUES ($1, $2, 'user', 'peek')", [bob, wallet]), /violates foreign key constraint/);
    await assert.rejects(client.query("UPDATE audit_events SET action = 'nothing'"), /append-only/);
    await assert.rejects(client.query("DELETE FROM audit_events"), /append-only/);
  } finally {
    await drop();
  }
});
