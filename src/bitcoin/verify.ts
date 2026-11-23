import { secp256k1 } from "@noble/curves/secp256k1";
import { OutScript, SigHash, Transaction } from "@scure/btc-signer";
import type { VerifiedPrevout } from "../signing-policy/bitcoin.js";
import { RAW_TX_OPTIONS } from "./esplora.js";
import { sameScript, type BitcoinWallet } from "./wallet.js";

type EcdsaSignature = ReturnType<typeof secp256k1.Signature.fromDER>;

function strictDer(der: Uint8Array): EcdsaSignature | null {
  try {
    const signature = secp256k1.Signature.fromDER(der);
    return sameScript(signature.toDERRawBytes(), der) ? signature : null;
  } catch {
    return null;
  }
}

export function verifiedBitcoinTransaction(signedHex: string, unsigned: Uint8Array, prevouts: readonly VerifiedPrevout[], wallet: BitcoinWallet): Uint8Array {
  if (!/^(?:[0-9a-f]{2})+$/.test(signedHex)) throw new Error("whale-signer returned a transaction that is not hex");
  const signed = new Uint8Array(Buffer.from(signedHex, "hex"));
  let tx: Transaction;
  try {
    tx = Transaction.fromRaw(signed, RAW_TX_OPTIONS);
  } catch {
    throw new Error("whale-signer returned bytes that are not a bitcoin transaction");
  }
  if (!sameScript(tx.toBytes(true, false), unsigned)) throw new Error("whale-signer returned a different transaction");
  if (prevouts.length !== tx.inputsLength) throw new Error("the verified previous outputs do not match the inputs");
  const scriptCode = OutScript.encode({ type: "pkh", hash: wallet.script.subarray(2) });
  for (let index = 0; index < tx.inputsLength; index += 1) {
    const witness = tx.getInput(index).finalScriptWitness ?? [];
    const [signature, key] = witness;
    if (witness.length !== 2 || !signature || !key || !sameScript(key, wallet.publicKey)) throw new Error(`input ${index} is not signed by this wallet's key`);
    if (signature.at(-1) !== SigHash.ALL) throw new Error(`input ${index} is not signed SIGHASH_ALL`);
    const parsed = strictDer(signature.subarray(0, -1));
    if (!parsed) throw new Error(`input ${index} has a malformed signature`);
    if (parsed.hasHighS()) throw new Error(`input ${index} has a high-S signature`);
    const digest = tx.preimageWitnessV0(index, scriptCode, SigHash.ALL, (prevouts[index] as VerifiedPrevout).sats);
    if (!secp256k1.verify(parsed.toCompactRawBytes(), digest, wallet.publicKey, { lowS: true, prehash: false, format: "compact" })) throw new Error(`input ${index} has an invalid signature`);
  }
  return signed;
}
