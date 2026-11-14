import { z } from "zod";
import { addressKey, CHAINS } from "../chains.js";

// Hosted wallets sign EVM and Solana. HyperCore needs an approved agent key and zkSync has no live send.
export const HOSTED_CHAINS: readonly string[] = CHAINS.filter((spec) => spec.chain.kind !== "hypercore" && spec.liveSend !== "disabled").map((spec) => spec.key);
export const ACTIONS = ["swap", "transfer", "bridge"] as const;
export type Action = (typeof ACTIONS)[number];

const chainKey = z.string().refine((key) => HOSTED_CHAINS.includes(key), "unknown or unsupported chain");
const usd = z.number().finite().positive().max(1_000_000);
const destination = z
  .object({ family: z.enum(["evm", "solana"]), address: z.string().min(32).max(64), label: z.string().min(1).max(64) })
  .strict()
  .superRefine((value, ctx) => {
    const ok = value.family === "evm" ? /^0x[0-9a-fA-F]{40}$/.test(value.address) : /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(value.address);
    if (!ok) ctx.addIssue({ code: "custom", message: "address does not match its family" });
  });
const token = z.object({ chain: chainKey, address: z.string().min(32).max(64) }).strict();

const destinationKey = (entry: { family: string; address: string }) => `${entry.family}:${entry.family === "evm" ? entry.address.toLowerCase() : entry.address}`;

function unique<T>(items: readonly T[], key: (item: T) => string): boolean {
  return new Set(items.map(key)).size === items.length;
}

const actions = z.array(z.enum(ACTIONS)).min(1).max(ACTIONS.length);
const policyFields = {
  version: z.literal(1),
  actions,
  maxTxUsd: usd,
  dailyUsd: usd,
  approvalAboveUsd: usd.nullable(),
  maxSlippageBps: z.number().int().min(1).max(1_000),
  destinations: z.array(destination).max(100),
};

export const walletPolicySchema = z
  .object({ ...policyFields, chains: z.array(chainKey).min(1).max(HOSTED_CHAINS.length), tokenAllowlist: z.array(token).max(500).nullable() })
  .strict()
  .superRefine((policy, ctx) => {
    if (policy.dailyUsd < policy.maxTxUsd) ctx.addIssue({ code: "custom", message: "dailyUsd must be at least maxTxUsd" });
    if (!unique(policy.chains, (chain) => chain) || !unique(policy.actions, (action) => action)) ctx.addIssue({ code: "custom", message: "chains and actions must not repeat" });
    if (!unique(policy.destinations, destinationKey)) ctx.addIssue({ code: "custom", message: "destinations must not repeat" });
  });
export type WalletPolicy = z.infer<typeof walletPolicySchema>;

// Cheap chains first, small caps, and a human above half the per-transaction cap.
export const DEFAULT_POLICY: WalletPolicy = {
  version: 1,
  chains: ["base", "arbitrum", "solana"],
  actions: ["swap"],
  maxTxUsd: 50,
  dailyUsd: 100,
  approvalAboveUsd: 25,
  maxSlippageBps: 100,
  destinations: [],
  tokenAllowlist: null,
};

export const agentLimitsSchema = z
  .object({ chains: z.array(chainKey).min(1).max(HOSTED_CHAINS.length), actions, maxTxUsd: usd, dailyUsd: usd })
  .strict()
  .refine((limits) => limits.dailyUsd >= limits.maxTxUsd, "dailyUsd must be at least maxTxUsd");
export type AgentLimits = z.infer<typeof agentLimitsSchema>;

const hosted = (chain: string) => HOSTED_CHAINS.includes(chain);
const storedChains = z.array(z.string()).transform((chains) => chains.filter(hosted));
const storedTokens = z
  .array(z.object({ chain: z.string(), address: z.string() }).strict())
  .nullable()
  .transform((tokens) => tokens?.filter((entry) => hosted(entry.chain)) ?? null);

export const storedPolicySchema: z.ZodType<WalletPolicy, unknown> = z.object({ ...policyFields, chains: storedChains, tokenAllowlist: storedTokens }).strict();
export const storedLimitsSchema: z.ZodType<AgentLimits, unknown> = z.object({ chains: storedChains, actions, maxTxUsd: usd, dailyUsd: usd }).strict();

export function limitsWithin(limits: AgentLimits, policy: WalletPolicy): string | null {
  if (!limits.chains.every((chain) => policy.chains.includes(chain))) return "a chain is outside the wallet policy";
  if (!limits.actions.every((action) => policy.actions.includes(action))) return "an action is outside the wallet policy";
  if (limits.maxTxUsd > policy.maxTxUsd) return "maxTxUsd is above the wallet policy";
  if (limits.dailyUsd > policy.dailyUsd) return "dailyUsd is above the wallet policy";
  return null;
}

// The wallet policy can narrow after an agent is created, so the limit that applies is always the intersection.
export function effectiveLimits(limits: AgentLimits, policy: WalletPolicy): AgentLimits {
  return {
    chains: limits.chains.filter((chain) => policy.chains.includes(chain)),
    actions: limits.actions.filter((action) => policy.actions.includes(action)),
    maxTxUsd: Math.min(limits.maxTxUsd, policy.maxTxUsd),
    dailyUsd: Math.min(limits.dailyUsd, policy.dailyUsd),
  };
}

function adds<T>(before: readonly T[], after: readonly T[], key: (item: T) => string): boolean {
  const known = new Set(before.map(key));
  return after.some((item) => !known.has(key(item)));
}

const tokenKey = (entry: { chain: string; address: string }) => `${entry.chain}:${addressKey(entry.chain, entry.address)}`;

// Any single loosening makes the whole change a widening. Widening needs a passkey and a delay, narrowing applies at once.
export function changeDirection(before: WalletPolicy, after: WalletPolicy): "same" | "narrow" | "widen" {
  const widens =
    adds(before.chains, after.chains, (chain) => chain) ||
    adds(before.actions, after.actions, (action) => action) ||
    after.maxTxUsd > before.maxTxUsd ||
    after.dailyUsd > before.dailyUsd ||
    (before.approvalAboveUsd !== null && (after.approvalAboveUsd === null || after.approvalAboveUsd > before.approvalAboveUsd)) ||
    after.maxSlippageBps > before.maxSlippageBps ||
    adds(before.destinations, after.destinations, destinationKey) ||
    (before.tokenAllowlist !== null && (after.tokenAllowlist === null || adds(before.tokenAllowlist, after.tokenAllowlist, tokenKey)));
  if (widens) return "widen";
  return JSON.stringify(before) === JSON.stringify(after) ? "same" : "narrow";
}
