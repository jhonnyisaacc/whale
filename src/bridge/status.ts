import { z } from "zod";
import type { AppConfig } from "../config.js";
import { ACROSS_BASE } from "../aggregators/bridge.js";
import type { ExecutableBridge } from "../signing-policy/bridge-terms.js";
import { withTimeout } from "../timeout.js";
import { readVendorText, vendorResponse } from "../vendor-fetch.js";

export type BridgeState = "pending" | "landed" | "expired" | "refunded" | "failed" | "not_found";

export type BridgeStatus = { provider: ExecutableBridge; state: BridgeState; sourceTx: string; destinationTx: string | null; detail: string };

export type BridgeLookup = { provider: ExecutableBridge; fromChainId: number; txHash: string };

const TERMINAL: ReadonlySet<BridgeState> = new Set(["landed", "refunded", "failed"]);

const lifiStatusSchema = z
  .object({
    status: z.string(),
    substatus: z.string().nullish(),
    sending: z.object({ txHash: z.string().nullish() }).loose().nullish(),
    receiving: z.object({ txHash: z.string().nullish() }).loose().nullish(),
  })
  .loose();

const acrossStatusSchema = z
  .object({ status: z.string().optional(), depositTxHash: z.string().nullish(), fillTx: z.string().nullish(), depositRefundTxHash: z.string().nullish(), error: z.string().optional() })
  .loose();

const LIFI_STATES: Readonly<Record<string, BridgeState>> = { PENDING: "pending", FAILED: "failed", NOT_FOUND: "not_found", INVALID: "not_found" };
const ACROSS_STATES: Readonly<Record<string, BridgeState>> = { pending: "pending", slowFillRequested: "pending", filled: "landed", expired: "expired", refunded: "refunded" };

const sameHash = (left: string | null | undefined, right: string) => typeof left === "string" && left.toLowerCase() === right.toLowerCase();

export function readLifiStatus(lookup: BridgeLookup, body: unknown): BridgeStatus {
  const base = { provider: "lifi" as const, sourceTx: lookup.txHash, destinationTx: null };
  const parsed = lifiStatusSchema.safeParse(body);
  if (!parsed.success) return { ...base, state: "not_found", detail: "LI.FI answered without a status" };
  const { status, substatus, sending, receiving } = parsed.data;
  if (status !== "NOT_FOUND" && !sameHash(sending?.txHash, lookup.txHash)) return { ...base, state: "not_found", detail: "LI.FI answered for another transfer" };
  const state = status === "DONE" ? (substatus === "REFUNDED" ? "refunded" : "landed") : (LIFI_STATES[status] ?? "pending");
  return { ...base, state, destinationTx: state === "landed" ? (receiving?.txHash ?? null) : null, detail: [status, substatus].filter(Boolean).join(" ") };
}

export function readAcrossStatus(lookup: BridgeLookup, body: unknown): BridgeStatus {
  const base = { provider: "across" as const, sourceTx: lookup.txHash, destinationTx: null };
  const parsed = acrossStatusSchema.safeParse(body);
  if (!parsed.success || parsed.data.error === "DepositNotFoundException") return { ...base, state: "not_found", detail: "Across has no deposit for this transaction yet" };
  const { status, depositTxHash, fillTx, depositRefundTxHash } = parsed.data;
  if (!status || !sameHash(depositTxHash, lookup.txHash)) return { ...base, state: "not_found", detail: "Across answered for another deposit" };
  const state = ACROSS_STATES[status] ?? "pending";
  return { ...base, state, destinationTx: state === "landed" ? (fillTx ?? null) : state === "refunded" ? (depositRefundTxHash ?? null) : null, detail: status };
}

function statusUrl(config: AppConfig, lookup: BridgeLookup): string {
  if (lookup.provider === "lifi") return `${config.lifiBase}/status?${new URLSearchParams({ txHash: lookup.txHash, fromChain: String(lookup.fromChainId) })}`;
  return `${ACROSS_BASE}/deposit/status?${new URLSearchParams({ originChainId: String(lookup.fromChainId), depositTxHash: lookup.txHash })}`;
}

export async function bridgeStatus(config: AppConfig, lookup: BridgeLookup, fetchImpl: typeof fetch = fetch): Promise<BridgeStatus> {
  const body = await withTimeout(config.bridgeQuoteTimeoutMs, async (signal) => {
    const response = await vendorResponse(fetchImpl, statusUrl(config, lookup), { signal });
    const text = await readVendorText(response);
    if (!response.ok && response.status !== 404) throw new Error(`${lookup.provider} status answered ${response.status}`);
    return JSON.parse(text) as unknown;
  });
  return lookup.provider === "lifi" ? readLifiStatus(lookup, body) : readAcrossStatus(lookup, body);
}

export type TrackIo = { now(): number; sleep(ms: number): Promise<void>; pollMs: number };

export async function trackBridge(lookup: BridgeLookup, read: (lookup: BridgeLookup) => Promise<BridgeStatus>, io: TrackIo, deadlineMs: number): Promise<BridgeStatus> {
  let last: BridgeStatus = { provider: lookup.provider, state: "pending", sourceTx: lookup.txHash, destinationTx: null, detail: "no status answer yet" };
  for (;;) {
    last = await read(lookup).catch(() => last);
    if (TERMINAL.has(last.state) || io.now() >= deadlineMs) return last;
    await io.sleep(io.pollMs);
  }
}
