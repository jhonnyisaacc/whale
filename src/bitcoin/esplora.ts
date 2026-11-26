import { Transaction } from "@scure/btc-signer";
import { z } from "zod";
import { withTimeout } from "../timeout.js";
import { readVendorText, vendorResponse } from "../vendor-fetch.js";

export type Utxo = { readonly txid: string; readonly vout: number; readonly sats: bigint; readonly confirmed: boolean };
export type AddressBalance = { readonly confirmedSats: bigint; readonly pendingSats: bigint };

export type BitcoinIndexer = {
  utxos(address: string): Promise<Utxo[]>;
  transaction(txid: string): Promise<Uint8Array>;
  feeRate(): Promise<number>;
  balance(address: string): Promise<AddressBalance>;
  simulate(signed: Uint8Array): Promise<void>;
  broadcast(signed: Uint8Array): Promise<string>;
  transactionStatus(txid: string): Promise<"landed" | "pending" | null>;
};

export class SimulationRefused extends Error {}

export const RAW_TX_OPTIONS = { allowUnknownOutputs: true, allowUnknownInputs: true, disableScriptCheck: true } as const;

const ESPLORA_TIMEOUT_MS = 10_000;
const txid = z.string().regex(/^[0-9a-f]{64}$/);
const sats = z.number().int().nonnegative().max(21e14).transform(BigInt);

export const utxoList = z
  .array(z.object({ txid, vout: z.number().int().nonnegative().max(1_000_000), value: sats, status: z.object({ confirmed: z.boolean() }).loose() }).loose())
  .max(5_000);
const stats = z.object({ funded_txo_sum: sats, spent_txo_sum: sats }).loose();
export const addressInfo = z.object({ chain_stats: stats, mempool_stats: stats }).loose();
export const feeEstimates = z.record(z.string(), z.number().positive().finite());
export const txHex = z.string().trim().regex(/^(?:[0-9a-f]{2})+$/).min(120).max(800_000);
export const mempoolTest = z.tuple([z.object({ txid, allowed: z.boolean(), "reject-reason": z.string().nullish() }).loose()]);

const BITCOIND_REASONS = [
  "missing-inputs",
  "bad-txns-inputs-missingorspent",
  "bad-txns-inputs-duplicate",
  "bad-txns-in-belowout",
  "bad-txns-vout-negative",
  "bad-txns-vin-empty",
  "bad-txns-vout-empty",
  "bad-txns-oversize",
  "bad-txns-nonstandard-inputs",
  "bad-txns-too-many-sigops",
  "bad-txns-premature-spend-of-coinbase",
  "bad-txns-spends-conflicting-tx",
  "bad-witness-nonstandard",
  "txn-mempool-conflict",
  "txn-already-in-mempool",
  "txn-already-known",
  "txn-same-nonwitness-data-in-mempool",
  "min relay fee not met",
  "mempool min fee not met",
  "insufficient fee",
  "mempool full",
  "too-long-mempool-chain",
  "too many potential replacements",
  "replacement-adds-unconfirmed",
  "non-mandatory-script-verify-flag",
  "mandatory-script-verify-flag-failed",
  "mempool-script-verify-flag-failed",
  "max-fee-exceeded",
  "absurdly-high-fee",
  "dust",
  "tx-size",
  "tx-size-small",
  "scriptpubkey",
  "scriptsig-size",
  "scriptsig-not-pushonly",
  "bare-multisig",
  "multi-op-return",
  "version",
  "non-final",
  "non-BIP68-final",
  "Transaction already in block chain",
  "Transaction outputs already in utxo set",
  "Fee exceeds maximum configured by user",
  "TX decode failed",
];

const UNKNOWN_BITCOIND_REASON = "reason not in a known bitcoind format";

const rpcErrorBody = z.object({ message: z.string() }).loose();

function rpcMessage(text: string): string {
  const json = /^sendrawtransaction RPC error: (\{.*\})$/s.exec(text)?.[1];
  if (!json) return text;
  try {
    return rpcErrorBody.parse(JSON.parse(json)).message;
  } catch {
    return text;
  }
}

function bitcoindReason(text: string): string {
  const message = rpcMessage(text.trim());
  return BITCOIND_REASONS.find((reason) => message === reason || [",", " (", ":"].some((separator) => message.startsWith(`${reason}${separator}`))) ?? UNKNOWN_BITCOIND_REASON;
}

export function transactionId(raw: Uint8Array): string {
  return Transaction.fromRaw(raw, RAW_TX_OPTIONS).id;
}

