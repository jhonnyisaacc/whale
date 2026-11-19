import type { AppConfig } from "../config.js";
import { commitSpend, createMemoryJournal, recordSpend, releaseSpend, spendDay } from "../spend.js";
import type { BridgeSpend } from "./execute.js";

export const BRIDGE_SCOPE = "bridge";

export function bridgeSpend(config: Pick<AppConfig, "databaseUrl" | "dailyUsdCap" | "dailyBridgeUsdCap" | "spendTimezone">, now: () => Date = () => new Date()): BridgeSpend {
  const scope = { strategyId: BRIDGE_SCOPE, capUsd: config.dailyBridgeUsdCap };
  const day = () => spendDay(now(), config.spendTimezone);
  const { databaseUrl } = config;
  if (databaseUrl) {
    return {
      reserve: (key, usd) => recordSpend(databaseUrl, key, usd, day(), config.dailyUsdCap, scope),
      release: (key) => releaseSpend(databaseUrl, key),
      commit: (key) => commitSpend(databaseUrl, key),
    };
  }
  const memory = createMemoryJournal();
  return {
    reserve: (key, usd) => memory.reserve(key, usd, day(), config.dailyUsdCap, scope),
    release: (key) => memory.settle(key, "released"),
    commit: (key) => memory.settle(key, "committed"),
  };
}
