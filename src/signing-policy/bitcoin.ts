import { Transaction } from "@scure/btc-signer";
import { classify, sameScript, scriptAddress, type BitcoinNetwork, type Script } from "../bitcoin/wallet.js";

export type BitcoinRule = { readonly own: Script; readonly destinations: readonly Script[]; readonly maxFeeSats: bigint; readonly maxInputs: number; readonly network: BitcoinNetwork };
export type VerifiedPrevout = { readonly script: Uint8Array; readonly sats: bigint };
export type BitcoinSpend = { readonly prevouts: readonly VerifiedPrevout[]; readonly feeSats: bigint; readonly changeSats: bigint; readonly spentSats: bigint };

const RAW = { allowUnknownOutputs: true, allowUnknownInputs: true, disableScriptCheck: true } as const;
const SEQUENCE = 0xfffffffd;

function parse(bytes: Uint8Array, name: string): Transaction {
  try {
    return Transaction.fromRaw(bytes, RAW);
  } catch {
    throw new Error(`bitcoin: ${name} is not a bitcoin transaction`);
  }
}

function verifiedPrevouts(tx: Transaction, previous: readonly Uint8Array[]): VerifiedPrevout[] {
  if (previous.length !== tx.inputsLength) throw new Error("bitcoin: previous must list one transaction per input");
  return previous.map((bytes, index) => {
    const input = tx.getInput(index);
    const txid = Buffer.from(input.txid ?? []).toString("hex");
    const prior = parse(bytes, `previous ${index}`);
    if (prior.id !== txid) throw new Error(`bitcoin: input ${index}: the previous transaction does not hash to ${txid}`);
    const vout = input.index ?? 0;
    if (vout >= prior.outputsLength) throw new Error(`bitcoin: input ${index}: the previous transaction has no output ${vout}`);
    const output = prior.getOutput(vout);
    return { script: output.script ?? new Uint8Array(), sats: output.amount ?? 0n };
  });
}

export function assertBitcoinSigning(unsigned: Uint8Array, previous: readonly Uint8Array[], rule: BitcoinRule): BitcoinSpend {
  const tx = parse(unsigned, "the transaction");
  const prevouts = verifiedPrevouts(tx, previous);
  const inputs = Array.from({ length: tx.inputsLength }, (_, index) => tx.getInput(index));
  if (tx.version !== 2 || tx.lockTime !== 0 || inputs.some((input) => input.sequence !== SEQUENCE)) {
    throw new Error("bitcoin: the transaction must be version 2, lock time 0, and sequence 0xfffffffd on every input");
  }
  inputs.forEach((input, index) => {
    if ((input.finalScriptSig?.length ?? 0) > 0 || (input.finalScriptWitness?.length ?? 0) > 0) throw new Error(`bitcoin: input ${index} carries a signature already`);
  });
  if (inputs.length === 0) throw new Error("bitcoin: the transaction has no inputs");
  if (inputs.length > rule.maxInputs) throw new Error(`bitcoin: ${inputs.length} inputs is above the ${rule.maxInputs} input limit`);
  const seen = new Set<string>();
  inputs.forEach((input, index) => {
    const outpoint = `${Buffer.from(input.txid ?? []).toString("hex")}:${input.index}`;
    if (seen.has(outpoint)) throw new Error(`bitcoin: input ${index} spends the same coin as an earlier input`);
    seen.add(outpoint);
  });
  prevouts.forEach((prevout, index) => {
    if (!sameScript(prevout.script, rule.own)) throw new Error(`bitcoin: input ${index} does not spend this wallet's address`);
  });
  if (tx.outputsLength === 0) throw new Error("bitcoin: the transaction has no outputs");
  let outputSats = 0n;
  let changeSats = 0n;
  for (let index = 0; index < tx.outputsLength; index++) {
    const output = tx.getOutput(index);
    const script = output.script ?? new Uint8Array();
    const sats = output.amount ?? 0n;
    outputSats += sats;
    if (sameScript(script, rule.own)) {
      changeSats += sats;
      continue;
    }
    if (rule.destinations.some((destination) => sameScript(script, destination))) continue;
    const kind = classify(script);
    if (kind === "op_return") throw new Error(`bitcoin: output ${index} is OP_RETURN`);
    if (kind === "unknown") throw new Error(`bitcoin: output ${index} has an unknown script`);
    throw new Error(`bitcoin: output ${index} pays ${scriptAddress(script, rule.network)}, which is not an allowed destination`);
  }
  const inputSats = prevouts.reduce((sum, prevout) => sum + prevout.sats, 0n);
  if (outputSats > inputSats) throw new Error("bitcoin: outputs spend more than the inputs hold");
  const feeSats = inputSats - outputSats;
  if (feeSats > rule.maxFeeSats) throw new Error(`bitcoin: the fee ${feeSats} sats is above the ${rule.maxFeeSats} sats cap`);
  return { prevouts, feeSats, changeSats, spentSats: inputSats - changeSats };
}
