import { z } from "zod";
import type { HyperliquidMarket, SwapIntent } from "./domain.js";
import { intentSchema } from "./schemas.js";
import { withTimeout } from "./timeout.js";
import { readVendorText, vendorResponse } from "./vendor-fetch.js";

export const perpOrderSchema = z
  .object({
    idempotencyKey: z.string().min(1).max(200),
    coin: z.string().regex(/^[A-Za-z0-9]{1,20}$/),
    side: z.enum(["buy", "sell"]),
    notionalUsd: z.number().positive(),
    slippageBps: z.number().int().nonnegative(),
    mode: z.enum(["dry_run", "live"]).default("dry_run"),
  })
  .strict();

export type PerpOrder = { kind: "perp" } & z.infer<typeof perpOrderSchema>;

const meta = z.object({ universe: z.array(z.object({ name: z.string(), maxLeverage: z.number().int().positive(), isDelisted: z.boolean().optional() }).loose()) }).loose();

export async function perpMarket(url: string, coin: string, fetchImpl: typeof fetch = fetch): Promise<HyperliquidMarket | null> {
  const body = await withTimeout(1500, async (signal) => {
    const response = await vendorResponse(fetchImpl, `${url.replace(/\/$/, "")}/info`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ type: "meta" }), signal });
    return response.ok ? meta.parse(JSON.parse(await readVendorText(response))) : null;
  });
  const assetIndex = body?.universe.findIndex((row) => row.name === coin && row.isDelisted !== true) ?? -1;
  const row = body?.universe[assetIndex];
  return row ? { coin, assetIndex, market: "perp", maxLeverage: row.maxLeverage } : null;
}

export function perpIntent(order: PerpOrder, market: HyperliquidMarket, now: number): SwapIntent {
  return intentSchema.parse({
    idempotencyKey: order.idempotencyKey,
    side: order.side,
    notionalUsd: order.notionalUsd,
    slippageBps: order.slippageBps,
    token: { symbol: order.coin, address: order.coin, decimals: null, chain: { kind: "hypercore", market: "perp" }, chainKey: "hypercore", pairMap: { pools: [], top: null } },
    holdings: [],
    hyperliquid: market,
    receivedAtMs: now,
  });
}
