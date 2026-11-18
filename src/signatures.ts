import { createPublicKey, verify } from "node:crypto";
import { VersionedTransaction } from "@solana/web3.js";
import bs58 from "bs58";
import { parseTransaction, recoverTransactionAddress, serializeTransaction, type Hex, type TransactionSerializedEIP1559 } from "viem";

export type EvmTxRequest = {
  chainId: number;
  nonce: number;
  to: Hex;
  value: bigint;
  data: Hex;
  gas: bigint;
  maxFeePerGas: bigint;
  maxPriorityFeePerGas: bigint;
};

type EvmSignature = { r: Hex; s: Hex; yParity: number };

const ED25519_SPKI_PREFIX = Buffer.from("302a300506032b6570032100", "hex");
const SECP256K1_HALF_N = 0x7fffffffffffffffffffffffffffffff5d576e7357a4501ddfe92f46681b20a0n;

export function serializeEvmRequest(request: EvmTxRequest, signature?: EvmSignature): TransactionSerializedEIP1559 {
  return serializeTransaction({ type: "eip1559", ...request, accessList: [] }, signature);
}

export async function verifiedEvmTransaction(signed: string, request: EvmTxRequest, address: string): Promise<Hex> {
  const fail = (what: string) => new Error(`evm chain ${request.chainId}: ${what}`);
  const raw = signed.toLowerCase() as Hex;
  let parsed: ReturnType<typeof parseTransaction>;
  try {
    parsed = parseTransaction(raw);
  } catch {
    throw fail("signed transaction does not parse");
  }
  if (parsed.type !== "eip1559") throw fail("signed transaction is not EIP-1559");
  if (parsed.r === undefined || parsed.s === undefined || parsed.yParity === undefined) throw fail("signed transaction is not signed");
  if (BigInt(parsed.r) === 0n || BigInt(parsed.s) === 0n) throw fail("signature is zero");
  if (BigInt(parsed.s) > SECP256K1_HALF_N) throw fail("signature s is not canonical");
  const expected = serializeEvmRequest(request, { r: parsed.r, s: parsed.s, yParity: parsed.yParity });
  if (expected !== raw) throw fail("signed transaction is not the requested transaction");
  const signer = await recoverTransactionAddress({ serializedTransaction: expected }).catch(() => null);
  if (signer?.toLowerCase() !== address.toLowerCase()) throw fail("signature does not recover to the wallet");
  return expected;
}

export function verifiesEd25519(message: Uint8Array, address: string, signature: Uint8Array): boolean {
  try {
    const key = Buffer.from(bs58.decode(address));
    if (key.byteLength !== 32 || signature.byteLength !== 64) return false;
    return verify(null, message, createPublicKey({ key: Buffer.concat([ED25519_SPKI_PREFIX, key]), format: "der", type: "spki" }), signature);
  } catch {
    return false;
  }
}

export function verifiedSolanaTransaction(signed: Uint8Array, requested: Uint8Array, address: string): Uint8Array {
  const fail = (what: string) => new Error(`solana: ${what}`);
  let tx: VersionedTransaction;
  try {
    tx = VersionedTransaction.deserialize(signed);
  } catch {
    throw fail("signed transaction does not parse");
  }
  const request = VersionedTransaction.deserialize(requested);
  const message = request.message.serialize();
  if (!Buffer.from(tx.message.serialize()).equals(Buffer.from(message))) throw fail("signed message is not the requested message");
  if (request.message.staticAccountKeys[0]?.toBase58() !== address) throw fail("fee payer is not the wallet");
  const signature = tx.signatures[0];
  if (!signature || signature.every((byte) => byte === 0)) throw fail("signature is zero");
  if (!verifiesEd25519(message, address, signature)) throw fail("signature does not verify against the wallet key");
  request.signatures[0] = signature;
  return request.serialize();
}
