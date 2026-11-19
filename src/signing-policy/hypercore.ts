import { assertTradableAction, type HyperliquidAction, type WithdrawAction } from "../hyperliquid.js";

const SPOT_ASSETS = 10_000;
const BUILDER_ASSETS = 100_000;
const WITHDRAW_FIELDS = ["type", "hyperliquidChain", "signatureChainId", "destination", "amount", "time"];

export type HypercoreLimits = { maxLeverage: number; maxOrderUsd: number; sellLimits: Readonly<Record<string, bigint>> };
export type HypercoreWithdrawPolicy = { owner: string; withdrawAllowlist: readonly string[]; maxWithdrawUsd: number; isMainnet: boolean };

function refuse(reason: string): never {
  throw new Error(`hypercore: ${reason}`);
}

function exactly(value: unknown, fields: readonly string[], what: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) refuse(`${what} is not an object`);
  const actual = Object.keys(value).sort().join(",");
  if (actual !== [...fields].sort().join(",")) refuse(`${what} has fields the signer does not decode`);
  return value as Record<string, unknown>;
}

function wireNumber(value: unknown, what: string): number {
  if (typeof value !== "string" || !/^(0|[1-9]\d*)(\.\d*[1-9])?$/.test(value)) refuse(`${what} is not a plain decimal`);
  return Number(value);
}

function sizeUnits(size: string): bigint {
  const [whole = "", fraction = ""] = size.split(".");
  if (fraction.length > 8) refuse("order size has more than 8 decimals");
  return BigInt(whole + fraction.padEnd(8, "0"));
}

function orderNotional(order: unknown, sold: Map<string, bigint>): number {
  const row = exactly(order, ["a", "b", "p", "s", "r", "t"], "order");
  const limit = exactly(exactly(row.t, ["limit"], "order").limit, ["tif"], "order");
  if (limit.tif !== "Ioc") refuse("only immediate-or-cancel limit orders are signed");
  if (!Number.isSafeInteger(row.a) || (row.a as number) < 0) refuse("order asset is not an index");
  if ((row.a as number) >= BUILDER_ASSETS) refuse("builder-deployed perps are not signed");
  if (typeof row.b !== "boolean" || typeof row.r !== "boolean") refuse("order side or reduce-only is not a boolean");
  const notional = wireNumber(row.p, "order price") * wireNumber(row.s, "order size");
  if (!row.b && (row.a as number) < SPOT_ASSETS) {
    const key = `hypercore:perp:${row.a as number}:sold`;
    sold.set(key, (sold.get(key) ?? 0n) + sizeUnits(row.s as string));
  }
  return notional;
}

export function assertHyperliquidSigning(action: { type: string }, limits: HypercoreLimits): asserts action is HyperliquidAction {
  try {
    assertTradableAction(action);
  } catch (error) {
    refuse(error instanceof Error ? error.message : String(error));
  }
  if (action.type === "order") {
    const row = exactly(action, ["type", "orders", "grouping"], "order action");
    if (row.grouping !== "na") refuse("order grouping is not na");
    if (!Array.isArray(row.orders) || row.orders.length === 0) refuse("order action has no orders");
    const sold = new Map<string, bigint>();
    const notional = row.orders.reduce((sum: number, order: unknown) => sum + orderNotional(order, sold), 0);
    for (const [key, units] of sold) {
      const limit = limits.sellLimits[key];
      if (limit === undefined) refuse(`no limit is set for ${key}`);
      if (units > limit) refuse(`${units} of ${key} is above its ${limit} limit`);
    }
    if (!(notional > 0)) refuse("order notional is not positive");
    if (notional > limits.maxOrderUsd) refuse(`order notional ${notional} USD exceeds the ${limits.maxOrderUsd} USD signing policy`);
    return;
  }
  if (action.type === "cancel") {
    const row = exactly(action, ["type", "cancels"], "cancel action");
    if (!Array.isArray(row.cancels) || row.cancels.length === 0) refuse("cancel action has no cancels");
    for (const cancel of row.cancels) {
      const item = exactly(cancel, ["a", "o"], "cancel");
      if (!Number.isSafeInteger(item.a) || !Number.isSafeInteger(item.o)) refuse("cancel asset or order id is not an integer");
    }
    return;
  }
  const row = exactly(action, ["type", "asset", "isCross", "leverage"], "updateLeverage action");
  if (!Number.isSafeInteger(row.asset)) refuse("leverage asset is not an index");
  if (row.isCross !== false) refuse("only isolated leverage is signed");
  if (!Number.isSafeInteger(row.leverage) || (row.leverage as number) < 1) refuse("leverage is not a whole number of at least 1");
  if ((row.leverage as number) > limits.maxLeverage) refuse("leverage exceeds the signing policy");
}

export function assertHyperliquidWithdraw(action: WithdrawAction, policy: HypercoreWithdrawPolicy): void {
  const row = exactly(action, WITHDRAW_FIELDS, "withdraw");
  if (row.type !== "withdraw3") refuse("withdraw is not withdraw3");
  const expected = policy.isMainnet ? "Mainnet" : "Testnet";
  if (row.hyperliquidChain !== expected) refuse(`withdraw names ${String(row.hyperliquidChain)} but the signer is on ${expected}`);
  if (row.signatureChainId !== "0x66eee") refuse("withdraw signatureChainId is not 0x66eee");
  if (typeof row.destination !== "string" || !/^0x[0-9a-f]{40}$/.test(row.destination)) refuse("withdraw destination is not a lowercase evm address");
  const allowed = [policy.owner, ...policy.withdrawAllowlist].map((item) => item.toLowerCase());
  if (!allowed.includes(row.destination)) refuse("withdraw destination is not this wallet or allowlisted");
  if (typeof row.amount !== "string" || !/^(0|[1-9]\d*)(\.\d{0,5}[1-9])?$/.test(row.amount) || !(Number(row.amount) > 0)) refuse("withdraw amount is not a positive USD amount");
  if (Number(row.amount) > policy.maxWithdrawUsd) refuse(`withdraw amount ${row.amount} USD exceeds the ${policy.maxWithdrawUsd} USD signing policy`);
  if (!Number.isSafeInteger(row.time) || (row.time as number) <= 0) refuse("withdraw time is not a millisecond timestamp");
}
