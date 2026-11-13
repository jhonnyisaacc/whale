import type pg from "pg";
import { z } from "zod";
import { chainByKey } from "../chains.js";
import type { HostedCommand } from "../hosted-commands.js";
import { audit } from "./accounts.js";
import type { AgentContext } from "./agents.js";
import type { ExecutorClient } from "./executor-client.js";
import { planSend } from "./mcp-sends.js";
import { effectiveLimits, type WalletPolicy } from "./policy.js";
import type { WalletView } from "./wallets.js";

const amount = { type: "string", description: "Positive integer in the token's smallest unit (wei, lamports, 6-decimal USDC units)." };
const token = { type: "string", description: "Token address. EVM: 0x address. Solana: mint address." };
const chain = { type: "string", description: "Chain key, for example base, arbitrum, solana." };
const key = { type: "string", description: "Your unique id for this operation, 8 to 128 characters. Reusing it never repeats an operation." };

export const HOSTED_TOOLS = [
  { name: "wallet_status", description: "Show this agent's wallet, its addresses, the limits that apply now, and whether sends are live. Moves no money.", inputSchema: { type: "object", properties: {}, additionalProperties: false } },
  { name: "deposit_address", description: "Return the wallet address to fund on a chain. Moves no money.", inputSchema: { type: "object", properties: { chain }, required: ["chain"], additionalProperties: false } },
  { name: "balance", description: "Read the wallet's native balance on a chain. Moves no money.", inputSchema: { type: "object", properties: { chain }, required: ["chain"], additionalProperties: false } },
  { name: "quote", description: "Quote a same-chain swap from the wallet. Moves no money.", inputSchema: { type: "object", properties: { chain, sellToken: token, buyToken: token, sellAmount: amount, slippageBps: { type: "integer", minimum: 1, maximum: 1000 } }, required: ["chain", "sellToken", "buyToken", "sellAmount"], additionalProperties: false } },
  { name: "swap", description: "Plan a swap and return the route it would take. Checks this agent's chains, actions, and per-transaction and daily USD caps, the wallet's daily USD cap, and the wallet's slippage and token list. Above the owner's approval threshold, or when it cannot be priced, it returns approval_required: call again later with the same idempotencyKey. Hosted sends are dry-run: nothing is signed.", inputSchema: { type: "object", properties: { chain, sellToken: token, buyToken: token, sellAmount: amount, slippageBps: { type: "integer", minimum: 1, maximum: 1000 }, idempotencyKey: key }, required: ["chain", "sellToken", "buyToken", "sellAmount", "idempotencyKey"], additionalProperties: false } },
  { name: "transfer", description: "Plan a transfer to an address on the wallet's destination list. Checks this agent's chains and actions and the wallet's token list, not its USD limits. When the owner set an approval threshold it returns approval_required: call again later with the same idempotencyKey. Hosted sends are dry-run: nothing is signed.", inputSchema: { type: "object", properties: { chain, token, to: { type: "string", description: "A destination the wallet owner listed in the dashboard." }, amount, idempotencyKey: key }, required: ["chain", "token", "to", "amount", "idempotencyKey"], additionalProperties: false } },
] as const;

const swapArgs = z.object({ chain: z.string(), sellToken: z.string(), buyToken: z.string(), sellAmount: z.string(), slippageBps: z.number().int().optional(), idempotencyKey: z.string().optional() }).strict();
const transferArgs = z.object({ chain: z.string(), token: z.string(), to: z.string(), amount: z.string(), idempotencyKey: z.string() }).strict();
const chainArgs = z.object({ chain: z.string() }).strict();

export type ToolEnv = { pool: pg.Pool; agent: AgentContext; wallet: WalletView; executor: ExecutorClient | null };
export type ToolOutcome = { ok: true; value: unknown } | { ok: false; error: string };

function family(chainKey: string): "evm" | "solana" | null {
  const kind = chainByKey(chainKey)?.chain.kind;
  return kind === "evm" || kind === "solana" ? kind : null;
}

function addressOf(wallet: WalletView, chainKey: string): string | null {
  const wanted = family(chainKey);
  return wallet.addresses.find((entry) => entry.family === wanted)?.address ?? null;
}

function sameAddress(chainKey: string, left: string, right: string): boolean {
  return family(chainKey) === "evm" ? left.toLowerCase() === right.toLowerCase() : left === right;
}

function tokenAllowed(policy: WalletPolicy, chainKey: string, address: string): boolean {
  return policy.tokenAllowlist === null || policy.tokenAllowlist.some((entry) => entry.chain === chainKey && sameAddress(chainKey, entry.address, address));
}

