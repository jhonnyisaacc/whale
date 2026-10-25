import { z } from "zod";
import { withTimeout } from "./timeout.js";
import { holdingFitsChain } from "./balances.js";
import { addressKey, chainByKey } from "./chains.js";
import type { AppConfig } from "./config.js";
import type { Holding } from "./domain.js";
import { readVendorText, vendorResponse } from "./vendor-fetch.js";

const PLATFORM_TO_CHAIN: Record<string, string> = {
  ethereum: "ethereum",
  "optimistic-ethereum": "optimism",
  "binance-smart-chain": "bnb",
  "polygon-pos": "polygon",
  zksync: "zksync",
  base: "base",
  "arbitrum-one": "arbitrum",
  linea: "linea",
  blast: "blast",
  scroll: "scroll",
  solana: "solana",
};

function coingeckoPlatform(chainKey: string): string | null {
  const found = Object.entries(PLATFORM_TO_CHAIN).find(([, key]) => key === chainKey);
  return found?.[0] ?? null;
}

export type PriceOf = (holding: Holding) => number | null;

const NATIVE_COINGECKO_ID: Record<string, string> = {
  ETH: "ethereum",
  SOL: "solana",
  BNB: "binancecoin",
  POL: "polygon-ecosystem-token",
  HYPE: "hyperliquid",
  MON: "monad",
};

const priceSchema = z.record(z.string(), z.object({ usd: z.number() }).passthrough());

export function priceKey(holding: Holding): string | null {
  if (!holding.chainKey) return null;
  const spec = chainByKey(holding.chainKey);
  if (!spec) return null;
  if (holding.native) return `native:${spec.nativeSymbol.toUpperCase()}`;
  return `${holding.chainKey}:${addressKey(holding.chainKey, holding.address)}`;
}

export function createPriceCache(load: () => Promise<ReadonlyMap<string, number>>, maxAgeMs: number, now: () => number = Date.now) {
  const rows = new Map<string, { usd: number; atMs: number }>();
  let refreshing = false;
  return {
    async refresh(): Promise<void> {
      if (refreshing) return;
      refreshing = true;
      try {
        const prices = await load();
        const atMs = now();
        for (const [key, usd] of prices) {
          if (Number.isFinite(usd) && usd > 0) rows.set(key, { usd, atMs });
        }
      } finally {
        refreshing = false;
      }
    },
    priceOf(holding: Holding): number | null {
      const key = priceKey(holding);
      const row = key === null ? undefined : rows.get(key);
      if (!row || now() - row.atMs > maxAgeMs) return null;
      return row.usd;
    },
  };
}

export function pricedHoldings(holdings: readonly Holding[], chainKeys: Iterable<string>): Holding[] {
  const out = new Map<string, Holding>();
  for (const chainKey of chainKeys) {
    for (const holding of holdings) {
      if (holding.chainKey && holding.chainKey !== chainKey) continue;
      if (!holdingFitsChain(holding, chainKey)) continue;
      const scoped = { ...holding, chainKey };
      const key = priceKey(scoped);
      if (key !== null && !out.has(key)) out.set(key, scoped);
    }
  }
  return [...out.values()];
}

export function coingeckoLoader(config: AppConfig, holdings: readonly Holding[], fetchImpl: typeof fetch = fetch): () => Promise<Map<string, number>> {
  const headers: Record<string, string> = config.keys.coingecko ? { "x-cg-demo-api-key": config.keys.coingecko } : {};
  const base = config.coingeckoBase.replace(/\/$/, "");
  const getPrices = async (url: string) => {
    const body = await withTimeout(config.priceTimeoutMs, async (signal) => {
      const response = await vendorResponse(fetchImpl, url, { headers, signal });
      if (!response.ok) throw new Error(`price lookup failed ${response.status}`);
      return JSON.parse(await readVendorText(response)) as unknown;
    });
    return priceSchema.parse(body);
  };
  return async () => {
    const prices = new Map<string, number>();
    const natives = new Map<string, string>();
    const tokens: { key: string; platform: string; address: string }[] = [];
    for (const holding of holdings) {
      const key = priceKey(holding);
      if (key === null || !holding.chainKey) continue;
      if (holding.native) {
        const id = NATIVE_COINGECKO_ID[chainByKey(holding.chainKey)?.nativeSymbol.toUpperCase() ?? ""];
        if (id) natives.set(id, key);
        continue;
      }
      const platform = coingeckoPlatform(holding.chainKey);
      if (platform) tokens.push({ key, platform, address: holding.address });
    }
    const requests: Promise<void>[] = [];
    if (natives.size > 0) {
      requests.push(
        getPrices(`${base}/simple/price?ids=${[...natives.keys()].map(encodeURIComponent).join(",")}&vs_currencies=usd`).then((body) => {
          for (const [id, key] of natives) {
            const usd = body[id]?.usd;
            if (usd !== undefined) prices.set(key, usd);
          }
        }),
      );
    }
    for (const token of tokens) {
      requests.push(
        getPrices(`${base}/simple/token_price/${token.platform}?contract_addresses=${encodeURIComponent(token.address)}&vs_currencies=usd`).then((body) => {
          const usd = (body[token.address] ?? body[token.address.toLowerCase()])?.usd;
          if (usd !== undefined) prices.set(token.key, usd);
        }),
      );
    }
    const settled = await Promise.allSettled(requests);
    const failed = settled.filter((item) => item.status === "rejected").length;
    if (failed === settled.length && failed > 0) throw new Error("every price lookup failed");
    return prices;
  };
}
