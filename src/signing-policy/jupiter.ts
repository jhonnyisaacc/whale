import { VersionedTransaction } from "@solana/web3.js";
import { z } from "zod";
import { associatedTokenAddress, JUPITER_PROGRAM_ID, SHARED_ROUTE_SLOT as SLOT, TOKEN_2022_PROGRAM, TOKEN_PROGRAM } from "../signing-policy.js";
import { routeArguments } from "./jupiter-route-plan.js";

const quoteSchema = z
  .object({
    inputMint: z.string(),
    outputMint: z.string(),
    inAmount: z.string().regex(/^\d+$/),
    outAmount: z.string().regex(/^\d+$/),
    otherAmountThreshold: z.string().regex(/^\d+$/),
    slippageBps: z.number().int().min(0).max(10_000),
  })
  .loose();

const SHARED_ACCOUNTS_ROUTE = "c1209b3341d69c81";
const ARGUMENTS_AT = 9;

export type JupiterExpectation = {
  owner: string;
  sellToken: string;
  buyToken: string;
  sellAmount: string;
  minOut: bigint;
  quote: unknown;
};

export function assertJupiterTransaction(tx: VersionedTransaction, expected: JupiterExpectation): void {
  const quote = quoteSchema.parse(expected.quote);
  if (quote.inputMint !== expected.sellToken || quote.outputMint !== expected.buyToken || quote.inAmount !== expected.sellAmount) {
    throw new Error("jupiter quote does not match the leg");
  }
  const threshold = BigInt(quote.otherAmountThreshold);
  if (threshold < expected.minOut) throw new Error("jupiter quote minimum is below the leg minimum");
  const keys = tx.message.staticAccountKeys;
  const routes = tx.message.compiledInstructions.filter((ix) => keys[ix.programIdIndex]?.toBase58() === JUPITER_PROGRAM_ID);
  if (routes.length !== 1) throw new Error("jupiter swap must contain exactly one route instruction");
  const ix = routes[0] as (typeof routes)[number];
  if (Buffer.from(ix.data.subarray(0, 8)).toString("hex") !== SHARED_ACCOUNTS_ROUTE) throw new Error("jupiter route is not sharedAccountsRoute");
  const account = (position: number): string | null => keys[ix.accountKeyIndexes[position] ?? -1]?.toBase58() ?? null;
  if (account(SLOT.authority) !== expected.owner) throw new Error("jupiter transfer authority is not the wallet");
  if (ix.accountKeyIndexes.some((_, position) => position !== SLOT.authority && account(position) === expected.owner)) {
    throw new Error("jupiter passes the wallet to an account other than the transfer authority");
  }
  if (account(SLOT.platformFee) !== JUPITER_PROGRAM_ID) throw new Error("jupiter platform fee account is set");
  const destinationMint = account(SLOT.destinationMint);
  if (destinationMint !== null && destinationMint !== expected.buyToken) throw new Error("jupiter transaction buys a different mint");
  const sourceMint = account(SLOT.sourceMint);
  if (sourceMint !== null && sourceMint !== expected.sellToken) throw new Error("jupiter transaction sells a different mint");
  const source = account(SLOT.source);
  if (![TOKEN_PROGRAM, TOKEN_2022_PROGRAM].some((program) => source === associatedTokenAddress(expected.owner, expected.sellToken, program))) {
    throw new Error("jupiter source is not the wallet's token account for the sold mint");
  }
  if (account(SLOT.destination) !== associatedTokenAddress(expected.owner, expected.buyToken, TOKEN_PROGRAM)) {
    throw new Error("jupiter destination is not the wallet's token account for the bought mint");
  }
  const args = routeArguments(Buffer.from(ix.data), ARGUMENTS_AT);
  if (args.inAmount !== BigInt(expected.sellAmount)) throw new Error("jupiter transaction input differs from the authorized amount");
  if (args.quotedOut !== BigInt(quote.outAmount)) throw new Error("jupiter transaction output differs from the quote");
  if (args.slippageBps !== quote.slippageBps) throw new Error("jupiter transaction slippage differs from the quote");
  if (args.platformFeeBps !== 0) throw new Error("jupiter platform fee is not authorized");
  const minimum = (args.quotedOut * BigInt(10_000 - args.slippageBps) + 9_999n) / 10_000n;
  if (minimum < threshold) throw new Error("jupiter transaction minimum is below the authorized minimum");
}
