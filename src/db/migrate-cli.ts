import { MIGRATIONS_DIR, migrate } from "./migrate.js";

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) {
  console.error("DATABASE_URL is required to run migrations");
  process.exit(1);
}
const ran = await migrate(databaseUrl, MIGRATIONS_DIR);
console.log(ran.length === 0 ? "migrations: up to date" : `migrations applied: ${ran.join(", ")}`);
