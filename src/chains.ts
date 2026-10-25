import type { ChainRef } from "./domain.js";

export type LiveSend = "eip1559" | "solana" | "hypercore" | "disabled";

export type AggregatorId = "zeroex" | "lifi" | "jupiter" | "none";

export type ChainSpec = {
  key: string;
  chain: ChainRef;
  nativeSymbol: string;
  minNativeReserve: number;
  aggregator: AggregatorId;
  enabledByDefault: boolean;
  liveSend: LiveSend;
  rpcEnv: string;
  defaultRpc: string | null;
  dexscreenerSlug: string | null;
  sources: string[];
  gap: string | null;
};

const evm = (
  key: string,
  chainId: number,
  nativeSymbol: string,
  minNativeReserve: number,
  aggregator: AggregatorId,
  rpcEnv: string,
  defaultRpc: string | null,
  dexscreenerSlug: string | null,
  sources: string[],
  gap: string | null = null,
  enabledByDefault = true,
): ChainSpec => ({
  key,
  chain: { kind: "evm", chainId },
  nativeSymbol,
  minNativeReserve,
  aggregator,
  enabledByDefault,
  liveSend: key === "zksync" ? "disabled" : "eip1559",
  rpcEnv,
  defaultRpc,
  dexscreenerSlug,
  sources,
  gap,
});

