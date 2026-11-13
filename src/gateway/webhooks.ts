import { createHmac, randomBytes } from "node:crypto";
import type pg from "pg";
import { audit } from "./accounts.js";
import { publicHttpsUrl, safeRequest, type SafeResponse } from "./safe-https.js";
import { sealer } from "./seal.js";

export const WEBHOOK_EVENTS = [
  "approval.requested",
  "approval.approved",
  "approval.denied",
  "policy.widen_requested",
  "policy.widened",
  "policy.narrowed",
  "wallet.activated",
  "wallet.delegation_refused",
  "wallet.frozen",
  "wallet.unfrozen",
  "agent.created",
  "agent.connected",
  "agent.revoked",
  "mcp.denied",
  "mcp.swap_planned",
  "mcp.transfer_planned",
] as const;
export const MAX_WEBHOOKS = 5;
export const RETRY_AFTER_MS = [60_000, 5 * 60_000, 30 * 60_000, 2 * 3_600_000, 6 * 3_600_000];
const DISABLE_AFTER_FAILURES = 50;
const BATCH = 20;
const SEND_DEADLINE_MS = 5_000;
const LEASE_MS = 3 * BATCH * SEND_DEADLINE_MS;
const FOREVER_MS = 100 * 365 * 24 * 3_600_000;

export type Send = (url: string, init: { method: "POST"; headers: Record<string, string>; body: string; maxBytes: number; timeoutMs: number }) => Promise<SafeResponse>;

export function signature(secret: string, timestamp: number, body: string): string {
  return `t=${timestamp},v1=${createHmac("sha256", secret).update(`${timestamp}.${body}`).digest("hex")}`;
}

export async function addWebhook(
  pool: pg.Pool,
  gatewaySecret: Buffer,
  input: { accountId: string; url: string; format: "whale" | "slack"; events: string[] },
): Promise<{ id: string; secret: string } | string> {
  if (!publicHttpsUrl(input.url)) return "the URL must be https on the default port, with a host name";
  const count = await pool.query<{ n: number }>("SELECT count(*)::int AS n FROM webhooks WHERE account_id = $1 AND disabled_at IS NULL", [input.accountId]);
  if ((count.rows[0]?.n ?? 0) >= MAX_WEBHOOKS) return "an account holds at most five webhooks";
  const secret = `whsec_${randomBytes(32).toString("base64url")}`;
  const sealed = sealer(gatewaySecret, "webhook-secret").seal(secret, FOREVER_MS);
  const created = await pool.query<{ id: string }>("INSERT INTO webhooks (account_id, url, format, events, secret_sealed) VALUES ($1, $2, $3, $4, $5) RETURNING id", [
    input.accountId,
    input.url,
    input.format,
    [...new Set(input.events)],
    sealed,
  ]);
  const id = created.rows[0]?.id as string;
  await audit(pool, { accountId: input.accountId, actor: "user", action: "webhook.added", detail: { webhookId: id, host: new URL(input.url).host } });
  return { id, secret };
}

export async function listWebhooks(pool: pg.Pool, accountId: string) {
  const rows = await pool.query<{ id: string; url: string; format: string; events: string[]; failures: number; disabled_at: Date | null; last_status: number | null; last_error: string | null }>(
    `SELECT w.id, w.url, w.format, w.events, w.failures, w.disabled_at, d.last_status, d.last_error
     FROM webhooks w LEFT JOIN LATERAL (SELECT last_status, last_error FROM webhook_deliveries WHERE webhook_id = w.id AND account_id = w.account_id AND attempts > 0 ORDER BY id DESC LIMIT 1) d ON true
     WHERE w.account_id = $1 ORDER BY w.created_at`,
    [accountId],
  );
  return rows.rows.map((row) => ({ id: row.id, url: row.url, format: row.format, events: row.events, failures: row.failures, disabled: row.disabled_at !== null, lastStatus: row.last_status, lastError: row.last_error }));
}

export async function removeWebhook(pool: pg.Pool, accountId: string, webhookId: string): Promise<boolean> {
  const removed = await pool.query("DELETE FROM webhooks WHERE id = $1 AND account_id = $2", [webhookId, accountId]);
  if ((removed.rowCount ?? 0) === 0) return false;
  await audit(pool, { accountId, actor: "user", action: "webhook.removed", detail: { webhookId } });
  return true;
}

// A test reaches only the webhook asked about, so it is queued here and not through audit(), which fans out.
export async function testWebhook(pool: pg.Pool, accountId: string, webhookId: string): Promise<boolean> {
  const queued = await pool.query(
    `WITH hook AS (SELECT id, account_id FROM webhooks WHERE id = $2 AND account_id = $1 AND disabled_at IS NULL),
     event AS (
       INSERT INTO audit_events (account_id, actor, action, detail) SELECT $1, 'user', 'webhook.test', jsonb_build_object('webhookId', $2::text) FROM hook RETURNING id
     )
     INSERT INTO webhook_deliveries (webhook_id, account_id, event_id, next_attempt_at) SELECT hook.id, hook.account_id, event.id, now() FROM hook, event RETURNING id`,
    [accountId, webhookId],
  );
  return (queued.rowCount ?? 0) === 1;
}

