import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { PublicKey, VersionedTransaction } from "@solana/web3.js";
import { loadConfig } from "../src/config.js";
import { withPolicy, type TransactionSigner } from "../src/managed-signer.js";
import { associatedTokenAddress, JUPITER_PROGRAM_ID } from "../src/signing-policy.js";
import { assertJupiterTransaction } from "../src/signing-policy/jupiter.js";

type Fixture = { request: { userPublicKey: string }; quote: { inputMint: string; outputMint: string; inAmount: string; otherAmountThreshold: string }; transaction: string };

const TOKEN = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";
const WBTC = "3NZ9JMVBmGAqocybic2c7LQCJScmgsAZ6vQqTDzcqmJh";
const USDC = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";

function fixture(name: string): Fixture {
  return JSON.parse(readFileSync(new URL(`../../test/fixtures/jupiter/${name}.json`, import.meta.url), "utf8")) as Fixture;
}

function decode(swap: Fixture): VersionedTransaction {
  return VersionedTransaction.deserialize(Buffer.from(swap.transaction, "base64"));
}

function jupiterInstruction(tx: VersionedTransaction) {
  const index = tx.message.staticAccountKeys.findIndex((key) => key.toBase58() === JUPITER_PROGRAM_ID);
  const ix = tx.message.compiledInstructions.find((candidate) => candidate.programIdIndex === index);
  assert.ok(ix, "fixture has a Jupiter instruction");
  return ix;
}

function insertWritableKey(tx: VersionedTransaction, key: string): number {
  const message = tx.message;
  const at = message.staticAccountKeys.length - message.header.numReadonlyUnsignedAccounts;
  message.staticAccountKeys.splice(at, 0, new PublicKey(key));
  for (const ix of message.compiledInstructions) {
    if (ix.programIdIndex >= at) ix.programIdIndex += 1;
    ix.accountKeyIndexes = ix.accountKeyIndexes.map((index) => (index >= at ? index + 1 : index));
  }
  return at;
}

function walletAccount(owner: string, mint: string): string {
  return associatedTokenAddress(owner, mint, TOKEN);
}

function quoteLayer(swap: Fixture, tx: VersionedTransaction): void {
  const { quote } = swap;
  assertJupiterTransaction(tx, {
    owner: swap.request.userPublicKey,
    sellToken: quote.inputMint,
    buyToken: quote.outputMint,
    sellAmount: quote.inAmount,
    minOut: BigInt(quote.otherAmountThreshold),
    quote,
  });
}

function signer(owner: string, calls: string[]): TransactionSigner {
  return withPolicy(
    {
      backend: "keystore",
      evmAddress: () => null,
      solanaAddress: () => owner,
      signEvm: async () => "0x",
      signSolana: async () => {
        calls.push("solana");
        return new Uint8Array();
      },
      signHyperliquid: async () => ({ r: "0x01", s: "0x02", v: 27 }),
    },
    loadConfig({}),
  );
}

async function refusedEverywhere(swap: Fixture, tx: VersionedTransaction, quoteReason: RegExp, signReason: RegExp): Promise<void> {
  assert.throws(() => quoteLayer(swap, tx), quoteReason);
  const calls: string[] = [];
  await assert.rejects(() => signer(swap.request.userPublicKey, calls).signSolana(tx.serialize()), signReason);
  assert.deepEqual(calls, []);
}

test("a real Jupiter sharedAccountsRoute through the wallet's own accounts passes both policy layers", async () => {
  const swap = fixture("usdc-sol-shared");
  const tx = decode(swap);
  assert.equal(Buffer.from(jupiterInstruction(tx).data.subarray(0, 8)).toString("hex"), "c1209b3341d69c81");
  quoteLayer(swap, tx);
  const calls: string[] = [];
  await signer(swap.request.userPublicKey, calls).signSolana(tx.serialize());
  assert.deepEqual(calls, ["solana"]);
});

test("a Jupiter route that charges USDC while its step sells the wallet's wBTC is refused (#62)", async () => {
  const swap = fixture("usdc-sol-route");
  const owner = swap.request.userPublicKey;
  const tx = decode(swap);
  const ix = jupiterInstruction(tx);
  const usdc = tx.message.staticAccountKeys.findIndex((key) => key.toBase58() === walletAccount(owner, USDC));
  assert.equal(ix.accountKeyIndexes[2], usdc, "route charges the wallet's USDC account in slot 2");
  const stepSource = ix.accountKeyIndexes.findIndex((index, position) => position > 8 && index === usdc);
  assert.ok(stepSource > 8, "the real step sells from the wallet's USDC account");
  const wbtc = insertWritableKey(tx, walletAccount(owner, WBTC));
  ix.accountKeyIndexes[stepSource] = wbtc;
  assert.ok(ix.accountKeyIndexes.slice(9).includes(0), "the step still carries the wallet as its authority");
  await refusedEverywhere(swap, tx, /not sharedAccountsRoute/, /solana instruction is not allowed JUP6\S+ e517cb977ae3ad2a/);
  await refusedEverywhere(swap, decode(swap), /not sharedAccountsRoute/, /solana instruction is not allowed JUP6\S+ e517cb977ae3ad2a/);
});

test("a sharedAccountsRoute that hands the wallet's signature to a step is refused", async () => {
  const swap = fixture("usdc-sol-shared");
  const owner = swap.request.userPublicKey;
  const tx = decode(swap);
  const ix = jupiterInstruction(tx);
  const steps = ix.accountKeyIndexes.map((index, position) => [index, position] as const).filter(([index, position]) => position > 12 && index > 0 && index < tx.message.staticAccountKeys.length);
  const [authority, source] = steps.map(([, position]) => position);
  assert.ok(authority !== undefined && source !== undefined, "the real route has static step accounts to rewrite");
  const wbtc = insertWritableKey(tx, walletAccount(owner, WBTC));
  ix.accountKeyIndexes[authority] = 0;
  ix.accountKeyIndexes[source] = wbtc;
  await refusedEverywhere(swap, tx, /wallet to an account other than the transfer authority/, /wallet to an account other than the transfer authority/);
  const manifest = fixture("usdc-sol-manifest-shared");
  await refusedEverywhere(manifest, decode(manifest), /wallet to an account other than the transfer authority/, /wallet to an account other than the transfer authority/);
});

test("a real Jupiter buy into a Token-2022 account is refused", async () => {
  const swap = fixture("usdc-pyusd-shared");
  const tx = decode(swap);
  const destination = tx.message.staticAccountKeys[jupiterInstruction(tx).accountKeyIndexes[6] as number]?.toBase58();
  assert.equal(destination, associatedTokenAddress(swap.request.userPublicKey, swap.quote.outputMint, "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb"));
  await refusedEverywhere(swap, tx, /destination is not the wallet's token account/, /destination is not a hot wallet token account/);
});
