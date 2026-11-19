import { decodeFunctionData, parseAbi, type Hex } from "viem";
import { chainByEvmId } from "../chains.js";
import { LIFI_SWAP, lifiDeposit } from "./swap-terms.js";

export type ExecutableBridge = "lifi" | "across";

const LIFI_DIAMOND = "0x1231DEB6f5749EF6cE6943a275A1D3E7486F4EaE";
export const BRIDGE_CONTRACTS: Readonly<Record<number, Readonly<Record<ExecutableBridge, string>>>> = {
  1: { lifi: LIFI_DIAMOND, across: "0x5c7BCd6E7De5423a257D81B442095A1a6ced35C5" },
  10: { lifi: LIFI_DIAMOND, across: "0x6f26Bf09B1C792e3228e5467807a900A503c0281" },
  137: { lifi: LIFI_DIAMOND, across: "0x9295ee1d8C5b022Be115A2AD3c30C72E34e7F096" },
  8453: { lifi: LIFI_DIAMOND, across: "0x09aea4b2242abC8bb4BB78D537A67a245A7bEC64" },
  42161: { lifi: LIFI_DIAMOND, across: "0xe35e9842fceaCA96570B734083f4a58e8F7C5f2A" },
};

const BRIDGE_DATA =
  "(bytes32 transactionId, string bridge, string integrator, address referrer, address sendingAssetId, address receiver, uint256 minAmount, uint256 destinationChainId, bool hasSourceSwaps, bool hasDestinationCall)";
const ACROSS_V4_DATA =
  "(bytes32 receiverAddress, bytes32 refundAddress, bytes32 sendingAssetId, bytes32 receivingAssetId, uint256 outputAmount, uint128 outputAmountMultiplier, bytes32 exclusiveRelayer, uint32 quoteTimestamp, uint32 fillDeadline, uint32 exclusivityParameter, bytes message)";

export const LIFI_ACROSS_ABI = parseAbi([
  `function startBridgeTokensViaAcrossV4(${BRIDGE_DATA} _bridgeData, ${ACROSS_V4_DATA} _acrossData) payable`,
  `function swapAndStartBridgeTokensViaAcrossV4(${BRIDGE_DATA} _bridgeData, ${LIFI_SWAP}[] _swapData, ${ACROSS_V4_DATA} _acrossData) payable`,
] as const);

export const ACROSS_SPOKE_POOL_ABI = parseAbi([
  "function deposit(bytes32 depositor, bytes32 recipient, bytes32 inputToken, bytes32 outputToken, uint256 inputAmount, uint256 outputAmount, uint256 destinationChainId, bytes32 exclusiveRelayer, uint32 quoteTimestamp, uint32 fillDeadline, uint32 exclusivityParameter, bytes message) payable",
] as const);

const MULTIPLIER_BASE = 10n ** 18n;

export type BridgeTerms = {
  provider: ExecutableBridge;
  destinationChainId: bigint;
  recipient: string;
  refund: string;
  charge: { token: string; amount: bigint };
  outputToken: string;
  minOutput: bigint;
  destinationCall: boolean;
};

function evmAddress(word: Hex): string | null {
  return /^0x0{24}[0-9a-f]{40}$/i.test(word) ? `0x${word.slice(26)}` : null;
}

function decoded<T>(read: () => T): T | null {
  try {
    return read();
  } catch {
    return null;
  }
}

