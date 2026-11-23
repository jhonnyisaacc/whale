import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { Transaction } from "@scure/btc-signer";
import { bitcoinWallet, destinationScript, type Script } from "../src/bitcoin/wallet.js";
import { assertBitcoinSigning, type BitcoinRule } from "../src/signing-policy/bitcoin.js";

type Case = { name: string; job: { transaction: string; previous: string[] }; expect: "signed" | "refused"; reason?: string; signedTransaction?: string; spent?: Record<string, string>; signerOnly?: boolean; spentSats?: string };
type Section = { network: "regtest"; destinations: string[]; maxFeeSats: string; maxInputs: number };

const read = (name: string) => JSON.parse(readFileSync(new URL(`../../signer/vectors/${name}`, import.meta.url), "utf8")) as unknown;
const vectors = read("bitcoin.json") as { publicKey: string; own: string; cases: Case[] };
const section = (read("policy.json") as { bitcoin: Section }).bitcoin;
const evm = read("evm.json") as { own: string };
const bytes = (hex: string) => Uint8Array.from(Buffer.from(hex, "hex"));

const wallet = bitcoinWallet(vectors.publicKey, evm.own, section.network);
const rule: BitcoinRule = {
  own: wallet.script,
  destinations: section.destinations.map((address) => destinationScript(address, section.network)).filter((script): script is Script => script !== null),
  maxFeeSats: BigInt(section.maxFeeSats),
  maxInputs: section.maxInputs,
  network: section.network,
};

test("the bitcoin vectors pay the address the EVM vector key derives, and every policy destination decodes on its network", () => {
  assert.equal(wallet.address, vectors.own);
  assert.equal(rule.destinations.length, section.destinations.length);
});

test("the app's bitcoin signing rule makes the same decision with the same reason as whale-signer on every vector", () => {
  assert.ok(vectors.cases.length >= 20);
  for (const entry of vectors.cases) {
    const check = () => assertBitcoinSigning(bytes(entry.job.transaction), entry.job.previous.map(bytes), rule);
    if (entry.expect === "refused" && !entry.signerOnly) {
      assert.throws(check, (error: Error) => error.message === `bitcoin: ${entry.reason}`, entry.name);
      continue;
    }
    const spent = entry.spent?.["bitcoin:native"] ?? entry.spentSats;
    assert.equal(String(check().spentSats), spent, entry.name);
  }
});

test("each signed bitcoin vector is the exact unsigned transaction plus a witness, so the signer changed no output or fee", () => {
  const signedCases = vectors.cases.filter((item) => item.signedTransaction);
  assert.equal(signedCases.length, 3);
  for (const entry of signedCases) {
    const signed = Transaction.fromRaw(bytes(entry.signedTransaction ?? ""));
    assert.equal(Buffer.from(signed.toBytes(true, false)).toString("hex"), entry.job.transaction, entry.name);
    assert.ok(Array.from({ length: signed.inputsLength }, (_, index) => signed.getInput(index).finalScriptWitness?.length === 2).every(Boolean), entry.name);
  }
});
