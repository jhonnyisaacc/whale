import type pg from "pg";
import { QUOTE_ASSETS, quoteAssetOf } from "../chains.js";
import type { HostedCommand } from "../hosted-commands.js";
import { audit, inTransaction } from "./accounts.js";
import type { AgentContext } from "./agents.js";
import { approvalFor, requestApproval } from "./approvals.js";
import { ExecutorRefused, type ExecutorClient } from "./executor-client.js";
import { effectiveLimits } from "./policy.js";
import { dailyRefusal, KEY_REUSED, recordedSpend, reserveSend, settleSend, type Priced, type Send } from "./send-ledger.js";

export { dailyRefusal } from "./send-ledger.js";

export type SendOutcome = { ok: true; value: unknown } | { ok: false; error: string };

const DOLLAR_TOKENS = new Set(["USDC", "USDT", "USDB"]);

function usd(value: number): string {
  return `${value.toFixed(2)} USD`;
}

function sellUsd(command: Extract<HostedCommand, { kind: "swap" }>): number | null {
  const asset = quoteAssetOf(QUOTE_ASSETS, command.chainKey, command.sellToken);
  if (!asset || !DOLLAR_TOKENS.has(asset.symbol)) return null;
  return Number(BigInt(command.sellAmount)) / 10 ** asset.decimals;
}

export function today(): string {
  return new Date().toISOString().slice(0, 10);
}

export function perTxRefusal(agent: AgentContext, estimate: number, lead: string): string | null {
  const cap = effectiveLimits(agent.limits, agent.policy).maxTxUsd;
  return estimate > cap ? `${lead} ${usd(estimate)}, above this agent's ${usd(cap)} per-transaction cap` : null;
}

export function transferApprovalReason(agent: AgentContext): string | null {
  return agent.policy.approvalAboveUsd === null ? null : "transfers out need the owner's approval";
}

const SETTLING = "a send with this idempotencyKey is still settling. Call again later with the same idempotencyKey";

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
  const settling: SendOutcome = { ok: true, value: { status: "settling", reason: SETTLING } };

  const recorded = await recordedSpend(pool, agent, command);
  if (recorded === "conflict") return deny(KEY_REUSED);
  if (recorded === "reserved") return settling;
  const approval = await approvalFor(pool, agent, command.idempotencyKey, command);
  if (approval === "conflict") return deny(KEY_REUSED);
  if (approval === "claimed") return settling;
  if (approval === "used") return deny("this approval was already used. Ask again with a new idempotencyKey");
  if (approval === "denied") return deny("the owner denied this operation");
  if (approval === "expired") return deny("the approval request expired. Ask again with a new idempotencyKey");
  if (approval === "pending") return { ok: true, value: { status: "approval_pending", reason: "the owner has not answered yet. Call again later with the same idempotencyKey" } };
  const approved = approval === "approved";
  const threshold = agent.policy.approvalAboveUsd;
  let priced: Priced | null = null;
  const transferApproval = command.kind === "transfer" && !approved ? transferApprovalReason(agent) : null;
  if (transferApproval) return ask(null, transferApproval);
  if (command.kind === "swap") {
    const estimate = sellUsd(command);
    const overCap = estimate === null ? null : perTxRefusal(agent, estimate, "the swap sells about");
    if (overCap) return deny(overCap);
    priced = estimate === null ? null : { usd: estimate, day: today() };
    const overDaily = priced && recorded !== "committed" ? await dailyRefusal(pool, agent, priced) : null;
    if (overDaily) return deny(overDaily);
    if (!approved && estimate === null) return ask(null, "the swap sells a token Whale cannot price");
    if (!approved && estimate !== null && threshold !== null && estimate > threshold) return ask(estimate, `the swap sells about ${usd(estimate)}, above the ${usd(threshold)} approval threshold`);
  }

  const reservation = await reserveSend(pool, agent, command, priced, approved);
  if (reservation.kind === "refused") return deny(reservation.reason);
  if (reservation.kind === "settling") return settling;
  if (reservation.kind === "lapsed") return lapsedApproval(pool, agent, command, deny, settling);
  const request = { accountId: agent.accountId, walletId: agent.walletId, agentId: agent.agentId, command };
  let value: unknown;
  try {
    value = await executor.run(request);
  } catch (error) {
    if (reservation.kind === "unreserved") throw error;
    if (!(error instanceof ExecutorRefused)) return { ok: false, error: "the executor did not confirm the send, so it may have happened. Nothing is released until Whale settles it. Call again later with the same idempotencyKey" };
    await inTransaction(pool, (client) => settleSend(client, agent.agentId, command.idempotencyKey, "released"));
    return deny(`the executor refused the send (${error.message}). Nothing was spent`);
  }
  await inTransaction(pool, async (client) => {
    if (reservation.kind === "reserved") await settleSend(client, agent.agentId, command.idempotencyKey, "committed");
    await audit(client, { ...scope, action: `mcp.${command.kind}_planned`, detail: { idempotencyKey: command.idempotencyKey, chain: command.chainKey, approved } });
  });
  return { ok: true, value };
}

async function lapsedApproval(pool: pg.Pool, agent: AgentContext, command: Send, deny: (reason: string) => Promise<SendOutcome>, settling: SendOutcome): Promise<SendOutcome> {
  const now = await approvalFor(pool, agent, command.idempotencyKey, command);
  if (now === "claimed") return settling;
  return deny(now === "expired" ? "the approval request expired. Ask again with a new idempotencyKey" : "this approval was already used. Ask again with a new idempotencyKey");
}
