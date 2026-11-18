import { addressKey, chainByKey } from "../chains.js";
import type { AppConfig } from "../config.js";
import { BRIDGE_PROVIDERS, type BridgeProvider, type BridgeQuote, type BridgeRoute } from "../rebalance.js";
import { withTimeout } from "../timeout.js";
import { acrossSchema, callProvider, lifiBridgeSchema, lifiHeaders, relayBridgeSchema } from "./shared.js";

export const ACROSS_BASE = "https://app.across.to/api";
export const RELAY_BASE = "https://api.relay.link";

type ChainIds = { from: number; to: number };
type Fetcher = (config: AppConfig, route: BridgeRoute, ids: ChainIds, fetchImpl: typeof fetch, signal: AbortSignal) => Promise<BridgeQuote | null>;
type Echo = { amountIn: string; recipient: string | null; amountOut: string; costsUsd: readonly string[] };

export type BridgeRouteEntry = { calls: true; solanaChainId: number | null; fetch: Fetcher } | { calls: false; reason: string };

export const BRIDGE_ROUTE_REGISTRY: Record<BridgeProvider, BridgeRouteEntry> = {
  lifi: { calls: true, solanaChainId: 1151111081099710, fetch: quoteLifi },
  across: { calls: true, solanaChainId: null, fetch: quoteAcross },
  relay: { calls: true, solanaChainId: 792703809, fetch: quoteRelay },
  debridge: {
    calls: false,
    reason: "deBridge charges a fixed fee in the source chain's native coin outside the quoted output. This path has no native price, so the fee would be understated.",
  },
};

function providerChainId(entry: { solanaChainId: number | null }, chainKey: string): number | null {
  const chain = chainByKey(chainKey)?.chain;
  if (chain?.kind === "evm") return chain.chainId;
  if (chain?.kind === "solana") return entry.solanaChainId;
  return null;
}

function quoteFrom(provider: BridgeProvider, route: BridgeRoute, echo: Echo): BridgeQuote | null {
  if (echo.amountIn !== route.amount || !/^\d{1,78}$/.test(echo.amountOut)) return null;
  const { chainKey, address } = route.destination;
  if (echo.recipient !== null && addressKey(chainKey, echo.recipient) !== addressKey(chainKey, address)) return null;
  const costs = echo.costsUsd.map(Number);
  if (costs.some((cost) => !Number.isFinite(cost) || cost < 0)) return null;
  const outUsd = Number(echo.amountOut) / 10 ** route.buy.decimals;
  const feeUsd = route.amountInUsd - outUsd + costs.reduce((sum, cost) => sum + cost, 0);
  return { provider, feeUsd: Math.round(feeUsd * 1e6) / 1e6, amountInUsd: route.amountInUsd, destination: route.destination };
}

async function quoteLifi(config: AppConfig, route: BridgeRoute, ids: ChainIds, fetchImpl: typeof fetch, signal: AbortSignal): Promise<BridgeQuote | null> {
  const url = new URL(`${config.lifiBase}/quote`);
  url.searchParams.set("fromChain", String(ids.from));
  url.searchParams.set("toChain", String(ids.to));
  url.searchParams.set("fromToken", route.sell.address);
  url.searchParams.set("toToken", route.buy.address);
  url.searchParams.set("fromAmount", route.amount);
  url.searchParams.set("fromAddress", route.source.address);
  url.searchParams.set("toAddress", route.destination.address);
  if (config.keys.lifiIntegrator) url.searchParams.set("integrator", config.keys.lifiIntegrator);
  const parsed = lifiBridgeSchema.safeParse(await callProvider(config, "lifi-bridge", url.toString(), { headers: lifiHeaders(config) }, fetchImpl, signal));
  if (!parsed.success) return null;
  const { action, estimate } = parsed.data;
  const separate = (estimate.feeCosts ?? []).filter((fee) => fee.included === false).map((fee) => fee.amountUSD);
  const gas = (estimate.gasCosts ?? []).map((cost) => cost.amountUSD);
  return quoteFrom("lifi", route, { amountIn: action.fromAmount, recipient: action.toAddress, amountOut: estimate.toAmount, costsUsd: [...separate, ...gas] });
}

