import type pg from "pg";
import type { HostedCommand } from "../hosted-commands.js";
import { audit, inTransaction } from "./accounts.js";
import type { AgentContext } from "./agents.js";
import type { GatewayConfig } from "./config.js";
import { bindingOf, verifyStepUp, type AssertionPayload } from "./passkeys.js";

export const APPROVAL_TTL_MS = 60 * 60 * 1000;

export type Approval = {
  id: string;
  walletId: string;
  agentId: string;
  agentName: string;
  kind: "swap" | "transfer";
  command: HostedCommand;
  estimateUsd: number | null;
  reason: string;
  status: "pending" | "approved" | "claimed" | "denied" | "used" | "expired";
  createdAt: string;
  expiresAt: string;
};

export function approvalAction(approvalId: string, command: HostedCommand) {
  return { kind: "approval.approve", approvalId, command };
}

const statusAt = (now: string) => `CASE WHEN a.status IN ('pending', 'approved') AND a.expires_at <= ${now}::timestamptz THEN 'expired' ELSE a.status END`;
const storedAs = (status: string | null) => (status === "expired" ? ["pending", "approved", "expired"] : status === null ? null : [status]);

export async function requestApproval(
  pool: pg.Pool,
  agent: AgentContext,
  input: { kind: "swap" | "transfer"; idempotencyKey: string; command: HostedCommand; estimateUsd: number | null; reason: string },
  now = Date.now(),
): Promise<{ id: string; status: string; expiresAt: string }> {
  return inTransaction(pool, async (client) => {
    const existing = await client.query<{ id: string; status: Approval["status"]; expires_at: Date; command: unknown }>(
      `SELECT a.id, ${statusAt("$3")} AS status, a.expires_at, a.command FROM approvals a WHERE a.agent_id = $1 AND a.idempotency_key = $2 FOR UPDATE`,
      [agent.agentId, input.idempotencyKey, new Date(now)],
    );
    const row = existing.rows[0];
    if (row) {
      if (bindingOf(row.command) !== bindingOf(input.command)) throw new Error("this idempotencyKey was already used for a different command");
      return { id: row.id, status: row.status, expiresAt: row.expires_at.toISOString() };
    }
    const expiresAt = new Date(now + APPROVAL_TTL_MS);
    const created = await client.query<{ id: string }>(
      `INSERT INTO approvals (account_id, wallet_id, agent_id, kind, idempotency_key, command, estimate_usd, reason, expires_at, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10) RETURNING id`,
      [agent.accountId, agent.walletId, agent.agentId, input.kind, input.idempotencyKey, JSON.stringify(input.command), input.estimateUsd, input.reason, expiresAt, new Date(now)],
    );
    const id = created.rows[0]?.id as string;
    await audit(client, { accountId: agent.accountId, walletId: agent.walletId, agentId: agent.agentId, actor: "agent", action: "approval.requested", detail: { approvalId: id, kind: input.kind, estimateUsd: input.estimateUsd } });
    return { id, status: "pending", expiresAt: expiresAt.toISOString() };
  });
}

export async function approvalFor(pool: pg.Pool, agent: AgentContext, idempotencyKey: string, command: HostedCommand): Promise<Approval["status"] | "missing" | "conflict"> {
  const found = await pool.query<{ status: Approval["status"]; command: unknown }>(`SELECT ${statusAt("now()")} AS status, a.command FROM approvals a WHERE a.agent_id = $1 AND a.idempotency_key = $2`, [
    agent.agentId,
    idempotencyKey,
  ]);
  const row = found.rows[0];
  if (!row) return "missing";
  if (bindingOf(row.command) !== bindingOf(command)) return "conflict";
  return row.status;
}

export async function decideApproval(
  pool: pg.Pool,
  config: GatewayConfig,
  input: { accountId: string; approvalId: string; approve: boolean; assertion: AssertionPayload | null },
  now = Date.now(),
): Promise<true | string> {
  const found = await pool.query<{ command: HostedCommand; status: string; expires_at: Date; wallet_id: string; agent_id: string }>(
    "SELECT command, status, expires_at, wallet_id, agent_id FROM approvals WHERE id = $1 AND account_id = $2",
    [input.approvalId, input.accountId],
  );
  const row = found.rows[0];
  if (!row) return "not_found";
  if (row.status !== "pending" || row.expires_at.getTime() <= now) return "not_pending";
  if (input.approve) {
    if (!input.assertion) return "step_up_required";
    const verified = await verifyStepUp(pool, config, input.accountId, approvalAction(input.approvalId, row.command), input.assertion, now);
    if (verified !== true) return verified;
  }
  const status = input.approve ? "approved" : "denied";
  const updated = await pool.query("UPDATE approvals SET status = $2, decided_at = $3 WHERE id = $1 AND status = 'pending' AND expires_at > $3", [input.approvalId, status, new Date(now)]);
  if ((updated.rowCount ?? 0) === 0) return "not_pending";
  await audit(pool, { accountId: input.accountId, walletId: row.wallet_id, agentId: row.agent_id, actor: "user", action: `approval.${status}`, detail: { approvalId: input.approvalId } });
  return true;
}

