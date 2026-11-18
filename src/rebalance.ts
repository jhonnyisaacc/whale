import { addressKey } from "./chains.js";

export const BRIDGE_PROVIDERS = ["lifi", "across", "relay", "debridge"] as const;

export type BridgeProvider = (typeof BRIDGE_PROVIDERS)[number];

export type ChainAddress = { chainKey: string; address: string };

export type BridgeQuote = {
  provider: BridgeProvider;
  feeUsd: number;
  amountInUsd: number;
  destination: ChainAddress;
};

export type RebalancePlan =
  | { kind: "skip"; reason: string; quote: null }
  | { kind: "would_send"; reason: string; quote: BridgeQuote; broadcast: false };

export function planRebalance(input: {
  quotes: readonly BridgeQuote[];
  maxBridgeUsd: number;
  maxFeeBps: number;
  spentBridgeUsd: number;
  dailyBridgeCap: number;
  ownAddresses: readonly ChainAddress[];
  allowlist: readonly ChainAddress[];
}): RebalancePlan {
  if (input.allowlist.length === 0) return { kind: "skip", reason: "bridge allowlist is empty", quote: null };
  const usable = input.quotes.filter((quote) => {
    if (!listed(input.ownAddresses, quote.destination) || !listed(input.allowlist, quote.destination)) return false;
    if (!(quote.amountInUsd > 0) || quote.amountInUsd > input.maxBridgeUsd) return false;
    const feeBps = (quote.feeUsd / quote.amountInUsd) * 10_000;
    return Number.isFinite(feeBps) && feeBps <= input.maxFeeBps && quote.feeUsd >= 0;
  });
  if (usable.length === 0) return { kind: "skip", reason: "no bridge quote inside the fee cap and allowlist", quote: null };
  const next = usable.reduce((best, quote) => (quote.feeUsd < best.feeUsd ? quote : best));
  if (input.spentBridgeUsd + next.amountInUsd > input.dailyBridgeCap) {
    return { kind: "skip", reason: "bridge daily cap", quote: null };
  }
  return {
    kind: "would_send",
    reason: `${next.provider} fee ${next.feeUsd} USD`,
    quote: next,
    broadcast: false,
  };
}

function listed(list: readonly ChainAddress[], target: ChainAddress): boolean {
  const key = addressKey(target.chainKey, target.address);
  return list.some((item) => item.chainKey === target.chainKey && addressKey(item.chainKey, item.address) === key);
}
