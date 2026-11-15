import { z } from "zod";
import { QUOTE_ASSETS, quoteAssetOf } from "../chains.js";
import { safeRequest, type SafeResponse } from "./safe-https.js";

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

export type X402Payment = { chainKey: string; token: string; to: string; amount: string; usd: number };
export type X402Verdict = { verdict: "fits" | "needs_approval" | "refused"; reasons: string[] };
export type JudgePayment = (payment: X402Payment) => Promise<X402Verdict>;
export type X402Option = { network: string; chain: string | null; asset: string; symbol: string | null; amount: string | null; usd: number | null; payTo: string } & X402Verdict;
export type X402Quote =
  | { status: "no_payment_required"; httpStatus: number }
  | { status: "plan"; paid: false; note: string; options: X402Option[]; best: X402Option | null }
  | { status: "unreadable"; reason: string };

export type Fetch402 = (url: string) => Promise<SafeResponse>;
export const fetch402: Fetch402 = (url) => safeRequest(url, { method: "GET", headers: { accept: "application/json" }, maxBytes: 64 * 1024, timeoutMs: 5_000 });

async function option(raw: z.infer<typeof requirementSchema>, judge: JudgePayment): Promise<X402Option> {
  const chain = NETWORKS[raw.network] ?? null;
  const stated = raw.maxAmountRequired ?? raw.amount;
  const amount = stated && BigInt(stated) > 0n ? stated : null;
  const known = chain ? quoteAssetOf(QUOTE_ASSETS, chain, raw.asset) : undefined;
  const stable = known && (known.symbol === "USDC" || known.symbol === "USDT") ? known : undefined;
  const usd = stable && amount ? Number(amount) / 10 ** stable.decimals : null;
  const reasons: string[] = [];
  if (raw.scheme !== "exact") reasons.push(`scheme ${raw.scheme} is not supported`);
  if (!chain) reasons.push(`network ${raw.network} is not a supported mainnet`);
  if (amount === null) reasons.push("the option names no amount to pay");
  else if (!stable) reasons.push("the asset is not a known stablecoin, so the price is unknown");
  const base = { network: raw.network, chain, asset: raw.asset, symbol: known?.symbol ?? null, amount, usd, payTo: raw.payTo };
  if (reasons.length > 0 || chain === null || amount === null || usd === null) return { ...base, verdict: "refused", reasons };
  return { ...base, ...(await judge({ chainKey: chain, token: raw.asset, to: raw.payTo, amount, usd })) };
}

function cheapest(options: X402Option[], verdict: X402Verdict["verdict"]): X402Option | null {
  return options.filter((entry) => entry.verdict === verdict).sort((left, right) => (left.usd ?? Infinity) - (right.usd ?? Infinity))[0] ?? null;
}

export async function x402Quote(url: string, judge: JudgePayment, fetchImpl: Fetch402 = fetch402): Promise<X402Quote> {
  let response: SafeResponse;
  try {
    response = await fetchImpl(url);
  } catch (error) {
    return { status: "unreadable", reason: error instanceof Error ? error.message : "the resource could not be reached" };
  }
  if (response.status !== 402) return { status: "no_payment_required", httpStatus: response.status };
  if (response.truncated) return { status: "unreadable", reason: "the 402 body is larger than 64 KiB" };
  let challenge: z.infer<typeof challengeSchema>;
  try {
    challenge = challengeSchema.parse(JSON.parse(response.body));
  } catch {
    return { status: "unreadable", reason: "the 402 body is not an x402 payment challenge" };
  }
  const options = await Promise.all(
    challenge.accepts.flatMap((entry) => {
      const parsed = requirementSchema.safeParse(entry);
      return parsed.success ? [option(parsed.data, judge)] : [];
    }),
  );
  const best = cheapest(options, "fits") ?? cheapest(options, "needs_approval");
  return { status: "plan", paid: false, note: "Hosted x402 payments are not enabled. Nothing was paid.", options, best };
}