export async function listApprovals(pool: pg.Pool, accountId: string, status: string | null, now = Date.now()): Promise<Approval[]> {
  const rows = await pool.query<{
    id: string;
    wallet_id: string;
    agent_id: string;
    name: string;
    kind: Approval["kind"];
    command: HostedCommand;
    estimate_usd: number | null;
    reason: string;
    status: Approval["status"];
    created_at: Date;
    expires_at: Date;
  }>(
    `SELECT a.id, a.wallet_id, a.agent_id, g.name, a.kind, a.command, a.estimate_usd, a.reason, ${statusAt("$3")} AS status, a.created_at, a.expires_at
     FROM approvals a JOIN agents g ON g.id = a.agent_id
     WHERE a.account_id = $1 AND ($2::text IS NULL OR (a.status = ANY ($4::text[]) AND ${statusAt("$3")} = $2)) ORDER BY a.created_at DESC LIMIT 100`,
    [accountId, status, new Date(now), storedAs(status)],
  );
  return rows.rows.map((row) => ({
    id: row.id,
    walletId: row.wallet_id,
    agentId: row.agent_id,
    agentName: row.name,
    kind: row.kind,
    command: row.command,
    estimateUsd: row.estimate_usd,
    reason: row.reason,
    status: row.status,
    createdAt: row.created_at.toISOString(),
    expiresAt: row.expires_at.toISOString(),
  }));
}

export async function openRequests(pool: pg.Pool, agent: AgentContext) {
  const rows = await pool.query<{ id: string; kind: Approval["kind"]; idempotency_key: string; command: HostedCommand; estimate_usd: number | null; reason: string; status: Approval["status"]; created_at: Date; expires_at: Date }>(
    `SELECT a.id, a.kind, a.idempotency_key, a.command, a.estimate_usd, a.reason, ${statusAt("now()")} AS status, a.created_at, a.expires_at FROM approvals a
     WHERE a.agent_id = $1 AND a.status IN ('pending', 'approved') AND ${statusAt("now()")} IN ('pending', 'approved') ORDER BY a.created_at DESC LIMIT 100`,
    [agent.agentId],
  );
  return rows.rows.map((row) => ({
    approvalId: row.id,
    kind: row.kind,
    idempotencyKey: row.idempotency_key,
    command: row.command,
    estimateUsd: row.estimate_usd,
    reason: row.reason,
    status: row.status,
    createdAt: row.created_at.toISOString(),
    expiresAt: row.expires_at.toISOString(),
  }));
}

export async function cancelRequest(pool: pg.Pool, agent: AgentContext, approvalId: string): Promise<true | string> {
  return inTransaction(pool, async (client) => {
    const found = await client.query<{ status: Approval["status"] }>(`SELECT ${statusAt("now()")} AS status FROM approvals a WHERE a.id = $1 AND a.agent_id = $2 FOR UPDATE`, [approvalId, agent.agentId]);
    const status = found.rows[0]?.status;
    if (status === "claimed") return "the send for this request is already running, so it cannot be cancelled. Call swap or transfer again later with the same idempotencyKey to get its result";
    if (status !== "pending" && status !== "approved") return "this agent has no open request with that approvalId";
    await client.query("UPDATE approvals SET status = 'denied', decided_at = now() WHERE id = $1", [approvalId]);
    await audit(client, { accountId: agent.accountId, walletId: agent.walletId, agentId: agent.agentId, actor: "agent", action: "approval.denied", detail: { approvalId, reason: "cancelled by the agent" } });
    return true;
  });
}

export async function listActivity(pool: pg.Pool, accountId: string, walletId: string | null, before: number | null) {
  const rows = await pool.query<{ id: string; wallet_id: string | null; agent_id: string | null; name: string | null; actor: string; action: string; detail: unknown; created_at: Date }>(
    `SELECT e.id::text, e.wallet_id, e.agent_id, g.name, e.actor, e.action, e.detail, e.created_at
     FROM audit_events e LEFT JOIN agents g ON g.id = e.agent_id
     WHERE e.account_id = $1 AND ($2::uuid IS NULL OR e.wallet_id = $2::uuid) AND ($3::bigint IS NULL OR e.id < $3::bigint)
     ORDER BY e.id DESC LIMIT 50`,
    [accountId, walletId, before],
  );
  return rows.rows.map((row) => ({ id: Number(row.id), walletId: row.wallet_id, agentId: row.agent_id, agentName: row.name, actor: row.actor, action: row.action, detail: row.detail, at: row.created_at.toISOString() }));
}
