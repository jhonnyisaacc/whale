import { createHmac } from "node:crypto";
import { withTimeout } from "../timeout.js";
import { z } from "zod";
import type { AppConfig } from "../config.js";
import type { ChainRef } from "../domain.js";
import { chainByEvmId, gasCeilingUsd } from "../chains.js";
import { validSellAmount, type QuoteHop } from "../quote-hop.js";
import type { HopQuote } from "../executor.js";
import { ProviderGuard, classifyHttp, retryAfterAt } from "../provider-guard.js";
import { impactPctFromUsd, readJupiter, readLifi, readZeroEx } from "../quotes.js";
import { readVendorText, vendorResponse } from "../vendor-fetch.js";

const ZEROEX = new Set([1, 10, 56, 137, 143, 8453, 42161, 59144, 534352, 4663, 999]);
const ONEINCH = new Set([1, 10, 56, 137, 324, 8453, 42161, 59144]);
const VELORA = new Set([1, 10, 56, 137, 8453, 42161]);
const OKX_EVM = new Set([1, 10, 56, 137, 324, 8453, 42161, 59144, 81457, 534352, 4663, 999]);
export const KYBER_SLUG: Record<number, string> = {
  1: "ethereum",
  56: "bsc",
  42161: "arbitrum",
  137: "polygon",
  10: "optimism",
  8453: "base",
  59144: "linea",
  999: "hyperevm",
  4663: "robinhood",
  143: "monad",
};

export const PROVIDER_REGISTRY = {
  odos: { calls: false, reason: "Odos shut down trading and API services." },
  jumper: { calls: false, reason: "Jumper is the LI.FI interface. Bridge quotes call LI.FI once." },
} as const;

export function kyberSupports(chainId: number): boolean {
  return KYBER_SLUG[chainId] !== undefined;
}

const SIGNABLE_PROVIDERS: ReadonlySet<string> = new Set(["jupiter", "zeroex", "kyberswap"]);

export function signableProvider(config: AppConfig, id: string): boolean {
  return SIGNABLE_PROVIDERS.has(id) || (id === "lifi" && config.lifiLive);
}

export type QuoteProviderId = "jupiter" | "zeroex" | "oneinch" | "kyberswap" | "velora" | "okx" | "lifi";

export type Reference = { spentUsd: number; priceUsd: number; decimals: number };

const guards = new Map<string, ProviderGuard>();

export function resetProviderGuards(): void {
  guards.clear();
}

export function guardFor(config: AppConfig): ProviderGuard {
  const existing = guards.get("app");
  if (existing) return existing;
  const created = new ProviderGuard({
    budget: config.providerBudgetPerMinute,
    windowMs: 60_000,
    failureThreshold: config.providerFailureThreshold,
    openMs: config.providerOpenMs,
    now: () => config.now?.() ?? Date.now(),
  });
  guards.set("app", created);
  return created;
}

export function providersFor(chain: ChainRef, config: AppConfig): QuoteProviderId[] {
  if (chain.kind === "solana") {
    const out: QuoteProviderId[] = ["jupiter"];
    if (config.keys.okxKey && config.keys.okxSecret && config.keys.okxPassphrase) out.push("okx");
    return out;
  }
  if (chain.kind !== "evm") return [];
  const id = chain.chainId;
  const out: QuoteProviderId[] = [];
  if (ZEROEX.has(id) && config.keys.zeroEx) out.push("zeroex");
  if (ONEINCH.has(id) && config.keys.oneInch) out.push("oneinch");
  if (KYBER_SLUG[id]) out.push("kyberswap");
  if (VELORA.has(id)) out.push("velora");
  if (OKX_EVM.has(id) && config.keys.okxKey && config.keys.okxSecret && config.keys.okxPassphrase) out.push("okx");
  out.push("lifi");
  return out;
}

export const oneInchSchema = z.object({ dstAmount: z.string() }).passthrough();
export const kyberSchema = z
  .object({
    data: z.object({
      routeSummary: z.object({ amountOut: z.string(), gasUsd: z.string().optional(), routerAddress: z.string() }).passthrough(),
    }),
  })
  .passthrough();
export const kyberBuildSchema = z
  .object({ data: z.object({ data: z.string(), routerAddress: z.string(), transactionValue: z.string().optional(), amountOut: z.string().optional() }) })
  .passthrough();
export const veloraSchema = z.object({ priceRoute: z.object({ destAmount: z.string(), gasCostUSD: z.string().optional() }).passthrough() }).passthrough();
export const okxSchema = z
  .object({
    code: z.string(),
    data: z.array(z.object({ toTokenAmount: z.string(), tradeFee: z.string().optional() }).passthrough()),
  })
  .passthrough();

