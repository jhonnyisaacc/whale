import { createPublicClient, erc20Abi, http } from "viem";
import type { ChainRef, TokenRecord } from "./domain.js";

const cache = new Map<string, number>();

function cacheKey(chainKey: string, contract: string): string {
  return `${chainKey}:${contract.toLowerCase()}`;
}

export function resetTokenDecimals(): void {
  cache.clear();
}

export function acceptDecimals(value: number | null | undefined): number | null {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0 || value > 18) return null;
  return value;
}

export function cachedTokenDecimals(chainKey: string, contract: string): number | null {
  return cache.get(cacheKey(chainKey, contract)) ?? null;
}

export function rememberTokenDecimals(chainKey: string, contract: string, decimals: number): void {
  const accepted = acceptDecimals(decimals);
  if (accepted === null) return;
  cache.set(cacheKey(chainKey, contract), accepted);
}

export async function readErc20Decimals(rpc: string, contract: string): Promise<number | null> {
  if (!/^0x[0-9a-fA-F]{40}$/.test(contract)) return null;
  try {
    const client = createPublicClient({ transport: http(rpc, { retryCount: 0, timeout: 1500 }) });
    const raw = await client.readContract({
      address: contract as `0x${string}`,
      abi: erc20Abi,
      functionName: "decimals",
    });
    return acceptDecimals(Number(raw));
  } catch {
    return null;
  }
}

export async function resolveTokenDecimals(
  chainKey: string,
  contract: string,
  chain: ChainRef,
  rpc: string | undefined,
  read: (rpc: string, contract: string) => Promise<number | null> = readErc20Decimals,
): Promise<number | null> {
  const hit = cachedTokenDecimals(chainKey, contract);
  if (hit !== null) return hit;
  if (chain.kind !== "evm" || !rpc) return null;
  const decimals = acceptDecimals(await read(rpc, contract));
  if (decimals === null) return null;
  rememberTokenDecimals(chainKey, contract, decimals);
  return decimals;
}

export async function fillTokenDecimals(
  tokens: readonly TokenRecord[],
  rpcByChainKey: Readonly<Record<string, string>>,
  read: (rpc: string, contract: string) => Promise<number | null> = readErc20Decimals,
): Promise<TokenRecord[]> {
  const out = tokens.slice();
  const jobs: number[] = [];
  tokens.forEach((token, index) => {
    const known = acceptDecimals(token.decimals);
    if (known !== null) {
      rememberTokenDecimals(token.chainKey, token.contract, known);
      return;
    }
    if (token.chain.kind !== "evm" || token.pairMap.pools.length === 0 || !rpcByChainKey[token.chainKey]) return;
    jobs.push(index);
  });
  let cursor = 0;
  async function worker(): Promise<void> {
    while (cursor < jobs.length) {
      const index = jobs[cursor];
      cursor += 1;
      const token = out[index];
      if (!token) return;
      const decimals = await resolveTokenDecimals(token.chainKey, token.contract, token.chain, rpcByChainKey[token.chainKey], read);
      if (decimals !== null) out[index] = { ...token, decimals };
    }
  }
  const width = Math.min(8, jobs.length);
  await Promise.all(Array.from({ length: width }, () => worker()));
  return out;
}