type Due = { id: string; attempts: number; webhook_id: string; url: string; format: "whale" | "slack"; secret_sealed: string; event_id: string; account_id: string; wallet_id: string | null; agent_id: string | null; actor: string; action: string; detail: unknown; created_at: Date };

function payload(row: Due): string {
  if (row.format === "slack") {
    const reason = row.detail && typeof row.detail === "object" && typeof (row.detail as { reason?: unknown }).reason === "string" ? `: ${(row.detail as { reason: string }).reason}` : "";
    return JSON.stringify({ text: `Whale · ${row.action}${reason}` });
  }
  return JSON.stringify({ id: `evt_${row.event_id}`, type: row.action, createdAt: row.created_at.toISOString(), accountId: row.account_id, walletId: row.wallet_id, agentId: row.agent_id, actor: row.actor, detail: row.detail });
}

// Rows are leased by pushing next_attempt_at forward under SKIP LOCKED, so two gateways never send the same delivery
// at once. A 2xx ends it; anything else retries on the backoff list, then gives up.
export async function deliverDue(pool: pg.Pool, gatewaySecret: Buffer, send: Send = safeRequest, now = Date.now()): Promise<number> {
  const claimed = await pool.query<Due>(
    `WITH due AS (
       SELECT id FROM webhook_deliveries WHERE delivered_at IS NULL AND gave_up_at IS NULL AND next_attempt_at <= $1 ORDER BY next_attempt_at LIMIT ${BATCH} FOR UPDATE SKIP LOCKED
     ), leased AS (
       UPDATE webhook_deliveries d SET next_attempt_at = $1::timestamptz + make_interval(secs => ${LEASE_MS / 1000}) FROM due WHERE d.id = due.id RETURNING d.id, d.attempts, d.webhook_id, d.account_id, d.event_id
     )
     SELECT leased.id::text, leased.attempts, w.id AS webhook_id, w.url, w.format, w.secret_sealed, e.id::text AS event_id, e.account_id, e.wallet_id, e.agent_id, e.actor, e.action, e.detail, e.created_at
     FROM leased JOIN webhooks w ON w.id = leased.webhook_id AND w.account_id = leased.account_id AND w.disabled_at IS NULL
     JOIN audit_events e ON e.id = leased.event_id AND e.account_id = leased.account_id`,
    [new Date(now)],
  );
  const open = sealer(gatewaySecret, "webhook-secret");
  let delivered = 0;
  for (const row of claimed.rows) {
    const body = payload(row);
    const secret = open.open(row.secret_sealed, now);
    let status = 0;
    let error: string | null = null;
    try {
      if (typeof secret !== "string") throw new Error("the webhook secret cannot be opened with this GATEWAY_SECRET");
      const timestamp = Math.floor(now / 1000);
      const response = await send(row.url, {
        method: "POST",
        headers: { "content-type": "application/json", "user-agent": "Whale-Webhooks/0.1", "whale-event-id": `evt_${row.event_id}`, "whale-signature": signature(secret, timestamp, body) },
        body,
        maxBytes: 4_096,
        timeoutMs: SEND_DEADLINE_MS,
      });
      status = response.status;
    } catch (caught) {
      error = (caught instanceof Error ? caught.message : "send failed").slice(0, 300);
    }
    if (status >= 200 && status < 300) {
      delivered += 1;
      await pool.query("UPDATE webhook_deliveries SET delivered_at = $2, attempts = attempts + 1, last_status = $3, last_error = NULL WHERE id = $1", [row.id, new Date(now), status]);
      await pool.query("UPDATE webhooks SET failures = 0 WHERE id = $1 AND account_id = $2", [row.webhook_id, row.account_id]);
      continue;
    }
    const attempts = row.attempts + 1;
    const retry = RETRY_AFTER_MS[attempts - 1];
    await pool.query("UPDATE webhook_deliveries SET attempts = $2, last_status = $3, last_error = $4, next_attempt_at = $5, gave_up_at = $6 WHERE id = $1", [
      row.id,
      attempts,
      status || null,
      error ?? `answered ${status}`,
      new Date(now + (retry ?? 0)),
      retry === undefined ? new Date(now) : null,
    ]);
    await pool.query(`UPDATE webhooks SET failures = failures + 1, disabled_at = CASE WHEN failures + 1 >= ${DISABLE_AFTER_FAILURES} THEN now() ELSE disabled_at END WHERE id = $1 AND account_id = $2`, [row.webhook_id, row.account_id]);
  }
  return delivered;
}
