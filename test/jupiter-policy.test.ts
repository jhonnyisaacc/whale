import assert from "node:assert/strict";
import test from "node:test";
import { AddressLookupTableAccount, Keypair, PublicKey, TransactionInstruction, TransactionMessage, VersionedTransaction } from "@solana/web3.js";
import { associatedTokenAddress, JUPITER_PROGRAM_ID } from "../src/signing-policy.js";
import { assertJupiterTransaction, type JupiterExpectation } from "../src/signing-policy/jupiter.js";

const JUP = new PublicKey(JUPITER_PROGRAM_ID);
const TOKEN = new PublicKey("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA");
const ROUTE = Buffer.from("e517cb977ae3ad2a", "hex");
const SHARED_ROUTE = Buffer.from("c1209b3341d69c81", "hex");
const TOKEN_LEDGER_ROUTE = Buffer.from("e6798f50779f6aaa", "hex");
const WHIRLPOOL_STEP = Buffer.from([17, 1, 100, 0, 1]);
const DLMM_STEP = Buffer.from([75, 2, 0, 0, 0, 0, 1, 1, 3, 100, 1, 2]);
const owner = Keypair.generate().publicKey;
const sellMint = Keypair.generate().publicKey;
const buyMint = Keypair.generate().publicKey;
const filler = Keypair.generate().publicKey;
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
const lookupTable = new AddressLookupTableAccount({
  key: Keypair.generate().publicKey,
  state: { deactivationSlot: 2n ** 64n - 1n, lastExtendedSlot: 0, lastExtendedSlotStartIndex: 0, addresses: [sellMint, buyMint, filler] },
});

type Build = { kind?: Buffer; steps?: Buffer[]; out?: bigint; slippage?: number; trailing?: Buffer; lookup?: boolean; destination?: PublicKey; optional?: PublicKey };

function args(inAmount: bigint, out: bigint, slippage: number): Buffer {
  const data = Buffer.alloc(19);
  data.writeBigUInt64LE(inAmount, 0);
  data.writeBigUInt64LE(out, 8);
  data.writeUInt16LE(slippage, 16);
  return data;
}

function routeData(kind: Buffer, steps: Buffer[], tail: Buffer): Buffer {
  const count = Buffer.alloc(4);
  count.writeUInt32LE(steps.length);
  const id = kind.equals(ROUTE) ? [] : [Buffer.from([0])];
  return Buffer.concat([kind, ...id, count, ...steps, tail]);
}

function transaction(build: Build = {}): VersionedTransaction {
  const kind = build.kind ?? SHARED_ROUTE;
  const destination = build.destination ?? destinationAta;
  const shared = kind.equals(SHARED_ROUTE) || kind.equals(TOKEN_LEDGER_ROUTE);
  const keys = shared
    ? [TOKEN, filler, owner, sourceAta, filler, filler, destination, sellMint, buyMint, JUP, JUP, JUP, JUP]
    : [TOKEN, owner, sourceAta, destination, build.optional ?? JUP, buyMint, JUP, JUP, JUP];
  const tail = Buffer.concat([args(5_000_000n, build.out ?? 10_000_000n, build.slippage ?? 50), build.trailing ?? Buffer.alloc(0)]);
  const ix = new TransactionInstruction({
    programId: JUP,
    keys: keys.map((pubkey) => ({ pubkey, isSigner: pubkey.equals(owner), isWritable: !pubkey.equals(sellMint) && !pubkey.equals(buyMint) })),
    data: routeData(kind, build.steps ?? [WHIRLPOOL_STEP], tail),
  });
  const message = new TransactionMessage({ payerKey: owner, recentBlockhash: "11111111111111111111111111111111", instructions: [ix] });
  return new VersionedTransaction(message.compileToV0Message(build.lookup ? [lookupTable] : []));
}

function editArgs(tx: VersionedTransaction, edit: (data: Buffer) => void): void {
  const ix = tx.message.compiledInstructions[0] as (typeof tx.message.compiledInstructions)[number];
  const data = Buffer.from(ix.data);
  edit(data);
  ix.data = data;
}

function replaceAccount(tx: VersionedTransaction, position: number): void {
  const index = tx.message.staticAccountKeys.push(Keypair.generate().publicKey) - 1;
  const ix = tx.message.compiledInstructions[0] as (typeof tx.message.compiledInstructions)[number];
  ix.accountKeyIndexes[position] = index;
}

