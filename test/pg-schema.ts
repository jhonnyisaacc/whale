import { randomBytes } from "node:crypto";
import pg from "pg";
import { MIGRATIONS_DIR, migrate } from "../src/db/migrate.js";

export const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;

// Each test gets its own migrated schema, so tests run in parallel against one database and leave nothing behind.
export async function migratedSchema(): Promise<{ pool: pg.Pool; drop: () => Promise<void> }> {
  const schema = `t_${randomBytes(6).toString("hex")}`;
  const admin = new pg.Client({ connectionString: TEST_DATABASE_URL });
  await admin.connect();
  await admin.query(`CREATE SCHEMA ${schema}`);
  await admin.end();
  const config = { connectionString: TEST_DATABASE_URL, options: `-c search_path=${schema}` };
  await migrate(config, MIGRATIONS_DIR);
  const pool = new pg.Pool({ ...config, max: 4 });
  return {
    pool,
    drop: async () => {
      await pool.query(`DROP SCHEMA ${schema} CASCADE`);
      await pool.end();
    },
  };
}
