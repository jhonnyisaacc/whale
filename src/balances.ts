import { PublicKey } from "@solana/web3.js";
import { chainByKey } from "./chains.js";
import type { Holding } from "./domain.js";

export type BalanceReader = (holding: Holding) => Promise<number | null>;

export function applyBalance(holding: Holding, amount: number, unitUsd: number): Holding {
  return { ...holding, amount, usd: amount * unitUsd };
}

export function scopeHolding(holding: Holding, tradeChainKey: string): Holding {
  if (holding.chainKey) return holding;
  return { ...holding, chainKey: tradeChainKey };
}

const WRAPPED_SOL_MINT = "So11111111111111111111111111111111111111112";

const NATIVE_ASSETS = ["SOL", "ETH", "BNB", "POL", "MON", "HYPE"] as const;

type NativeAsset = (typeof NATIVE_ASSETS)[number];

const ADDRESS_MARKERS: Record<string, NativeAsset> = {
  sol: "SOL",
  eth: "ETH",
  bnb: "BNB",
  pol: "POL",
  mon: "MON",
  hype: "HYPE",
};

function nativeAsset(symbol: string): NativeAsset | undefined {
  const key = symbol.trim().toUpperCase();
  return (NATIVE_ASSETS as readonly string[]).includes(key) ? (key as NativeAsset) : undefined;
}

function assetFromAddress(address: string): NativeAsset | undefined {
  const trimmed = address.trim();
  if (trimmed === WRAPPED_SOL_MINT) return "SOL";
  return ADDRESS_MARKERS[trimmed.toLowerCase()];
}

function assetOnChain(asset: NativeAsset, chainKey: string): boolean {
  return chainByKey(chainKey)?.nativeSymbol.toUpperCase() === asset;
}

type NativeRow = Pick<Holding, "symbol" | "address" | "native" | "decimals" | "chainKey">;

export function nativeHoldingError(holding: NativeRow): string | undefined {
  if (!holding.native) return undefined;
  const symbol = holding.symbol.trim();
  const fromSymbol = nativeAsset(symbol);
  const fromAddress = assetFromAddress(holding.address);
  if (fromAddress && symbol.length > 0 && symbol.toUpperCase() !== fromAddress) return "native asset conflict";
  const asset = fromSymbol ?? fromAddress;
  if (asset) {
    const decimals = asset === "SOL" ? 9 : 18;
    if (holding.decimals !== undefined && holding.decimals !== decimals) return "native decimals";
    if (holding.chainKey && !assetOnChain(asset, holding.chainKey)) return "native chain";
    return undefined;
  }
  if (!holding.chainKey) return "ambiguous native";
  const spec = chainByKey(holding.chainKey);
  if (!spec || symbol.toUpperCase() !== spec.nativeSymbol.toUpperCase()) return "native chain";
  return undefined;
}

function nativeFitsChain(holding: NativeRow, tradeChainKey: string): boolean {
  if (nativeHoldingError(holding)) return false;
  const asset = nativeAsset(holding.symbol) ?? assetFromAddress(holding.address);
  if (asset) return assetOnChain(asset, tradeChainKey);
  return holding.chainKey === tradeChainKey;
}

export function holdingFitsChain(holding: Holding, tradeChainKey: string): boolean {
  if (holding.native) return nativeFitsChain(holding, tradeChainKey);
  const kind = chainByKey(tradeChainKey)?.chain.kind;
  if (kind === "evm") return /^0x[0-9a-fA-F]{40}$/.test(holding.address);
  if (kind === "solana") {
    try {
      new PublicKey(holding.address);
      return true;
    } catch {
      return false;
    }
  }
  return false;
}

export async function holdingsForTrade(
  live: boolean,
  declared: readonly Holding[],
  read: BalanceReader | null,
  tradeChainKey: string,
  priceOf: ((holding: Holding) => number | null) | null,
): Promise<{ ok: true; holdings: Holding[] } | { ok: false; reason: string }> {
  if (!live) return { ok: true, holdings: [...declared] };
  if (!read || !tradeChainKey) return { ok: false, reason: "balance was not read" };
  const scoped = declared
    .filter((holding) => (!holding.chainKey || holding.chainKey === tradeChainKey) && holdingFitsChain(holding, tradeChainKey))
    .map((holding) => scopeHolding(holding, tradeChainKey));
  const rows = await Promise.all(
    scoped.map(async (holding): Promise<Holding | "unpriced" | "failed"> => {
      const unitUsd = priceOf?.(holding) ?? null;
      if (unitUsd === null || !(unitUsd > 0)) return "unpriced";
      let amount: number | null;
      try {
        amount = await read(holding);
      } catch {
        return "failed";
      }
      if (amount === null || !Number.isFinite(amount) || amount < 0) return "failed";
      return applyBalance(holding, amount, unitUsd);
    }),
  );
  const holdings = rows.filter((row): row is Holding => typeof row !== "string");
  if (holdings.length === 0 && rows.includes("unpriced")) return { ok: false, reason: "holding price stale" };
  if (holdings.length === 0 && rows.includes("failed")) return { ok: false, reason: "balance was not read" };
  return { ok: true, holdings };
}

export type BalanceCache = { read: BalanceReader; invalidate(chainKey: string): void };

export function createBalanceCache(read: BalanceReader, ttlMs: number, now: () => number = Date.now): BalanceCache {
  const rows = new Map<string, { chainKey: string; amount: Promise<number | null>; atMs: number }>();
  return {
    read(holding) {
      const key = `${holding.chainKey ?? ""}:${holding.native ? "native" : holding.address.toLowerCase()}`;
      const at = now();
      const hit = rows.get(key);
      if (hit && at - hit.atMs < ttlMs) return hit.amount;
      const amount = read(holding);
      const row = { chainKey: holding.chainKey ?? "", amount, atMs: at };
      rows.set(key, row);
      amount.then(
        (value) => {
          if (value === null && rows.get(key) === row) rows.delete(key);
        },
        () => {
          if (rows.get(key) === row) rows.delete(key);
        },
      );
      return amount;
    },
    invalidate(chainKey) {
      for (const [key, row] of rows) if (row.chainKey === chainKey) rows.delete(key);
    },
  };
}