function lifiTerms(data: Hex): BridgeTerms | null {
  const call = decoded(() => decodeFunctionData({ abi: LIFI_ACROSS_ABI, data }));
  if (!call) return null;
  const [bridge] = call.args;
  const across = call.functionName === "startBridgeTokensViaAcrossV4" ? call.args[1] : call.args[2];
  const recipient = evmAddress(across.receiverAddress);
  const refund = evmAddress(across.refundAddress);
  const sending = evmAddress(across.sendingAssetId);
  const outputToken = evmAddress(across.receivingAssetId);
  if (!recipient || !refund || !sending || !outputToken) return null;
  if (recipient.toLowerCase() !== bridge.receiver.toLowerCase() || sending.toLowerCase() !== bridge.sendingAssetId.toLowerCase()) return null;
  const charge = call.functionName === "startBridgeTokensViaAcrossV4" ? { token: bridge.sendingAssetId, amount: bridge.minAmount } : lifiDeposit(call.args[1], false);
  if (!charge) return null;
  const minOutput = call.functionName === "startBridgeTokensViaAcrossV4" ? across.outputAmount : (bridge.minAmount * across.outputAmountMultiplier) / MULTIPLIER_BASE;
  const destinationCall = bridge.hasDestinationCall || across.message !== "0x";
  return { provider: "lifi", destinationChainId: bridge.destinationChainId, recipient, refund, charge, outputToken, minOutput, destinationCall };
}

function acrossTerms(data: Hex): BridgeTerms | null {
  const call = decoded(() => decodeFunctionData({ abi: ACROSS_SPOKE_POOL_ABI, data }));
  if (!call) return null;
  const [depositor, recipientWord, inputToken, outputWord, inputAmount, outputAmount, destinationChainId, , , , , message] = call.args;
  const recipient = evmAddress(recipientWord);
  const refund = evmAddress(depositor);
  const token = evmAddress(inputToken);
  const outputToken = evmAddress(outputWord);
  if (!recipient || !refund || !token || !outputToken) return null;
  return { provider: "across", destinationChainId, recipient, refund, charge: { token, amount: inputAmount }, outputToken, minOutput: outputAmount, destinationCall: message !== "0x" };
}

export function bridgeTerms(data: Hex): BridgeTerms | null {
  return lifiTerms(data) ?? acrossTerms(data);
}

export type BridgeCheck = {
  chainId: number;
  to: string;
  data: Hex;
  value: bigint;
  owner: string;
  allowlist: readonly string[];
  charge?: { token: string; amount: bigint };
  chainIds: readonly number[];
};

function chainLabel(chainId: bigint | number): string {
  return `${chainByEvmId(Number(chainId))?.key ?? "unknown"} (chain id ${chainId})`;
}

export function bridgeSpenders(chainId: number): string[] {
  return Object.values(BRIDGE_CONTRACTS[chainId] ?? {});
}

export function checkBridge(input: BridgeCheck): void {
  const same = (left: string, right: string) => left.toLowerCase() === right.toLowerCase();
  if (input.value !== 0n) throw new Error("bridge must not attach native value");
  const terms = bridgeTerms(input.data);
  if (!terms) throw new Error("bridge calldata is not a call the signing policy decodes");
  const contract = BRIDGE_CONTRACTS[input.chainId]?.[terms.provider];
  if (!contract || !same(contract, input.to)) throw new Error(`bridge contract is not the verified ${terms.provider} contract for ${chainLabel(input.chainId)}`);
  const destination = terms.destinationChainId;
  if (destination === BigInt(input.chainId) || !input.chainIds.some((id) => BigInt(id) === destination)) {
    throw new Error(`bridge destination chain ${destination} is not in the signing policy`);
  }
  if (!same(terms.recipient, input.owner) && !input.allowlist.some((item) => same(item, terms.recipient))) {
    throw new Error(`bridge recipient ${terms.recipient.toLowerCase()} on ${chainLabel(destination)} is not this wallet or an allowlisted destination`);
  }
  if (!same(terms.refund, input.owner)) throw new Error("bridge refund address is not this wallet");
  if (terms.destinationCall) throw new Error("bridge runs a call on the destination chain");
  if (!input.charge) throw new Error("bridge has no reserved charge");
  if (!same(terms.charge.token, input.charge.token) || terms.charge.amount !== input.charge.amount) {
    throw new Error(`bridge charges ${terms.charge.amount} of ${terms.charge.token.toLowerCase()}, not the ${input.charge.amount} reserved`);
  }
}
