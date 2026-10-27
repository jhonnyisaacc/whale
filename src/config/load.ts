import { CHAINS, QUOTE_ASSETS, chainByKey, type QuoteAsset, type QuoteAssets } from "../chains.js";
import { kyberSupports } from "../aggregators.js";
import { DEFAULT_MAX_VALUE_WEI, SOLANA_BASE_PROGRAMS } from "../signing-policy.js";
import { chainAddressMap, reorgDepths, routerAllowlist, spendTimezone, splitList } from "./guard.js";
import { isSolanaAddress } from "../signer.js";
import { DEFAULT_KYBER_CLIENT_ID, type AppConfig, type ApprovalSeed } from "./types.js";
import { manifestRouters, parseDeploymentManifest } from "../deployment-manifest.js";
import { supportByChain } from "../support.js";
export type { AppConfig, ApprovalSeed, StrategyCap } from "./types.js";

function screeningEnabled(env: NodeJS.ProcessEnv, live: boolean): boolean {
  if (env.TOKEN_SCREENING === "false") return false;
  if (env.TOKEN_SCREENING === "true") return true;
  return live;
}

function taxCap(env: NodeJS.ProcessEnv): number {
  const raw = env.MAX_TOKEN_TAX;
  if (raw === undefined || raw === "") return 0;
  const value = Number(raw);
  if (!Number.isFinite(value) || value < 0 || value > 1) throw new Error("invalid MAX_TOKEN_TAX");
  return value;
}

function intEnv(env: NodeJS.ProcessEnv, name: string, fallback: number): number {
  const raw = env[name];
  if (raw === undefined || raw === "") return fallback;
  const value = Number(raw);
  if (!Number.isFinite(value)) throw new Error(`invalid ${name}`);
  return value;
}

function enabledKeys(env: NodeJS.ProcessEnv): Set<string> {
  const disabled = new Set(
    (env.DISABLED_CHAINS ?? "")
      .split(",")
      .map((item) => item.trim())
      .filter(Boolean),
  );
  const extra = (env.ENABLED_CHAINS ?? "")
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
  const keys = new Set(CHAINS.filter((chain) => chain.enabledByDefault && !disabled.has(chain.key)).map((chain) => chain.key));
  for (const key of extra) {
    if (!chainByKey(key)) throw new Error(`unknown chain ${key}`);
    keys.add(key);
  }
  for (const key of disabled) keys.delete(key);
  return keys;
}

function quoteAssetList(chainKey: string, list: unknown): QuoteAsset[] {
  const spec = chainByKey(chainKey);
  if (!spec || !Array.isArray(list)) throw new Error(`QUOTE_ASSET_ALLOWLIST_JSON has an invalid entry for ${chainKey}`);
  return list.map((row) => {
    const item = (typeof row === "object" && row !== null ? row : {}) as Partial<QuoteAsset>;
    const address = typeof item.address === "string" ? item.address : "";
    const valid = spec.chain.kind === "evm" ? /^0x[0-9a-fA-F]{40}$/.test(address) : spec.chain.kind === "solana" && isSolanaAddress(address);
    const decimals = item.decimals;
    if (!valid || typeof item.symbol !== "string" || item.symbol.length === 0 || typeof decimals !== "number" || !Number.isInteger(decimals) || decimals < 0 || decimals > 18) {
      throw new Error(`QUOTE_ASSET_ALLOWLIST_JSON has an invalid asset for ${chainKey}`);
    }
    return { address, symbol: item.symbol, decimals };
  });
}

