export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    readonly detail: unknown,
  ) {
    super(code);
  }
}

// Same-origin only. The session cookie is HttpOnly, and the gateway refuses a mutating call without a matching Origin.
export async function api<T>(path: string, init: { method?: string; body?: unknown } = {}): Promise<T> {
  const response = await fetch(path, {
    method: init.method ?? "GET",
    credentials: "same-origin",
    headers: init.body === undefined ? { accept: "application/json" } : { accept: "application/json", "content-type": "application/json" },
    ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
  });
  if (response.status === 204) return undefined as T;
  const text = await response.text();
  let body: unknown = null;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    body = null;
  }
  if (!response.ok) {
    const fields = (body ?? {}) as { error?: string; detail?: unknown; problems?: unknown };
    throw new ApiError(response.status, fields.error ?? `http_${response.status}`, fields.detail ?? fields.problems ?? null);
  }
  return body as T;
}

export function describe(error: unknown): string {
  if (error instanceof ApiError) {
    const detail = Array.isArray(error.detail) ? error.detail.join("; ") : typeof error.detail === "string" ? error.detail : "";
    return detail ? `${error.code.replace(/_/g, " ")}: ${detail}` : error.code.replace(/_/g, " ");
  }
  if (error instanceof DOMException && error.name === "NotAllowedError") return "The passkey prompt was dismissed or timed out.";
  return error instanceof Error ? error.message : "Something went wrong.";
}

export type Policy = {
  version: 1;
  chains: string[];
  actions: ("swap" | "transfer" | "bridge")[];
  maxTxUsd: number;
  dailyUsd: number;
  approvalAboveUsd: number | null;
  maxSlippageBps: number;
  destinations: { family: "evm" | "solana"; address: string; label: string }[];
  tokenAllowlist: { chain: string; address: string }[] | null;
};

export type Wallet = {
  id: string;
  label: string;
  level: "enclave" | "self_hosted" | "smart_account";
  status: "pending" | "active" | "frozen" | "archived";
  live: boolean;
  addresses: { family: string; address: string }[];
  policy: Policy;
  policyVersion: number;
  createdAt: string;
};

export type Limits = { chains: string[]; actions: Policy["actions"]; maxTxUsd: number; dailyUsd: number };

export type Agent = { id: string; name: string; limits: Limits; createdAt: string; lastUsedAt: string | null; revoked: boolean; keyPrefixes: string[] };

export type Me = { accountId: string; email: string | null };
