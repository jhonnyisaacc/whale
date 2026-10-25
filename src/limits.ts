import type { ChainRef } from "./domain.js";
import { chainByEvmId, chainByKey, type QuoteAssets } from "./chains.js";

export type LimitConfig = {
  maxUsdPerTrade: number;
  dailyUsdCap: number;
  maxSlippageBps: number;
  slippageHardMaxBps: number;
  maxLeverage: number;
  minLiquidityUsd: number;
  killSwitch: boolean;
  enabledChainKeys: ReadonlySet<string>;
  minExecutionSlippageBps?: number;
  quoteAssets?: QuoteAssets;
  spendTimezone?: string;
};

export type LimitInput = {
  notionalUsd: number;
  slippageBps: number;
  leverage: number;
  spentTodayUsd: number;
  chain: ChainRef;
  chainKey: string;
  liquidityUsd: number | null;
};

export type LimitDecision = { ok: true } | { ok: false; reason: string };

export function checkLimits(config: LimitConfig, input: LimitInput): LimitDecision {
  if (config.killSwitch) return { ok: false, reason: "kill switch is on" };
  if (!config.enabledChainKeys.has(input.chainKey)) {
    return { ok: false, reason: `chain ${input.chainKey} is disabled` };
  }
  if (!(input.notionalUsd > 0) || input.notionalUsd > config.maxUsdPerTrade) {
    return { ok: false, reason: `notional exceeds ${config.maxUsdPerTrade} USD` };
  }
  if (input.spentTodayUsd + input.notionalUsd > config.dailyUsdCap) {
    return { ok: false, reason: `daily cap ${config.dailyUsdCap} USD` };
  }
  if (input.slippageBps < 0 || input.slippageBps > config.maxSlippageBps) {
    return { ok: false, reason: `slippage exceeds ${config.maxSlippageBps} bps` };
  }
  if (input.slippageBps > config.slippageHardMaxBps) {
    return { ok: false, reason: `slippage exceeds hard max ${config.slippageHardMaxBps} bps` };
  }
  if (input.chain.kind === "hypercore" && input.leverage > config.maxLeverage) {
    return { ok: false, reason: `leverage exceeds ${config.maxLeverage}` };
  }
  if (input.liquidityUsd !== null && input.liquidityUsd < config.minLiquidityUsd && input.chain.kind !== "hypercore") {
    return { ok: false, reason: `liquidity below ${config.minLiquidityUsd} USD` };
  }
  return { ok: true };
}

export function chainKeyFor(chain: ChainRef): string | undefined {
  if (chain.kind === "solana") return "solana";
  if (chain.kind === "hypercore") return "hypercore";
  return chainByEvmId(chain.chainId)?.key;
}

export function knownChain(chainKey: string): boolean {
  return chainByKey(chainKey) !== undefined;
}
