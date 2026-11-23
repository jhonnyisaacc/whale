import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { secp256k1 } from "@noble/curves/secp256k1";
import { p2wpkh, RawTx, Transaction } from "@scure/btc-signer";
import { RAW_TX_OPTIONS } from "../src/bitcoin/esplora.js";
import { verifiedBitcoinTransaction } from "../src/bitcoin/verify.js";
import { BTC_PARAMS, type BitcoinWallet, type Script } from "../src/bitcoin/wallet.js";

const hexOf = (bytes: Uint8Array) => Buffer.from(bytes).toString("hex");
const fixture = (name: string) => readFileSync(new URL(`../../test/fixtures/bitcoin/${name}`, import.meta.url), "utf8").trim();
const SIGNED = fixture("tx.hex");
const signedTx = Transaction.fromRaw(Buffer.from(SIGNED, "hex"), RAW_TX_OPTIONS);
const previous = Transaction.fromRaw(Buffer.from(fixture("prev.hex"), "hex"), RAW_TX_OPTIONS);
const spentOutput = previous.getOutput(signedTx.getInput(0).index as number);
const PREVOUTS = [{ script: spentOutput.script as Uint8Array, sats: spentOutput.amount as bigint }];
const UNSIGNED = signedTx.toBytes(true, false);

function walletOf(publicKey: Uint8Array): BitcoinWallet {
  const pay = p2wpkh(publicKey, BTC_PARAMS.bitcoin);
  return { network: "bitcoin", publicKey, script: pay.script as Script, address: pay.address as string };
}

const OWNER = walletOf(signedTx.getInput(0).finalScriptWitness?.[1] as Uint8Array);

function withWitness(edit: (signature: Uint8Array) => Uint8Array): string {
  const raw = RawTx.decode(Buffer.from(SIGNED, "hex"));
  const [[signature, key]] = raw.witnesses as [[Uint8Array, Uint8Array]];
  return hexOf(RawTx.encode({ ...raw, witnesses: [[edit(signature), key]] }));
}

test("a real mainnet P2WPKH spend verifies against the amount read from its previous transaction", () => {
  assert.equal(hexOf(OWNER.script), hexOf(PREVOUTS[0]?.script as Uint8Array), "the fixture spends the key in its own witness");
  assert.equal(hexOf(verifiedBitcoinTransaction(SIGNED, UNSIGNED, PREVOUTS, OWNER)), SIGNED);
});

test("a signed answer whose outputs differ from the requested transaction is refused", () => {
  const raw = RawTx.decode(UNSIGNED);
  const asked = RawTx.encode({ ...raw, outputs: raw.outputs.map((output) => ({ ...output, amount: output.amount - 1n })) });
  assert.throws(() => verifiedBitcoinTransaction(SIGNED, asked, PREVOUTS, OWNER), /whale-signer returned a different transaction/);
});

test("a signature by another key is refused", () => {
  const other = walletOf(secp256k1.getPublicKey(new Uint8Array(32).fill(7), true));
  assert.throws(() => verifiedBitcoinTransaction(SIGNED, UNSIGNED, PREVOUTS, other), /input 0 is not signed by this wallet's key/);
});

test("the high-S twin of a valid signature is refused", () => {
  const highS = withWitness((signature) => {
    const parsed = secp256k1.Signature.fromDER(signature.subarray(0, -1));
    const twin = new secp256k1.Signature(parsed.r, secp256k1.CURVE.n - parsed.s);
    return new Uint8Array([...twin.toDERRawBytes(), 0x01]);
  });
  assert.throws(() => verifiedBitcoinTransaction(highS, UNSIGNED, PREVOUTS, OWNER), /input 0 has a high-S signature/);
});

test("a signature over a different input amount is refused, because BIP143 commits to it", () => {
  const lied = [{ script: PREVOUTS[0]?.script as Uint8Array, sats: (PREVOUTS[0]?.sats as bigint) + 1n }];
  assert.throws(() => verifiedBitcoinTransaction(SIGNED, UNSIGNED, lied, OWNER), /input 0 has an invalid signature/);
});

test("a signature that is not SIGHASH_ALL, not strict DER, or not hex is refused", () => {
  assert.throws(() => verifiedBitcoinTransaction(withWitness((signature) => new Uint8Array([...signature.subarray(0, -1), 0x83])), UNSIGNED, PREVOUTS, OWNER), /not signed SIGHASH_ALL/);
  assert.throws(() => verifiedBitcoinTransaction(withWitness((signature) => new Uint8Array([0x30, 0x00, ...signature.subarray(2)])), UNSIGNED, PREVOUTS, OWNER), /malformed signature/);
  assert.throws(() => verifiedBitcoinTransaction(`${SIGNED}z`, UNSIGNED, PREVOUTS, OWNER), /not hex/);
});
