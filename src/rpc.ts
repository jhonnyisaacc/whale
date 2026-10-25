import { Connection } from "@solana/web3.js";
import { createPublicClient, fallback, http, type PublicClient } from "viem";

export function rpcTransport(url: string) {
  return http(url, { retryCount: 0, timeout: 1_500 });
}

export function readTransport(urls: readonly string[]) {
  const [only] = urls;
  if (urls.length === 1 && only) return rpcTransport(only);
  return fallback(urls.map(rpcTransport), { rank: false });
}

const evmClients = new Map<string, PublicClient>();
const connections = new Map<string, Connection>();

export function resetRpcClients(): void {
  evmClients.clear();
  connections.clear();
}

export function evmReadClient(urls: readonly string[]): PublicClient {
  const key = urls.join(",");
  const existing = evmClients.get(key);
  if (existing) return existing;
  const created = createPublicClient({ transport: readTransport(urls) });
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
