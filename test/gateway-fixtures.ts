import type pg from "pg";
import { createSession } from "../src/gateway/accounts.js";
import type { GatewayConfig } from "../src/gateway/config.js";
import { CLIENT_ID } from "./google-fixtures.js";

export const ORIGIN = "https://whale.example";

export function gatewayConfig(): GatewayConfig {
  return {
    publicUrl: new URL(ORIGIN),
    port: 0,
    databaseUrl: "unused",
    google: { clientId: CLIENT_ID, clientSecret: "google-secret" },
    secret: Buffer.alloc(32, 3),
    trustProxyHops: 0,
    executor: null,
  };
}

export async function signedInAccount(pool: pg.Pool): Promise<{ accountId: string; headers: Record<string, string> }> {
  const account = await pool.query<{ id: string }>("INSERT INTO accounts DEFAULT VALUES RETURNING id");
  const accountId = account.rows[0]?.id as string;
  const { token } = await createSession(pool, accountId);
  return { accountId, headers: { cookie: `__Host-whale_session=${token}`, origin: ORIGIN } };
}
