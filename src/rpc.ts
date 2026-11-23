import { Connection } from "@solana/web3.js";
import { createPublicClient, fallback, http, type PublicClient, type Transport } from "viem";
import { chainByEvmId } from "./chains.js";

const fetchIgnoringRetryAfter: typeof fetch = async (input, init) => {
  const response = await fetch(input, init);
  if (!response.headers.has("retry-after")) return response;
  const headers = new Headers(response.headers);
  headers.delete("retry-after");
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
};

export function rpcTransport(url: string) {
  return http(url, { retryCount: 0, timeout: 1_500, fetchFn: fetchIgnoringRetryAfter });
}

type ChainCheck = { kind: "match" } | { kind: "mismatch"; returned: number } | { kind: "unchecked" };

const UNCHECKED_RETRY_MS = 30_000;

const chainChecks = new Map<string, { check: Promise<ChainCheck>; retryAt: number }>();

async function probeChainId(chainId: number, url: string): Promise<ChainCheck> {
  try {
    const returned = await createPublicClient({ transport: rpcTransport(url) }).getChainId();
    return returned === chainId ? { kind: "match" } : { kind: "mismatch", returned };
  } catch {
    return { kind: "unchecked" };
  }
}

function checkChainId(chainId: number, url: string): Promise<ChainCheck> {
  const key = `${chainId}:${url}`;
  const cached = chainChecks.get(key);
  if (cached && Date.now() < cached.retryAt) return cached.check;
  const entry = { check: probeChainId(chainId, url), retryAt: Number.POSITIVE_INFINITY };
  chainChecks.set(key, entry);
  void entry.check.then((result) => {
    if (result.kind === "unchecked") entry.retryAt = Date.now() + UNCHECKED_RETRY_MS;
  });
  return entry.check;
}

export async function assertChainId(chainId: number, urls: readonly string[]): Promise<void> {
  const checks = await Promise.all(urls.map((url) => checkChainId(chainId, url)));
  for (const check of checks) {
    if (check.kind !== "mismatch") continue;
    const name = chainByEvmId(chainId)?.key ?? `chain ${chainId}`;
    throw new Error(
      `refusing ${name}: it is configured as chain ${chainId}, but an RPC in RPC_URL_${chainId}, RPC_URLS_${chainId} or MEV_RPC_URL_${chainId} answered eth_chainId with chain ${check.returned}`,
    );
  }
}

export function readTransport(chainId: number, urls: readonly string[]): Transport {
  const [only] = urls;
  const transport = urls.length === 1 && only ? rpcTransport(only) : fallback(urls.map(rpcTransport), { rank: false });
  return (params) => {
    const inner = transport(params);
    const request = async (...args: Parameters<typeof inner.request>) => {
      await assertChainId(chainId, urls);
      return inner.request(...args);
    };
    return { ...inner, request: request as typeof inner.request };
  };
}

const evmClients = new Map<string, PublicClient>();
const connections = new Map<string, Connection>();

export function resetRpcClients(): void {
  evmClients.clear();
  connections.clear();
  chainChecks.clear();
}

export function evmReadClient(chainId: number, urls: readonly string[]): PublicClient {
  const key = `${chainId}:${urls.join(",")}`;
  const existing = evmClients.get(key);
  if (existing) return existing;
  const created = createPublicClient({ transport: readTransport(chainId, urls) });
  evmClients.set(key, created);
  return created;
}

export function solanaConnection(url: string): Connection {
  const existing = connections.get(url);
  if (existing) return existing;
  const created = new Connection(url, "confirmed");
  connections.set(url, created);
  return created;
}

export async function firstOk<T>(attempts: ReadonlyArray<() => Promise<T>>): Promise<T> {
  let last: unknown = new Error("no rpc is configured");
  for (const attempt of attempts) {
    try {
      return await attempt();
    } catch (error) {
      last = error;
    }
  }
  throw last;
}

export async function anyOk(attempts: ReadonlyArray<() => Promise<void>>): Promise<void> {
  if (attempts.length === 0) throw new Error("no rpc is configured");
  try {
    await Promise.any(attempts.map((attempt) => attempt()));
  } catch (error) {
    throw error instanceof AggregateError ? error.errors[0] : error;
  }
}