// The gateway refuses what the agent may not do before anything reaches the executor. The executor and the
// signer check again on a live send; this check is what gives the agent a clear reason.
export function denyReason(agent: AgentContext, command: HostedCommand): string | null {
  const limits = effectiveLimits(agent.limits, agent.policy);
  if (!limits.chains.includes(command.chainKey)) return `${command.chainKey} is outside this agent's chains (${limits.chains.join(", ") || "none"})`;
  if (command.kind === "swap" && !limits.actions.includes("swap")) return "this agent may not swap";
  if (command.kind === "transfer" && !limits.actions.includes("transfer")) return "this agent may not transfer";
  if ((command.kind === "quote" || command.kind === "swap") && command.slippageBps > agent.policy.maxSlippageBps) return `slippage is above the wallet's ${agent.policy.maxSlippageBps} bps`;
  if ((command.kind === "quote" || command.kind === "swap") && !(tokenAllowed(agent.policy, command.chainKey, command.sellToken) && tokenAllowed(agent.policy, command.chainKey, command.buyToken))) return "a token is outside the wallet's token list";
  if (command.kind === "transfer") {
    if (!tokenAllowed(agent.policy, command.chainKey, command.token)) return "the token is outside the wallet's token list";
    const listed = agent.policy.destinations.some((entry) => entry.family === family(command.chainKey) && sameAddress(command.chainKey, entry.address, command.to));
    if (!listed) return "the destination is not on the wallet's destination list. The owner adds destinations in the dashboard";
  }
  return null;
}

export function commandFor(name: string, args: unknown, wallet: WalletView, agent: AgentContext): HostedCommand | string {
  const slippage = (value: number | undefined) => value ?? Math.min(50, agent.policy.maxSlippageBps);
  if (name === "quote" || name === "swap") {
    const parsed = swapArgs.safeParse(args);
    if (!parsed.success) return "arguments do not match the tool schema";
    const { chain: chainKey, sellToken, buyToken, sellAmount } = parsed.data;
    const base = { chainKey, sellToken, buyToken, sellAmount, slippageBps: slippage(parsed.data.slippageBps), taker: addressOf(wallet, chainKey) };
    if (name === "quote") return { kind: "quote", ...base };
    if (!parsed.data.idempotencyKey) return "swap needs an idempotencyKey";
    return { kind: "swap", ...base, idempotencyKey: parsed.data.idempotencyKey };
  }
  if (name === "transfer") {
    const parsed = transferArgs.safeParse(args);
    if (!parsed.success) return "arguments do not match the tool schema";
    return { kind: "transfer", chainKey: parsed.data.chain, token: parsed.data.token, to: parsed.data.to, amount: parsed.data.amount, idempotencyKey: parsed.data.idempotencyKey };
  }
  const parsed = chainArgs.safeParse(args);
  if (!parsed.success) return "arguments do not match the tool schema";
  const address = addressOf(wallet, parsed.data.chain);
  if (!address) return "this wallet has no address on that chain yet. Finish wallet setup in the dashboard";
  return { kind: "balance", chainKey: parsed.data.chain, address };
}

function walletStatus(env: ToolEnv): unknown {
  const { wallet, agent } = env;
  return {
    wallet: { id: wallet.id, label: wallet.label, level: wallet.level, status: wallet.status, addresses: wallet.addresses },
    mode: "dry_run",
    limits: effectiveLimits(agent.limits, agent.policy),
    approvalAboveUsd: agent.policy.approvalAboveUsd,
    maxSlippageBps: agent.policy.maxSlippageBps,
    destinations: agent.policy.destinations.map((entry) => ({ family: entry.family, address: entry.address, label: entry.label })),
  };
}

export async function callHostedTool(env: ToolEnv, name: string, args: unknown): Promise<ToolOutcome> {
  const { agent } = env;
  if (name === "wallet_status") return { ok: true, value: walletStatus(env) };
  if (name === "deposit_address") {
    const parsed = chainArgs.safeParse(args);
    if (!parsed.success) return { ok: false, error: "arguments do not match the tool schema" };
    const address = addressOf(env.wallet, parsed.data.chain);
    return address ? { ok: true, value: { chain: parsed.data.chain, address } } : { ok: false, error: "this wallet has no address on that chain yet. Finish wallet setup in the dashboard" };
  }
  if (!HOSTED_TOOLS.some((tool) => tool.name === name)) return { ok: false, error: `unknown tool ${name}` };
  const command = commandFor(name, args, env.wallet, agent);
  if (typeof command === "string") return { ok: false, error: command };
  const denied = chainByKey(command.chainKey) ? denyReason(agent, command) : `unknown chain ${command.chainKey}`;
  const scope = { accountId: agent.accountId, walletId: agent.walletId, agentId: agent.agentId, actor: "agent" as const };
  if (denied) {
    await audit(env.pool, { ...scope, action: "mcp.denied", detail: { tool: name, reason: denied } });
    return { ok: false, error: denied };
  }
  if (!env.executor) return { ok: false, error: "quotes are not configured on this deployment" };
  if (command.kind === "swap" || command.kind === "transfer") return planSend(env.pool, env.executor, agent, name, command);
  return { ok: true, value: await env.executor.run({ accountId: agent.accountId, walletId: agent.walletId, agentId: agent.agentId, command }) };
}
