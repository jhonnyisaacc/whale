import type pg from "pg";
import { QUOTE_ASSETS, quoteAssetOf } from "../chains.js";
import type { HostedCommand } from "../hosted-commands.js";
import { audit, inTransaction } from "./accounts.js";
import type { AgentContext } from "./agents.js";
import { approvalFor, requestApproval, spendApproval } from "./approvals.js";
import type { ExecutorClient } from "./executor-client.js";
import { effectiveLimits } from "./policy.js";

export type SendOutcome = { ok: true; value: unknown } | { ok: false; error: string };
type Send = Extract<HostedCommand, { kind: "swap" | "transfer" }>;

const DOLLAR_TOKENS = new Set(["USDC", "USDT", "USDB"]);

function usd(value: number): string {
  return `${value.toFixed(2)} USD`;
}

function sellUsd(command: Extract<HostedCommand, { kind: "swap" }>): number | null {
  const asset = quoteAssetOf(QUOTE_ASSETS, command.chainKey, command.sellToken);
  if (!asset || !DOLLAR_TOKENS.has(asset.symbol)) return null;
  return Number(BigInt(command.sellAmount)) / 10 ** asset.decimals;
}

type Priced = { usd: number; day: string };

async function dailyRefusal(client: pg.Pool | pg.ClientBase, agent: AgentContext, idempotencyKey: string, priced: Priced): Promise<string | null> {
  const totals = await client.query<{ agent: number; wallet: number }>(
    `SELECT COALESCE(SUM(usd) FILTER (WHERE agent_id = $2), 0)::float8 AS agent, COALESCE(SUM(usd), 0)::float8 AS wallet
     FROM agent_spends WHERE wallet_id = $1 AND day = $3::date AND NOT (agent_id = $2 AND idempotency_key = $4)`,
    [agent.walletId, agent.agentId, priced.day, idempotencyKey],
  );
  const spent = totals.rows[0] ?? { agent: 0, wallet: 0 };
  const agentCap = effectiveLimits(agent.limits, agent.policy).dailyUsd;
  if (spent.agent + priced.usd > agentCap) return `the swap would take today's total to about ${usd(spent.agent + priced.usd)}, above this agent's ${usd(agentCap)} daily cap`;
  if (spent.wallet + priced.usd > agent.policy.dailyUsd) return `the swap would take today's total to about ${usd(spent.wallet + priced.usd)}, above the wallet's ${usd(agent.policy.dailyUsd)} daily cap`;
  return null;
}

async function recordSpend(client: pg.ClientBase, agent: AgentContext, idempotencyKey: string, priced: Priced): Promise<string | null> {
  await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [`agent_spends:${agent.walletId}`]);
  const refused = await dailyRefusal(client, agent, idempotencyKey, priced);
  if (refused) return refused;
  await client.query(
    "INSERT INTO agent_spends (agent_id, idempotency_key, account_id, wallet_id, usd, day) VALUES ($1, $2, $3, $4, $5, $6::date) ON CONFLICT (agent_id, idempotency_key) DO NOTHING",
    [agent.agentId, idempotencyKey, agent.accountId, agent.walletId, priced.usd, priced.day],
  );
  return null;
}

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

  const approval = await approvalFor(pool, agent, command.idempotencyKey, command);
  if (approval === "conflict") return deny("this idempotencyKey was already used for a different command");
  if (approval === "used") return deny("this approval was already used. Ask again with a new idempotencyKey");
  if (approval === "denied") return deny("the owner denied this operation");
  if (approval === "expired") return deny("the approval request expired. Ask again with a new idempotencyKey");
  if (approval === "pending") return { ok: true, value: { status: "approval_pending", reason: "the owner has not answered yet. Call again later with the same idempotencyKey" } };
  const approved = approval === "approved";
  const threshold = agent.policy.approvalAboveUsd;
  let priced: Priced | null = null;
  if (command.kind === "transfer" && !approved && threshold !== null) return ask(null, "transfers out need the owner's approval");
  if (command.kind === "swap") {
    const estimate = sellUsd(command);
    const cap = effectiveLimits(agent.limits, agent.policy).maxTxUsd;
    if (estimate !== null && estimate > cap) return deny(`the swap sells about ${usd(estimate)}, above this agent's ${usd(cap)} per-transaction cap`);
    priced = estimate === null ? null : { usd: estimate, day: new Date().toISOString().slice(0, 10) };
    const overDaily = priced ? await dailyRefusal(pool, agent, command.idempotencyKey, priced) : null;
    if (overDaily) return deny(overDaily);
    if (!approved && estimate === null) return ask(null, "the swap sells a token Whale cannot price");
    if (!approved && estimate !== null && threshold !== null && estimate > threshold) return ask(estimate, `the swap sells about ${usd(estimate)}, above the ${usd(threshold)} approval threshold`);
  }

  const value = await executor.run({ accountId: agent.accountId, walletId: agent.walletId, agentId: agent.agentId, command });
  const refused = await inTransaction(pool, async (client) => {
    const overDaily = priced ? await recordSpend(client, agent, command.idempotencyKey, priced) : null;
    if (overDaily) return overDaily;
    if (approved && !(await spendApproval(client, agent, command.idempotencyKey))) return "this approval was already used. Ask again with a new idempotencyKey";
    await audit(client, { ...scope, action: `mcp.${command.kind}_planned`, detail: { idempotencyKey: command.idempotencyKey, chain: command.chainKey, approved } });
    return null;
  });
  return refused ? deny(refused) : { ok: true, value };
}
