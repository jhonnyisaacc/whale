export const BRIDGE_PROVIDERS = ["lifi", "across", "relay", "debridge"] as const;

export type BridgeProvider = (typeof BRIDGE_PROVIDERS)[number];

export type BridgeQuote = {
  provider: BridgeProvider;
  feeUsd: number;
  amountInUsd: number;
  destination: string;
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
  ownAddresses: readonly string[];
  allowlist: readonly string[];
}): RebalancePlan {
  if (input.allowlist.length === 0) return { kind: "skip", reason: "bridge allowlist is empty", quote: null };
  const own = new Set(input.ownAddresses.map((item) => item.toLowerCase()));
  const allowed = new Set(input.allowlist.map((item) => item.toLowerCase()));
  const usable = input.quotes.filter((quote) => {
    const dest = quote.destination.toLowerCase();
    if (!own.has(dest) || !allowed.has(dest)) return false;
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
