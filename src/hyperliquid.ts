import { encode } from "@msgpack/msgpack";
import { withTimeout } from "./timeout.js";
import { keccak256 } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import type { Hex } from "viem";
import { Secret } from "./redact.js";
import { readVendorText, vendorResponse } from "./vendor-fetch.js";

export type OrderAction = {
  type: "order";
  orders: Array<{
    a: number;
    b: boolean;
    p: string;
    s: string;
    r: boolean;
    t: { limit: { tif: "Ioc" | "Gtc" | "Alo" } };
  }>;
  grouping: "na";
};

export type CancelAction = {
  type: "cancel";
  cancels: Array<{ a: number; o: number }>;
};

export type LeverageAction = {
  type: "updateLeverage";
  asset: number;
  isCross: boolean;
  leverage: number;
};

export type HyperliquidAction = OrderAction | CancelAction | LeverageAction;

const FORBIDDEN = new Set([
  "withdraw3",
  "usdSend",
  "spotSend",
  "sendAsset",
  "agentSendAsset",
  "usdClassTransfer",
  "vaultTransfer",
  "approveAgent",
]);

export function assertTradableAction(action: { type: string }): asserts action is HyperliquidAction {
  if (FORBIDDEN.has(action.type)) {
    throw new Error(`refusing hyperliquid action ${action.type}`);
  }
  if (action.type !== "order" && action.type !== "cancel" && action.type !== "updateLeverage") {
    throw new Error(`unsupported hyperliquid action ${action.type}`);
  }
}

export function floatToWire(value: number): string {
  const rounded = value.toFixed(8);
  if (Math.abs(Number(rounded) - value) >= 1e-12) {
    throw new Error("floatToWire rounding");
  }
  const trimmed = rounded.replace(/\.?0+$/, "");
  return trimmed === "-0" || trimmed === "" ? "0" : trimmed;
}

export function buildOrder(input: {
  asset: number;
  isBuy: boolean;
  limitPx: number;
  size: number;
  reduceOnly?: boolean;
}): OrderAction {
  return {
    type: "order",
    orders: [
      {
        a: input.asset,
        b: input.isBuy,
        p: floatToWire(input.limitPx),
        s: floatToWire(input.size),
        r: input.reduceOnly ?? false,
        t: { limit: { tif: "Ioc" } },
      },
    ],
    grouping: "na",
  };
}

export function buildLeverage(asset: number, leverage: number): LeverageAction {
  if (!Number.isInteger(leverage) || leverage < 1) throw new Error("leverage must be an integer >= 1");
  return { type: "updateLeverage", asset, isCross: false, leverage };
}

export function cappedLimitPx(mark: number, isBuy: boolean, capBps: number): number {
  if (!(mark > 0)) throw new Error("mark price missing");
  if (!Number.isInteger(capBps) || capBps < 0) throw new Error("slippage cap is negative");
  const factor = capBps / 10_000;
  const raw = isBuy ? mark * (1 + factor) : mark * (1 - factor);
  if (!(raw > 0)) throw new Error("capped limit is not positive");
  return Number(raw.toFixed(8));
}

export async function assertApprovedAgent(url: string, master: string, agent: string, fetchImpl: typeof fetch, nowMs = Date.now()): Promise<void> {
  const body: unknown = await withTimeout(1500, async (signal) => {
    const response = await vendorResponse(fetchImpl, `${url.replace(/\/$/, "")}/info`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ type: "extraAgents", user: master }),
      signal,
    });
    if (!response.ok) throw new Error("hyperliquid agent check failed");
    return JSON.parse(await readVendorText(response)) as unknown;
  });
  if (!Array.isArray(body)) throw new Error("hyperliquid agent is not approved");
  const agents = body.flatMap((row) => {
    if (typeof row !== "object" || row === null || typeof (row as { address?: unknown }).address !== "string") return [];
    const validUntil = (row as { validUntil?: unknown }).validUntil;
    return [{ address: (row as { address: string }).address, validUntil: typeof validUntil === "number" ? validUntil : null }];
  });
  if (!agentIsApproved(agents, agent, nowMs)) throw new Error("hyperliquid agent is not approved");
}

export function agentIsApproved(agents: readonly { address?: string; validUntil?: number | null }[], address: string, nowMs = Date.now()): boolean {
  const target = address.toLowerCase();
  return agents.some((agent) => {
    if (typeof agent.address !== "string" || agent.address.toLowerCase() !== target) return false;
    if (agent.validUntil == null) return true;
    return agent.validUntil > nowMs;
  });
}

function addressToBytes(address: string): Uint8Array {
  const hex = address.startsWith("0x") ? address.slice(2) : address;
  return Uint8Array.from(Buffer.from(hex, "hex"));
}

export function actionHash(action: HyperliquidAction, vaultAddress: string | null, nonce: number, expiresAfter: number | null): Hex {
  assertTradableAction(action);
  const packed = encode(action);
  const nonceBytes = Buffer.alloc(8);
  nonceBytes.writeBigUInt64BE(BigInt(nonce));
  const parts: Uint8Array[] = [packed, nonceBytes];
  if (vaultAddress === null) parts.push(Uint8Array.of(0));
  else parts.push(Uint8Array.of(1), addressToBytes(vaultAddress));
  if (expiresAfter !== null) {
    const expiry = Buffer.alloc(8);
    expiry.writeBigUInt64BE(BigInt(expiresAfter));
    parts.push(Uint8Array.of(0), expiry);
  }
  const data = Buffer.concat(parts.map((part) => Buffer.from(part)));
  return keccak256(data);
}

