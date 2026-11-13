import pg from "pg";
import { MIGRATIONS_DIR, migrate } from "./db/migrate.js";
import { buildGateway } from "./gateway/app.js";
import { loadGatewayConfig } from "./gateway/config.js";
import { applyDueChanges } from "./gateway/policy-changes.js";
import { WEB_DIST_DIR } from "./gateway/static.js";
import { deliverDue } from "./gateway/webhooks.js";

const config = loadGatewayConfig();
const applied = await migrate(config.databaseUrl, MIGRATIONS_DIR);
const pool = new pg.Pool({ connectionString: config.databaseUrl, max: 10 });
const app = await buildGateway({ config, pool, webDir: WEB_DIST_DIR });
if (applied.length > 0) app.log.info({ applied }, "migrations applied");
await app.listen({ host: "0.0.0.0", port: config.port });

// Widenings wait 24 hours. Each replica sweeps once a minute; a row lock keeps two replicas from applying one change twice.
const sweep = setInterval(() => {
  applyDueChanges(pool).catch((error: unknown) => app.log.warn({ err: error }, "policy sweep failed"));
}, 60_000);
sweep.unref();
const deliveries = setInterval(() => {
  deliverDue(pool, config.secret).catch((error: unknown) => app.log.warn({ err: error }, "webhook delivery failed"));
}, 15_000);
deliveries.unref();

let stopping = false;
async function stop(): Promise<void> {
  if (stopping) return;
  stopping = true;
  clearInterval(sweep);
  clearInterval(deliveries);
  await Promise.race([app.close(), new Promise((resolve) => setTimeout(resolve, 10_000).unref())]);
  await pool.end();
  process.exit(0);
}
process.on("SIGTERM", () => void stop());
process.on("SIGINT", () => void stop());
