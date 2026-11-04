import type pg from "pg";
import type { HostedCommand } from "../hosted-commands.js";
import { audit } from "./accounts.js";
import type { AgentContext } from "./agents.js";
import { consumeApproval, estimateUsd, requestApproval } from "./approvals.js";
import type { ExecutorClient } from "./executor-client.js";
import { effectiveLimits } from "./policy.js";

export type SendOutcome = { ok: true; value: unknown } | { ok: false; error: string };
type Send = Extract<HostedCommand, { kind: "swap" | "transfer" }>;

function usd(value: number): string {
  return `${value.toFixed(2)} USD`;
}

// The order matters. A decided approval is read first, so a retry with the same idempotencyKey finds its answer.
// A transfer has no quote to price it, so with a threshold set every transfer out asks the owner. A swap is priced by
// its quote: above the agent's cap it is refused even if approved, above the threshold it asks.
export async function planSend(pool: pg.Pool, executor: ExecutorClient, agent: AgentContext, tool: string, command: Send): Promise<SendOutcome> {
  const scope = { accountId: agent.accountId, walletId: agent.walletId, agentId: agent.agentId, actor: "agent" as const };
  const deny = async (reason: string): Promise<SendOutcome> => {
    await audit(pool, { ...scope, action: "mcp.denied", detail: { tool, reason } });
    return { ok: false, error: reason };
  };
  const ask = async (estimate: number | null, reason: string): Promise<SendOutcome> => {
    const request = await requestApproval(pool, agent, { kind: command.kind, idempotencyKey: command.idempotencyKey, command, estimateUsd: estimate, reason });
    return {
      ok: true,
      value: { status: "approval_required", approvalId: request.id, expiresAt: request.expiresAt, estimateUsd: estimate, reason: `${reason}. The owner answers in the Whale dashboard. Call again later with the same idempotencyKey` },
    };
  };

  const approval = await consumeApproval(pool, agent, command.idempotencyKey, command);
  if (approval === "denied") return deny("the owner denied this operation");
  if (approval === "expired") return deny("the approval request expired. Ask again with a new idempotencyKey");
  if (approval === "pending") return { ok: true, value: { status: "approval_pending", reason: "the owner has not answered yet. Call again later with the same idempotencyKey" } };
  const approved = approval === "used";
  const threshold = agent.policy.approvalAboveUsd;
  if (command.kind === "transfer" && !approved && threshold !== null) return ask(null, "transfers out need the owner's approval");

  const value = await executor.run({ walletId: agent.walletId, agentId: agent.agentId, command });
  if (command.kind === "swap") {
    const estimate = estimateUsd(value);
    const cap = effectiveLimits(agent.limits, agent.policy).maxTxUsd;
    if (estimate !== null && estimate > cap) return deny(`the swap is worth about ${usd(estimate)}, above this agent's ${usd(cap)} per-transaction cap`);
    if (!approved && threshold !== null && (estimate === null || estimate > threshold)) {
      return ask(estimate, estimate === null ? "the swap could not be priced" : `the swap is worth about ${usd(estimate)}, above the ${usd(threshold)} approval threshold`);
    }
  }
  await audit(pool, { ...scope, action: `mcp.${command.kind}_planned`, detail: { idempotencyKey: command.idempotencyKey, chain: command.chainKey, approved } });
  return { ok: true, value };
}