function quoteAssets(env: NodeJS.ProcessEnv): QuoteAssets {
  if (env.QUOTE_DECIMALS_JSON) throw new Error("QUOTE_DECIMALS_JSON was replaced by QUOTE_ASSET_ALLOWLIST_JSON");
  if (!env.QUOTE_ASSET_ALLOWLIST_JSON) return QUOTE_ASSETS;
  const parsed: unknown = JSON.parse(env.QUOTE_ASSET_ALLOWLIST_JSON);
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) throw new Error("QUOTE_ASSET_ALLOWLIST_JSON must be an object");
  const out: Record<string, readonly QuoteAsset[]> = { ...QUOTE_ASSETS };
  for (const [chainKey, list] of Object.entries(parsed)) out[chainKey] = quoteAssetList(chainKey, list);
  return out;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  if (env.AUTH_TOKEN) throw new Error("AUTH_TOKEN was split into EXECUTOR_AUTH_TOKEN and RESOLVER_AUTH_TOKEN. Set those and unset AUTH_TOKEN.");
  if (env.LISTING_TRADER_LIVE !== undefined) throw new Error("LISTING_TRADER_LIVE is closed");
  if (env.STRATEGY_CAPS_JSON !== undefined) throw new Error("STRATEGY_CAPS_JSON is closed");
  if (env.WITHDRAW_ENABLED !== undefined) throw new Error("WITHDRAW_ENABLED is closed");
  const live = env.WHALE_BROADCAST === "true";
  const maxSlippageBps = intEnv(env, "MAX_SLIPPAGE_BPS", 100);
  const slippageHardMaxBps = intEnv(env, "SLIPPAGE_HARD_MAX_BPS", 300);
  if (maxSlippageBps > slippageHardMaxBps) {
    throw new Error("MAX_SLIPPAGE_BPS exceeds SLIPPAGE_HARD_MAX_BPS");
  }
  const manifest = env.WALLET_DEPLOYMENT_MANIFEST_JSON ? parseDeploymentManifest(JSON.parse(env.WALLET_DEPLOYMENT_MANIFEST_JSON) as unknown) : null;
  const legacyRouters = routerAllowlist(env);
  if (manifest && env.ROUTER_ALLOWLIST_JSON && JSON.stringify(manifestRouters(manifest)) !== JSON.stringify(legacyRouters)) {
    throw new Error("WALLET_DEPLOYMENT_MANIFEST_JSON and ROUTER_ALLOWLIST_JSON disagree on routers");
  }
  const maxWithdrawAmount = intEnv(env, "MAX_WITHDRAW_AMOUNT", 1);
  const rpcUrlsByChainKey = rpcLists(env);
  const rpcByChainKey: Record<string, string> = {};
  for (const [key, urls] of Object.entries(rpcUrlsByChainKey)) {
    if (urls[0]) rpcByChainKey[key] = urls[0];
  }
  let dexscreenerSlugOverrides: Record<string, string> = {};
  if (env.DEXSCREENER_CHAIN_SLUGS) {
    const parsed: unknown = JSON.parse(env.DEXSCREENER_CHAIN_SLUGS);
    if (typeof parsed !== "object" || parsed === null) throw new Error("DEXSCREENER_CHAIN_SLUGS must be an object");
    dexscreenerSlugOverrides = parsed as Record<string, string>;
  }
  return {
    live,
    killSwitch: env.KILL_SWITCH === "1" || env.KILL_SWITCH === "true",
    port: intEnv(env, "PORT", 8080),
    maxUsdPerTrade: intEnv(env, "MAX_USD_PER_TRADE", 5),
    dailyUsdCap: intEnv(env, "DAILY_USD_CAP", 25),
    maxSlippageBps,
    slippageHardMaxBps,
    maxLeverage: intEnv(env, "MAX_LEVERAGE", 1),
    minLiquidityUsd: intEnv(env, "MIN_LIQUIDITY_USD", 75_000),
    enabledChainKeys: enabledKeys(env),
    databaseUrl: env.DATABASE_URL ?? null,
    notifierUrl: env.NOTIFIER_WEBHOOK_URL ?? null,
    resolverUrl: env.RESOLVER_URL ?? null,
    zeroExBase: env.ZEROX_API_BASE ?? "https://api.0x.org",
    jupiterBase: env.JUPITER_API_BASE ?? "https://api.jup.ag/swap/v1",
    lifiBase: env.LIFI_API_BASE ?? "https://li.quest/v1",
    lifiLive: env.LIFI_LIVE === "true",
    hyperliquidUrl: env.HYPERLIQUID_API_URL ?? "https://api.hyperliquid.xyz",
    jupiterImpactUnit: env.JUPITER_IMPACT_UNIT === "percent" ? "percent" : "fraction",
    liveLookupTimeoutMs: intEnv(env, "LIVE_LOOKUP_TIMEOUT_MS", 400),
    fullRefreshMs: intEnv(env, "FULL_REFRESH_MS", 24 * 60 * 60 * 1000),
    liquidityRefreshMs: intEnv(env, "LIQUIDITY_REFRESH_MS", 10 * 60 * 1000),
    refreshEnabled: env.REFRESH_ENABLED === "true",
    shortlistLimit: intEnv(env, "SHORTLIST_LIMIT", 200),
    quoteAssets: quoteAssets(env),
    coingeckoBase: env.COINGECKO_API_BASE ?? "https://api.coingecko.com/api/v3",
    priceRefreshMs: intEnv(env, "PRICE_REFRESH_MS", 30_000),
    priceMaxAgeMs: intEnv(env, "PRICE_MAX_AGE_MS", 90_000),
    priceTimeoutMs: intEnv(env, "PRICE_TIMEOUT_MS", 3_000),
    dexscreenerBase: env.DEXSCREENER_API_BASE ?? "https://api.dexscreener.com",
    withdrawAllowlist: (env.OWNER_WITHDRAW_ADDRESSES ?? "")
      .split(",")
      .map((item) => item.trim())
      .filter(Boolean),
    dexscreenerSlugOverrides,
    rpcByChainKey,
    rpcUrlsByChainKey,
    quoteTimeoutMs: intEnv(env, "QUOTE_TIMEOUT_MS", 350),
    quoteDeadlineMs: intEnv(env, "QUOTE_DEADLINE_MS", 500),
    firmTimeoutMs: intEnv(env, "FIRM_TIMEOUT_MS", 800),
    quoteTtlMs: intEnv(env, "QUOTE_TTL_MS", 2_000),
    raceGraceMs: intEnv(env, "RACE_GRACE_MS", 60),
    raceSlippageBps: Math.min(intEnv(env, "RACE_SLIPPAGE_BPS", 50), maxSlippageBps),
    screenCacheMs: intEnv(env, "SCREEN_CACHE_MS", 10 * 60 * 1000),
    balanceCacheMs: intEnv(env, "BALANCE_CACHE_MS", 3_000),
    ...solanaFees(env),
    providerBudgetPerMinute: intEnv(env, "PROVIDER_BUDGET_PER_MINUTE", 30),
    providerFailureThreshold: intEnv(env, "PROVIDER_FAILURE_THRESHOLD", 3),
    providerOpenMs: intEnv(env, "PROVIDER_OPEN_MS", 30_000),
    maxBridgeUsd: intEnv(env, "MAX_BRIDGE_USD", 25),
    maxBridgeFeeBps: intEnv(env, "MAX_BRIDGE_FEE_BPS", 50),
    dailyBridgeUsdCap: intEnv(env, "DAILY_BRIDGE_USD_CAP", 50),
    targetUsdcUsd: intEnv(env, "TARGET_USDC_USD", 20),
    targetNativeUsd: intEnv(env, "TARGET_NATIVE_USD", 2),
    executorAuthTokens: splitList(env.EXECUTOR_AUTH_TOKEN),
    resolverAuthTokens: splitList(env.RESOLVER_AUTH_TOKEN),
    strategies: {},
    listingRateLimitPerMin: intEnv(env, "LISTING_RATE_LIMIT_PER_MIN", 60),
    resolverTimeoutMs: intEnv(env, "RESOLVER_TIMEOUT_MS", 6_500),
    resolverFetchTimeoutMs: intEnv(env, "RESOLVER_FETCH_TIMEOUT_MS", 5_000),
    resolverMaxBodyBytes: intEnv(env, "RESOLVER_MAX_BODY_BYTES", 16 * 1024 * 1024),
    reconcileIntervalMs: intEnv(env, "RECONCILE_INTERVAL_MS", 5 * 60 * 1000),
    adminToken: env.ADMIN_TOKEN ?? null,
    withdrawEnabled: false,
    maxWithdrawAmount,
    maxWithdrawDailyAmount: intEnv(env, "MAX_WITHDRAW_DAILY_AMOUNT", maxWithdrawAmount),
    tokenRecoveryAllowlist: splitList(env.TOKEN_RECOVERY_ALLOWLIST),
    spendTimezone: spendTimezone(env.SPEND_TIMEZONE),
    minPoolAgeHours: intEnv(env, "MIN_POOL_AGE_HOURS", 24),
    minVolume24hUsd: intEnv(env, "MIN_VOLUME_24H_USD", 10_000),
    hyperliquidAccount: env.HYPERLIQUID_ACCOUNT_ADDRESS ?? null,
    allowHotApproval: env.ALLOW_HOT_APPROVAL === "true",
    screening: screeningEnabled(env, live),
    maxTokenTax: taxCap(env),
    confirmTimeoutMs: intEnv(env, "CONFIRM_TIMEOUT_MS", 30_000),
    reconcileAfterMinutes: intEnv(env, "RECONCILE_AFTER_MINUTES", 10),
    minExecutionSlippageBps: intEnv(env, "MIN_EXECUTION_SLIPPAGE_BPS", 20),
    routerAllowlist: manifest ? manifestRouters(manifest) : legacyRouters,
    reorgDepthByChainId: reorgDepths(env.REORG_DEPTH_JSON),
    zeroExSettlers: env.ZEROX_SETTLER_ALLOWLIST_JSON ? chainAddressMap(env.ZEROX_SETTLER_ALLOWLIST_JSON, "ZEROX_SETTLER_ALLOWLIST_JSON", /^0x[0-9a-fA-F]{40}$/) : {},
    supportByChain: supportByChain(CHAINS.map((chain) => chain.key), env.SUPPORT_TIERS),
    solanaProgramAllowlist: [...new Set([...SOLANA_BASE_PROGRAMS, ...splitList(env.SOLANA_PROGRAM_ALLOWLIST), ...(manifest?.solanaPrograms ?? [])])],
    maxValueWei: manifest ? BigInt(manifest.maxValueWei) : weiEnv(env.MAX_NATIVE_VALUE_WEI),
    mevRpcByChainId: mevRpcs(env),
    jitoUrl: env.JITO_ENABLED === "true" ? (env.JITO_BLOCK_ENGINE_URL ?? "https://mainnet.block-engine.jito.wtf/api/v1/transactions") : null,
    oneInchBase: env.ONEINCH_API_BASE ?? "https://api.1inch.com",
    kyberBase: env.KYBER_API_BASE ?? "https://aggregator-api.kyberswap.com",
    veloraBase: env.VELORA_API_BASE ?? "https://api.velora.xyz",
    keys: {
      zeroEx: env.ZEROX_API_KEY ?? null,
      jupiter: env.JUPITER_API_KEY ?? null,
      lifi: env.LIFI_API_KEY ?? null,
      lifiIntegrator: env.LIFI_INTEGRATOR ?? null,
      oneInch: env.ONEINCH_API_KEY ?? null,
      okxKey: env.OKX_API_KEY ?? null,
      okxSecret: env.OKX_API_SECRET ?? null,
      okxPassphrase: env.OKX_API_PASSPHRASE ?? null,
      kyberClientId: env.KYBERSWAP_CLIENT_ID || DEFAULT_KYBER_CLIENT_ID,
      veloraPartner: env.VELORA_PARTNER ?? null,
      acrossKey: env.ACROSS_API_KEY ?? null,
      acrossIntegrator: env.ACROSS_INTEGRATOR_ID ?? null,
      relayKey: env.RELAY_API_KEY ?? null,
      debridgeToken: env.DEBRIDGE_ACCESS_TOKEN ?? null,
      goplus: env.GOPLUS_API_KEY ?? null,
      blockaid: env.BLOCKAID_API_KEY ?? null,
      coingecko: env.COINGECKO_API_KEY ?? null,
    },
    approvalSeed: approvalSeed(env),
  };
}

