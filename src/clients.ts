import { z } from "zod";
import type { AppConfig } from "./config.js";
import type { HopQuote } from "./executor.js";
import { firmZeroEx as firmZeroExQuote, raceProviderQuotes } from "./aggregators.js";
import { validSellAmount, type QuoteHop } from "./quote-hop.js";
import { readVendorText, vendorResponse } from "./vendor-fetch.js";

export { validSellAmount, type QuoteHop };

export async function quoteHop(
  config: AppConfig,
  hop: QuoteHop,
  reference: { spentUsd: number; priceUsd: number; decimals: number } | null,
  fetchImpl: typeof fetch = fetch,
): Promise<HopQuote> {
  return raceProviderQuotes(config, hop, reference, fetchImpl);
}

export async function firmZeroEx(
  config: AppConfig,
  hop: QuoteHop,
  chainId: number,
  taker: string,
  reference: { spentUsd: number; priceUsd: number; decimals: number } | null,
  fetchImpl: typeof fetch,
): Promise<HopQuote> {
  return firmZeroExQuote(config, hop, chainId, taker, reference, fetchImpl);
}

export async function fetchHyperliquidMid(url: string, coin: string, fetchImpl: typeof fetch = fetch): Promise<number | null> {
  const response = await vendorResponse(fetchImpl, `${url.replace(/\/$/, "")}/info`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ type: "allMids" }),
  });
  if (!response.ok) return null;
  const parsed = z.record(z.string(), z.string()).safeParse(JSON.parse(await readVendorText(response)));
  if (!parsed.success) return null;
  const value = Number(parsed.data[coin]);
  return Number.isFinite(value) && value > 0 ? value : null;
}