export const CHAINS: readonly ChainSpec[] = [
  evm("ethereum", 1, "ETH", 0.002, "zeroex", "RPC_URL_1", null, "ethereum", [
    "https://docs.0x.org/docs/introduction/supported-chains",
  ]),
  evm("optimism", 10, "ETH", 0.001, "zeroex", "RPC_URL_10", null, "optimism", [
    "https://docs.0x.org/docs/introduction/supported-chains",
  ]),
  evm("bnb", 56, "BNB", 0.004, "zeroex", "RPC_URL_56", null, "bsc", [
    "https://docs.0x.org/docs/introduction/supported-chains",
  ]),
  evm("polygon", 137, "POL", 25, "zeroex", "RPC_URL_137", null, "polygon", [
    "https://docs.0x.org/docs/introduction/supported-chains",
  ]),
  evm(
    "zksync",
    324,
    "ETH",
    0.001,
    "lifi",
    "RPC_URL_324",
    "https://mainnet.era.zksync.io",
    "zksync",
    [
      "https://docs.zksync.io/zksync-network/zksync-era/network-details",
      "https://docs.li.fi/llms.txt",
    ],
    "0x Swap API does not list zkSync. Quotes use LI.FI with fromChain equal to toChain. Live send stays off because zkSync transactions are not standard EIP-1559.",
  ),
  evm("base", 8453, "ETH", 0.001, "zeroex", "RPC_URL_8453", null, "base", [
    "https://docs.0x.org/docs/introduction/supported-chains",
  ]),
  evm("arbitrum", 42161, "ETH", 0.001, "zeroex", "RPC_URL_42161", null, "arbitrum", [
    "https://docs.0x.org/docs/introduction/supported-chains",
  ]),
  evm("linea", 59144, "ETH", 0.001, "zeroex", "RPC_URL_59144", null, "linea", [
    "https://docs.0x.org/docs/introduction/supported-chains",
  ]),
  evm(
    "blast",
    81457,
    "ETH",
    0.001,
    "lifi",
    "RPC_URL_81457",
    "https://rpc.blast.io",
    "blast",
    [
      "https://docs.blast.io/building/network-information",
      "https://docs.li.fi/llms.txt",
    ],
    "0x removed Blast from its swap chain list. Quotes use LI.FI same-chain only.",
  ),
  evm("scroll", 534352, "ETH", 0.001, "zeroex", "RPC_URL_534352", null, "scroll", [
    "https://docs.0x.org/docs/introduction/supported-chains",
  ]),
  evm(
    "robinhood",
    4663,
    "ETH",
    0.001,
    "zeroex",
    "RPC_URL_4663",
    "https://rpc.mainnet.chain.robinhood.com",
    null,
    [
      "https://docs.robinhood.com/chain/connecting/",
      "https://docs.0x.org/changelog",
    ],
    "DexScreener's slug for Robinhood Chain was not in the sources checked, so pool refresh ignores that slug until DEXSCREENER_CHAIN_SLUGS sets one.",
  ),
  evm(
    "hyperevm",
    999,
    "HYPE",
    0.03,
    "zeroex",
    "RPC_URL_999",
    "https://rpc.hyperliquid.xyz/evm",
    null,
    [
      "https://hyperliquid.gitbook.io/hyperliquid-docs/for-developers/hyperevm",
      "https://docs.0x.org/docs/introduction/supported-chains",
    ],
    "DexScreener's slug for HyperEVM was not confirmed. Pool refresh ignores it until DEXSCREENER_CHAIN_SLUGS sets one. 0x lists HyperEVM on the Swap API.",
  ),
  evm(
    "monad",
    143,
    "MON",
    100,
    "zeroex",
    "RPC_URL_143",
    "https://rpc.monad.xyz",
    null,
    [
      "https://docs.monad.xyz/developer-essentials/network-information",
      "https://docs.0x.org/docs/introduction/supported-chains",
      "https://docs.kyberswap.com/developer-guide/aggregator-api/aggregator-api-specification/evm-swaps",
      "https://docs.monad.xyz/tooling-and-infra/dex-aggregators",
    ],
    "Monad mainnet is chain 143. The network page lists https://rpc.monad.xyz. 0x lists Swap API support for 143. KyberSwap lists the aggregator slug monad. Monad's aggregator page names LI.FI. DexScreener's slug was not on those pages, so pool refresh ignores Monad until DEXSCREENER_CHAIN_SLUGS sets one. The chain stays off until ENABLED_CHAINS includes monad. No swap router address is shipped. Set ROUTER_ALLOWLIST_JSON for 143. feeRankOf returns 1000 because Monad is not in the rank table.",
    false,
  ),
  {
    key: "solana",
    chain: { kind: "solana" },
    nativeSymbol: "SOL",
    minNativeReserve: 0.02,
    aggregator: "jupiter",
    enabledByDefault: true,
    liveSend: "solana",
    rpcEnv: "SOLANA_RPC_URL",
    defaultRpc: null,
    dexscreenerSlug: "solana",
    sources: ["https://developers.jup.ag/docs/api-reference/swap/v1/quote"],
    gap: "Jupiter's published quote page says Metis Swap V1 is superseded by Swap V2. The default URL remains the V1 path that page documents. Live mode refuses any other host.",
  },
  {
    key: "hypercore",
    chain: { kind: "hypercore", market: "perp" },
    nativeSymbol: "USDC",
    minNativeReserve: 0,
    aggregator: "none",
    enabledByDefault: true,
    liveSend: "hypercore",
    rpcEnv: "HYPERLIQUID_API_URL",
    defaultRpc: "https://api.hyperliquid.xyz",
    dexscreenerSlug: null,
    sources: [
      "https://hyperliquid.gitbook.io/hyperliquid-docs/for-developers/api/exchange-endpoint",
      "https://hyperliquid.gitbook.io/hyperliquid-docs/for-developers/api/nonces-and-api-wallets",
      "https://github.com/hyperliquid-dex/hyperliquid-python-sdk/blob/master/hyperliquid/utils/signing.py",
    ],
    gap: "The service signs only order, cancel, and updateLeverage. It does not construct withdraw3 or agentSendAsset. Official docs describe API wallets as signers for a master account. They do not state a protocol-level withdraw ban in the pages checked, so the ban is enforced here.",
  },
];

const byKey = new Map(CHAINS.map((chain) => [chain.key, chain]));
const byEvmId = new Map(
  CHAINS.flatMap((chain) => (chain.chain.kind === "evm" ? [[chain.chain.chainId, chain] as const] : [])),
);

export function chainByKey(key: string): ChainSpec | undefined {
  return byKey.get(key);
}

// Blocks below the head at which a mined nonce is treated as final: Polygon and BNB reorg deeper than the other chains.
const REORG_DEPTH: Readonly<Record<number, number>> = { 56: 15, 137: 64 };
export const DEFAULT_REORG_DEPTH = 3;

export function reorgDepth(chainId: number, overrides: Readonly<Record<number, number>>): number {
  return overrides[chainId] ?? REORG_DEPTH[chainId] ?? DEFAULT_REORG_DEPTH;
}

