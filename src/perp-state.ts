import { z } from "zod";
import { withTimeout } from "./timeout.js";
import { readVendorText, vendorResponse } from "./vendor-fetch.js";

const decimal = z.string().regex(/^-?\d+(\.\d+)?$/);
const nonZero = decimal.refine((value) => /[1-9]/.test(value), "position size is zero");
const count = z.number().int().nonnegative();

const marginSummary = z.object({ accountValue: decimal, totalNtlPos: decimal, totalRawUsd: decimal, totalMarginUsed: decimal });

const leverage = z.discriminatedUnion("type", [
  z.object({ type: z.literal("cross"), value: z.number().int().positive() }),
  z.object({ type: z.literal("isolated"), value: z.number().int().positive(), rawUsd: decimal }),
]);

export const clearinghouseStateSchema = z.object({
  marginSummary,
  crossMarginSummary: marginSummary,
  crossMaintenanceMarginUsed: decimal,
  withdrawable: decimal,
  assetPositions: z.array(
    z.object({
      type: z.literal("oneWay"),
      position: z.object({
        coin: z.string().min(1),
        szi: nonZero,
        leverage,
        entryPx: decimal,
        positionValue: decimal,
        unrealizedPnl: decimal,
        returnOnEquity: decimal,
        liquidationPx: decimal.nullable(),
        marginUsed: decimal,
        maxLeverage: z.number().int().positive(),
        cumFunding: z.object({ allTime: decimal, sinceOpen: decimal, sinceChange: decimal }),
      }),
    }),
  ),
  time: count,
});

export const openOrdersSchema = z.array(
  z.object({
    coin: z.string().min(1),
    side: z.enum(["A", "B"]),
    limitPx: decimal,
    sz: decimal,
    oid: count,
    timestamp: count,
    origSz: decimal,
    reduceOnly: z.boolean().optional(),
  }),
);

export const metaAndAssetCtxsSchema = z
  .tuple([
    z.object({ universe: z.array(z.object({ name: z.string().min(1), szDecimals: count, maxLeverage: z.number().int().positive() })) }),
    z.array(z.object({ funding: decimal, markPx: decimal, oraclePx: decimal, openInterest: decimal })),
  ])
  .refine(([meta, ctxs]) => meta.universe.length === ctxs.length, "universe and asset contexts differ in length");

export type PerpPosition = {
  coin: string;
  side: "long" | "short";
  size: string;
  entryPx: string;
  markPx: string;
  oraclePx: string;
  liquidationPx: string | null;
  positionValueUsd: string;
  unrealizedPnlUsd: string;
  returnOnEquity: string;
  marginUsedUsd: string;
  leverage: { mode: "cross" | "isolated"; value: number; max: number };
  funding: { hourlyRate: string; paidSinceOpenUsd: string; paidSinceChangeUsd: string; paidAllTimeUsd: string };
};

export type PerpOrder = {
  oid: number;
  coin: string;
  side: "buy" | "sell";
  limitPx: string;
  size: string;
  originalSize: string;
  reduceOnly: boolean | null;
  placedAtMs: number;
};

export type PerpAccount = {
  account: string;
  asOfMs: number;
  margin: {
    accountValueUsd: string;
    totalNotionalUsd: string;
    marginUsedUsd: string;
    withdrawableUsd: string;
    crossAccountValueUsd: string;
    crossMarginUsedUsd: string;
    crossMaintenanceMarginUsedUsd: string;
  };
  positions: PerpPosition[];
  openOrders: PerpOrder[];
};

export function perpAccount(
  account: string,
  state: z.infer<typeof clearinghouseStateSchema>,
  orders: z.infer<typeof openOrdersSchema>,
  [meta, ctxs]: z.infer<typeof metaAndAssetCtxsSchema>,
): PerpAccount {
  const markets = new Map(meta.universe.map((asset, index) => [asset.name, ctxs[index]!]));
  return {
    account,
    asOfMs: state.time,
    margin: {
      accountValueUsd: state.marginSummary.accountValue,
      totalNotionalUsd: state.marginSummary.totalNtlPos,
      marginUsedUsd: state.marginSummary.totalMarginUsed,
      withdrawableUsd: state.withdrawable,
      crossAccountValueUsd: state.crossMarginSummary.accountValue,
      crossMarginUsedUsd: state.crossMarginSummary.totalMarginUsed,
      crossMaintenanceMarginUsedUsd: state.crossMaintenanceMarginUsed,
    },
    positions: state.assetPositions.map(({ position }) => {
      const market = markets.get(position.coin);
      if (!market) throw new Error(`hyperliquid has no market context for ${position.coin}`);
      const short = position.szi.startsWith("-");
      return {
        coin: position.coin,
        side: short ? "short" : "long",
        size: short ? position.szi.slice(1) : position.szi,
        entryPx: position.entryPx,
        markPx: market.markPx,
        oraclePx: market.oraclePx,
        liquidationPx: position.liquidationPx,
        positionValueUsd: position.positionValue,
        unrealizedPnlUsd: position.unrealizedPnl,
        returnOnEquity: position.returnOnEquity,
        marginUsedUsd: position.marginUsed,
        leverage: { mode: position.leverage.type, value: position.leverage.value, max: position.maxLeverage },
        funding: {
          hourlyRate: market.funding,
          paidSinceOpenUsd: position.cumFunding.sinceOpen,
          paidSinceChangeUsd: position.cumFunding.sinceChange,
          paidAllTimeUsd: position.cumFunding.allTime,
        },
      };
    }),
    openOrders: orders.map((order) => ({
      oid: order.oid,
      coin: order.coin,
      side: order.side === "B" ? "buy" : "sell",
      limitPx: order.limitPx,
      size: order.sz,
      originalSize: order.origSz,
      reduceOnly: order.reduceOnly ?? null,
      placedAtMs: order.timestamp,
    })),
  };
}

async function postInfo<T>(url: string, body: Record<string, string>, schema: z.ZodType<T>, fetchImpl: typeof fetch): Promise<T> {
  const raw = await withTimeout(5000, async (signal) => {
    const response = await vendorResponse(fetchImpl, `${url.replace(/\/$/, "")}/info`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
      signal,
    });
    if (!response.ok) throw new Error(`hyperliquid info ${body.type} returned ${response.status}`);
    return JSON.parse(await readVendorText(response)) as unknown;
  });
  const parsed = schema.safeParse(raw);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    throw new Error(`hyperliquid info ${body.type} has an unknown shape at ${issue?.path.join(".") || "the root"}: ${issue?.message ?? "invalid"}`);
  }
  return parsed.data;
}

export async function readPerpAccount(url: string, account: string, fetchImpl: typeof fetch = fetch): Promise<PerpAccount> {
  if (!/^0x[0-9a-fA-F]{40}$/.test(account)) throw new Error("the hyperliquid account is not an evm address");
  const user = account.toLowerCase();
  const [state, orders, markets] = await Promise.all([
    postInfo(url, { type: "clearinghouseState", user }, clearinghouseStateSchema, fetchImpl),
    postInfo(url, { type: "openOrders", user }, openOrdersSchema, fetchImpl),
    postInfo(url, { type: "metaAndAssetCtxs" }, metaAndAssetCtxsSchema, fetchImpl),
  ]);
  return perpAccount(user, state, orders, markets);
}
