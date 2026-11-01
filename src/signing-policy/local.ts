import { createHash } from "node:crypto";
import { VersionedTransaction } from "@solana/web3.js";
import type { Hex } from "viem";
import { chainByEvmId } from "../chains.js";
import type { DeploymentManifestV2 } from "../deployment-manifest.js";
import { spendDay } from "../spend.js";
import {
  assertEvmSigning,
  assertHyperliquidSigning,
  assertSolanaSigning,
  evmChainIds,
  swapTerms,
  type EvmApproval,
  type EvmPurpose,
  type SolanaMessage,
  type SwapTerms,
} from "../signing-policy.js";

export const LOCAL_CAP_FIELDS = ["chains", "maxUsdPerTrade", "dailyUsdCap", "maxValueWei", "transferRecipients"] as const;
export type LocalCapField = (typeof LOCAL_CAP_FIELDS)[number];

export type LocalDenyCode =
  | "kill_switch"
  | "approvals_integrity"
  | "missing_cap"
  | "chain_denied"
  | "router_not_approved"
  | "settler_not_approved"
  | "program_not_approved"
  | "per_trade_cap"
  | "daily_cap"
  | "native_value_cap"
  | "transfer_recipient_denied"
  | "tx_mismatch"
  | "tx_undecodable"
  | "opaque_calldata"
  | "purpose_denied";

export type LocalSpendJournal = {
  day: string;
  spentUsd: string;
  keys: Readonly<Record<string, string>>;
};

export type LocalDecision =
  | { ok: true; spend: LocalSpendJournal }
  | { ok: false; code: "missing_cap"; cap: LocalCapField }
  | { ok: false; code: Exclude<LocalDenyCode, "missing_cap"> };

export type LocalPurpose = "swap" | "transfer" | "withdraw" | "approve" | "revoke";

export type LocalSignRequest = {
  idempotencyKey: string;
  purpose: LocalPurpose;
  chainKey: string;
  chainId: number;
  to: string;
  value: string;
  dataHash: string;
  notionalUsd: string;
  recipient?: string;
  buyToken?: string;
  minOut?: string;
  nativeSell?: boolean;
  approval?: { token: string; amount: string };
};

export type LocalEvmTx = {
  kind: "evm";
  chainId: number;
  to: string;
  data: string;
  value: string;
  gas?: string;
  nonce?: number;
  maxFeePerGas?: string;
  maxPriorityFeePerGas?: string;
};

export type LocalSolanaTx = { kind: "solana"; serializedBase64: string };

export type LocalHyperliquidTx = {
  kind: "hyperliquid";
  action: { type: string };
  nonce: number;
  isMainnet: boolean;
};

export type LocalSignTx = LocalEvmTx | LocalSolanaTx | LocalHyperliquidTx;

export type LocalPolicyInput = {
  manifest: DeploymentManifestV2;
  kill: { filePresent: boolean; env?: string };
  approvalsMacOk: boolean;
  request: LocalSignRequest;
  tx: LocalSignTx;
  spend: LocalSpendJournal;
  now: Date;
  owner: string;
  allowHotApproval: boolean;
  maxLeverage: number;
  recoveryTokens?: readonly string[];
};

type EvmDecoded = {
  kind: "evm";
  chainId: number;
  to: string;
  data: Hex;
  value: string;
  dataHash: string;
  terms: SwapTerms | null;
};

type SolanaDecoded = { kind: "solana"; message: SolanaMessage };

type HyperliquidDecoded = { kind: "hyperliquid"; action: { type: string } };

type Decoded = EvmDecoded | SolanaDecoded | HyperliquidDecoded;

