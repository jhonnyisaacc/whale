import type { SwapIntent } from "../domain.js";
import type { HyperMarket, HyperMarketQuery } from "../hyperliquid-markets.js";
import { belowPerpMinimum, type LimitConfig } from "../limits.js";

export type HyperMarketOf = (query: HyperMarketQuery) => Promise<HyperMarket | null>;

function marketQuery(token: SwapIntent["token"], market: "perp" | "spot"): HyperMarketQuery | string {
  if (token.chain.kind === "hypercore") return market === "perp" && token.chain.market === "perp" ? { market, coin: token.address } : `${token.address} is not a hypercore ${market} token`;
  if (token.chainKey === "hyperevm" && market === "spot") return { market, evmContract: token.address };
  return `${token.symbol} on ${token.chainKey} has no hyperliquid ${market} market`;
}

export async function tokenHyperMarket(intent: SwapIntent, deps: { hyperMarket?: HyperMarketOf; config: Pick<LimitConfig, "maxUsdPerTrade"> }): Promise<HyperMarket | string> {
  const claim = intent.hyperliquid;
  const belowMinimum = claim?.market === "perp" ? belowPerpMinimum(deps.config, intent.notionalUsd) : null;
  if (belowMinimum) return belowMinimum;
  const marketOf = deps.hyperMarket;
  if (!claim || !marketOf) return "hyperliquid market unverifiable";
  const query = marketQuery(intent.token, claim.market);
  if (typeof query === "string") return query;
  let market: HyperMarket | null;
  try {
    market = await marketOf(query);
  } catch {
    return "hyperliquid market unverifiable";
  }
  if (!market) return `${intent.token.address} has no hyperliquid ${claim.market} market`;
  if (claim.coin !== market.coin || claim.assetIndex !== market.assetIndex) {
    return `hyperliquid ${claim.coin} asset ${claim.assetIndex} is not the ${claim.market} market of ${intent.token.address}, asset ${market.assetIndex}`;
  }
  return market;
}
