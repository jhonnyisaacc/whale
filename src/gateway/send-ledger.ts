import type pg from "pg";
import type { HostedCommand } from "../hosted-commands.js";
import { audit, inTransaction } from "./accounts.js";
import type { AgentContext } from "./agents.js";
import type { ExecutorClient } from "./executor-client.js";
import { bindingOf } from "./passkeys.js";
import { effectiveLimits } from "./policy.js";

export type Send = Extract<HostedCommand, { kind: "swap" | "transfer" }>;
export type Priced = { usd: number; day: string };
export type Reservation = { kind: "reserved" } | { kind: "unreserved" } | { kind: "settling" } | { kind: "lapsed" } | { kind: "refused"; reason: string };
type Settlement = "committed" | "released";

export const KEY_REUSED = "this idempotencyKey was already used for a different command";
export const SETTLE_GRACE_MS = 60_000;

function usd(value: number): string {
  return `${value.toFixed(2)} USD`;
}

export async function dailyRefusal(client: pg.Pool | pg.ClientBase, agent: AgentContext, priced: Priced, what = "the swap"): Promise<string | null> {
  const totals = await client.query<{ agent: number; wallet: number }>(
    `SELECT COALESCE(SUM(usd) FILTER (WHERE agent_id = $2), 0)::float8 AS agent, COALESCE(SUM(usd), 0)::float8 AS wallet
     FROM agent_spends WHERE wallet_id = $1 AND day = $3::date AND state <> 'released'`,
    [agent.walletId, agent.agentId, priced.day],
  );
  const spent = totals.rows[0] ?? { agent: 0, wallet: 0 };
  const agentCap = effectiveLimits(agent.limits, agent.policy).dailyUsd;
  if (spent.agent + priced.usd > agentCap) return `${what} would take today's total to about ${usd(spent.agent + priced.usd)}, above this agent's ${usd(agentCap)} daily cap`;
  if (spent.wallet + priced.usd > agent.policy.dailyUsd) return `${what} would take today's total to about ${usd(spent.wallet + priced.usd)}, above the wallet's ${usd(agent.policy.dailyUsd)} daily cap`;
  return null;
}

export async function recordedSpend(client: pg.Pool | pg.ClientBase, agent: AgentContext, command: Send): Promise<"none" | "conflict" | "reserved" | "committed" | "released"> {
  const found = await client.query<{ binding: string; state: "reserved" | "committed" | "released" }>("SELECT binding, state FROM agent_spends WHERE agent_id = $1 AND idempotency_key = $2", [
    agent.agentId,
    command.idempotencyKey,
  ]);
  const row = found.rows[0];
  if (!row) return "none";
  return row.binding === bindingOf(command) ? row.state : "conflict";
}

export async function reserveSend(pool: pg.Pool, agent: AgentContext, command: Send, priced: Priced, approved: boolean, what: string): Promise<Reservation> {
  return inTransaction(pool, async (client) => {
    await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [`agent_spends:${agent.walletId}`]);
    const recorded = await recordedSpend(client, agent, command);
    if (recorded === "conflict") return { kind: "refused", reason: KEY_REUSED };
    if (recorded === "reserved") return { kind: "settling" };
    if (recorded === "committed") return { kind: "unreserved" };
    const refused = await dailyRefusal(client, agent, priced, what);
    if (refused) return { kind: "refused", reason: refused };
    if (approved) {
      const claimed = await client.query("UPDATE approvals SET status = 'claimed', claimed_at = now() WHERE agent_id = $1 AND idempotency_key = $2 AND status = 'approved' AND expires_at > now()", [
        agent.agentId,
        command.idempotencyKey,
      ]);
      if ((claimed.rowCount ?? 0) !== 1) return { kind: "lapsed" };
    }
    await client.query(
      `INSERT INTO agent_spends (agent_id, idempotency_key, binding, account_id, wallet_id, usd, day, state, reserved_at) VALUES ($1, $2, $3, $4, $5, $6, $7::date, 'reserved', now())
       ON CONFLICT (agent_id, idempotency_key) DO UPDATE SET usd = EXCLUDED.usd, day = EXCLUDED.day, state = 'reserved', reserved_at = now()`,
      [agent.agentId, command.idempotencyKey, bindingOf(command), agent.accountId, agent.walletId, priced.usd, priced.day],
    );
    return { kind: "reserved" };
  });
}

export async function settleSend(client: pg.ClientBase, agentId: string, idempotencyKey: string, settlement: Settlement, reservedBefore: Date | null = null): Promise<boolean> {
  const spend = await client.query("UPDATE agent_spends SET state = $3 WHERE agent_id = $1 AND idempotency_key = $2 AND state = 'reserved' AND ($4::timestamptz IS NULL OR reserved_at < $4)", [
    agentId,
    idempotencyKey,
    settlement,
    reservedBefore,
  ]);
  const approval = await client.query("UPDATE approvals SET status = $3, claimed_at = NULL WHERE agent_id = $1 AND idempotency_key = $2 AND status = 'claimed' AND ($4::timestamptz IS NULL OR claimed_at < $4)", [
    agentId,
    idempotencyKey,
    settlement === "committed" ? "used" : "approved",
    reservedBefore,
  ]);
  return (spend.rowCount ?? 0) + (approval.rowCount ?? 0) > 0;
}

export async function settleStaleSends(pool: pg.Pool, executor: ExecutorClient, graceMs = SETTLE_GRACE_MS, onError: (error: unknown) => void = () => undefined): Promise<number> {
  const cutoff = (await pool.query<{ cutoff: Date }>("SELECT now() - $1 * interval '1 millisecond' AS cutoff", [graceMs])).rows[0]?.cutoff as Date;
  const stale = await pool.query<{ agent_id: string; idempotency_key: string; account_id: string; wallet_id: string }>(
    `SELECT agent_id, idempotency_key, account_id, wallet_id FROM agent_spends WHERE state = 'reserved' AND reserved_at < $1
     UNION SELECT agent_id, idempotency_key, account_id, wallet_id FROM approvals WHERE status = 'claimed' AND claimed_at < $1`,
    [cutoff],
  );
  let settled = 0;
  for (const row of stale.rows) {
    const report = await executor.report({ accountId: row.account_id, walletId: row.wallet_id, agentId: row.agent_id, idempotencyKey: row.idempotency_key }).catch((error: unknown) => (onError(error), null));
    if (!report) continue;
    const settlement: Settlement = report.executed ? "committed" : "released";
    const changed = await inTransaction(pool, async (client) => {
      if (!(await settleSend(client, row.agent_id, row.idempotency_key, settlement, cutoff))) return false;
      await audit(client, { accountId: row.account_id, walletId: row.wallet_id, agentId: row.agent_id, actor: "system", action: "mcp.send_settled", detail: { idempotencyKey: row.idempotency_key, settlement } });
      return true;
    });
    if (changed) settled += 1;
  }
  return settled;
}
