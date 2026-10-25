import { TransactionReceiptNotFoundError, createPublicClient, type Hex } from "viem";
import { encodeFunctionData, erc20Abi, keccak256, parseUnits } from "viem";
import type { RouteLeg, TxRecord } from "../domain.js";
import type { EvmSignInput } from "../managed-signer.js";
import { firmJupiter, firmKyber, firmLifi, firmZeroEx, jupiterQuote, jupiterSwap, kyberFromRoute } from "../aggregators.js";
import { chainByEvmId } from "../chains.js";
import { isDefiniteRejection } from "../nonce.js";
import type { RaceQuote, TxOutcome } from "../domain.js";
import { BroadcastError } from "../executor.js";
import { allowanceCovers, rememberApproval } from "../approvals.js";
import { readLifi, readZeroEx } from "../quotes.js";
import { redactError } from "../redact.js";
import { sellBaseUnits } from "../routing.js";
import { routersForChain, swapTerms } from "../signing-policy.js";
import { approvalSpender, asHex, assertMinOut, executionSlippageBps, journal, onAnyRpc, ourMinOut, referenceFor, rememberIfFunded, reusableQuote, reuseOrFirm, type Confirmed, type Ctx, type EvmCtx, type EvmReceipt, type EvmRpc, type EvmTx, type PreparedLeg, type Submitted, NATIVE_SELL, digits, overCap } from "./shared.js";

export function evmRecord(ctx: EvmCtx, signed: Hex, tx: { to: Hex; value: bigint; nonce: number }): TxRecord {
  return { chainKey: ctx.chainKey, txHash: keccak256(signed), from: ctx.owner, to: tx.to, value: tx.value.toString(), outcome: "pending", nonce: tx.nonce };
}
