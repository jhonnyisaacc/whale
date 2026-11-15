import { VersionedTransaction } from "@solana/web3.js";
import { z } from "zod";
import { associatedTokenAddress, JUPITER_PROGRAM_ID } from "../signing-policy.js";
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

const TOKEN_PROGRAMS = ["TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA", "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb"] as const;

type RouteLayout = { argumentsAt: number; source: number; destination: number; optionalDestination: number | null; sourceMint: number | null; destinationMint: number };

const LAYOUTS: Readonly<Record<string, RouteLayout>> = {
  e517cb977ae3ad2a: { argumentsAt: 8, source: 2, destination: 3, optionalDestination: 4, sourceMint: null, destinationMint: 5 },
  c1209b3341d69c81: { argumentsAt: 9, source: 3, destination: 6, optionalDestination: null, sourceMint: 7, destinationMint: 8 },
};

export type JupiterExpectation = {
  owner: string;
  sellToken: string;
  buyToken: string;
  sellAmount: string;
  minOut: bigint;
  quote: unknown;
};

function ownerTokenAccount(owner: string, mint: string, account: string | null): boolean {
  return account !== null && TOKEN_PROGRAMS.some((program) => associatedTokenAddress(owner, mint, program) === account);
}

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
  const layout = LAYOUTS[Buffer.from(ix.data.subarray(0, 8)).toString("hex")];
  if (!layout) throw new Error("jupiter token-ledger and opaque routes are not accepted");
  const account = (position: number): string | null => keys[ix.accountKeyIndexes[position] ?? -1]?.toBase58() ?? null;
  const destinationMint = account(layout.destinationMint);
  if (destinationMint !== null && destinationMint !== expected.buyToken) throw new Error("jupiter transaction buys a different mint");
  const sourceMint = layout.sourceMint === null ? null : account(layout.sourceMint);
  if (sourceMint !== null && sourceMint !== expected.sellToken) throw new Error("jupiter transaction sells a different mint");
  if (!ownerTokenAccount(expected.owner, expected.sellToken, account(layout.source))) throw new Error("jupiter source is not the wallet's token account for the sold mint");
  if (!ownerTokenAccount(expected.owner, expected.buyToken, account(layout.destination))) {
    throw new Error("jupiter destination is not the wallet's token account for the bought mint");
  }
  if (layout.optionalDestination !== null) {
    const optional = account(layout.optionalDestination);
    if (optional !== JUPITER_PROGRAM_ID && optional !== account(layout.destination)) throw new Error("jupiter output goes to a different token account");
  }
  const args = routeArguments(Buffer.from(ix.data), layout.argumentsAt);
  if (args.inAmount !== BigInt(expected.sellAmount)) throw new Error("jupiter transaction input differs from the authorized amount");
  if (args.quotedOut !== BigInt(quote.outAmount)) throw new Error("jupiter transaction output differs from the quote");
  if (args.slippageBps !== quote.slippageBps) throw new Error("jupiter transaction slippage differs from the quote");
  if (args.platformFeeBps !== 0) throw new Error("jupiter platform fee is not authorized");
  const minimum = (args.quotedOut * BigInt(10_000 - args.slippageBps) + 9_999n) / 10_000n;
  if (minimum < threshold) throw new Error("jupiter transaction minimum is below the authorized minimum");
}