const POLICY_CODES: Readonly<Record<string, Exclude<LocalDenyCode, "missing_cap">>> = {
  "chain is not in the signing policy": "chain_denied",
  "native value exceeds the signing policy": "native_value_cap",
  "withdraw destination is not allowlisted": "transfer_recipient_denied",
  "token withdraw must not attach native value": "native_value_cap",
  "withdraw calldata is not a transfer": "tx_undecodable",
  "token is not in the recovery allowlist": "purpose_denied",
  "token sell must not attach native value": "native_value_cap",
  "router allowlist is empty": "router_not_approved",
  "transaction destination is not an allowlisted router": "router_not_approved",
  "swap recipient is not the hot wallet": "tx_mismatch",
  "0x exec operator is not its target": "settler_not_approved",
  "0x target is not a pinned Settler": "settler_not_approved",
  "0x exec does not call a Settler": "settler_not_approved",
  "swap calldata does not name a checkable recipient": "opaque_calldata",
  "approval must not attach native value": "native_value_cap",
  "approval target is not the sold token": "tx_mismatch",
  "approval calldata is not approve": "tx_undecodable",
  "revoke amount is not zero": "tx_mismatch",
  "approval is not cached": "purpose_denied",
  "approval amount is not the exact sell amount": "tx_mismatch",
  "approval spender is not an allowlisted router": "router_not_approved",
  "solana instruction account is not a static key": "tx_undecodable",
  "solana native transfer source is not the hot wallet": "tx_mismatch",
  "solana native transfer destination is not allowlisted": "transfer_recipient_denied",
  "solana token transfer destination is not allowlisted": "transfer_recipient_denied",
  "solana close account destination is not the hot wallet": "tx_mismatch",
  "solana token account owner is not the hot wallet": "tx_mismatch",
  "jupiter transfer authority is not the hot wallet": "tx_mismatch",
  "jupiter platform fee account is set": "purpose_denied",
  "jupiter destination is not a hot wallet token account": "transfer_recipient_denied",
  "associated account funder is not the hot wallet": "tx_mismatch",
  "associated account owner is not allowlisted": "transfer_recipient_denied",
  "solana fee payer is not the hot wallet": "tx_mismatch",
  "solana jito tip exceeds the signing policy": "purpose_denied",
  "solana priority fee exceeds the signing policy": "purpose_denied",
  "leverage exceeds the signing policy": "purpose_denied",
};

function deny(code: Exclude<LocalDenyCode, "missing_cap">): LocalDecision {
  return { ok: false, code };
}

function denyCap(cap: LocalCapField): LocalDecision {
  return { ok: false, code: "missing_cap", cap };
}

function killOn(kill: LocalPolicyInput["kill"]): boolean {
  return kill.filePresent || kill.env === "1" || kill.env === "true";
}

function sameAddress(left: string, right: string): boolean {
  return left.toLowerCase() === right.toLowerCase();
}

function digit(value: string): bigint | null {
  return /^\d+$/.test(value) ? BigInt(value) : null;
}

function listed(chains: readonly string[], key: string): boolean {
  return chains.some((item) => item === key);
}

function calldataBytes(data: string): Buffer | null {
  if (!/^0x[0-9a-fA-F]*$/.test(data) || data.length % 2 !== 0) return null;
  return Buffer.from(data.slice(2), "hex");
}

function codeForPolicyError(message: string): Exclude<LocalDenyCode, "missing_cap"> {
  if (message.startsWith("solana program is not allowlisted") || message.startsWith("solana instruction is not allowed")) {
    return "program_not_approved";
  }
  if (message.startsWith("solana ") && message.endsWith("instruction is truncated")) return "tx_undecodable";
  if (message.startsWith("refusing hyperliquid action") || message.startsWith("unsupported hyperliquid action")) return "purpose_denied";
  return POLICY_CODES[message] ?? "purpose_denied";
}

function solanaMessage(serialized: Uint8Array): SolanaMessage {
  const { message } = VersionedTransaction.deserialize(serialized);
  const keys = message.staticAccountKeys.map((key) => key.toBase58());
  return {
    feePayer: keys[0] ?? "",
    staticKeys: keys,
    instructions: message.compiledInstructions.map((ix) => ({
      program: keys[ix.programIdIndex] ?? "",
      accounts: ix.accountKeyIndexes.map((index) => keys[index] ?? null),
      data: ix.data,
    })),
  };
}

