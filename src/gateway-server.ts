import pg from "pg";
import { MIGRATIONS_DIR, migrate } from "./db/migrate.js";
import { buildGateway } from "./gateway/app.js";
import { loadGatewayConfig } from "./gateway/config.js";

const config = loadGatewayConfig();
const applied = await migrate(config.databaseUrl, MIGRATIONS_DIR);
const pool = new pg.Pool({ connectionString: config.databaseUrl, max: 10 });
const app = await buildGateway({ config, pool });
if (applied.length > 0) app.log.info({ applied }, "migrations applied");
await app.listen({ host: "0.0.0.0", port: config.port });

let stopping = false;
async function stop(): Promise<void> {
  if (stopping) return;
  stopping = true;
  await Promise.race([app.close(), new Promise((resolve) => setTimeout(resolve, 10_000).unref())]);
  await pool.end();
  process.exit(0);
}
process.on("SIGTERM", () => void stop());
process.on("SIGINT", () => void stop());
