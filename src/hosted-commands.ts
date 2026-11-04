import { z } from "zod";
import { chainByKey } from "./chains.js";
import type { Asset, WalletCommand } from "./commands.js";

// The wire shape between the public gateway and the private executor. It carries no mode field: every hosted
// command converts to a dry-run until ADR 0003 opens hosted live.
const amount = z.string().regex(/^[1-9]\d{0,77}$/, "an amount is a positive integer in the token's smallest unit");
const address = z.string().min(32).max(64);
const chainKey = z.string().min(1).max(32).refine((key) => chainByKey(key) !== undefined, "unknown chain");
const idempotencyKey = z.string().min(8).max(128).regex(/^[A-Za-z0-9:_-]+$/);
const slippageBps = z.number().int().min(1).max(1_000);

export const hostedCommandSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("quote"), chainKey, sellToken: address, buyToken: address, sellAmount: amount, slippageBps, taker: address.nullable() }).strict(),
  z.object({ kind: z.literal("swap"), chainKey, sellToken: address, buyToken: address, sellAmount: amount, slippageBps, taker: address.nullable(), idempotencyKey }).strict(),
  z.object({ kind: z.literal("transfer"), chainKey, token: address, to: address, amount, idempotencyKey }).strict(),
  z.object({ kind: z.literal("balance"), chainKey, address }).strict(),
]);
export type HostedCommand = z.infer<typeof hostedCommandSchema>;

export const hostedRequestSchema = z.object({ walletId: z.uuid(), agentId: z.uuid(), command: hostedCommandSchema }).strict();
export type HostedRequest = z.infer<typeof hostedRequestSchema>;

function asset(key: string, tokenAddress: string): Asset {
  const spec = chainByKey(key);
  if (!spec) throw new Error(`unknown chain ${key}`);
  return { chain: spec.chain, chainKey: key, address: tokenAddress, symbol: "?", decimals: null };
}

export function walletCommandOf(command: HostedCommand): WalletCommand {
  if (command.kind === "quote" || command.kind === "swap") {
    return { kind: "quote", sell: asset(command.chainKey, command.sellToken), buy: asset(command.chainKey, command.buyToken), sellAmount: command.sellAmount, taker: command.taker, slippageBps: command.slippageBps };
  }
  if (command.kind === "transfer") {
    return { kind: "transfer", idempotencyKey: command.idempotencyKey, asset: asset(command.chainKey, command.token), to: command.to, amount: command.amount, mode: "dry_run" };
  }
  return { kind: "balance", chainKey: command.chainKey, address: command.address };
}
