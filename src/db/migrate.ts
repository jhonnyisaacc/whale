import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";

export type Migration = { version: number; name: string; sql: string; checksum: string };
export type AppliedMigration = { version: number; checksum: string };

export const MIGRATIONS_DIR = fileURLToPath(new URL("../../../migrations", import.meta.url));

const FILE_NAME = /^(\d{4})_([a-z0-9_]+)\.sql$/;
// One fixed key, so two gateway replicas that boot together apply each migration once.
const MIGRATION_LOCK = 4_627_001;
const LEDGER_SQL = `
CREATE TABLE IF NOT EXISTS schema_migrations (
  version integer PRIMARY KEY,
  name text NOT NULL,
  checksum text NOT NULL,
  applied_at timestamptz NOT NULL DEFAULT now()
)`;

export function loadMigrations(dir: string): Migration[] {
  const found: Migration[] = [];
  for (const file of readdirSync(dir).sort()) {
    if (!file.endsWith(".sql")) continue;
    const match = FILE_NAME.exec(file);
    if (!match) throw new Error(`migration ${file} must be named like 0001_name.sql`);
    const sql = readFileSync(path.join(dir, file), "utf8");
    found.push({ version: Number(match[1]), name: match[2] as string, sql, checksum: createHash("sha256").update(sql).digest("hex") });
  }
  found.forEach((migration, index) => {
    if (migration.version !== index + 1) throw new Error(`migration versions must run from 1 without gaps; ${migration.version} sits at position ${index + 1}`);
  });
  return found;
}

export function pendingMigrations(local: readonly Migration[], applied: readonly AppliedMigration[]): Migration[] {
  const byVersion = new Map(local.map((migration) => [migration.version, migration]));
  for (const row of applied) {
    const migration = byVersion.get(row.version);
    if (!migration) throw new Error(`the database has migration ${row.version}, which this build does not ship`);
    if (migration.checksum !== row.checksum) throw new Error(`migration ${row.version} changed after it was applied; add a new migration instead`);
  }
  const done = new Set(applied.map((row) => row.version));
  return local.filter((migration) => !done.has(migration.version));
}

export function migrationLabel(migration: Pick<Migration, "version" | "name">): string {
  return `${String(migration.version).padStart(4, "0")}_${migration.name}`;
}

// Each migration runs in its own transaction with its ledger row, so a failure leaves no half-applied file.
export async function migrate(connection: string | pg.ClientConfig, dir: string): Promise<string[]> {
  const local = loadMigrations(dir);
  const client = new pg.Client(typeof connection === "string" ? { connectionString: connection } : connection);
  await client.connect();
  try {
    await client.query("SELECT pg_advisory_lock($1)", [MIGRATION_LOCK]);
    try {
      await client.query(LEDGER_SQL);
      const applied = await client.query<AppliedMigration>("SELECT version, checksum FROM schema_migrations ORDER BY version");
      const ran: string[] = [];
      for (const migration of pendingMigrations(local, applied.rows)) {
        await client.query("BEGIN");
        try {
          await client.query(migration.sql);
          await client.query("INSERT INTO schema_migrations (version, name, checksum) VALUES ($1, $2, $3)", [migration.version, migration.name, migration.checksum]);
          await client.query("COMMIT");
        } catch (error) {
          await client.query("ROLLBACK");
          throw error;
        }
        ran.push(migrationLabel(migration));
      }
      return ran;
    } finally {
      await client.query("SELECT pg_advisory_unlock($1)", [MIGRATION_LOCK]);
    }
  } finally {
    await client.end();
  }
}