test("route and shared_accounts_route accept an exact quote with wallet-owned token accounts", () => {
  for (const kind of [ROUTE, SHARED_ROUTE]) {
    assert.doesNotThrow(() => assertJupiterTransaction(transaction({ kind }), expectation));
    assert.doesNotThrow(() => assertJupiterTransaction(transaction({ kind, steps: [WHIRLPOOL_STEP, DLMM_STEP] }), expectation));
  }
});

test("Jupiter accepts routes whose mints are loaded from an address lookup table", () => {
  for (const kind of [ROUTE, SHARED_ROUTE]) {
    const tx = transaction({ kind, lookup: true });
    assert.ok(tx.message.addressTableLookups.length > 0);
    assert.doesNotThrow(() => assertJupiterTransaction(tx, expectation));
  }
});

test("Jupiter accepts a quote whose threshold Jupiter rounded up and refuses one the route cannot honor", () => {
  const odd = { ...quote, outAmount: "3630149", otherAmountThreshold: "3611999" };
  const tx = transaction({ out: 3_630_149n, lookup: true });
  assert.doesNotThrow(() => assertJupiterTransaction(tx, { ...expectation, minOut: 3_611_999n, quote: odd }));
  const raised = { ...odd, otherAmountThreshold: "3612000" };
  assert.throws(() => assertJupiterTransaction(tx, { ...expectation, minOut: 3_612_000n, quote: raised }), /minimum is below/);
});

test("Jupiter refuses decoy arguments appended after the arguments the program reads", () => {
  const decoy = args(5_000_000n, 10_000_000n, 50);
  for (const kind of [ROUTE, SHARED_ROUTE]) {
    for (const steps of [[], [WHIRLPOOL_STEP]]) {
      assert.throws(() => assertJupiterTransaction(transaction({ kind, steps, out: 1n, slippage: 10_000, trailing: decoy }), expectation), /trailing bytes/);
    }
  }
});

test("Jupiter refuses a route plan it cannot decode exactly", () => {
  const cases: Array<[Buffer, RegExp]> = [
    [Buffer.from([250, 100, 0, 1]), /unknown swap variant/],
    [Buffer.from([17, 2, 100, 0, 1]), /invalid bool/],
    [Buffer.from([75, 255, 255, 0, 0]), /truncated/],
  ];
  for (const [step, reason] of cases) assert.throws(() => assertJupiterTransaction(transaction({ steps: [step] }), expectation), reason);
});

test("Jupiter rejects changed input, output, slippage, fees, and token-ledger routes", () => {
  const cases: Array<[VersionedTransaction, RegExp]> = [];
  const input = transaction();
  editArgs(input, (data) => data.writeBigUInt64LE(5_000_001n, data.length - 19));
  cases.push([input, /input differs/]);
  cases.push([transaction({ out: 9_000_000n }), /output differs/]);
  cases.push([transaction({ slippage: 10_000 }), /slippage differs/]);
  const fee = transaction();
  editArgs(fee, (data) => {
    data[data.length - 1] = 1;
  });
  cases.push([fee, /platform fee/]);
  cases.push([transaction({ kind: TOKEN_LEDGER_ROUTE }), /token-ledger/]);
  for (const [tx, reason] of cases) assert.throws(() => assertJupiterTransaction(tx, expectation), reason);
});

test("Jupiter rejects foreign token accounts, changed mints, and a mismatched quote", () => {
  const stranger = Keypair.generate().publicKey;
  const foreign = new PublicKey(associatedTokenAddress(stranger.toBase58(), buyMint.toBase58(), TOKEN.toBase58()));
  const source = transaction();
  replaceAccount(source, 3);
  assert.throws(() => assertJupiterTransaction(source, expectation), /source is not the wallet's token account/);
  for (const kind of [ROUTE, SHARED_ROUTE]) {
    assert.throws(() => assertJupiterTransaction(transaction({ kind, destination: foreign, lookup: true }), expectation), /destination is not the wallet's token account/);
  }
  assert.throws(() => assertJupiterTransaction(transaction({ kind: ROUTE, optional: foreign }), expectation), /different token account/);
  const sourceMint = transaction();
  replaceAccount(sourceMint, 7);
  assert.throws(() => assertJupiterTransaction(sourceMint, expectation), /sells a different mint/);
  const destinationMint = transaction();
  replaceAccount(destinationMint, 8);
  assert.throws(() => assertJupiterTransaction(destinationMint, expectation), /buys a different mint/);
  assert.throws(() => assertJupiterTransaction(transaction(), { ...expectation, quote: { ...quote, inAmount: "5000001" } }), /quote does not match the leg/);
});
