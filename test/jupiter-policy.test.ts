import assert from "node:assert/strict";
import test from "node:test";
import { Keypair, PublicKey, TransactionInstruction, TransactionMessage, VersionedTransaction } from "@solana/web3.js";
import { associatedTokenAddress, JUPITER_PROGRAM_ID } from "../src/signing-policy.js";
import { assertJupiterTransaction, type JupiterExpectation } from "../src/signing-policy/jupiter.js";

const JUP = new PublicKey(JUPITER_PROGRAM_ID);
const TOKEN = new PublicKey("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA");
const ROUTE = Buffer.from("e517cb977ae3ad2a", "hex");
const SHARED_ROUTE = Buffer.from("c1209b3341d69c81", "hex");
const TOKEN_LEDGER_ROUTE = Buffer.from("e6798f50779f6aaa", "hex");
const owner = Keypair.generate().publicKey;
const sellMint = Keypair.generate().publicKey;
const buyMint = Keypair.generate().publicKey;
const sourceAta = new PublicKey(associatedTokenAddress(owner.toBase58(), sellMint.toBase58(), TOKEN.toBase58()));
const destinationAta = new PublicKey(associatedTokenAddress(owner.toBase58(), buyMint.toBase58(), TOKEN.toBase58()));
const quote = {
  inputMint: sellMint.toBase58(),
  outputMint: buyMint.toBase58(),
  inAmount: "5000000",
  outAmount: "10000000",
  otherAmountThreshold: "9950000",
  slippageBps: 50,
};
const expectation: JupiterExpectation = { owner: owner.toBase58(), sellToken: quote.inputMint, buyToken: quote.outputMint, sellAmount: quote.inAmount, minOut: 9_950_000n, quote };

function routeData(kind: Buffer): Buffer {
  const args = Buffer.alloc(19);
  args.writeBigUInt64LE(5_000_000n, 0);
  args.writeBigUInt64LE(10_000_000n, 8);
  args.writeUInt16LE(50, 16);
  return Buffer.concat([kind, Buffer.alloc(5), args]);
}

function transaction(kind = SHARED_ROUTE): VersionedTransaction {
  const filler = Keypair.generate().publicKey;
  const shared = kind.equals(SHARED_ROUTE) || kind.equals(TOKEN_LEDGER_ROUTE);
  const keys = shared
    ? [TOKEN, filler, owner, sourceAta, filler, filler, destinationAta, sellMint, buyMint, JUP, JUP, JUP, JUP]
    : [TOKEN, owner, sourceAta, destinationAta, JUP, buyMint, JUP, JUP, JUP];
  const ix = new TransactionInstruction({
    programId: JUP,
    keys: keys.map((pubkey) => ({ pubkey, isSigner: pubkey.equals(owner), isWritable: true })),
    data: routeData(kind),
  });
  return new VersionedTransaction(new TransactionMessage({ payerKey: owner, recentBlockhash: "11111111111111111111111111111111", instructions: [ix] }).compileToV0Message());
}

function replaceAccount(tx: VersionedTransaction, position: number): void {
  const index = tx.message.staticAccountKeys.push(Keypair.generate().publicKey) - 1;
  const ix = tx.message.compiledInstructions[0] as (typeof tx.message.compiledInstructions)[number];
  ix.accountKeyIndexes[position] = index;
}

function editArgs(tx: VersionedTransaction, edit: (data: Buffer) => void): void {
  const ix = tx.message.compiledInstructions[0] as (typeof tx.message.compiledInstructions)[number];
  const data = Buffer.from(ix.data);
  edit(data);
  ix.data = data;
}

test("route and shared_accounts_route accept an exact quote with a wallet-owned source ATA", () => {
  assert.doesNotThrow(() => assertJupiterTransaction(transaction(ROUTE), expectation));
  assert.doesNotThrow(() => assertJupiterTransaction(transaction(SHARED_ROUTE), expectation));
});

test("Jupiter rejects changed input, output, slippage, fees, and token-ledger routes", () => {
  const cases: Array<[VersionedTransaction, RegExp]> = [];
  const input = transaction();
  editArgs(input, (data) => data.writeBigUInt64LE(5_000_001n, data.length - 19));
  cases.push([input, /input differs/]);
  const output = transaction();
  editArgs(output, (data) => data.writeBigUInt64LE(9_000_000n, data.length - 11));
  cases.push([output, /output differs|minimum is below/]);
  const slippage = transaction();
  editArgs(slippage, (data) => data.writeUInt16LE(10_000, data.length - 3));
  cases.push([slippage, /slippage differs/]);
  const fee = transaction();
  editArgs(fee, (data) => {
    data[data.length - 1] = 1;
  });
  cases.push([fee, /platform fee/]);
  cases.push([transaction(TOKEN_LEDGER_ROUTE), /token-ledger/]);
  for (const [tx, reason] of cases) assert.throws(() => assertJupiterTransaction(tx, expectation), reason);
});

test("Jupiter rejects a foreign source, changed mints, and a mismatched quote", () => {
  const source = transaction();
  replaceAccount(source, 3);
  assert.throws(() => assertJupiterTransaction(source, expectation), /source is not the wallet's token account/);
  const sourceMint = transaction();
  replaceAccount(sourceMint, 7);
  assert.throws(() => assertJupiterTransaction(sourceMint, expectation), /sells a different mint/);
  const destinationMint = transaction();
  replaceAccount(destinationMint, 8);
  assert.throws(() => assertJupiterTransaction(destinationMint, expectation), /buys a different mint/);
  assert.throws(() => assertJupiterTransaction(transaction(), { ...expectation, quote: { ...quote, inAmount: "5000001" } }), /quote does not match the leg/);
});
