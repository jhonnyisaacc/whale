import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import pg from "pg";
import { MIGRATIONS_DIR, migrate } from "../src/db/migrate.js";

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
    assert.deepEqual([...left, ...right], ["0001_tenancy"]);
    assert.deepEqual(await migrate(config, MIGRATIONS_DIR), []);
    const ledger = await client.query("SELECT version, name FROM schema_migrations");
    assert.deepEqual(ledger.rows, [{ version: 1, name: "tenancy" }]);
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
    await assert.rejects(client.query("TRUNCATE audit_events"), /append-only/);
    await assert.rejects(client.query("TRUNCATE accounts CASCADE"), /append-only/);
    assert.equal((await client.query("SELECT count(*)::int AS n FROM audit_events")).rows[0]?.n, 1);
  } finally {
    await drop();
  }
});

test("one EVM address belongs to one wallet whatever its case, while Solana addresses stay case-sensitive", { skip: !url }, async () => {
  const { config, client, drop } = await freshSchema();
  try {
    await migrate(config, MIGRATIONS_DIR);
    const account = (await client.query<{ id: string }>("INSERT INTO accounts DEFAULT VALUES RETURNING id")).rows[0]?.id;
    const wallet = async () => (await client.query<{ id: string }>("INSERT INTO wallets (account_id, label, level) VALUES ($1, 'w', 'self_hosted') RETURNING id", [account])).rows[0]?.id;
    const first = await wallet();
    const second = await wallet();
    const address = "0xAbCdEf0123456789aBcDeF0123456789AbCdEf01";
    await client.query("INSERT INTO wallet_addresses (wallet_id, family, address) VALUES ($1, 'evm', $2), ($1, 'solana', 'AbcSolana')", [first, address]);
    await assert.rejects(client.query("INSERT INTO wallet_addresses (wallet_id, family, address) VALUES ($1, 'evm', $2)", [second, address.toLowerCase()]), /duplicate key/);
    await client.query("INSERT INTO wallet_addresses (wallet_id, family, address) VALUES ($1, 'solana', 'abcsolana')", [second]);
  } finally {
    await drop();
  }
});

function migrationsDir(files: Record<string, string>): string {
  const dir = mkdtempSync(path.join(tmpdir(), "whale-migrations-"));
  for (const [name, sql] of Object.entries(files)) writeFileSync(path.join(dir, name), sql);
  return dir;
}

test("a migration blocked on a table lock gives up and frees the runner lock", { skip: !url }, async () => {
  const { config, client, drop } = await freshSchema();
  const blocker = new pg.Client(config);
  await blocker.connect();
  try {
    const first = { "0001_a.sql": "CREATE TABLE held (id int)" };
    await migrate(config, migrationsDir(first));
    const next = migrationsDir({ ...first, "0002_b.sql": "ALTER TABLE held ADD COLUMN extra int" });
    await blocker.query("BEGIN");
    await blocker.query("LOCK TABLE held IN ACCESS SHARE MODE");
    const blocked = migrate(config, next, { lockTimeoutMs: 200 });
    blocked.catch(() => {});
    const outcome = await Promise.race([blocked.then(() => "applied", (error: Error) => error.message), new Promise((resolve) => setTimeout(resolve, 3000, "still waiting"))]);
    assert.match(String(outcome), /lock timeout/);
    await blocker.query("COMMIT");
    await blocked.catch(() => {});
    assert.deepEqual(await migrate(config, next, { lockTimeoutMs: 200 }), ["0002_b"]);
  } finally {
    await blocker.query("ROLLBACK").catch(() => {});
    await blocker.end();
    await drop();
  }
});
