import { z } from "zod";
import { withTimeout } from "./timeout.js";
import type { AppConfig } from "./config.js";
import type { ChainRef } from "./domain.js";
import { readVendorText, vendorResponse } from "./vendor-fetch.js";

const BLOCKAID_CHAIN: Record<string, string> = {
  ethereum: "ethereum",
  optimism: "optimism",
  bnb: "bsc",
  polygon: "polygon",
  base: "base",
  arbitrum: "arbitrum",
  linea: "linea",
  blast: "blast",
  scroll: "scroll",
  zksync: "zksync",
  robinhood: "robinhood",
  hyperevm: "hyperevm",
  monad: "monad",
  solana: "solana",
};

const GOPLUS_EVM_CHAIN_IDS = new Set([1, 10, 56, 137, 143, 324, 4663, 8453, 42161, 59144, 81457, 534352]);

const goplusSchema = z
  .object({
    code: z.union([z.number(), z.string()]),
    result: z
      .record(
        z.string(),
        z
          .object({
            is_honeypot: z.string().optional(),
            cannot_sell_all: z.string().optional(),
            buy_tax: z.string().optional(),
            sell_tax: z.string().optional(),
          })
          .passthrough(),
      )
      .optional(),
  })
  .passthrough();

const blockaidSchema = z.object({ result_type: z.enum(["Benign", "Warning", "Malicious", "Spam"]) }).passthrough();

type Verdict = "allow" | "deny";
type Outcome = Verdict | "unavailable";

const caches = new WeakMap<AppConfig, Map<string, { verdict: Promise<Verdict>; atMs: number }>>();

function cacheFor(config: AppConfig): Map<string, { verdict: Promise<Verdict>; atMs: number }> {
  const existing = caches.get(config);
  if (existing) return existing;
  const created = new Map<string, { verdict: Promise<Verdict>; atMs: number }>();
  caches.set(config, created);
  return created;
}

export async function screenToken(
  config: AppConfig,
  token: { chainKey: string; chain: ChainRef; contract: string },
  fetchImpl: typeof fetch = fetch,
): Promise<Verdict> {
  if (!config.screening) return "allow";
  const verdicts = cacheFor(config);
  const key = `${token.chainKey}:${token.contract.toLowerCase()}`;
  const now = config.now?.() ?? Date.now();
  const cached = verdicts.get(key);
  if (cached && now - cached.atMs < config.screenCacheMs) return cached.verdict;
  const outcome = screenUncached(config, token, fetchImpl);
  const verdict = outcome.then((result) => (result === "allow" ? "allow" : "deny"));
  if (verdicts.size >= 1024) {
    for (const [stale, row] of verdicts) if (now - row.atMs >= config.screenCacheMs) verdicts.delete(stale);
  }
  verdicts.set(key, { verdict, atMs: now });
  outcome.then((result) => {
    if (result === "unavailable" && verdicts.get(key)?.verdict === verdict) verdicts.delete(key);
  });
  return verdict;
}

async function screenUncached(config: AppConfig, token: { chainKey: string; chain: ChainRef; contract: string }, fetchImpl: typeof fetch): Promise<Outcome> {
  const goplusUrl = goPlusUrl(token);
  if (!goplusUrl) return "deny";
  const blockaidChain = BLOCKAID_CHAIN[token.chainKey];
  const results = await Promise.all([
    guarded(() => screenGoPlus(config, goplusUrl, token.contract, fetchImpl)),
    config.keys.blockaid && blockaidChain ? guarded(() => screenBlockaid(config, blockaidChain, token.contract, fetchImpl)) : Promise.resolve<Outcome>("allow"),
  ]);
  if (results.includes("deny")) return "deny";
  if (results.includes("unavailable")) return "unavailable";
  return "allow";
}

async function guarded(run: () => Promise<Outcome>): Promise<Outcome> {
  try {
    return await run();
  } catch {
    return "unavailable";
  }
}

function goPlusUrl(token: { chain: ChainRef; contract: string }): string | null {
  const contract = encodeURIComponent(token.contract);
  if (token.chain.kind === "solana") return `https://api.gopluslabs.io/api/v1/solana/token_security?contract_addresses=${contract}`;
  if (token.chain.kind === "evm" && GOPLUS_EVM_CHAIN_IDS.has(token.chain.chainId)) {
    return `https://api.gopluslabs.io/api/v1/token_security/${token.chain.chainId}?contract_addresses=${contract}`;
  }
  return null;
}

async function screenGoPlus(config: AppConfig, url: string, contract: string, fetchImpl: typeof fetch): Promise<Outcome> {
  const headers: Record<string, string> = {};
  if (config.keys.goplus) headers.authorization = `Bearer ${config.keys.goplus}`;
  const body = await withTimeout(config.liveLookupTimeoutMs, async (signal) => {
    const response = await vendorResponse(fetchImpl, url, { headers, signal });
    return response.ok ? (JSON.parse(await readVendorText(response)) as unknown) : null;
  });
  if (body === null) return "unavailable";
  const parsed = goplusSchema.safeParse(body);
  if (!parsed.success || String(parsed.data.code) !== "1" || !parsed.data.result) return "unavailable";
  const row = parsed.data.result[contract] ?? parsed.data.result[contract.toLowerCase()];
  if (!row) return "deny";
  if (row.is_honeypot === "1" || row.cannot_sell_all === "1") return "deny";
  if (config.live && (!row.buy_tax || !row.sell_tax)) return "deny";
  if (taxTooHigh(row.buy_tax, config.maxTokenTax) || taxTooHigh(row.sell_tax, config.maxTokenTax)) return "deny";
  return "allow";
}

function taxTooHigh(raw: string | undefined, cap: number): boolean {
  if (raw === undefined || raw === "") return false;
  const value = Number(raw);
  if (!Number.isFinite(value) || value < 0) return true;
  return value > cap;
}

async function screenBlockaid(config: AppConfig, chain: string, address: string, fetchImpl: typeof fetch): Promise<Outcome> {
  const body = await withTimeout(config.liveLookupTimeoutMs, async (signal) => {
    const response = await vendorResponse(
      fetchImpl,
      "https://api.blockaid.io/v0/token/scan",
      {
        method: "POST",
        headers: { "content-type": "application/json", "x-api-key": config.keys.blockaid ?? "" },
        body: JSON.stringify({ chain, address }),
        signal,
      },
      false,
    );
    return response.ok ? (JSON.parse(await readVendorText(response)) as unknown) : null;
  });
  if (body === null) return "unavailable";
  const parsed = blockaidSchema.safeParse(body);
  if (!parsed.success) return "unavailable";
  return parsed.data.result_type === "Benign" ? "allow" : "deny";
}
