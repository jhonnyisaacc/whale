import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { secp256k1 } from "@noble/curves/secp256k1";
import { p2wpkh, RawTx, Transaction } from "@scure/btc-signer";
import type { Utxo } from "../src/bitcoin/esplora.js";
import { CHANGE_DUST_SATS, SEQUENCE, selectCoins, unsignedTransaction, vsize, type SendPlan } from "../src/bitcoin/plan.js";
import { BTC_PARAMS, type Script } from "../src/bitcoin/wallet.js";

const scriptOf = (byte: number) => p2wpkh(secp256k1.getPublicKey(new Uint8Array(32).fill(byte), true), BTC_PARAMS.regtest).script as Script;
const OWN = scriptOf(0x11);
const TO = scriptOf(0x22);
const LIMITS = { maxInputs: 3, maxFeeSats: 10_000n };
const coin = (txid: string, sats: bigint, confirmed = true): Utxo => ({ txid: txid.repeat(64).slice(0, 64), vout: 0, sats, confirmed });
const feeWithChange = (inputs: number, rate: number) => BigInt(Math.ceil(vsize(inputs, [TO, OWN]) * rate));
const feeAlone = (inputs: number, rate: number) => BigInt(Math.ceil(vsize(inputs, [TO]) * rate));

function planOf(selection: ReturnType<typeof selectCoins>): SendPlan {
  assert.equal(selection.kind, "plan", JSON.stringify(selection, (_key, value: unknown) => (typeof value === "bigint" ? String(value) : value)));
  return (selection as { plan: SendPlan }).plan;
}

test("a coin that covers the amount and the fee with no room for change pays exactly that fee", () => {
  const plan = planOf(selectCoins([coin("a", 100_000n + feeAlone(1, 2))], TO, 100_000n, OWN, 2, LIMITS));
  assert.equal(plan.changeSats, 0n);
  assert.equal(plan.feeSats, feeAlone(1, 2));
});

test("a larger coin pays the amount, the fee for two outputs, and the rest back as change", () => {
  const plan = planOf(selectCoins([coin("a", 500_000n)], TO, 100_000n, OWN, 3, LIMITS));
  assert.equal(plan.feeSats, feeWithChange(1, 3));
  assert.equal(plan.changeSats, 500_000n - 100_000n - feeWithChange(1, 3));
  assert.equal(plan.sats + plan.changeSats + plan.feeSats, 500_000n);
});

test("change below the 294-sat dust line goes to the fee instead of an output", () => {
  const total = 100_000n + feeWithChange(1, 2) + CHANGE_DUST_SATS - 1n;
  const plan = planOf(selectCoins([coin("a", total)], TO, 100_000n, OWN, 2, LIMITS));
  assert.equal(plan.changeSats, 0n);
  assert.equal(plan.feeSats, total - 100_000n);
});

test("coins are picked largest first, confirmed only, and the same set gives the same plan in any order", () => {
  const coins = [coin("c", 40_000n), coin("a", 90_000n), coin("b", 90_000n), coin("d", 900_000n, false)];
  const plan = planOf(selectCoins(coins, TO, 150_000n, OWN, 1, LIMITS));
  assert.deepEqual(plan.inputs.map((input) => input.txid[0]), ["a", "b"]);
  assert.deepEqual(planOf(selectCoins([...coins].reverse(), TO, 150_000n, OWN, 1, LIMITS)), plan);
});

test("a fee above the sats cap is refused, never clamped", () => {
  const selection = selectCoins([coin("a", 5_000_000n)], TO, 100_000n, OWN, 100, LIMITS);
  assert.deepEqual(selection, { kind: "refused", reason: `the fee ${feeWithChange(1, 100)} sats is above the 10000 sats cap` });
});

test("a send that needs more inputs than the cap is refused", () => {
  const coins = ["a", "b", "c", "d"].map((id) => coin(id, 30_000n));
  assert.deepEqual(selectCoins(coins, TO, 100_000n, OWN, 1, LIMITS), { kind: "refused", reason: "the send needs more than 3 inputs" });
});

test("a send larger than the confirmed coins is refused, and unconfirmed coins do not count", () => {
  const selection = selectCoins([coin("a", 60_000n), coin("b", 900_000n, false)], TO, 100_000n, OWN, 1, LIMITS);
  assert.deepEqual(selection, { kind: "refused", reason: "not enough confirmed BTC: 60000 sats confirmed, 100000 sats asked plus the fee" });
});

test("the vsize estimate never undercounts a real signed P2WPKH spend, and overcounts it by at most a byte per input", () => {
  const real = Transaction.fromRaw(Buffer.from(readFileSync(new URL("../../test/fixtures/bitcoin/tx.hex", import.meta.url), "utf8").trim(), "hex"));
  const estimate = vsize(real.inputsLength, Array.from({ length: real.outputsLength }, (_, index) => real.getOutput(index).script as Uint8Array));
  assert.ok(estimate >= real.vsize && estimate - real.vsize <= real.inputsLength, `${estimate} vs ${real.vsize}`);
});

test("the unsigned transaction is version 2, lock time 0, sequence 0xfffffffd, no witness, outputs [to, change]", () => {
  const plan = planOf(selectCoins([coin("a", 300_000n), coin("b", 200_000n)], TO, 400_000n, OWN, 2, LIMITS));
  const bytes = unsignedTransaction(plan, OWN);
  const raw = RawTx.decode(bytes);
  assert.equal(raw.version, 2);
  assert.equal(raw.lockTime, 0);
  assert.equal(raw.segwitFlag, false);
  assert.deepEqual(raw.inputs.map((input) => [input.sequence, input.finalScriptSig.length]), [[SEQUENCE, 0], [SEQUENCE, 0]]);
  assert.deepEqual(raw.outputs.map((output) => [Buffer.from(output.script).toString("hex"), output.amount]), [[Buffer.from(TO).toString("hex"), 400_000n], [Buffer.from(OWN).toString("hex"), plan.changeSats]]);
  assert.equal(Buffer.from(Transaction.fromRaw(bytes).getInput(0).txid as Uint8Array).toString("hex"), "a".repeat(64));
});
