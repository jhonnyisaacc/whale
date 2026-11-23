export type BridgeToken = { address: string; decimals: number };

export const BRIDGE_TOKENS: Readonly<Record<string, Readonly<Record<number, BridgeToken>>>> = {
  USDC: {
    1: { address: "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48", decimals: 6 },
    10: { address: "0x0b2C639c533813f4Aa9D7837CAf62653d097Ff85", decimals: 6 },
    137: { address: "0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359", decimals: 6 },
    8453: { address: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913", decimals: 6 },
    42161: { address: "0xaf88d065e77c8cC2239327C5EDb3A432268e5831", decimals: 6 },
  },
  USDT: {
    1: { address: "0xdAC17F958D2ee523a2206206994597C13D831ec7", decimals: 6 },
    10: { address: "0x94b008aA00579c1307B0EF2c499aD98a8ce58e58", decimals: 6 },
    137: { address: "0xc2132D05D31c914a87C6611C10748AEb04B58e8F", decimals: 6 },
    8453: { address: "0xfde4C96c8593536E31F229EA8f37b2ADa2699bb2", decimals: 6 },
    42161: { address: "0xFd086bC7CD5C481DCC9C85ebE478A1C0b69FCbb9", decimals: 6 },
  },
  WETH: {
    1: { address: "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2", decimals: 18 },
    10: { address: "0x4200000000000000000000000000000000000006", decimals: 18 },
    137: { address: "0x7ceB23fD6bC0adD59E62ac25578270cFf1b9f619", decimals: 18 },
    8453: { address: "0x4200000000000000000000000000000000000006", decimals: 18 },
    42161: { address: "0x82aF49447D8a07e3bd95BD0d56f35241523fBab1", decimals: 18 },
  },
};

export type BridgePair = { symbol: string; input: BridgeToken; output: BridgeToken };

export function bridgePair(sourceChainId: number, inputToken: string, destinationChainId: number, outputToken: string): BridgePair | null {
  const same = (left: string, right: string) => left.toLowerCase() === right.toLowerCase();
  for (const [symbol, byChain] of Object.entries(BRIDGE_TOKENS)) {
    const input = byChain[sourceChainId];
    const output = byChain[destinationChainId];
    if (input && output && same(input.address, inputToken) && same(output.address, outputToken)) return { symbol, input, output };
  }
  return null;
}

export function meetsBridgeFloor(pair: BridgePair, charged: bigint, minOutput: bigint, maxFeeBps: number): boolean {
  const common = Math.max(pair.input.decimals, pair.output.decimals);
  const received = minOutput * 10n ** BigInt(common - pair.output.decimals) * 10_000n;
  const floor = charged * 10n ** BigInt(common - pair.input.decimals) * BigInt(10_000 - maxFeeBps);
  return received >= floor;
}

const PAR = 10n ** 18n;

export function withinPar(pair: BridgePair, multiplier: bigint): boolean {
  return multiplier * 10n ** BigInt(pair.input.decimals) <= PAR * 10n ** BigInt(pair.output.decimals);
}
