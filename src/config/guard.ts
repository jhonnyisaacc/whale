import { CHAINS } from "../chains.js";
import { isSolanaAddress } from "../signer.js";
import { kyberSupports } from "../aggregators.js";
import { DEFAULT_KYBER_CLIENT_ID } from "./types.js";
import type { AppConfig } from "./types.js";

export const OFFICIAL_HTTP = {
  zeroExBase: "https://api.0x.org",
  jupiterBase: "https://api.jup.ag/swap/v1",
  lifiBase: "https://li.quest/v1",
  oneInchBase: "https://api.1inch.com",
  kyberBase: "https://aggregator-api.kyberswap.com",
  veloraBase: "https://api.velora.xyz",
  hyperliquidUrl: "https://api.hyperliquid.xyz",
  coingeckoBase: "https://api.coingecko.com/api/v3",
  dexscreenerBase: "https://api.dexscreener.com",
  jitoUrl: "https://mainnet.block-engine.jito.wtf/api/v1/transactions",
  turnkey: "https://api.turnkey.com",
} as const;

export function sameBase(actual: string, official: string): boolean {
  try {
    const left = new URL(actual);
    const right = new URL(official);
    if (left.origin !== right.origin) return false;
    return left.pathname === right.pathname || left.pathname.startsWith(`${right.pathname}/`);
  } catch {
    return false;
  }
}

export function spendTimezone(raw: string | undefined): string {
  const timeZone = raw && raw.length > 0 ? raw : "UTC";
  try {
    new Intl.DateTimeFormat("en-CA", { timeZone }).format(new Date());
  } catch {
    throw new Error("invalid SPEND_TIMEZONE");
  }
  return timeZone;
}

export function chainAddressMap(raw: string, name: string, pattern = /./): Record<number, string[]> {
  const parsed: unknown = JSON.parse(raw);
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) throw new Error(`${name} must be an object`);
  const map: Record<number, string[]> = {};
  for (const [id, list] of Object.entries(parsed)) {
    if (!/^\d+$/.test(id) || !Array.isArray(list) || list.some((item) => typeof item !== "string" || !pattern.test(item))) {
      throw new Error(`${name} is invalid`);
    }
    map[Number(id)] = list;
  }
  return map;
}

export function reorgDepths(raw: string | undefined): Record<number, number> {
  if (!raw) return {};
  const parsed: unknown = JSON.parse(raw);
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) throw new Error("REORG_DEPTH_JSON must be an object");
  const map: Record<number, number> = {};
  for (const [id, depth] of Object.entries(parsed)) {
    if (!/^\d+$/.test(id) || !Number.isSafeInteger(depth) || (depth as number) < 0) throw new Error("REORG_DEPTH_JSON is invalid");
    map[Number(id)] = depth as number;
  }
  return map;
}

export function routerAllowlist(env: NodeJS.ProcessEnv): Record<number, string[]> {
  if (env.ROUTER_ALLOWLIST_JSON) return chainAddressMap(env.ROUTER_ALLOWLIST_JSON, "ROUTER_ALLOWLIST_JSON");
  const global = splitList(env.ROUTER_ALLOWLIST);
  const map: Record<number, string[]> = {};
  if (global.length === 0) return map;
  for (const chain of CHAINS) {
    if (chain.chain.kind === "evm") map[chain.chain.chainId] = [...global];
  }
  return map;
}

function isOwnerAddress(value: string): boolean {
  return /^0x[0-9a-fA-F]{40}$/.test(value) || isSolanaAddress(value);
}

export function assertLiveEdges(config: AppConfig, env: NodeJS.ProcessEnv): void {
  if (config.withdrawEnabled) {
    if (config.withdrawAllowlist.length === 0) throw new Error("WITHDRAW_ENABLED requires OWNER_WITHDRAW_ADDRESSES");
    for (const address of config.withdrawAllowlist) {
      if (!isOwnerAddress(address)) throw new Error("OWNER_WITHDRAW_ADDRESSES has an invalid address");
    }
    for (const token of config.tokenRecoveryAllowlist) {
      if (!isOwnerAddress(token)) throw new Error("TOKEN_RECOVERY_ALLOWLIST has an invalid address");
    }
  }
  if (!config.live) return;
  const fields = ["zeroExBase", "jupiterBase", "lifiBase", "oneInchBase", "kyberBase", "veloraBase", "hyperliquidUrl", "coingeckoBase", "dexscreenerBase"] as const;
  for (const field of fields) {
    if (!sameBase(config[field], OFFICIAL_HTTP[field])) throw new Error(`live mode pins ${field} to ${OFFICIAL_HTTP[field]}`);
  }
  if (config.jitoUrl && !sameBase(config.jitoUrl, OFFICIAL_HTTP.jitoUrl)) throw new Error(`live mode pins jitoUrl to ${OFFICIAL_HTTP.jitoUrl}`);
  if (env.TURNKEY_API_BASE && !sameBase(env.TURNKEY_API_BASE, OFFICIAL_HTTP.turnkey)) {
    throw new Error(`live mode pins TURNKEY_API_BASE to ${OFFICIAL_HTTP.turnkey}`);
  }
  assertServiceUrl(config.notifierUrl);
  assertServiceUrl(config.resolverUrl);
  for (const url of [...Object.values(config.rpcUrlsByChainKey).flat(), ...Object.values(config.mevRpcByChainId)]) assertRpcUrl(url);
  if (!config.keys.zeroEx) throw new Error("live mode requires ZEROX_API_KEY");
  if (Object.values(config.zeroExSettlers).flat().length === 0) throw new Error("live mode requires ZEROX_SETTLER_ALLOWLIST_JSON");
  const kyberChains = CHAINS.some((chain) => config.enabledChainKeys.has(chain.key) && chain.chain.kind === "evm" && kyberSupports(chain.chain.chainId));
  if (kyberChains && config.keys.kyberClientId === DEFAULT_KYBER_CLIENT_ID) throw new Error("live mode requires a unique KYBERSWAP_CLIENT_ID");
}

function assertRpcUrl(value: string): void {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error("live RPC URLs must be https or a railway.internal host");
  }
  const railway = url.hostname === "railway.internal" || url.hostname.endsWith(".railway.internal");
  if (url.protocol === "https:" || (url.protocol === "http:" && railway)) return;
  throw new Error("live RPC URLs must be https or a railway.internal host");
}

function assertServiceUrl(value: string | null): void {
  if (!value) return;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error("notifier and resolver URLs must be https or a railway.internal host");
  }
  const railway = url.hostname === "railway.internal" || url.hostname.endsWith(".railway.internal");
  if (url.protocol === "https:") return;
  if (url.protocol === "http:" && railway) return;
  throw new Error("notifier and resolver URLs must be https or a railway.internal host");
}


export function splitList(raw: string | undefined): string[] {
  return (raw ?? "")
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}