export async function signL1Action(privateKey: Secret, action: HyperliquidAction, nonce: number, isMainnet: boolean): Promise<{ r: Hex; s: Hex; v: number }> {
  assertTradableAction(action);
  const connectionId = actionHash(action, null, nonce, null);
  const account = privateKeyToAccount(privateKey.reveal() as `0x${string}`);
  const signature = await account.signTypedData({
    domain: {
      name: "Exchange",
      version: "1",
      chainId: 1337,
      verifyingContract: "0x0000000000000000000000000000000000000000",
    },
    types: {
      Agent: [
        { name: "source", type: "string" },
        { name: "connectionId", type: "bytes32" },
      ],
    },
    primaryType: "Agent",
    message: { source: isMainnet ? "a" : "b", connectionId },
  });
  return {
    r: `0x${signature.slice(2, 66)}` as Hex,
    s: `0x${signature.slice(66, 130)}` as Hex,
    v: Number.parseInt(signature.slice(130, 132), 16),
  };
}

export function orderSize(notionalUsd: number, markPx: number, szDecimals: number): number {
  if (!(markPx > 0)) throw new Error("mark price missing");
  if (!Number.isInteger(szDecimals) || szDecimals < 0) throw new Error("hyperliquid szDecimals missing");
  const factor = 10 ** szDecimals;
  const size = Math.floor(Number(((notionalUsd / markPx) * factor).toPrecision(12))) / factor;
  if (!(size > 0)) throw new Error("hyperliquid order size rounds to zero");
  return Number(size.toFixed(szDecimals));
}

export function wirePrice(px: number, szDecimals: number, market: "perp" | "spot", isBuy: boolean): number {
  if (!(px > 0)) throw new Error("limit price is not positive");
  if (Number.isInteger(px)) return px;
  const maxDecimals = Math.max(0, (market === "spot" ? 8 : 6) - szDecimals);
  const sigDecimals = 5 - (Math.floor(Math.log10(px)) + 1);
  const decimals = Math.max(0, Math.min(maxDecimals, sigDecimals));
  const factor = 10 ** decimals;
  const scaled = Number((px * factor).toPrecision(12));
  const rounded = (isBuy ? Math.floor(scaled) : Math.ceil(scaled)) / factor;
  if (!(rounded > 0)) throw new Error("limit price rounds to zero");
  return Number(rounded.toFixed(decimals));
}

let lastNonce = 0;

export function nextHyperliquidNonce(now = Date.now()): number {
  lastNonce = Math.max(now, lastNonce + 1);
  return lastNonce;
}

const szCache = new Map<string, number>();

export function resetSzDecimals(): void {
  szCache.clear();
}

export async function fetchSzDecimals(url: string, market: { market: "perp" | "spot"; assetIndex: number }, fetchImpl: typeof fetch = fetch): Promise<number | null> {
  const key = `${url}|${market.market}|${market.assetIndex}`;
  const cached = szCache.get(key);
  if (cached !== undefined) return cached;
  type Meta = {
    universe?: Array<{ szDecimals?: number; tokens?: number[]; index?: number }>;
    tokens?: Array<{ szDecimals?: number; index?: number }>;
  };
  const body = await withTimeout(1500, async (signal) => {
    const response = await vendorResponse(fetchImpl, `${url.replace(/\/$/, "")}/info`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ type: market.market === "spot" ? "spotMeta" : "meta" }),
      signal,
    });
    return response.ok ? (JSON.parse(await readVendorText(response)) as Meta) : null;
  });
  if (!body) return null;
  let value: number | undefined;
  if (market.market === "perp") {
    value = body.universe?.[market.assetIndex]?.szDecimals;
  } else {
    const spotIndex = market.assetIndex >= 10_000 ? market.assetIndex - 10_000 : market.assetIndex;
    const pair = body.universe?.find((row) => row.index === spotIndex);
    const base = pair?.tokens?.[0];
    value = body.tokens?.find((token) => token.index === base)?.szDecimals;
  }
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0) return null;
  szCache.set(key, value);
  return value;
}

export type ExchangeOutcome =
  | { status: "err"; error: string }
  | { status: "ok"; statuses: Array<{ filled?: { totalSz: string; avgPx: string }; error?: string; resting?: unknown }> };

export function readExchangeResponse(body: unknown): ExchangeOutcome {
  if (typeof body !== "object" || body === null) return { status: "err", error: "hyperliquid response is not an object" };
  const row = body as { status?: unknown; response?: unknown };
  if (row.status !== "ok") return { status: "err", error: typeof row.response === "string" ? row.response : "hyperliquid rejected the action" };
  const data = (row.response as { data?: { statuses?: unknown } } | undefined)?.data;
  const raw = Array.isArray(data?.statuses) ? data.statuses : [];
  const statuses = raw.map((item: unknown) => {
    if (typeof item !== "object" || item === null) return { error: "unknown order status" };
    const entry = item as { filled?: { totalSz?: unknown; avgPx?: unknown }; error?: unknown; resting?: unknown };
    if (typeof entry.error === "string") return { error: entry.error };
    if (entry.filled && typeof entry.filled.totalSz === "string" && typeof entry.filled.avgPx === "string") {
      return { filled: { totalSz: entry.filled.totalSz, avgPx: entry.filled.avgPx } };
    }
    if (entry.resting !== undefined) return { resting: entry.resting };
    return { error: "unknown order status" };
  });
  return { status: "ok", statuses };
}