export const lifiBridgeSchema = z
  .object({
    estimate: z.object({ toAmount: z.string(), feeCosts: z.array(z.object({ amountUSD: z.string().optional() })).optional() }).optional(),
    action: z.object({ toAddress: z.string().optional() }).optional(),
  })
  .passthrough();
export const relayBridgeSchema = z
  .object({
    details: z.object({ recipient: z.string(), currencyOut: z.object({ amountUsd: z.string().optional() }).optional() }),
    fees: z.record(z.object({ amountUsd: z.string().optional() }).passthrough()),
  })
  .passthrough();
export const debridgeSchema = z
  .object({
    estimation: z.object({
      srcChainTokenIn: z.object({ approximateUsdValue: z.number().optional() }).optional(),
      dstChainTokenOut: z.object({ amount: z.string(), approximateUsdValue: z.number().optional() }),
    }),
  })
  .passthrough();
export const acrossSchema = z
  .object({ expectedOutputAmount: z.string(), fees: z.object({ total: z.object({ amountUsd: z.string() }) }) })
  .passthrough();

export function empty(): HopQuote {
  return { priceImpactPct: null, feeUsd: 0, buyAmount: "0", signable: false };
}

export function withNet(quote: HopQuote, reference: Reference | null, chainKey: string, gasUsd: number | null): HopQuote {
  if (quote.priceImpactPct === null || !reference || !/^\d+$/.test(quote.buyAmount)) return quote;
  const human = Number(quote.buyAmount) / 10 ** reference.decimals;
  if (!Number.isFinite(human)) return quote;
  const gas = gasUsd ?? gasCeilingUsd(chainKey);
  return { ...quote, gasUsd: gas, netOutputUsd: human * reference.priceUsd - quote.feeUsd - gas };
}

export function chainKeyOf(chain: ChainRef): string {
  if (chain.kind === "solana") return "solana";
  if (chain.kind === "evm") return chainByEvmId(chain.chainId)?.key ?? String(chain.chainId);
  return "hypercore";
}

export function nowMs(config: AppConfig): number {
  return config.now?.() ?? Date.now();
}

export async function callProvider(config: AppConfig, id: string, url: string, init: RequestInit, fetchImpl: typeof fetch, signal: AbortSignal): Promise<unknown | null> {
  const guard = guardFor(config);
  if (guard.before(id) !== "allow") return null;
  try {
    const response = await vendorResponse(fetchImpl, url, { ...init, signal });
    const text = await readVendorText(response);
    const kind = classifyHttp(response.status, text);
    if (kind === "compliance") {
      guard.compliance(id);
      return null;
    }
    if (kind === "rate") {
      guard.rateLimited(id, retryAfterAt(response.headers.get("retry-after"), nowMs(config)));
      return null;
    }
    if (kind !== "ok") {
      guard.failure(id, "http");
      return null;
    }
    try {
      const parsed = JSON.parse(text) as unknown;
      guard.success(id);
      return parsed;
    } catch {
      guard.failure(id, "schema");
      return null;
    }
  } catch {
    guard.failure(id, "network");
    return null;
  }
}

export function callFirm(config: AppConfig, id: string, url: string, init: RequestInit, fetchImpl: typeof fetch): Promise<unknown | null> {
  return withTimeout(config.firmTimeoutMs, (signal) => callProvider(config, id, url, init, fetchImpl, signal));
}

export function jupiterHeaders(config: AppConfig, json = false): Record<string, string> {
  const headers: Record<string, string> = json ? { "content-type": "application/json" } : {};
  if (config.keys.jupiter) headers["x-api-key"] = config.keys.jupiter;
  return headers;
}

export function jupiterQuoteUrl(config: AppConfig, hop: QuoteHop, slippageBps: number): string {
  const url = new URL(`${config.jupiterBase}/quote`);
  url.searchParams.set("inputMint", hop.sellAddress);
  url.searchParams.set("outputMint", hop.buyAddress);
  url.searchParams.set("amount", hop.sellAmount);
  url.searchParams.set("slippageBps", String(slippageBps));
  return url.toString();
}

export function jupiterQuote(config: AppConfig, body: unknown): HopQuote {
  const parsed = readJupiter(body as Parameters<typeof readJupiter>[0], config.jupiterImpactUnit);
  return { priceImpactPct: parsed.priceImpactPct, feeUsd: 0, buyAmount: parsed.buyAmount, raw: body, provider: "jupiter", signable: true };
}

