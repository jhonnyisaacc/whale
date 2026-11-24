import type { SpendJournal } from "../spend.js";
import type { BridgeSpend } from "./execute.js";

export const BRIDGE_SCOPE = "bridge";

export function bridgeSpend(journal: SpendJournal, dailyBridgeUsdCap: number): BridgeSpend {
  const scope = { strategyId: BRIDGE_SCOPE, capUsd: dailyBridgeUsdCap };
  return {
    reserve: (key, usd) => journal.reserve(key, usd, scope),
    release: (key) => journal.release(key),
    commit: (key) => journal.commit(key),
    record: (key, tx) => journal.record(key, tx),
  };
}
