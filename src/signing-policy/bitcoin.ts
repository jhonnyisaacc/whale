import type { BitcoinNetwork, Script } from "../bitcoin/wallet.js";

export type BitcoinRule = { readonly own: Script; readonly destinations: readonly Script[]; readonly maxFeeSats: bigint; readonly maxInputs: number; readonly network: BitcoinNetwork };
export type VerifiedPrevout = { readonly script: Uint8Array; readonly sats: bigint };
export type BitcoinSpend = { readonly prevouts: readonly VerifiedPrevout[]; readonly feeSats: bigint; readonly changeSats: bigint; readonly spentSats: bigint };

export function assertBitcoinSigning(unsigned: Uint8Array, previous: readonly Uint8Array[], rule: BitcoinRule): BitcoinSpend {
  void unsigned;
  void previous;
  void rule;
  throw new Error("bitcoin: not implemented");
}
