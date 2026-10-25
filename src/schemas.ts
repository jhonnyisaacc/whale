import { z } from "zod";
import { nativeHoldingError } from "./balances.js";
import { chainByKey } from "./chains.js";

export const chainSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("solana") }),
  z.object({ kind: z.literal("evm"), chainId: z.number().int().positive() }),
  z.object({ kind: z.literal("hypercore"), market: z.enum(["perp", "spot"]) }),
]);

const poolSchema = z
  .object({
    poolAddress: z.string(),
    dex: z.string(),
    chainKey: z.string(),
    baseSymbol: z.string(),
    baseAddress: z.string(),
    quoteSymbol: z.string(),
    quoteAddress: z.string(),
    liquidityUsd: z.number(),
    priceUsd: z.number().nullable(),
    baseDecimals: z.number().nullable(),
  })
  .passthrough();

const pairMapSchema = z.object({
  pools: z.array(poolSchema),
  top: poolSchema.nullable(),
});

const hyperliquidSchema = z.object({
  coin: z.string(),
  assetIndex: z.number().int(),
  market: z.enum(["perp", "spot"]),
  maxLeverage: z.number(),
});

const intentTokenSchema = z.object({
  symbol: z.string().min(1),
  address: z.string().min(1),
  decimals: z.number().int().nullable(),
  chain: chainSchema,
  chainKey: z.string().min(1),
  pairMap: pairMapSchema,
});

const holdingSchema = z.object({
  symbol: z.string(),
  address: z.string(),
  amount: z.number(),
  usd: z.number(),
  native: z.boolean(),
  decimals: z.number().int().optional(),
  chainKey: z
    .string()
    .min(1)
    .optional()
    .refine((value) => value === undefined || chainByKey(value) !== undefined, { message: "unknown chain" }),
}).superRefine((holding, ctx) => {
  const message = nativeHoldingError(holding);
  if (message) ctx.addIssue({ code: z.ZodIssueCode.custom, message });
});

export const intentSchema = z.object({
  idempotencyKey: z.string().min(1).max(200),
  side: z.enum(["buy", "sell"]),
  notionalUsd: z.number().positive(),
  slippageBps: z.number().int().nonnegative(),
  token: intentTokenSchema,
  holdings: z.array(holdingSchema).max(64),
  hyperliquid: hyperliquidSchema.nullable(),
  receivedAtMs: z.number(),
  alternates: z.array(intentTokenSchema).max(16).optional(),
});

export const alertSchema = z.object({
  id: z.string().min(1).max(200),
  ticker: z.string().min(1).max(32),
  projectName: z.string().min(1).max(200),
  source: z.string().min(1).max(80),
  publishedAt: z.string().min(1).max(40),
  receivedAt: z.string().min(1).max(40),
  chainHint: z.string().max(40).optional(),
});

export const withdrawSchema = z.object({
  idempotencyKey: z.string().min(1).max(80).optional(),
  to: z.string().min(1).max(128),
  chainKey: z.string().min(1).max(40).optional(),
  amount: z.number().positive().optional(),
  mint: z.string().min(1).max(128).optional(),
  decimals: z.number().int().nonnegative().max(18).optional(),
});

export const rebalanceSchema = z.object({
  quotes: z
    .array(
      z.object({
        provider: z.enum(["lifi", "across", "relay", "debridge"]),
        feeUsd: z.number(),
        amountInUsd: z.number(),
        destination: z.string().min(1).max(128),
      }),
    )
    .max(8),
  ownAddresses: z.array(z.string().min(1).max(128)).max(8),
  spentBridgeUsd: z.number().nonnegative().default(0),
});

export const tokenRecordSchema = z
  .object({
    id: z.string(),
    ticker: z.string(),
    names: z.array(z.string()),
    chainKey: z.string(),
    chain: chainSchema,
    contract: z.string(),
    decimals: z.number().nullable(),
    pairMap: pairMapSchema,
    hyperliquid: hyperliquidSchema.nullable(),
    refreshedAt: z.string(),
  })
  .passthrough();

export const resolutionSchema = z.object({
  kind: z.string(),
  token: tokenRecordSchema.optional(),
  alternates: z.array(tokenRecordSchema).optional(),
  detail: z.string().optional(),
});

export const holdingsSchema = z.array(holdingSchema).max(64);
