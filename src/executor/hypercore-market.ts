import type { SwapIntent } from "../domain.js";
import type { HyperMarket } from "../hyperliquid-markets.js";

export type HyperMarketOf = (query: { coin: string; market: "perp" | "spot" }) => Promise<HyperMarket | null>;

export async function tokenHyperMarket(intent: SwapIntent, marketOf: HyperMarketOf | undefined): Promise<HyperMarket | string> {
  const claim = intent.hyperliquid;
  const { token } = intent;
  if (!claim || !marketOf) return "hyperliquid market unverifiable";
  if (token.chain.kind === "hypercore" && token.chain.market !== claim.market) return `${token.symbol} is a hypercore ${token.chain.market} token, not ${claim.market}`;
  let market: HyperMarket | null;
  try {
    market = await marketOf({ coin: token.symbol, market: claim.market });
  } catch {
    return "hyperliquid market unverifiable";
  }
  if (!market) return `${token.symbol} has no hyperliquid ${claim.market} market`;
  if (claim.coin !== market.coin || claim.assetIndex !== market.assetIndex) {
    return `hyperliquid ${claim.coin} asset ${claim.assetIndex} is not the ${claim.market} market of ${token.symbol}, asset ${market.assetIndex}`;
  }
  return market;
}
