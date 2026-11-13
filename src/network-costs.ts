import { chainByKey, feeRankOf, gasCeilingUsd } from "./chains.js";
import { NATIVE_COINGECKO_ID } from "./prices.js";
import { rpcLists } from "./config/load.js";
import { evmReadClient, firstOk, solanaConnection } from "./rpc.js";
import { readVendorText, vendorResponse } from "./vendor-fetch.js";

export const EVM_GAS = { swap: 180_000n, transfer: 65_000n };
export const SOLANA_UNITS = { swap: 200_000, transfer: 30_000 };
const SOLANA_BASE_LAMPORTS = 5_000;
const CACHE_MS = 30_000;
const READ_TIMEOUT_MS = 2_500;

export type CostReaders = {
  evmGasPriceWei(chainKey: string): Promise<bigint | null>;
  solanaPriorityMicroLamports(): Promise<number | null>;
  nativeUsd(symbols: readonly string[]): Promise<Map<string, number>>;
};

export type NetworkCost = { chainKey: string; swapUsd: number; transferUsd: number; source: "live" | "static" };
export type SkippedNetwork = { chainKey: string; reason: string };

export function skippedNetworks(chainKeys: readonly string[]): SkippedNetwork[] {
  return chainKeys.filter((key) => chainByKey(key)?.chain.kind === "hypercore").map((chainKey) => ({ chainKey, reason: "Hyperliquid charges trading fees, not gas, so it has no network cost to compare" }));
}

function within<T>(work: Promise<T>): Promise<T | null> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<null>((resolve) => {
    timer = setTimeout(() => resolve(null), READ_TIMEOUT_MS).unref();
  });
  return Promise.race([work, timeout])
    .catch(() => null)
    .finally(() => clearTimeout(timer));
}

function median(values: readonly number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.floor(sorted.length / 2)] ?? null;
}

export function envCostReaders(env: NodeJS.ProcessEnv, fetchImpl: typeof fetch = fetch): CostReaders {
  const rpcs = rpcLists(env);
  return {
    async evmGasPriceWei(chainKey) {
      const urls = rpcs[chainKey];
      return urls ? within(evmReadClient(urls).getGasPrice()) : null;
    },
    async solanaPriorityMicroLamports() {
      const urls = rpcs.solana;
      if (!urls) return null;
      const fees = await within(firstOk(urls.map((url) => () => solanaConnection(url).getRecentPrioritizationFees())));
      return fees ? median(fees.map((entry) => entry.prioritizationFee)) : null;
    },
    async nativeUsd(symbols) {
      const ids = [...new Set(symbols.map((symbol) => NATIVE_COINGECKO_ID[symbol.toUpperCase()]).filter((id): id is string => id !== undefined))];
      const out = new Map<string, number>();
      if (ids.length === 0) return out;
      const base = (env.COINGECKO_API_BASE ?? "https://api.coingecko.com/api/v3").replace(/\/$/, "");
      const headers: Record<string, string> = env.COINGECKO_API_KEY ? { "x-cg-demo-api-key": env.COINGECKO_API_KEY } : {};
      const response = await within(vendorResponse(fetchImpl, `${base}/simple/price?ids=${ids.join(",")}&vs_currencies=usd`, { headers, signal: AbortSignal.timeout(READ_TIMEOUT_MS) }));
      if (!response?.ok) return out;
      const body = await within(readVendorText(response, 64 * 1024).then((text) => JSON.parse(text) as Record<string, { usd?: unknown }> | null));
      if (!body) return out;
      for (const symbol of symbols) {
        const usd = body[NATIVE_COINGECKO_ID[symbol.toUpperCase()] ?? ""]?.usd;
        if (typeof usd === "number" && Number.isFinite(usd)) out.set(symbol.toUpperCase(), usd);
      }
      return out;
    },
  };
}

function staticCost(chainKey: string): NetworkCost {
  const ceiling = gasCeilingUsd(chainKey);
  return { chainKey, swapUsd: ceiling, transferUsd: ceiling / 2, source: "static" };
}

export async function networkCosts(chainKeys: readonly string[], readers: CostReaders): Promise<NetworkCost[]> {
  const specs = chainKeys.map((key) => chainByKey(key)).filter((spec) => spec !== undefined && spec.chain.kind !== "hypercore");
  const prices = await readers.nativeUsd(specs.map((spec) => spec?.nativeSymbol ?? ""));
  const costs = await Promise.all(
    specs.map(async (spec): Promise<NetworkCost> => {
      if (!spec) throw new Error("unreachable");
      const usd = prices.get(spec.nativeSymbol.toUpperCase());
      if (usd === undefined || !(usd > 0)) return staticCost(spec.key);
      if (spec.chain.kind === "solana") {
        const priority = await readers.solanaPriorityMicroLamports();
        if (priority === null) return staticCost(spec.key);
        const lamports = (units: number) => SOLANA_BASE_LAMPORTS + (priority * units) / 1_000_000;
        return { chainKey: spec.key, swapUsd: (lamports(SOLANA_UNITS.swap) / 1e9) * usd, transferUsd: (lamports(SOLANA_UNITS.transfer) / 1e9) * usd, source: "live" };
      }
      const price = await readers.evmGasPriceWei(spec.key);
      if (price === null || price <= 0n) return staticCost(spec.key);
      const cost = (gas: bigint) => (Number(gas * price) / 1e18) * usd;
      return { chainKey: spec.key, swapUsd: cost(EVM_GAS.swap), transferUsd: cost(EVM_GAS.transfer), source: "live" };
    }),
  );
  return costs.sort((left, right) => left.swapUsd - right.swapUsd || feeRankOf(left.chainKey) - feeRankOf(right.chainKey));
}

const CACHE_ENTRIES = 64;
const cache = new Map<string, { at: number; value: Promise<NetworkCost[]> }>();

export function cachedNetworkCosts(chainKeys: readonly string[], readers: CostReaders, now = Date.now()): Promise<NetworkCost[]> {
  const key = [...chainKeys].sort().join(",");
  const hit = cache.get(key);
  if (hit && now - hit.at < CACHE_MS) return hit.value;
  for (const [stale, entry] of cache) if (now - entry.at >= CACHE_MS || cache.size >= CACHE_ENTRIES) cache.delete(stale);
  const value = networkCosts(chainKeys, readers);
  cache.set(key, { at: now, value });
  value.catch(() => {
    if (cache.get(key)?.value === value) cache.delete(key);
  });
  return value;
}
