import { z } from "zod";
import { QUOTE_ASSETS } from "../chains.js";
import type { AgentContext } from "./agents.js";
import { effectiveLimits } from "./policy.js";
import { safeRequest, type SafeResponse } from "./safe-https.js";

// x402 names networks either by short name or by CAIP-2 id. Test networks map to nothing, so they never fit.
const NETWORKS: Record<string, string> = {
  base: "base",
  "eip155:8453": "base",
  polygon: "polygon",
  "eip155:137": "polygon",
  arbitrum: "arbitrum",
  "eip155:42161": "arbitrum",
  optimism: "optimism",
  "eip155:10": "optimism",
  ethereum: "ethereum",
  "eip155:1": "ethereum",
  solana: "solana",
  "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp": "solana",
};

const requirementSchema = z
  .object({
    scheme: z.string().max(32),
    network: z.string().max(80),
    maxAmountRequired: z.string().regex(/^\d{1,40}$/).optional(),
    amount: z.string().regex(/^\d{1,40}$/).optional(),
    asset: z.string().max(80),
    payTo: z.string().max(80),
    description: z.string().max(500).optional(),
  })
  .loose();
const challengeSchema = z.object({ x402Version: z.number().int(), accepts: z.array(z.unknown()).min(1).max(16) }).loose();

export type X402Option = { network: string; chain: string | null; asset: string; symbol: string | null; amount: string; usd: number | null; payTo: string; fits: boolean; reasons: string[] };
export type X402Quote =
  | { status: "no_payment_required"; httpStatus: number }
  | { status: "plan"; paid: false; note: string; options: X402Option[]; best: X402Option | null }
  | { status: "unreadable"; reason: string };

export type Fetch402 = (url: string) => Promise<SafeResponse>;
export const fetch402: Fetch402 = (url) => safeRequest(url, { method: "GET", headers: { accept: "application/json" }, maxBytes: 64 * 1024, timeoutMs: 5_000 });

function option(raw: z.infer<typeof requirementSchema>, agent: AgentContext): X402Option {
  const limits = effectiveLimits(agent.limits, agent.policy);
  const chain = NETWORKS[raw.network] ?? null;
  const amount = raw.maxAmountRequired ?? raw.amount ?? "0";
  const known = chain ? QUOTE_ASSETS[chain]?.find((entry) => entry.address.toLowerCase() === raw.asset.toLowerCase()) : undefined;
  const stable = known && (known.symbol === "USDC" || known.symbol === "USDT") ? known : undefined;
  const usd = stable ? Number(amount) / 10 ** stable.decimals : null;
  const reasons: string[] = [];
  if (raw.scheme !== "exact") reasons.push(`scheme ${raw.scheme} is not supported`);
  if (!chain) reasons.push(`network ${raw.network} is not a supported mainnet`);
  else if (!limits.chains.includes(chain)) reasons.push(`${chain} is outside this agent's chains`);
  if (usd === null) reasons.push("the asset is not a known stablecoin, so the price is unknown");
  else if (usd > limits.maxTxUsd) reasons.push(`${usd} USD is above this agent's ${limits.maxTxUsd} USD per-transaction cap`);
  return { network: raw.network, chain, asset: raw.asset, symbol: known?.symbol ?? null, amount, usd, payTo: raw.payTo, fits: reasons.length === 0, reasons };
}

// Reads a paid resource's 402 challenge and says which payment option this agent could make. It pays nothing: a live
// x402 payment is a send with no simulation step, and AGENTS.md does not allow a send path that skips one.
export async function x402Quote(url: string, agent: AgentContext, fetchImpl: Fetch402 = fetch402): Promise<X402Quote> {
  let response: SafeResponse;
  try {
    response = await fetchImpl(url);
  } catch (error) {
    return { status: "unreadable", reason: error instanceof Error ? error.message : "the resource could not be reached" };
  }
  if (response.status !== 402) return { status: "no_payment_required", httpStatus: response.status };
  let challenge: z.infer<typeof challengeSchema>;
  try {
    challenge = challengeSchema.parse(JSON.parse(response.body));
  } catch {
    return { status: "unreadable", reason: "the 402 body is not an x402 payment challenge" };
  }
  const options = challenge.accepts.flatMap((entry) => {
    const parsed = requirementSchema.safeParse(entry);
    return parsed.success ? [option(parsed.data, agent)] : [];
  });
  const best = options.filter((entry) => entry.fits).sort((left, right) => (left.usd ?? Infinity) - (right.usd ?? Infinity))[0] ?? null;
  return { status: "plan", paid: false, note: "Hosted x402 payments are not enabled. Nothing was paid.", options, best };
}