export function chainByEvmId(chainId: number): ChainSpec | undefined {
  return byEvmId.get(chainId);
}

const FEE_RANK: Record<string, number> = {
  solana: 10,
  base: 20,
  arbitrum: 30,
  optimism: 40,
  polygon: 50,
  bnb: 60,
  linea: 70,
  scroll: 80,
  blast: 90,
  zksync: 100,
  robinhood: 110,
  hyperevm: 120,
  hypercore: 150,
  ethereum: 200,
};

const GAS_CEILING_USD: Record<string, number> = {
  solana: 0.02,
  base: 0.03,
  arbitrum: 0.03,
  optimism: 0.03,
  polygon: 0.05,
  bnb: 0.05,
  linea: 0.05,
  scroll: 0.08,
  blast: 0.08,
  zksync: 0.1,
  robinhood: 0.1,
  hyperevm: 0.1,
  hypercore: 0,
  ethereum: 2,
};

export function feeRankOf(key: string): number {
  return FEE_RANK[key] ?? 1_000;
}

export function gasCeilingUsd(key: string): number {
  return GAS_CEILING_USD[key] ?? 1;
}

export function dexscreenerSlugMap(overrides: Record<string, string> = {}): Map<string, string> {
  const map = new Map<string, string>();
  for (const chain of CHAINS) {
    if (chain.dexscreenerSlug) map.set(chain.dexscreenerSlug, chain.key);
  }
  for (const [slug, key] of Object.entries(overrides)) {
    if (chainByKey(key)) map.set(slug, key);
  }
  return map;
}

export type QuoteAsset = { address: string; symbol: string; decimals: number };

export type QuoteAssets = Readonly<Record<string, readonly QuoteAsset[]>>;

export function addressKey(chainKey: string, address: string): string {
  return chainByKey(chainKey)?.chain.kind === "evm" ? address.toLowerCase() : address;
}

export function quoteAssetOf(quoteAssets: QuoteAssets, chainKey: string, address: string): QuoteAsset | undefined {
  const key = addressKey(chainKey, address);
  return quoteAssets[chainKey]?.find((asset) => addressKey(chainKey, asset.address) === key);
}

const usdc = (address: string): QuoteAsset => ({ address, symbol: "USDC", decimals: 6 });
const weth = (address: string): QuoteAsset => ({ address, symbol: "WETH", decimals: 18 });

export const QUOTE_ASSETS: QuoteAssets = {
  ethereum: [
    usdc("0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48"),
    { address: "0xdac17f958d2ee523a2206206994597c13d831ec7", symbol: "USDT", decimals: 6 },
    weth("0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2"),
  ],
  optimism: [usdc("0x0b2C639c533813f4Aa9D7837CAf62653d097Ff85"), weth("0x4200000000000000000000000000000000000006")],
  polygon: [usdc("0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359")],
  zksync: [usdc("0x1d17CBcF0D6D143135aE902365D2E5e2A16538D4")],
  base: [usdc("0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913"), weth("0x4200000000000000000000000000000000000006")],
  arbitrum: [usdc("0xaf88d065e77c8cC2239327C5EDb3A432268e5831"), weth("0x82aF49447D8a07e3bd95BD0d56f35241523fBab1")],
  linea: [usdc("0x176211869cA2b568f2A7D4EE941E073a821EE1ff")],
  blast: [weth("0x4300000000000000000000000000000000000004"), { address: "0x4300000000000000000000000000000000000003", symbol: "USDB", decimals: 18 }],
  scroll: [weth("0x5300000000000000000000000000000000000004")],
  hyperevm: [usdc("0xb88339CB7199b77E23DB6E890353E22632Ba630f")],
  monad: [usdc("0x754704Bc059F8C67012fEd69BC8A327a5aafb603"), { address: "0x3bd359C1119dA7Da1D913D1C4D2B7c461115433A", symbol: "WMON", decimals: 18 }],
  solana: [
    usdc("EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v"),
    { address: "Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB", symbol: "USDT", decimals: 6 },
    { address: "So11111111111111111111111111111111111111112", symbol: "SOL", decimals: 9 },
  ],
};