export function parseUtxos(body: unknown): Utxo[] {
  return utxoList.parse(body).map((row) => ({ txid: row.txid, vout: row.vout, sats: row.value, confirmed: row.status.confirmed }));
}

export function parseBalance(body: unknown): AddressBalance {
  const info = addressInfo.parse(body);
  const confirmedSats = info.chain_stats.funded_txo_sum - info.chain_stats.spent_txo_sum;
  if (confirmedSats < 0n) throw new Error("esplora reports more confirmed sats spent than received");
  return { confirmedSats, pendingSats: info.mempool_stats.funded_txo_sum - info.mempool_stats.spent_txo_sum };
}

export function parseFeeRate(body: unknown): number {
  const rate = feeEstimates.parse(body)["3"];
  if (rate === undefined) throw new Error("esplora has no 3-block fee estimate");
  return Math.max(1, Math.ceil(rate));
}

export function parseMempoolTest(body: unknown, expected: string): void {
  const [result] = mempoolTest.parse(body);
  if (result.txid !== expected) throw new Error(`esplora tested txid ${result.txid} for transaction ${expected}`);
  if (!result.allowed) throw new SimulationRefused(`simulation rejected the transaction: ${result["reject-reason"] ? bitcoindReason(result["reject-reason"]) : "no reason given"}`);
}

const txStatus = z.object({ status: z.object({ confirmed: z.boolean() }).loose() }).loose();

export function parseTransactionStatus(body: unknown): "landed" | "pending" {
  return txStatus.parse(body).status.confirmed ? "landed" : "pending";
}

export function parseTransaction(body: string, expected: string): Uint8Array {
  const raw = Buffer.from(txHex.parse(body), "hex");
  if (transactionId(raw) !== expected) throw new Error(`esplora returned a transaction that does not hash to ${expected}`);
  return new Uint8Array(raw);
}

function decode<T>(route: string, text: string, parse: (body: unknown) => T): T {
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    throw new Error(`esplora ${route} answered a body that is not json`);
  }
  try {
    return parse(body);
  } catch (error) {
    throw error instanceof z.ZodError ? new Error(`esplora ${route} answered an unexpected shape`) : error;
  }
}

export function esploraIndexer(baseUrl: string, fetchImpl: typeof fetch = fetch): BitcoinIndexer {
  const base = baseUrl.replace(/\/$/, "");
  const request = (route: string, init: RequestInit = {}) =>
    withTimeout(ESPLORA_TIMEOUT_MS, async (signal) => {
      const response = await vendorResponse(fetchImpl, `${base}${route}`, { ...init, signal });
      return { status: response.status, ok: response.ok, text: await readVendorText(response) };
    });
  const read = async (route: string) => {
    const response = await request(route);
    if (!response.ok) throw new Error(`esplora ${route.split("/")[1]} read failed ${response.status}`);
    return response.text;
  };
  const json = async <T>(route: string, parse: (body: unknown) => T): Promise<T> => decode(route.split("/")[1] ?? route, await read(route), parse);
  return {
    utxos: async (address) => json(`/address/${encodeURIComponent(address)}/utxo`, parseUtxos),
    transaction: async (id) => parseTransaction(await read(`/tx/${txid.parse(id)}/hex`), id),
    feeRate: async () => json("/fee-estimates", parseFeeRate),
    balance: async (address) => json(`/address/${encodeURIComponent(address)}`, parseBalance),
    async simulate(signed) {
      const response = await request("/txs/test", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify([Buffer.from(signed).toString("hex")]) });
      if (!response.ok) throw new Error(`esplora could not simulate the transaction: txs/test answered ${response.status}`);
      const expected = transactionId(signed);
      decode("txs/test", response.text, (body) => parseMempoolTest(body, expected));
    },
    async broadcast(signed) {
      const expected = transactionId(signed);
      const response = await request("/tx", { method: "POST", headers: { "content-type": "text/plain" }, body: Buffer.from(signed).toString("hex") });
      if (!response.ok) throw new Error(`esplora broadcast failed ${response.status}: ${bitcoindReason(response.text)}`);
      const answered = txid.safeParse(response.text.trim());
      if (!answered.success) throw new Error(`esplora answered another txid for transaction ${expected}`);
      if (answered.data !== expected) throw new Error(`esplora answered txid ${answered.data} for transaction ${expected}`);
      return expected;
    },
    async transactionStatus(id) {
      const expected = txid.parse(id);
      const response = await request(`/tx/${expected}`);
      if (response.status === 404) return null;
      if (!response.ok) throw new Error(`esplora tx status failed ${response.status}`);
      return decode("tx", response.text, parseTransactionStatus);
    },
  };
}