function decodeTx(tx: LocalSignTx): { ok: true; tx: Decoded } | { ok: false } {
  if (tx.kind === "solana") {
    try {
      const bytes = Buffer.from(tx.serializedBase64, "base64");
      if (bytes.length === 0) return { ok: false };
      return { ok: true, tx: { kind: "solana", message: solanaMessage(bytes) } };
    } catch {
      return { ok: false };
    }
  }
  if (tx.kind === "hyperliquid") {
    if (typeof tx.action?.type !== "string" || !Number.isInteger(tx.nonce)) return { ok: false };
    return { ok: true, tx: { kind: "hyperliquid", action: tx.action } };
  }
  if (!Number.isInteger(tx.chainId) || digit(tx.value) === null) return { ok: false };
  const bytes = calldataBytes(tx.data);
  if (!bytes) return { ok: false };
  const data = tx.data as Hex;
  return {
    ok: true,
    tx: {
      kind: "evm",
      chainId: tx.chainId,
      to: tx.to,
      data,
      value: tx.value,
      dataHash: createHash("sha256").update(bytes).digest("hex"),
      terms: swapTerms(data),
    },
  };
}

function chainDecision(chains: readonly string[], tx: Decoded): LocalDecision | null {
  if (tx.kind === "hyperliquid") return listed(chains, "hypercore") ? null : deny("purpose_denied");
  if (tx.kind === "solana") return listed(chains, "solana") ? null : deny("chain_denied");
  if (!evmChainIds().includes(tx.chainId)) return deny("chain_denied");
  const key = chainByEvmId(tx.chainId)?.key;
  if (!key || !listed(chains, key)) return deny("chain_denied");
  return null;
}

function matchRequest(request: LocalSignRequest, tx: Decoded): LocalDecision | null {
  if (tx.kind === "solana") return request.chainKey === "solana" ? null : deny("tx_mismatch");
  if (tx.kind === "hyperliquid") return request.chainKey === "hypercore" ? null : deny("tx_mismatch");
  if (request.chainId !== tx.chainId || request.chainKey !== chainByEvmId(tx.chainId)?.key) return deny("tx_mismatch");
  if (!sameAddress(request.to, tx.to)) return deny("tx_mismatch");
  const requestedValue = digit(request.value);
  const txValue = digit(tx.value);
  if (requestedValue === null || txValue === null || requestedValue !== txValue) return deny("tx_mismatch");
  const hash = request.dataHash.toLowerCase().replace(/^0x/, "");
  if (!/^[0-9a-f]{64}$/.test(hash) || hash !== tx.dataHash) return deny("tx_mismatch");
  if (!tx.terms) return null;
  const minOut = request.minOut === undefined ? null : digit(request.minOut);
  if (!request.recipient || !request.buyToken || minOut === null) return deny("tx_mismatch");
  if (!sameAddress(request.recipient, tx.terms.recipient) || !sameAddress(request.buyToken, tx.terms.buyToken) || minOut !== tx.terms.minOut) {
    return deny("tx_mismatch");
  }
  return null;
}

function evmPurpose(purpose: LocalPurpose): EvmPurpose {
  return purpose === "transfer" ? "withdraw" : purpose;
}

function approvalOf(request: LocalSignRequest): EvmApproval | undefined {
  if (!request.approval || digit(request.approval.amount) === null) return undefined;
  return { token: request.approval.token, amount: BigInt(request.approval.amount) };
}