export function rpcListEnv(rpcEnv: string): string | null {
  return rpcEnv.includes("RPC_URL") ? rpcEnv.replace("RPC_URL", "RPC_URLS") : null;
}

function rpcLists(env: NodeJS.ProcessEnv): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  for (const chain of CHAINS) {
    const listEnv = rpcListEnv(chain.rpcEnv);
    const urls = [...new Set([env[chain.rpcEnv] ?? "", ...splitList(listEnv ? env[listEnv] : undefined)].filter(Boolean))];
    if (urls.length === 0 && chain.defaultRpc) urls.push(chain.defaultRpc);
    if (urls.length > 0) out[chain.key] = urls;
  }
  return out;
}

function solanaFees(env: NodeJS.ProcessEnv): { solanaMaxPriorityLamports: number; jitoTipLamports: number } {
  const solanaMaxPriorityLamports = intEnv(env, "SOLANA_MAX_PRIORITY_LAMPORTS", 1_000_000);
  const jitoTipLamports = intEnv(env, "JITO_TIP_LAMPORTS", 10_000);
  if (!Number.isInteger(solanaMaxPriorityLamports) || solanaMaxPriorityLamports < 0) throw new Error("invalid SOLANA_MAX_PRIORITY_LAMPORTS");
  if (!Number.isInteger(jitoTipLamports) || jitoTipLamports < 1_000) throw new Error("JITO_TIP_LAMPORTS must be at least 1000");
  if (jitoTipLamports > solanaMaxPriorityLamports) throw new Error("JITO_TIP_LAMPORTS exceeds SOLANA_MAX_PRIORITY_LAMPORTS");
  return { solanaMaxPriorityLamports, jitoTipLamports };
}

