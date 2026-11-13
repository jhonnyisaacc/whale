import { createHash, randomBytes } from "node:crypto";
import type pg from "pg";
import type { GoogleClaims } from "./google.js";

export const SESSION_COOKIE = "__Host-whale_session";
export const SESSION_IDLE_MS = 12 * 60 * 60 * 1000;
export const SESSION_MAX_MS = 7 * 24 * 60 * 60 * 1000;
// Writing last_seen_at on every request would turn reads into writes. Five minutes keeps the idle check honest.
const TOUCH_AFTER_MS = 5 * 60 * 1000;

export type Session = { accountId: string; email: string | null };

export function tokenHash(token: string): Buffer {
  return createHash("sha256").update(token).digest();
}

export async function inTransaction<T>(pool: pg.Pool, work: (client: pg.PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const result = await work(client);
    await client.query("COMMIT");
    return result;
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

export async function audit(
  client: pg.ClientBase | pg.Pool,
  event: { accountId: string; walletId?: string | null; agentId?: string | null; actor: "user" | "agent" | "system"; action: string; detail?: Record<string, unknown> },
): Promise<void> {
  await client.query(
    `WITH event AS (
       INSERT INTO audit_events (account_id, wallet_id, agent_id, actor, action, detail) VALUES ($1, $2, $3, $4, $5, $6) RETURNING id, account_id, action
     )
     INSERT INTO webhook_deliveries (webhook_id, account_id, event_id, next_attempt_at)
     SELECT w.id, w.account_id, event.id, now() FROM event JOIN webhooks w ON w.account_id = event.account_id AND w.disabled_at IS NULL AND event.action = ANY (w.events)`,
    [
    event.accountId,
    event.walletId ?? null,
    event.agentId ?? null,
    event.actor,
    event.action,
    JSON.stringify(event.detail ?? {}),
  ]);
}

export type SignIn = { accountId: string; created: boolean } | { refused: "account_closed" };

// The Google subject keys the account. An email can move between Google accounts, a subject cannot.
export async function signInWithGoogle(pool: pg.Pool, claims: GoogleClaims): Promise<SignIn> {
  return inTransaction(pool, async (client) => {
    const found = await client.query<{ account_id: string; status: string }>(
      "SELECT i.account_id, a.status FROM identities i JOIN accounts a ON a.id = i.account_id WHERE i.provider = 'google' AND i.subject = $1 FOR UPDATE OF i",
      [claims.sub],
    );
    const existing = found.rows[0];
    if (existing) {
      if (existing.status === "closed") return { refused: "account_closed" as const };
      await client.query("UPDATE identities SET email = $2, last_login_at = now() WHERE provider = 'google' AND subject = $1", [claims.sub, claims.email]);
      await audit(client, { accountId: existing.account_id, actor: "user", action: "account.signed_in" });
      return { accountId: existing.account_id, created: false };
    }
    const account = await client.query<{ id: string }>("INSERT INTO accounts DEFAULT VALUES RETURNING id");
    const accountId = account.rows[0]?.id;
    if (!accountId) throw new Error("account insert returned no id");
    // A concurrent first login for the same subject fails here on the primary key and rolls back the account.
    await client.query("INSERT INTO identities (provider, subject, account_id, email, last_login_at) VALUES ('google', $1, $2, $3, now())", [claims.sub, accountId, claims.email]);
    await audit(client, { accountId, actor: "user", action: "account.created" });
    return { accountId, created: true };
  });
}

export async function createSession(pool: pg.Pool, accountId: string, now = Date.now()): Promise<{ token: string; maxAgeSeconds: number }> {
  const token = randomBytes(32).toString("base64url");
  await pool.query("INSERT INTO sessions (token_hash, account_id, expires_at) VALUES ($1, $2, $3)", [tokenHash(token), accountId, new Date(now + SESSION_MAX_MS)]);
  return { token, maxAgeSeconds: SESSION_MAX_MS / 1000 };
}

export async function readSession(pool: pg.Pool, token: string, now = Date.now()): Promise<Session | null> {
  if (token.length < 40 || token.length > 64) return null;
  const hash = tokenHash(token);
  const found = await pool.query<{ account_id: string; last_seen_at: Date; expires_at: Date; email: string | null }>(
    `SELECT s.account_id, s.last_seen_at, s.expires_at,
       (SELECT email FROM identities i WHERE i.account_id = s.account_id ORDER BY last_login_at DESC NULLS LAST LIMIT 1) AS email
     FROM sessions s JOIN accounts a ON a.id = s.account_id
     WHERE s.token_hash = $1 AND s.revoked_at IS NULL AND a.status = 'active'`,
    [hash],
  );
  const row = found.rows[0];
  if (!row) return null;
  if (row.expires_at.getTime() <= now || row.last_seen_at.getTime() + SESSION_IDLE_MS <= now) return null;
  if (now - row.last_seen_at.getTime() >= TOUCH_AFTER_MS) await pool.query("UPDATE sessions SET last_seen_at = $2 WHERE token_hash = $1", [hash, new Date(now)]);
  return { accountId: row.account_id, email: row.email };
}

export async function revokeSession(pool: pg.Pool, token: string): Promise<void> {
  await pool.query("UPDATE sessions SET revoked_at = now() WHERE token_hash = $1 AND revoked_at IS NULL", [tokenHash(token)]);
}
