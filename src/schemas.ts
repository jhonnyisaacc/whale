import { z } from "zod";
import { nativeHoldingError } from "./balances.js";
import { CHAINS, chainByKey } from "./chains.js";

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
  .loose();

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

const intentTokenSchema = z
  .object({
    symbol: z.string().min(1),
    address: z.string().min(1),
    decimals: z.number().int().nullable(),
    chain: chainSchema,
    chainKey: z.string().min(1),
    pairMap: pairMapSchema,
  })
  .superRefine((token, ctx) => {
    const expected = chainByKey(token.chainKey)?.chain;
    if (!expected) {
      ctx.addIssue({ code: "custom", message: "unknown chain" });
      return;
    }
    const matches =
      expected.kind === "evm" && token.chain.kind === "evm"
        ? expected.chainId === token.chain.chainId
        : expected.kind === "hypercore" && token.chain.kind === "hypercore"
          ? expected.market === token.chain.market
          : expected.kind === "solana" && token.chain.kind === "solana";
    if (!matches) ctx.addIssue({ code: "custom", message: "chainKey does not match chain" });
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
  if (message) ctx.addIssue({ code: "custom", message });
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

export const withdrawSchema = z.object({
  idempotencyKey: z.string().min(1).max(80).optional(),
  to: z.string().min(1).max(128),
  chainKey: z.string().min(1).max(40).optional(),
  amount: z.number().positive().optional(),
  mint: z.string().min(1).max(128).optional(),
  decimals: z.number().int().nonnegative().max(18).optional(),
});

const chainAddressSchema = z.object({
  chainKey: z
    .string()
    .min(1)
    .max(40)
    .refine((value) => chainByKey(value) !== undefined, { message: "unknown chain" }),
  address: z.string().min(1).max(128),
});

export const rebalanceSchema = z.object({
  quotes: z
    .array(
      z.object({
        provider: z.enum(["lifi", "across", "relay", "debridge"]),
        feeUsd: z.number(),
        amountInUsd: z.number(),
        destination: chainAddressSchema,
      }),
    )
    .max(8),
  ownAddresses: z.array(chainAddressSchema).max(8),
  spentBridgeUsd: z.number().nonnegative().default(0),
});

export const SMALLEST_UNIT = /^[1-9]\d{0,77}$/;

export const bridgeRequestSchema = z.strictObject({
  fromChainKey: z.enum(CHAINS.map((chain) => chain.key)),
  destination: z.strictObject({ chainKey: z.enum(CHAINS.map((chain) => chain.key)), address: z.string().min(1).max(128) }),
  asset: z.string().min(1).max(16),
  amount: z.string().regex(SMALLEST_UNIT),
});

export const holdingsSchema = z.array(holdingSchema).max(64);
