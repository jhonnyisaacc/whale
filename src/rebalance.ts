import { addressFitsChain } from "./balances.js";
import { CHAINS, addressKey, type QuoteAsset, type QuoteAssets } from "./chains.js";

export const BRIDGE_PROVIDERS = ["lifi", "across", "relay", "debridge"] as const;

export type BridgeProvider = (typeof BRIDGE_PROVIDERS)[number];

export type ChainAddress = { chainKey: string; address: string };

export type BridgeQuote = {
  provider: BridgeProvider;
  feeUsd: number;
  amountInUsd: number;
  destination: ChainAddress;
};

export type BridgeRequest = { fromChainKey: string; destination: ChainAddress; asset: string; amount: string };

export type BridgePolicy = {
  enabledChainKeys: ReadonlySet<string>;
  allowlist: readonly ChainAddress[];
  senders: readonly ChainAddress[];
  assets: QuoteAssets;
  maxBridgeUsd: number;
  maxFeeBps: number;
  dailyBridgeCap: number;
};

export type BridgeRoute = {
  source: ChainAddress;
  destination: ChainAddress;
  sell: QuoteAsset;
  buy: QuoteAsset;
  amount: string;
  amountInUsd: number;
};

const USD_STABLES: ReadonlySet<string> = new Set(["USDC", "USDT"]);

export function chainAddresses(enabledChainKeys: ReadonlySet<string>, addresses: readonly string[]): ChainAddress[] {
  return CHAINS.filter((chain) => enabledChainKeys.has(chain.key)).flatMap((chain) =>
    addresses.filter((address) => addressFitsChain(chain.key, address)).map((address) => ({ chainKey: chain.key, address })),
  );
}

export function bridgeRoute(request: BridgeRequest, policy: BridgePolicy): { kind: "route"; route: BridgeRoute } | { kind: "refused"; reason: string } {
  const refuse = (reason: string) => ({ kind: "refused" as const, reason });
  const { fromChainKey, destination } = request;
  for (const chainKey of [fromChainKey, destination.chainKey]) {
    if (!policy.enabledChainKeys.has(chainKey)) return refuse(`${chainKey} is not enabled`);
  }
  if (fromChainKey === destination.chainKey) return refuse("the source and destination chains are the same");
  if (!addressFitsChain(destination.chainKey, destination.address)) return refuse(`the destination is not a ${destination.chainKey} address`);
  if (!listed(policy.allowlist, destination)) return refuse("the destination is not on the owner allowlist");
  const source = policy.senders.find((sender) => sender.chainKey === fromChainKey);
  if (!source) return refuse(`no hot wallet address is configured for ${fromChainKey}`);
  if (!USD_STABLES.has(request.asset)) return refuse("bridge plans move USDC or USDT only, because the USD caps need a local price");
  const sell = policy.assets[fromChainKey]?.find((asset) => asset.symbol === request.asset);
  const buy = policy.assets[destination.chainKey]?.find((asset) => asset.symbol === request.asset);
  if (!sell || !buy) return refuse(`${request.asset} is not a quote asset on both ${fromChainKey} and ${destination.chainKey}`);
  return { kind: "route", route: { source, destination, sell, buy, amount: request.amount, amountInUsd: Number(request.amount) / 10 ** sell.decimals } };
}

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
