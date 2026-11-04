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
  status: "pending" | "approved" | "denied" | "used" | "expired";
  createdAt: string;
  expiresAt: string;
};

export function approvalAction(approvalId: string, command: HostedCommand) {
  return { kind: "approval.approve", approvalId, command };
}

// A quote reports the bought side net of fees and gas. Adding them back gives the value leaving the wallet, which is
// what the per-transaction cap and the approval threshold talk about.
export function estimateUsd(plan: unknown): number | null {
  if (typeof plan !== "object" || plan === null) return null;
  const quote = (plan as { quote?: { netOutputUsd?: unknown; feeUsd?: unknown; gasUsd?: unknown } | null }).quote;
  if (!quote || typeof quote.netOutputUsd !== "number" || !Number.isFinite(quote.netOutputUsd)) return null;
  const extra = (value: unknown) => (typeof value === "number" && Number.isFinite(value) ? value : 0);
  return quote.netOutputUsd + extra(quote.feeUsd) + extra(quote.gasUsd);
}

export async function requestApproval(
  pool: pg.Pool,
  agent: AgentContext,
  input: { kind: "swap" | "transfer"; idempotencyKey: string; command: HostedCommand; estimateUsd: number | null; reason: string },
  now = Date.now(),
): Promise<{ id: string; status: string; expiresAt: string }> {
  return inTransaction(pool, async (client) => {
    const existing = await client.query<{ id: string; status: string; expires_at: Date; command: unknown }>(
      "SELECT id, status, expires_at, command FROM approvals WHERE agent_id = $1 AND idempotency_key = $2 FOR UPDATE",
      [agent.agentId, input.idempotencyKey],
    );
    const row = existing.rows[0];
    if (row) {
      if (bindingOf(row.command) !== bindingOf(input.command)) throw new Error("this idempotencyKey was already used for a different command");
      return { id: row.id, status: row.expires_at.getTime() <= now && row.status === "pending" ? "expired" : row.status, expiresAt: row.expires_at.toISOString() };
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

// An approval is spent once, by the agent that asked, for the command it asked about.
export async function consumeApproval(pool: pg.Pool, agent: AgentContext, idempotencyKey: string, command: HostedCommand, now = Date.now()): Promise<"used" | "pending" | "denied" | "expired" | "missing"> {
  return inTransaction(pool, async (client) => {
    const found = await client.query<{ id: string; status: Approval["status"]; expires_at: Date; command: unknown }>(
      "SELECT id, status, expires_at, command FROM approvals WHERE agent_id = $1 AND idempotency_key = $2 FOR UPDATE",
      [agent.agentId, idempotencyKey],
    );
    const row = found.rows[0];
    if (!row || bindingOf(row.command) !== bindingOf(command)) return "missing";
    if (row.status === "approved") {
      await client.query("UPDATE approvals SET status = 'used' WHERE id = $1", [row.id]);
      return "used";
    }
    if (row.status === "pending" && row.expires_at.getTime() <= now) return "expired";
    return row.status === "used" ? "missing" : row.status;
  });
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
  const updated = await pool.query("UPDATE approvals SET status = $2, decided_at = $3 WHERE id = $1 AND status = 'pending'", [input.approvalId, status, new Date(now)]);
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
    `SELECT a.id, a.wallet_id, a.agent_id, g.name, a.kind, a.command, a.estimate_usd, a.reason, a.status, a.created_at, a.expires_at
     FROM approvals a JOIN agents g ON g.id = a.agent_id
     WHERE a.account_id = $1 AND ($2::text IS NULL OR a.status = $2) ORDER BY a.created_at DESC LIMIT 100`,
    [accountId, status],
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
    status: row.status === "pending" && row.expires_at.getTime() <= now ? "expired" : row.status,
    createdAt: row.created_at.toISOString(),
    expiresAt: row.expires_at.toISOString(),
  }));
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
