import { Transaction } from "@scure/btc-signer";
import type { Utxo } from "./esplora.js";
import type { Script } from "./wallet.js";

export type SendPlan = { readonly inputs: readonly Utxo[]; readonly to: Script; readonly sats: bigint; readonly changeSats: bigint; readonly feeSats: bigint; readonly feeRate: number };
export type PlanLimits = { readonly maxInputs: number; readonly maxFeeSats: bigint };
export type Selection = { readonly kind: "plan"; readonly plan: SendPlan } | { readonly kind: "refused"; readonly reason: string };

export const CHANGE_DUST_SATS = 294n;
export const SEQUENCE = 0xfffffffd;

const P2WPKH_WITNESS_BYTES = 1 + 1 + 72 + 1 + 33;

function varintSize(count: number): number {
  return count < 0xfd ? 1 : count <= 0xffff ? 3 : 5;
}

export function vsize(inputs: number, outputs: readonly Uint8Array[]): number {
  const outputBytes = outputs.reduce((sum, script) => sum + 8 + varintSize(script.length) + script.length, 0);
  const stripped = 4 + varintSize(inputs) + inputs * (32 + 4 + 1 + 4) + varintSize(outputs.length) + outputBytes + 4;
  const witness = 2 + inputs * P2WPKH_WITNESS_BYTES;
  return Math.ceil((stripped * 4 + witness) / 4);
}

function feeAt(bytes: number, feeRate: number): bigint {
  return BigInt(Math.ceil(bytes * feeRate));
}

function largestFirst(a: Utxo, b: Utxo): number {
  if (a.sats !== b.sats) return a.sats > b.sats ? -1 : 1;
  if (a.txid !== b.txid) return a.txid < b.txid ? -1 : 1;
  return a.vout - b.vout;
}

export function selectCoins(utxos: readonly Utxo[], to: Script, sats: bigint, own: Script, feeRate: number, limits: PlanLimits): Selection {
  const refused = (reason: string): Selection => ({ kind: "refused", reason });
  const coins = utxos.filter((utxo) => utxo.confirmed).sort(largestFirst);
  let total = 0n;
  for (let count = 1; count <= Math.min(limits.maxInputs, coins.length); count += 1) {
    total += (coins[count - 1] as Utxo).sats;
    const withChange = feeAt(vsize(count, [to, own]), feeRate);
    const split =
      total >= sats + withChange + CHANGE_DUST_SATS
        ? { changeSats: total - sats - withChange, feeSats: withChange }
        : total >= sats + feeAt(vsize(count, [to]), feeRate)
          ? { changeSats: 0n, feeSats: total - sats }
          : null;
    if (!split) continue;
    if (split.feeSats > limits.maxFeeSats) return refused(`the fee ${split.feeSats} sats is above the ${limits.maxFeeSats} sats cap`);
    return { kind: "plan", plan: { inputs: coins.slice(0, count), to, sats, feeRate, ...split } };
  }
  const confirmed = coins.reduce((sum, utxo) => sum + utxo.sats, 0n);
  if (coins.length > limits.maxInputs && confirmed > sats) return refused(`the send needs more than ${limits.maxInputs} inputs`);
  return refused(`not enough confirmed BTC: ${confirmed} sats confirmed, ${sats} sats asked plus the fee`);
}

export function unsignedTransaction(plan: SendPlan, own: Script): Uint8Array {
  const tx = new Transaction({ version: 2, lockTime: 0 });
  for (const input of plan.inputs) tx.addInput({ txid: input.txid, index: input.vout, sequence: SEQUENCE });
  tx.addOutput({ script: plan.to, amount: plan.sats });
  if (plan.changeSats > 0n) tx.addOutput({ script: own, amount: plan.changeSats });
  return tx.toBytes(true, false);
}