async function quoteAcross(config: AppConfig, route: BridgeRoute, ids: ChainIds, fetchImpl: typeof fetch, signal: AbortSignal): Promise<BridgeQuote | null> {
  const url = new URL(`${ACROSS_BASE}/swap/approval`);
  url.searchParams.set("tradeType", "exactInput");
  url.searchParams.set("amount", route.amount);
  url.searchParams.set("inputToken", route.sell.address);
  url.searchParams.set("outputToken", route.buy.address);
  url.searchParams.set("originChainId", String(ids.from));
  url.searchParams.set("destinationChainId", String(ids.to));
  url.searchParams.set("depositor", route.source.address);
  url.searchParams.set("recipient", route.destination.address);
  if (config.keys.acrossIntegrator) url.searchParams.set("integratorId", config.keys.acrossIntegrator);
  const headers: Record<string, string> = config.keys.acrossKey ? { Authorization: `Bearer ${config.keys.acrossKey}` } : {};
  const parsed = acrossSchema.safeParse(await callProvider(config, "across-bridge", url.toString(), { headers }, fetchImpl, signal));
  if (!parsed.success) return null;
  const gas = parsed.data.fees.originGas ? [parsed.data.fees.originGas.amountUsd] : [];
  return quoteFrom("across", route, { amountIn: parsed.data.inputAmount, recipient: null, amountOut: parsed.data.expectedOutputAmount, costsUsd: gas });
}

async function quoteRelay(config: AppConfig, route: BridgeRoute, ids: ChainIds, fetchImpl: typeof fetch, signal: AbortSignal): Promise<BridgeQuote | null> {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (config.keys.relayKey) headers["x-api-key"] = config.keys.relayKey;
  const body = JSON.stringify({
    user: route.source.address,
    recipient: route.destination.address,
    originChainId: ids.from,
    destinationChainId: ids.to,
    originCurrency: route.sell.address,
    destinationCurrency: route.buy.address,
    amount: route.amount,
    tradeType: "EXACT_INPUT",
  });
  const parsed = relayBridgeSchema.safeParse(await callProvider(config, "relay-bridge", `${RELAY_BASE}/quote/v2`, { method: "POST", headers, body }, fetchImpl, signal));
  if (!parsed.success) return null;
  const { details, fees } = parsed.data;
  const gas = fees.gas ? [fees.gas.amountUsd] : [];
  return quoteFrom("relay", route, { amountIn: details.currencyIn.amount, recipient: details.recipient, amountOut: details.currencyOut.amount, costsUsd: gas });
}

function settled(signal: AbortSignal): Promise<null> {
  return new Promise((resolve) => {
    if (signal.aborted) resolve(null);
    signal.addEventListener("abort", () => resolve(null), { once: true });
  });
}

export async function fetchBridgeQuotes(config: AppConfig, route: BridgeRoute, fetchImpl: typeof fetch = fetch): Promise<BridgeQuote[]> {
  const quotes = await Promise.all(
    BRIDGE_PROVIDERS.map(async (provider) => {
      const entry = BRIDGE_ROUTE_REGISTRY[provider];
      if (!entry.calls) return null;
      const from = providerChainId(entry, route.source.chainKey);
      const to = providerChainId(entry, route.destination.chainKey);
      if (from === null || to === null) return null;
      return withTimeout(config.bridgeQuoteTimeoutMs, (signal) => Promise.race([entry.fetch(config, route, { from, to }, fetchImpl, signal), settled(signal)])).catch(() => null);
    }),
  );
  return quotes.filter((quote): quote is BridgeQuote => quote !== null);
}
