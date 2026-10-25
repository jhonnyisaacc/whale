import { z } from "zod";
import type { AppConfig } from "../config.js";
import type { QuoteHop } from "../quote-hop.js";
import type { HopQuote } from "../executor.js";
import { KYBER_SLUG, callFirm, empty, jupiterHeaders, jupiterQuote, jupiterQuoteUrl, kyberBuildSchema, kyberRoutesUrl, kyberRouteQuote, kyberSchema, lifiHeaders, lifiQuote, lifiUrl, zeroExHeaders, zeroExQuote, zeroExUrl, type Reference } from "./shared.js";

export async function firmJupiter(config: AppConfig, hop: QuoteHop, slippageBps: number, reference: Reference | null, fetchImpl: typeof fetch): Promise<HopQuote> {
  const body = await callFirm(config, "jupiter", jupiterQuoteUrl(config, hop, slippageBps), { headers: jupiterHeaders(config) }, fetchImpl);
  if (!body) return empty();
  return jupiterQuote(config, body);
}

const jupiterSwapSchema = z.object({ swapTransaction: z.string().min(1), lastValidBlockHeight: z.number().int().optional() }).passthrough();

function jupiterFees(config: AppConfig): Record<string, unknown> {
  if (config.jitoUrl) return { jitoTipLamports: config.jitoTipLamports };
  return { priorityLevelWithMaxLamports: { maxLamports: config.solanaMaxPriorityLamports, priorityLevel: "veryHigh" } };
}

export async function jupiterSwap(
  config: AppConfig,
  quoteResponse: unknown,
  owner: string,
  fetchImpl: typeof fetch,
): Promise<{ swapTransaction: string; lastValidBlockHeight?: number } | null> {
  const body = await callFirm(
    config,
    "jupiter",
    `${config.jupiterBase}/swap`,
    {
      method: "POST",
      headers: jupiterHeaders(config, true),
      body: JSON.stringify({
        quoteResponse,
        userPublicKey: owner,
        wrapAndUnwrapSol: true,
        dynamicComputeUnitLimit: true,
        prioritizationFeeLamports: jupiterFees(config),
      }),
    },
    fetchImpl,
  );
  const parsed = jupiterSwapSchema.safeParse(body);
  return parsed.success ? parsed.data : null;
}

export async function firmZeroEx(
  config: AppConfig,
  hop: QuoteHop,
  chainId: number,
  taker: string,
  reference: Reference | null,
  fetchImpl: typeof fetch,
  slippageBps = config.maxSlippageBps,
): Promise<HopQuote> {
  if (!config.keys.zeroEx) return empty();
  const body = await callFirm(config, "zeroex", zeroExUrl(config, hop, chainId, taker, slippageBps), { headers: zeroExHeaders(config) }, fetchImpl);
  if (!body) return empty();
  return zeroExQuote(body, reference);
}

export async function firmLifi(
  config: AppConfig,
  hop: QuoteHop,
  chainId: number,
  taker: string,
  reference: Reference | null,
  fetchImpl: typeof fetch,
  slippageBps = config.maxSlippageBps,
): Promise<HopQuote> {
  const body = await callFirm(config, "lifi", lifiUrl(config, hop, chainId, taker, slippageBps), { headers: lifiHeaders(config) }, fetchImpl);
  if (!body) return empty();
  return lifiQuote(config, body, reference, chainId);
}

export async function firmKyber(
  config: AppConfig,
  hop: QuoteHop,
  chainId: number,
  sender: string,
  reference: Reference | null,
  fetchImpl: typeof fetch,
  slippageBps = config.maxSlippageBps,
): Promise<HopQuote> {
  const slug = KYBER_SLUG[chainId];
  if (!slug) return empty();
  const body = await callFirm(config, "kyberswap", kyberRoutesUrl(config, slug, hop), { headers: { "x-client-id": config.keys.kyberClientId } }, fetchImpl);
  if (!body) return empty();
  return kyberFromRoute(config, body, chainId, sender, reference, fetchImpl, slippageBps);
}

export async function kyberFromRoute(
  config: AppConfig,
  body: unknown,
  chainId: number,
  sender: string,
  reference: Reference | null,
  fetchImpl: typeof fetch,
  slippageBps: number,
): Promise<HopQuote> {
  const quote = kyberRouteQuote(body, reference);
  if (!quote) return empty();
  const parsed = kyberSchema.parse(body);
  const built = await buildKyberSwap(config, chainId, parsed.data.routeSummary, sender, fetchImpl, slippageBps);
  if (!built) return empty();
  return { ...quote, raw: { route: body, build: built }, prepared: { to: built.to, data: built.data, value: built.value } };
}

export async function buildKyberSwap(
  config: AppConfig,
  chainId: number,
  routeSummary: unknown,
  sender: string,
  fetchImpl: typeof fetch,
  slippageBps = config.maxSlippageBps,
): Promise<{ to: string; data: string; value: string; amountOut: string | null; slippageBps: number } | null> {
  const slug = KYBER_SLUG[chainId];
  if (!slug) return null;
  const body = await callFirm(
    config,
    "kyberswap",
    `${config.kyberBase}/${slug}/api/v1/route/build`,
    {
      method: "POST",
      headers: { "content-type": "application/json", "x-client-id": config.keys.kyberClientId },
      body: JSON.stringify({ routeSummary, sender, recipient: sender, slippageTolerance: slippageBps, source: config.keys.kyberClientId }),
    },
    fetchImpl,
  );
  const parsed = kyberBuildSchema.safeParse(body);
  if (!parsed.success) return null;
  const built = parsed.data.data;
  return { to: built.routerAddress, data: built.data, value: built.transactionValue ?? "0", amountOut: built.amountOut ?? null, slippageBps };
}
