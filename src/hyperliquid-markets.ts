import { z } from "zod";
import { withTimeout } from "./timeout.js";
import { readVendorText, vendorResponse } from "./vendor-fetch.js";

export type HyperMarket = {
  coin: string;
  market: "perp" | "spot";
  assetIndex: number;
  szDecimals: number;
  maxLeverage: number;
  midKey: string;
};

const count = z.number().int().nonnegative();

export const perpMetaSchema = z
  .object({
    universe: z.array(z.object({ name: z.string(), szDecimals: count, maxLeverage: z.number().int().positive(), isDelisted: z.boolean().optional() }).loose()),
  })
  .loose();

export const spotMetaSchema = z
  .object({
    universe: z.array(z.object({ name: z.string(), index: count, tokens: z.tuple([count, count]) }).loose()),
    tokens: z.array(z.object({ name: z.string(), index: count, szDecimals: count }).loose()),
  })
  .loose();

export type PerpMeta = z.infer<typeof perpMetaSchema>;
export type SpotMeta = z.infer<typeof spotMetaSchema>;

const SPOT_ASSET_OFFSET = 10_000;

export function perpMarket(meta: PerpMeta, coin: string): HyperMarket | null {
  const assetIndex = meta.universe.findIndex((row) => row.name === coin);
  const row = meta.universe[assetIndex];
  if (!row || row.isDelisted === true) return null;
  return { coin, market: "perp", assetIndex, szDecimals: row.szDecimals, maxLeverage: row.maxLeverage, midKey: coin };
}

export function spotMarket(meta: SpotMeta, coin: string): HyperMarket | null {
  const usdc = meta.tokens.find((token) => token.name === "USDC");
  const base = meta.tokens.find((token) => token.name === coin);
  if (!usdc || !base) return null;
  const pair = meta.universe.find((row) => row.tokens[0] === base.index && row.tokens[1] === usdc.index);
  if (!pair) return null;
  return { coin, market: "spot", assetIndex: SPOT_ASSET_OFFSET + pair.index, szDecimals: base.szDecimals, maxLeverage: 1, midKey: pair.name };
}

const META_TTL_MS = 300_000;

function cachedMeta<T>(type: "meta" | "spotMeta", schema: z.ZodType<T>) {
  const cache = new Map<string, { atMs: number; meta: T }>();
  return {
    clear: () => cache.clear(),
    async read(url: string, fetchImpl: typeof fetch, nowMs: number): Promise<T> {
      const cached = cache.get(url);
      if (cached && nowMs - cached.atMs < META_TTL_MS) return cached.meta;
      const text = await withTimeout(1500, async (signal) => {
        const response = await vendorResponse(fetchImpl, `${url.replace(/\/$/, "")}/info`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ type }),
          signal,
        });
        if (!response.ok) throw new Error(`hyperliquid ${type} returned ${response.status}`);
        return readVendorText(response);
      });
      const meta = schema.parse(JSON.parse(text));
      cache.set(url, { atMs: nowMs, meta });
      return meta;
    },
  };
}

const perpMeta = cachedMeta("meta", perpMetaSchema);
const spotMeta = cachedMeta("spotMeta", spotMetaSchema);

export function resetHyperMeta(): void {
  perpMeta.clear();
  spotMeta.clear();
}

export async function fetchHyperMarket(url: string, query: { coin: string; market: "perp" | "spot" }, fetchImpl: typeof fetch = fetch, nowMs = Date.now()): Promise<HyperMarket | null> {
  if (query.market === "spot") return spotMarket(await spotMeta.read(url, fetchImpl, nowMs), query.coin);
  return perpMarket(await perpMeta.read(url, fetchImpl, nowMs), query.coin);
}
