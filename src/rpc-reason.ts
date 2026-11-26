import { DEFINITE_REJECTIONS } from "./nonce.js";

const OWN_REASONS = new Set(["simulation reverted", "a simulated call reverted", "no rpc is configured"]);

const KNOWN_PHRASES = [
  ...DEFINITE_REJECTIONS,
  "already known",
  "execution reverted",
  "out of gas",
  "gas required exceeds allowance",
  "blockhash not found",
  "already been processed",
  "simulation reverted",
];

const CHAIN_MISMATCH =
  /refusing (?:[a-z0-9-]{1,40}|chain \d{1,12}): it is configured as chain \d{1,12}, but an RPC in RPC_URL_\d{1,12}, RPC_URLS_\d{1,12} or MEV_RPC_URL_\d{1,12} answered eth_chainId with chain \d{1,20}/;

const TRANSPORT_CODES = new Set([
  "ECONNREFUSED",
  "ECONNRESET",
  "ECONNABORTED",
  "ETIMEDOUT",
  "ENOTFOUND",
  "EAI_AGAIN",
  "EHOSTUNREACH",
  "ENETUNREACH",
  "EPIPE",
  "EPROTO",
  "UND_ERR_CONNECT_TIMEOUT",
  "UND_ERR_HEADERS_TIMEOUT",
  "UND_ERR_BODY_TIMEOUT",
  "UND_ERR_SOCKET",
  "ERR_TLS_CERT_ALTNAME_INVALID",
  "CERT_HAS_EXPIRED",
  "DEPTH_ZERO_SELF_SIGNED_CERT",
  "SELF_SIGNED_CERT_IN_CHAIN",
  "UNABLE_TO_VERIFY_LEAF_SIGNATURE",
]);

export class RpcFailure extends Error {}

function causes(error: unknown): Error[] {
  const chain: Error[] = [];
  for (let current = error; current instanceof Error && chain.length < 8; current = current.cause) chain.push(current);
  return chain;
}

function detail(chain: readonly Error[]): string | null {
  for (const error of chain) {
    const { code, status } = error as { code?: unknown; status?: unknown };
    if (typeof code === "number" && Number.isSafeInteger(code) && Math.abs(code) <= 1_000_000) return `code ${code}`;
    if (typeof status === "number" && Number.isInteger(status) && status >= 100 && status <= 599) return `http ${status}`;
    if (typeof code === "string" && !/rpc/i.test(error.name) && TRANSPORT_CODES.has(code)) return code;
    if (error.name === "TimeoutError" || error.name === "AbortError") return "timed out";
  }
  return null;
}

export function rpcReason(error: unknown): string {
  if (error instanceof RpcFailure) return error.message;
  const chain = causes(error);
  const text = chain.length > 0 ? chain.map((entry) => entry.message).join("\n") : String(error);
  if (OWN_REASONS.has(text)) return text;
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