function runAsserts(input: LocalPolicyInput, tx: Decoded, manifest: DeploymentManifestV2, maxValueWei: string): LocalDecision | null {
  try {
    if (tx.kind === "evm") {
      if (input.request.approval && digit(input.request.approval.amount) === null) return deny("tx_mismatch");
      assertEvmSigning({
        chainId: tx.chainId,
        to: tx.to,
        data: tx.data,
        value: BigInt(tx.value),
        purpose: evmPurpose(input.request.purpose),
        routers: manifest.routers?.[String(tx.chainId)] ?? [],
        settlers: manifest.settlers?.[String(tx.chainId)] ?? [],
        withdrawAllowlist: manifest.transferRecipients ?? [],
        maxValueWei: BigInt(maxValueWei),
        allowHotApproval: input.allowHotApproval,
        owner: input.owner,
        allowOpaqueSwap: false,
        nativeSell: input.request.nativeSell === true,
        recoveryTokens: input.recoveryTokens ?? [],
        approval: approvalOf(input.request),
      });
      return null;
    }
    if (tx.kind === "solana") {
      if (input.request.purpose === "approve" || input.request.purpose === "revoke") return deny("purpose_denied");
      assertSolanaSigning({
        message: tx.message,
        expectedFeePayer: input.owner,
        allowlist: manifest.solanaPrograms,
        withdrawAllowlist: manifest.transferRecipients ?? [],
        maxTipLamports: 0,
        maxPriorityLamports: 0,
      });
      return null;
    }
    if (input.request.purpose !== "swap") return deny("purpose_denied");
    assertHyperliquidSigning(tx.action, input.maxLeverage);
    return null;
  } catch (error) {
    const message = error instanceof Error ? error.message : "";
    return deny(codeForPolicyError(message));
  }
}

function bindNotional(input: LocalPolicyInput, maxUsdPerTrade: string, dailyUsdCap: string): LocalDecision {
  const notional = digit(input.request.notionalUsd);
  if (notional === null) return deny("tx_mismatch");
  if (notional <= 0n || notional > BigInt(maxUsdPerTrade)) return deny("per_trade_cap");
  const day = spendDay(input.now, "UTC");
  const active = input.spend.day === day ? input.spend : { day, spentUsd: "0", keys: {} };
  const spent = digit(active.spentUsd);
  if (spent === null) return deny("approvals_integrity");
  const previous = active.keys[input.request.idempotencyKey];
  if (previous !== undefined) {
    const counted = digit(previous);
    if (counted === null) return deny("approvals_integrity");
    if (counted !== notional) return deny("tx_mismatch");
    if (spent > BigInt(dailyUsdCap)) return deny("daily_cap");
    return { ok: true, spend: { day, spentUsd: active.spentUsd, keys: active.keys } };
  }
  if (spent + notional > BigInt(dailyUsdCap)) return deny("daily_cap");
  return {
    ok: true,
    spend: {
      day,
      spentUsd: (spent + notional).toString(),
      keys: { ...active.keys, [input.request.idempotencyKey]: input.request.notionalUsd },
    },
  };
}

export function decideLocalPolicy(input: LocalPolicyInput): LocalDecision {
  if (killOn(input.kill)) return deny("kill_switch");
  if (!input.approvalsMacOk) return deny("approvals_integrity");
  if (input.manifest.chains === undefined) return denyCap("chains");
  if (input.manifest.maxUsdPerTrade === undefined) return denyCap("maxUsdPerTrade");
  if (input.manifest.dailyUsdCap === undefined) return denyCap("dailyUsdCap");
  if (input.manifest.maxValueWei === undefined) return denyCap("maxValueWei");
  const needsRecipient = input.request.purpose === "transfer" || input.request.purpose === "withdraw";
  if (needsRecipient && input.manifest.transferRecipients === undefined) return denyCap("transferRecipients");

  const decoded = decodeTx(input.tx);
  if (!decoded.ok) return deny("tx_undecodable");
  const chain = chainDecision(input.manifest.chains, decoded.tx);
  if (chain) return chain;
  const mismatch = matchRequest(input.request, decoded.tx);
  if (mismatch) return mismatch;
  const asserted = runAsserts(input, decoded.tx, input.manifest, input.manifest.maxValueWei);
  if (asserted) return asserted;
  return bindNotional(input, input.manifest.maxUsdPerTrade, input.manifest.dailyUsdCap);
}
