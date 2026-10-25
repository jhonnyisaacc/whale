import type { AppConfig } from "./types.js";

export function sendBoundMs(config: Pick<AppConfig, "confirmTimeoutMs" | "firmTimeoutMs">): number {
  return 2 * (3 * config.confirmTimeoutMs + config.firmTimeoutMs + 5_000);
}

export function drainTimeoutMs(config: Pick<AppConfig, "confirmTimeoutMs" | "firmTimeoutMs" | "quoteDeadlineMs">): number {
  return sendBoundMs(config) + config.quoteDeadlineMs + 5_000;
}

export function serviceTokens(config: AppConfig): string[] {
  return [...config.executorAuthTokens, ...config.resolverAuthTokens, ...Object.values(config.strategies).flatMap((strategy) => strategy.tokens)];
}

export function configSecrets(config: AppConfig): string[] {
  const { zeroEx, jupiter, lifi, oneInch, okxKey, okxSecret, okxPassphrase, acrossKey, relayKey, debridgeToken, goplus, blockaid, coingecko } = config.keys;
  return [
    zeroEx,
    jupiter,
    lifi,
    oneInch,
    okxKey,
    okxSecret,
    okxPassphrase,
    acrossKey,
    relayKey,
    debridgeToken,
    goplus,
    blockaid,
    coingecko,
    ...serviceTokens(config),
    config.adminToken,
    config.notifierUrl,
    config.databaseUrl,
    ...Object.values(config.rpcUrlsByChainKey).flat(),
    ...Object.values(config.mevRpcByChainId),
  ].filter((item): item is string => typeof item === "string" && item.length >= 8);
}

export function publicConfig(config: AppConfig): Record<string, unknown> {
  return {
    live: config.live,
    killSwitch: config.killSwitch,
    maxUsdPerTrade: config.maxUsdPerTrade,
    dailyUsdCap: config.dailyUsdCap,
    maxSlippageBps: config.maxSlippageBps,
    maxLeverage: config.maxLeverage,
    minLiquidityUsd: config.minLiquidityUsd,
    enabledChainKeys: [...config.enabledChainKeys],
    refreshEnabled: config.refreshEnabled,
    shortlistLimit: config.shortlistLimit,
    quoteDeadlineMs: config.quoteDeadlineMs,
    screening: config.screening,
    maxTokenTax: config.maxTokenTax,
    jito: config.jitoUrl !== null,
    strategies: Object.entries(config.strategies).map(([id, strategy]) => ({ id, dailyUsdCap: strategy.dailyUsdCap, maxUsdPerTrade: strategy.maxUsdPerTrade })),
  };
}
