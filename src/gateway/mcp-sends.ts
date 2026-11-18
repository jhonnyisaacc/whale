import type pg from "pg";
import { z } from "zod";
import { QUOTE_ASSETS, quoteAssetOf, type QuoteAsset } from "../chains.js";
import { audit, inTransaction } from "./accounts.js";
import type { AgentContext } from "./agents.js";
import { approvalFor, requestApproval } from "./approvals.js";
import { ExecutorRefused, type ExecutorClient } from "./executor-client.js";
import { effectiveLimits } from "./policy.js";
import { dailyRefusal, issuedNow, KEY_REUSED, recordedSpend, reserveSend, settleSend, type Priced, type Send } from "./send-ledger.js";

export { dailyRefusal } from "./send-ledger.js";

export type SendOutcome = { ok: true; value: unknown } | { ok: false; error: string };

const DOLLAR_TOKENS = new Set(["USDC", "USDT", "USDB"]);
const PRICE_SLIPPAGE_BPS = 50;
const PROBE_SHARE = 1000n;

const quotedReply = z.object({ kind: z.literal("quote"), status: z.literal("quoted"), quote: z.object({ buyAmount: z.string().regex(/^\d{1,78}$/) }).loose() }).loose();

function usd(value: number): string {
  return `${value.toFixed(2)} USD`;
}

async function quotedUsd(executor: ExecutorClient, agent: AgentContext, chainKey: string, sellToken: string, sellAmount: bigint, dollar: QuoteAsset, taker: string | null): Promise<number | null> {
  const command = { kind: "quote" as const, chainKey, sellToken, buyToken: dollar.address, sellAmount: sellAmount.toString(), slippageBps: PRICE_SLIPPAGE_BPS, taker };
  const reply = await executor.run({ accountId: agent.accountId, walletId: agent.walletId, agentId: agent.agentId, command }).catch(() => null);
  const parsed = quotedReply.safeParse(reply);
  if (!parsed.success) return null;
  const value = Number(BigInt(parsed.data.quote.buyAmount)) / 10 ** dollar.decimals;
  return value > 0 ? value : null;
}

async function sendUsd(executor: ExecutorClient, agent: AgentContext, command: Send, taker: string | null): Promise<number | null> {
  const [token, amount] = command.kind === "swap" ? [command.sellToken, command.sellAmount] : [command.token, command.amount];
  const asset = quoteAssetOf(QUOTE_ASSETS, command.chainKey, token);
  if (asset && DOLLAR_TOKENS.has(asset.symbol)) return Number(BigInt(amount)) / 10 ** asset.decimals;
  const dollar = QUOTE_ASSETS[command.chainKey]?.find((entry) => DOLLAR_TOKENS.has(entry.symbol));
  if (!dollar) return null;
  const whole = BigInt(amount);
  const probe = whole / PROBE_SHARE;
  const [full, sample] = await Promise.all([
    quotedUsd(executor, agent, command.chainKey, token, whole, dollar, taker),
    probe > 0n ? quotedUsd(executor, agent, command.chainKey, token, probe, dollar, taker) : null,
  ]);
  const estimates = [full, sample === null ? null : (sample * Number(whole)) / Number(probe)].filter((value): value is number => value !== null);
  return estimates.length === 0 ? null : Math.max(...estimates);
}

export function today(): string {
  return new Date().toISOString().slice(0, 10);
}

export function perTxRefusal(agent: AgentContext, estimate: number, lead: string): string | null {
  const cap = effectiveLimits(agent.limits, agent.policy).maxTxUsd;
  return estimate > cap ? `${lead} ${usd(estimate)}, above this agent's ${usd(cap)} per-transaction cap` : null;
}

export function thresholdReason(agent: AgentContext, estimate: number, lead: string): string | null {
  const threshold = agent.policy.approvalAboveUsd;
  return threshold !== null && estimate > threshold ? `${lead} ${usd(estimate)}, above the ${usd(threshold)} approval threshold` : null;
}

const SETTLING = "a send with this idempotencyKey is still settling. Call again later with the same idempotencyKey";

export async function planSend(pool: pg.Pool, executor: ExecutorClient, agent: AgentContext, tool: string, command: Send, taker: string | null): Promise<SendOutcome> {
  const scope = { accountId: agent.accountId, walletId: agent.walletId, agentId: agent.agentId, actor: "agent" as const };
  const deny = async (reason: string): Promise<SendOutcome> => {
    await audit(pool, { ...scope, action: "mcp.denied", detail: { tool, reason } });
    return { ok: false, error: reason };
  };
  const ask = async (estimate: number, reason: string): Promise<SendOutcome> => {
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
  const ids = { accountId: agent.accountId, walletId: agent.walletId, agentId: agent.agentId };
  if (recorded === "committed") {
    const report = await executor.report({ ...ids, idempotencyKey: command.idempotencyKey, issuedBefore: await issuedNow(pool) });
    if (report.state === "executed") return { ok: true, value: report.value };
    if (report.state === "in_progress") return settling;
    return deny("Whale counted this send as done but the executor has no record of it, so Whale did not run it again. Use a new idempotencyKey for a new send");
  }
  const approval = await approvalFor(pool, agent, command.idempotencyKey, command);
  if (approval === "conflict") return deny(KEY_REUSED);
  if (approval === "claimed") return settling;
  if (approval === "used") return deny("this approval was already used. Ask again with a new idempotencyKey");
  if (approval === "denied") return deny("the owner denied this operation");
  if (approval === "expired") return deny("the approval request expired. Ask again with a new idempotencyKey");
  if (approval === "pending") return { ok: true, value: { status: "approval_pending", reason: "the owner has not answered yet. Call again later with the same idempotencyKey" } };
  const approved = approval === "approved";
  const [what, verb] = command.kind === "swap" ? ["the swap", "sells"] : ["the transfer", "moves"];
  const estimate = await sendUsd(executor, agent, command, taker);
  if (estimate === null) return deny(`${what} ${verb} a token Whale could not price on ${command.chainKey}, so Whale refused it. No approval was requested and nothing was sent`);
  const overCap = perTxRefusal(agent, estimate, `${what} ${verb} about`);
  if (overCap) return deny(overCap);
  const priced: Priced = { usd: estimate, day: today() };
  const overDaily = await dailyRefusal(pool, agent, priced, what);
  if (overDaily) return deny(overDaily);
  const overThreshold = approved ? null : thresholdReason(agent, estimate, `${what} ${verb} about`);
  if (overThreshold) return ask(estimate, overThreshold);

  const reservation = await reserveSend(pool, agent, command, priced, approved, what);
  if (reservation.kind === "refused") return deny(reservation.reason);
  if (reservation.kind === "settling") return settling;
  if (reservation.kind === "lapsed") return lapsedApproval(pool, agent, command, deny, settling);
  let value: unknown;
  try {
    value = await executor.run({ ...ids, command, issuedAt: reservation.issuedAt });
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
