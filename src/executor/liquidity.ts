import { z } from "zod";
import { addressKey, dexscreenerSlugMap, quoteAssetOf, type QuoteAssets } from "../chains.js";
import type { AppConfig } from "../config.js";
import type { SwapIntent } from "../domain.js";
import type { ExecutorDeps } from "../executor.js";
import type { Liquidity } from "../limits.js";
import { withTimeout } from "../timeout.js";
import { readVendorText, vendorResponse } from "../vendor-fetch.js";

export type LiquidityOf = (token: { chainKey: string; address: string }) => Promise<number | null>;

type LiquidityConfig = Pick<AppConfig, "dexscreenerBase" | "dexscreenerSlugOverrides" | "quoteAssets" | "priceTimeoutMs">;

const pairsSchema = z.array(
  z
    .object({
      chainId: z.string(),
      baseToken: z.object({ address: z.string() }).loose(),
      quoteToken: z.object({ address: z.string() }).loose(),
      liquidity: z.object({ usd: z.number().optional() }).loose().optional(),
    })
    .loose(),
);

type Pair = z.infer<typeof pairsSchema>[number];

export function deepestQuotedPoolUsd(pairs: readonly Pair[], chainKey: string, slug: string, address: string, quoteAssets: QuoteAssets): number {
  const token = addressKey(chainKey, address);
  let deepest = 0;
  for (const pair of pairs) {
    if (pair.chainId !== slug) continue;
    const base = addressKey(chainKey, pair.baseToken.address);
    const quote = addressKey(chainKey, pair.quoteToken.address);
    const other = base === token ? pair.quoteToken.address : quote === token ? pair.baseToken.address : null;
    if (other === null || !quoteAssetOf(quoteAssets, chainKey, other)) continue;
    const usd = pair.liquidity?.usd;
    if (usd !== undefined && Number.isFinite(usd) && usd > deepest) deepest = usd;
  }
  return deepest;
}

export function dexscreenerLiquidity(config: LiquidityConfig, fetchImpl: typeof fetch = fetch): LiquidityOf {
  const slugs = new Map<string, string>();
  for (const [slug, chainKey] of dexscreenerSlugMap(config.dexscreenerSlugOverrides)) slugs.set(chainKey, slug);
  const base = config.dexscreenerBase.replace(/\/$/, "");
  return async ({ chainKey, address }) => {
    const slug = slugs.get(chainKey);
    if (!slug) return null;
    try {
      const pairs = await withTimeout(config.priceTimeoutMs, async (signal) => {
        const url = `${base}/token-pairs/v1/${encodeURIComponent(slug)}/${encodeURIComponent(address)}`;
        const response = await vendorResponse(fetchImpl, url, { signal });
        if (!response.ok) throw new Error(`liquidity lookup failed ${response.status}`);
        return pairsSchema.parse(JSON.parse(await readVendorText(response)));
      });
      return deepestQuotedPoolUsd(pairs, chainKey, slug, address, config.quoteAssets);
    } catch {
      return null;
    }
  };
}

function tokenId(token: SwapIntent["token"]): string {
  return `${token.chainKey}:${addressKey(token.chainKey, token.address)}`;
}

export async function liquidityLookup(intent: SwapIntent, deps: Pick<ExecutorDeps, "mode" | "config" | "liquidityOf">): Promise<(token: SwapIntent["token"]) => Liquidity> {
  if (deps.mode !== "live") return (token) => ({ source: "caller", usd: token.pairMap.top?.liquidityUsd ?? null });
  const tokens = new Map([intent.token, ...(intent.alternates ?? [])].filter((token) => deps.config.enabledChainKeys.has(token.chainKey)).map((token) => [tokenId(token), token]));
  const found = new Map<string, number | null>();
  await Promise.all(
    [...tokens.values()].map(async (token) => {
      const usd = deps.liquidityOf ? await deps.liquidityOf({ chainKey: token.chainKey, address: token.address }).catch(() => null) : null;
      found.set(tokenId(token), usd);
    }),
  );
  return (token) => ({ source: "whale", usd: found.get(tokenId(token)) ?? null });
}
