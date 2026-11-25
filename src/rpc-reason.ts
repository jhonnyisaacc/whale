import { DEFINITE_REJECTIONS } from "./nonce.js";

const KNOWN_PHRASES = [
  ...DEFINITE_REJECTIONS,
  "already known",
  "execution reverted",
  "out of gas",
  "gas required exceeds allowance",
  "blockhash not found",
  "already been processed",
  "simulation reverted",
  "a simulated call reverted",
  "no rpc is configured",
];

const CHAIN_MISMATCH =
  /refusing (?:[a-z0-9-]{1,40}|chain \d{1,12}): it is configured as chain \d{1,12}, but an RPC in RPC_URL_\d{1,12}, RPC_URLS_\d{1,12} or MEV_RPC_URL_\d{1,12} answered eth_chainId with chain \d{1,20}/;

const NODE_CODE = /^[A-Z][A-Z0-9_]{1,40}$/;

export class RpcFailure extends Error {}

function causes(error: unknown): Error[] {
  const chain: Error[] = [];
  for (let current = error; current instanceof Error && chain.length < 8; current = current.cause) chain.push(current);
  return chain;
}

function detail(chain: readonly Error[]): string | null {
  for (const error of chain) {
    const { code, status } = error as { code?: unknown; status?: unknown };
    if (typeof code === "number" && Number.isSafeInteger(code)) return `code ${code}`;
    if (typeof status === "number" && Number.isSafeInteger(status)) return `http ${status}`;
    if (typeof code === "string" && NODE_CODE.test(code)) return code;
    if (error.name === "TimeoutError" || error.name === "AbortError") return "timed out";
  }
  return null;
}

export function rpcReason(error: unknown): string {
  if (error instanceof RpcFailure) return error.message;
  const chain = causes(error);
  const text = chain.length > 0 ? chain.map((entry) => entry.message).join("\n") : String(error);
  const mismatch = CHAIN_MISMATCH.exec(text)?.[0];
  if (mismatch) return mismatch;
  const lower = text.toLowerCase();
  const phrases = KNOWN_PHRASES.filter((phrase) => lower.includes(phrase));
  const code = detail(chain);
  const head = code ? `rpc request failed (${code})` : "rpc request failed";
  return phrases.length > 0 ? `${head}: ${phrases.join("; ")}` : head;
}

export function guarded<A extends unknown[], R>(call: (...args: A) => Promise<R>): (...args: A) => Promise<R> {
  return async (...args) => {
    try {
      return await call(...args);
    } catch (error) {
      throw new RpcFailure(rpcReason(error));
    }
  };
}

export function guardRpc<T extends { [K in keyof T]: (...args: never[]) => Promise<unknown> }>(rpc: T): T {
  return Object.fromEntries(Object.entries(rpc).map(([name, call]) => [name, guarded(call as (...args: unknown[]) => Promise<unknown>)])) as unknown as T;
}