export function zeroExUrl(config: AppConfig, hop: QuoteHop, chainId: number, taker: string | null, slippageBps: number): string {
  const url = new URL(`${config.zeroExBase}/swap/allowance-holder/${taker ? "quote" : "price"}`);
  url.searchParams.set("chainId", String(chainId));
  url.searchParams.set("sellToken", hop.sellAddress);
  url.searchParams.set("buyToken", hop.buyAddress);
  url.searchParams.set("sellAmount", hop.sellAmount);
  if (taker) {
    url.searchParams.set("taker", taker);
    url.searchParams.set("slippageBps", String(slippageBps));
  }
  return url.toString();
}

export function zeroExHeaders(config: AppConfig): Record<string, string> {
  return { "0x-version": "v2", "0x-api-key": config.keys.zeroEx ?? "" };
}

export function zeroExQuote(body: unknown, reference: Reference | null): HopQuote {
  const parsed = readZeroEx(body as Parameters<typeof readZeroEx>[0], reference);
  return { priceImpactPct: parsed.priceImpactPct, feeUsd: 0, buyAmount: parsed.buyAmount, raw: body, prepared: parsed, provider: "zeroex", signable: true };
}

export function lifiUrl(config: AppConfig, hop: QuoteHop, chainId: number, taker: string, slippageBps: number): string {
  const url = new URL(`${config.lifiBase}/quote`);
  url.searchParams.set("fromChain", String(chainId));
  url.searchParams.set("toChain", String(chainId));
  url.searchParams.set("fromToken", hop.sellAddress);
  url.searchParams.set("toToken", hop.buyAddress);
  url.searchParams.set("fromAmount", hop.sellAmount);
  url.searchParams.set("fromAddress", taker);
  url.searchParams.set("slippage", String(slippageBps / 10_000));
  if (config.keys.lifiIntegrator) url.searchParams.set("integrator", config.keys.lifiIntegrator);
  return url.toString();
}

export function lifiHeaders(config: AppConfig): Record<string, string> {
  return config.keys.lifi ? { "x-lifi-api-key": config.keys.lifi } : {};
}

// LI.FI calldata targets its diamond with facet-specific encodings, so the signer cannot read the swap recipient.
// It stays quote-only unless the operator opts in with LIFI_LIVE=true.
export function lifiQuote(config: AppConfig, body: unknown, reference: Reference | null, chainId: number): HopQuote {
  const parsed = readLifi(body as Parameters<typeof readLifi>[0], reference, chainId);
  if (!parsed.sameChain) return empty();
  return { priceImpactPct: parsed.priceImpactPct, feeUsd: parsed.feeUsd, buyAmount: parsed.buyAmount, raw: body, provider: "lifi", signable: config.lifiLive };
}

export function kyberRoutesUrl(config: AppConfig, slug: string, hop: QuoteHop): string {
  const url = new URL(`${config.kyberBase}/${slug}/api/v1/routes`);
  url.searchParams.set("tokenIn", hop.sellAddress);
  url.searchParams.set("tokenOut", hop.buyAddress);
  url.searchParams.set("amountIn", hop.sellAmount);
  return url.toString();
}

export function kyberRouteQuote(body: unknown, reference: Reference | null): HopQuote | null {
  const parsed = kyberSchema.safeParse(body);
  if (!parsed.success) return null;
  const summary = parsed.data.data.routeSummary;
  const gas = summary.gasUsd ? Number(summary.gasUsd) : null;
  const impact = reference ? impactPctFromUsd(reference.spentUsd, Number(summary.amountOut) / 10 ** reference.decimals, reference.priceUsd) : null;
  return {
    priceImpactPct: impact,
    feeUsd: 0,
    buyAmount: summary.amountOut,
    provider: "kyberswap",
    signable: true,
    raw: body,
    gasUsd: Number.isFinite(gas ?? NaN) ? (gas as number) : undefined,
  };
}

export async function quoteKyber(config: AppConfig, hop: QuoteHop, chainId: number, reference: Reference | null, fetchImpl: typeof fetch, signal: AbortSignal, key: string): Promise<HopQuote> {
  const slug = KYBER_SLUG[chainId];
  if (!slug) return empty();
  const body = await callProvider(config, "kyberswap", kyberRoutesUrl(config, slug, hop), { headers: { "x-client-id": config.keys.kyberClientId } }, fetchImpl, signal);
  const quote = kyberRouteQuote(body, reference);
  if (!quote) return empty();
  return withNet(quote, reference, key, quote.gasUsd ?? null);
}

