import { secp256k1 } from "@noble/curves/secp256k1";
import { Address, OutScript, p2wpkh } from "@scure/btc-signer";
import { publicKeyToAddress } from "viem/accounts";

export const BITCOIN_KEY = "bitcoin";

export type BitcoinNetwork = "bitcoin" | "testnet" | "signet" | "regtest";
export type Script = Uint8Array & { readonly __script: unique symbol };
export type BitcoinWallet = { readonly network: BitcoinNetwork; readonly publicKey: Uint8Array; readonly script: Script; readonly address: string };
export type ScriptKind = "p2pkh" | "p2sh" | "p2wpkh" | "p2wsh" | "p2tr" | "op_return" | "unknown";

const TEST = { pubKeyHash: 0x6f, scriptHash: 0xc4, wif: 0xef };

export const BTC_PARAMS: Readonly<Record<BitcoinNetwork, { bech32: string; pubKeyHash: number; scriptHash: number; wif: number }>> = {
  bitcoin: { bech32: "bc", pubKeyHash: 0x00, scriptHash: 0x05, wif: 0x80 },
  testnet: { bech32: "tb", ...TEST },
  signet: { bech32: "tb", ...TEST },
  regtest: { bech32: "bcrt", ...TEST },
};

export const BITCOIN_NETWORKS: readonly BitcoinNetwork[] = ["bitcoin", "testnet", "signet", "regtest"];

const KINDS: Readonly<Record<string, ScriptKind>> = { pkh: "p2pkh", sh: "p2sh", wpkh: "p2wpkh", wsh: "p2wsh", tr: "p2tr" };

export function bitcoinWallet(publicKeyHex: string, evmAddress: string, network: BitcoinNetwork): BitcoinWallet {
  if (!/^0[23][0-9a-f]{64}$/.test(publicKeyHex)) throw new Error("bitcoinPublicKey is not a compressed secp256k1 key");
  const point = secp256k1.ProjectivePoint.fromHex(publicKeyHex);
  if (publicKeyToAddress(`0x${point.toHex(false)}`).toLowerCase() !== evmAddress.toLowerCase()) throw new Error("bitcoinPublicKey does not belong to the keystore's evmAddress");
  const publicKey = point.toRawBytes(true);
  const pay = p2wpkh(publicKey, BTC_PARAMS[network]);
  if (!pay.address) throw new Error("cannot encode the bitcoin address");
  return { network, publicKey, script: pay.script as Script, address: pay.address };
}

export function classify(script: Uint8Array): ScriptKind {
  if (script[0] === 0x6a) return "op_return";
  try {
    return KINDS[OutScript.decode(script).type] ?? "unknown";
  } catch {
    return "unknown";
  }
}

export function destinationScript(address: string, network: BitcoinNetwork): Script | null {
  try {
    const script = OutScript.encode(Address(BTC_PARAMS[network]).decode(address));
    const kind = classify(script);
    return kind === "op_return" || kind === "unknown" ? null : (script as Script);
  } catch {
    return null;
  }
}

export function scriptAddress(script: Uint8Array, network: BitcoinNetwork): string {
  try {
    return Address(BTC_PARAMS[network]).encode(OutScript.decode(script));
  } catch {
    return `script ${Buffer.from(script).toString("hex")}`;
  }
}

export function sameScript(a: Uint8Array, b: Uint8Array): boolean {
  return a.length === b.length && a.every((byte, index) => byte === b[index]);
}
