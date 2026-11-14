import { PublicKey, VersionedTransaction } from "@solana/web3.js";
import { z } from "zod";
import { associatedTokenAddress, JUPITER_PROGRAM_ID } from "../signing-policy.js";

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

const ROUTE = "e517cb977ae3ad2a";
const SHARED_ROUTE = "c1209b3341d69c81";

export type JupiterExpectation = {
  owner: string;
  sellToken: string;
  buyToken: string;
  sellAmount: string;
  minOut: bigint;
  quote: unknown;
};

function discriminator(data: Uint8Array): string {
  return Buffer.from(data.subarray(0, 8)).toString("hex");
}

export function assertJupiterTransaction(tx: VersionedTransaction, expected: JupiterExpectation): void {
  const quote = quoteSchema.parse(expected.quote);
  if (quote.inputMint !== expected.sellToken || quote.outputMint !== expected.buyToken || quote.inAmount !== expected.sellAmount) {
    throw new Error("jupiter quote does not match the leg");
  }
  const threshold = BigInt(quote.otherAmountThreshold);
  if (threshold < expected.minOut) throw new Error("jupiter quote minimum is below the leg minimum");
  const routes = tx.message.compiledInstructions.filter((ix) => tx.message.staticAccountKeys[ix.programIdIndex]?.toBase58() === JUPITER_PROGRAM_ID);
  if (routes.length !== 1) throw new Error("jupiter swap must contain exactly one route instruction");
  const ix = routes[0] as (typeof routes)[number];
  const kind = discriminator(ix.data);
  if (kind !== ROUTE && kind !== SHARED_ROUTE) throw new Error("jupiter token-ledger and opaque routes are not accepted");
  const layout = kind === ROUTE ? { source: 2, sourceMint: null, destinationMint: 5, tokenProgram: 0 } : { source: 3, sourceMint: 7, destinationMint: 8, tokenProgram: 0 };
  const account = (index: number): string => {
    const key = tx.message.staticAccountKeys[ix.accountKeyIndexes[index] ?? -1];
    if (!key) throw new Error("jupiter route uses an unreadable account");
    return key.toBase58();
  };
  if (account(layout.destinationMint) !== expected.buyToken) throw new Error("jupiter transaction buys a different mint");
  if (layout.sourceMint !== null && account(layout.sourceMint) !== expected.sellToken) throw new Error("jupiter transaction sells a different mint");
  const tokenProgram = account(layout.tokenProgram);
  const sourceAta = associatedTokenAddress(expected.owner, expected.sellToken, tokenProgram);
  if (account(layout.source) !== sourceAta) throw new Error("jupiter source is not the wallet's token account for the sold mint");
  const data = Buffer.from(ix.data);
  if (data.length < 27) throw new Error("jupiter route arguments are truncated");
  const inAmount = data.readBigUInt64LE(data.length - 19);
  const quotedOut = data.readBigUInt64LE(data.length - 11);
  const slippageBps = data.readUInt16LE(data.length - 3);
  const platformFeeBps = data[data.length - 1] as number;
  if (inAmount !== BigInt(expected.sellAmount) || inAmount !== BigInt(quote.inAmount)) throw new Error("jupiter transaction input differs from the authorized amount");
  if (quotedOut !== BigInt(quote.outAmount)) throw new Error("jupiter transaction output differs from the quote");
  if (slippageBps !== quote.slippageBps || slippageBps > 10_000) throw new Error("jupiter transaction slippage differs from the quote");
  if (platformFeeBps !== 0) throw new Error("jupiter platform fee is not authorized");
  const minimum = (quotedOut * BigInt(10_000 - slippageBps)) / 10_000n;
  if (minimum < expected.minOut || minimum < threshold) throw new Error("jupiter transaction minimum is below the authorized minimum");
}