function approvalSeed(env: NodeJS.ProcessEnv): ApprovalSeed[] {
  if (!env.APPROVAL_CACHE_JSON) return [];
  const parsed: unknown = JSON.parse(env.APPROVAL_CACHE_JSON);
  if (!Array.isArray(parsed)) throw new Error("APPROVAL_CACHE_JSON must be an array");
  return parsed.flatMap((row) => {
    if (typeof row !== "object" || row === null) return [];
    const item = row as Partial<ApprovalSeed>;
    if (typeof item.chainId !== "number" || typeof item.token !== "string" || typeof item.spender !== "string" || typeof item.owner !== "string" || typeof item.amount !== "string") {
      throw new Error("APPROVAL_CACHE_JSON row is invalid");
    }
    return [{ chainId: item.chainId, token: item.token, spender: item.spender, owner: item.owner, amount: item.amount }];
  });
}

// Worst case for one send: two legs, each waiting up to 3x CONFIRM_TIMEOUT_MS (the Solana bound; EVM is 2x),
// plus the firm build and a few RPC round trips per leg.
function weiEnv(raw: string | undefined): bigint {
  if (raw === undefined || raw === "") return DEFAULT_MAX_VALUE_WEI;
  if (!/^\d+$/.test(raw)) throw new Error("invalid MAX_NATIVE_VALUE_WEI");
  return BigInt(raw);
}

function mevRpcs(env: NodeJS.ProcessEnv): Record<number, string> {
  const out: Record<number, string> = {};
  for (const [name, value] of Object.entries(env)) {
    const match = /^MEV_RPC_URL_(\d+)$/.exec(name);
    if (match?.[1] && value) out[Number(match[1])] = value;
  }
  return out;
}
