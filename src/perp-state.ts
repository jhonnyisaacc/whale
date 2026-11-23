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

const orderFields = {
  coin: z.string().min(1),
  side: z.enum(["A", "B"]),
  limitPx: decimal,
  sz: decimal,
  oid: count,
  timestamp: count,
  origSz: decimal,
  reduceOnly: z.boolean(),
  tif: z.string().min(1).nullable(),
  cloid: z.string().min(1).nullable(),
  triggerPx: decimal,
};

const triggerOrderTypes = ["Stop Market", "Stop Limit", "Take Profit Market", "Take Profit Limit", "Trailing Stop Market"] as const;

const restingLimit = { ...orderFields, isTrigger: z.literal(false), isPositionTpsl: z.literal(false) };

const orderWithoutChildren = z.discriminatedUnion("isTrigger", [
  z.discriminatedUnion("triggerCondition", [
    z.object({ ...restingLimit, orderType: z.literal("Limit"), triggerCondition: z.literal("N/A") }),
    z.object({ ...restingLimit, orderType: z.enum(triggerOrderTypes), triggerCondition: z.literal("Triggered") }),
  ]),
  z.object({ ...orderFields, isTrigger: z.literal(true), orderType: z.enum(triggerOrderTypes), triggerCondition: z.string().min(1), isPositionTpsl: z.boolean() }),
]);

type FrontendOrder = z.infer<typeof orderWithoutChildren> & { children: FrontendOrder[] };

const frontendOrderSchema: z.ZodType<FrontendOrder> = orderWithoutChildren.and(z.object({ children: z.array(z.lazy(() => frontendOrderSchema)) }));

const frontendOpenOrdersSchema = z.array(z.unknown());

const orderLabel = z
  .object({ oid: count.nullable().catch(null), coin: z.string().min(1).nullable().catch(null), orderType: z.string().nullable().catch(null) })
  .catch({ oid: null, coin: null, orderType: null });

function shapeIssue(error: z.ZodError): string {
  const issue = error.issues[0];
  return `${issue?.path.join(".") || "the root"}: ${issue?.message ?? "invalid"}`;
}

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

type Sized = { size: string; originalSize: string };

export type PerpOrder = {
  oid: number;
  coin: string;
  side: "buy" | "sell";
  limitPx: string;
  reduceOnly: boolean;
  clientOrderId: string | null;
  placedAtMs: number;
  attached: PerpOrder[];
} & (
  | ({ kind: "limit"; timeInForce: string | null } & Sized)
  | ({ kind: "trigger"; orderType: (typeof triggerOrderTypes)[number]; isMarket: boolean; triggerPx: string; triggerCondition: string } & (
      | { isPositionTpsl: true; size: "entire position" }
      | ({ isPositionTpsl: false } & Sized)
    ))
);

function perpOrder(order: FrontendOrder): PerpOrder {
  const common = {
    oid: order.oid,
    coin: order.coin,
    side: order.side === "B" ? ("buy" as const) : ("sell" as const),
    limitPx: order.limitPx,
    reduceOnly: order.reduceOnly,
    clientOrderId: order.cloid,
    placedAtMs: order.timestamp,
    attached: order.children.map(perpOrder),
  };
  const sized = { size: order.sz, originalSize: order.origSz };
  if (!order.isTrigger) return { kind: "limit", ...common, timeInForce: order.tif, ...sized };
  const trigger = {
    kind: "trigger" as const,
    ...common,
    orderType: order.orderType,
    isMarket: order.orderType.endsWith(" Market"),
    triggerPx: order.triggerPx,
    triggerCondition: order.triggerCondition,
  };
  return order.isPositionTpsl ? { ...trigger, isPositionTpsl: true, size: "entire position" } : { ...trigger, isPositionTpsl: false, ...sized };
}

export type UnreadableOrder = { oid: number | null; coin: string | null; orderType: string | null; reason: string };

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
  unreadableOrders: UnreadableOrder[];
};

export function perpAccount(
  account: string,
  state: z.infer<typeof clearinghouseStateSchema>,
  orders: z.infer<typeof frontendOpenOrdersSchema>,
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
    ...perpOrders(orders, (coin) => markets.has(coin)),
  };
}

function perpOrders(rows: unknown[], isPerp: (coin: string) => boolean): Pick<PerpAccount, "openOrders" | "unreadableOrders"> {
  const openOrders: PerpOrder[] = [];
  const unreadableOrders: UnreadableOrder[] = [];
  for (const row of rows) {
    const label = orderLabel.parse(row);
    if (label.coin !== null && !isPerp(label.coin)) continue;
    const parsed = frontendOrderSchema.safeParse(row);
    if (parsed.success) openOrders.push(perpOrder(parsed.data));
    else unreadableOrders.push({ ...label, reason: `unknown order shape at ${shapeIssue(parsed.error)}` });
  }
  return { openOrders, unreadableOrders };
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
  if (!parsed.success) throw new Error(`hyperliquid info ${body.type} has an unknown shape at ${shapeIssue(parsed.error)}`);
  return parsed.data;
}

export async function readPerpAccount(url: string, account: string, fetchImpl: typeof fetch = fetch): Promise<PerpAccount> {
  if (!/^0x[0-9a-fA-F]{40}$/.test(account)) throw new Error("the hyperliquid account is not an evm address");
  const user = account.toLowerCase();
  const [state, orders, markets] = await Promise.all([
    postInfo(url, { type: "clearinghouseState", user }, clearinghouseStateSchema, fetchImpl),
    postInfo(url, { type: "frontendOpenOrders", user }, frontendOpenOrdersSchema, fetchImpl),
    postInfo(url, { type: "metaAndAssetCtxs" }, metaAndAssetCtxsSchema, fetchImpl),
  ]);
  return perpAccount(user, state, orders, markets);
}
