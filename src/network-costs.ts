import { chainByKey, feeRankOf, gasCeilingUsd } from "./chains.js";
import { NATIVE_COINGECKO_ID } from "./prices.js";
import { evmReadClient, solanaConnection } from "./rpc.js";
import { readVendorText, vendorResponse } from "./vendor-fetch.js";

// Typical work per operation. These are planning numbers for comparing chains, not a fee promise: a route with many
// hops costs more, and OP-stack chains add an L1 data fee these numbers leave out.
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

function within<T>(work: Promise<T>): Promise<T | null> {
  return Promise.race([work, new Promise<null>((resolve) => setTimeout(() => resolve(null), READ_TIMEOUT_MS).unref())]).catch(() => null);
}

function median(values: readonly number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.floor(sorted.length / 2)] ?? null;
}

export function envCostReaders(env: NodeJS.ProcessEnv, fetchImpl: typeof fetch = fetch): CostReaders {
  const rpcOf = (key: string) => {
    const spec = chainByKey(key);
    return spec ? env[spec.rpcEnv] ?? spec.defaultRpc : null;
  };
  return {
    async evmGasPriceWei(chainKey) {
      const url = rpcOf(chainKey);
      return url ? within(evmReadClient([url]).getGasPrice()) : null;
    },
    async solanaPriorityMicroLamports() {
      const url = rpcOf("solana");
      if (!url) return null;
      const fees = await within(solanaConnection(url).getRecentPrioritizationFees());
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
      const body = JSON.parse(await readVendorText(response, 64 * 1024)) as Record<string, { usd?: unknown }>;
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

// Live where the RPC and the native price both answer, the static ceiling otherwise. Cheapest first; ties keep the
// fee rank order, so the cheap L2s and Solana lead.
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

let cache: { key: string; at: number; value: NetworkCost[] } | null = null;

export async function cachedNetworkCosts(chainKeys: readonly string[], readers: CostReaders, now = Date.now()): Promise<NetworkCost[]> {
  const key = [...chainKeys].sort().join(",");
  if (cache && cache.key === key && now - cache.at < CACHE_MS) return cache.value;
  const value = await networkCosts(chainKeys, readers);
  cache = { key, at: now, value };
  return value;
}
