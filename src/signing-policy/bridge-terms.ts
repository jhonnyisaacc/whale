import { decodeAbiParameters, decodeFunctionData, encodeFunctionData, pad, parseAbi, parseAbiParameters, toFunctionSelector, type Hex } from "viem";
import { chainByEvmId } from "../chains.js";
import { bridgePair, meetsBridgeFloor, withinPar } from "./bridge-tokens.js";
import { evmAddress, lifiStepRefusal, MAX_U128, type LifiStep } from "./lifi-steps.js";

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
const LIFI_SWAP_DATA = "(address callTo, address approveTo, address sendingAssetId, address receivingAssetId, uint256 fromAmount, bytes callData, bool requiresDeposit)";
const ACROSS_V4_DATA =
  "(bytes32 receiverAddress, bytes32 refundAddress, bytes32 sendingAssetId, bytes32 receivingAssetId, uint256 outputAmount, uint128 outputAmountMultiplier, bytes32 exclusiveRelayer, uint32 quoteTimestamp, uint32 fillDeadline, uint32 exclusivityParameter, bytes message)";

export const LIFI_ACROSS_ABI = parseAbi([
  `function startBridgeTokensViaAcrossV4(${BRIDGE_DATA} _bridgeData, ${ACROSS_V4_DATA} _acrossData) payable`,
  `function swapAndStartBridgeTokensViaAcrossV4(${BRIDGE_DATA} _bridgeData, ${LIFI_SWAP_DATA}[] _swapData, ${ACROSS_V4_DATA} _acrossData) payable`,
] as const);

const BRIDGE_WORDS =
  "(bytes32 transactionId, string bridge, string integrator, address referrer, bytes32 sendingAssetId, bytes32 receiver, uint256 minAmount, uint256 destinationChainId, bool hasSourceSwaps, bool hasDestinationCall)";
const LIFI_SWAP_WORDS = "(bytes32 callTo, bytes32 approveTo, bytes32 sendingAssetId, bytes32 receivingAssetId, uint256 fromAmount, bytes callData, bool requiresDeposit)";
const LIFI_START_ARGS = parseAbiParameters(`${BRIDGE_WORDS} _bridgeData, ${ACROSS_V4_DATA} _acrossData`);
const LIFI_SWAP_AND_START_ARGS = parseAbiParameters(`${BRIDGE_WORDS} _bridgeData, ${LIFI_SWAP_WORDS}[] _swapData, ${ACROSS_V4_DATA} _acrossData`);
const [LIFI_START, LIFI_SWAP_AND_START] = LIFI_ACROSS_ABI.map((item) => toFunctionSelector(item));

export const ACROSS_SPOKE_POOL_ABI = parseAbi([
  "function deposit(bytes32 depositor, bytes32 recipient, bytes32 inputToken, bytes32 outputToken, uint256 inputAmount, uint256 outputAmount, uint256 destinationChainId, bytes32 exclusiveRelayer, uint32 quoteTimestamp, uint32 fillDeadline, uint32 exclusivityParameter, bytes message) payable",
] as const);

export type BridgeTerms = {
  provider: ExecutableBridge;
  destinationChainId: bigint;
  recipient: string;
  refund: string;
  charge: { token: string; amount: bigint };
  inputToken: string;
  outputToken: string;
  minOutput: bigint;
  outputMultiplier: bigint | null;
  exclusiveRelayer: Hex;
  exclusivity: number;
  destinationCall: boolean;
  steps: readonly LifiStep[];
};

function decoded<T>(read: () => T): T | null {
  try {
    return read();
  } catch {
    return null;
  }
}

const PAR = 10n ** 18n;

type LifiSwap = LifiStep & { receivingAssetId: string; requiresDeposit: boolean };
type SwapWords = { callTo: Hex; approveTo: Hex; sendingAssetId: Hex; receivingAssetId: Hex; fromAmount: bigint; callData: Hex; requiresDeposit: boolean };

function lifiSwap(swap: SwapWords): LifiSwap | null {
  const [callTo, approveTo, sendingAssetId, receivingAssetId] = [swap.callTo, swap.approveTo, swap.sendingAssetId, swap.receivingAssetId].map(evmAddress);
  if (!callTo || !approveTo || !sendingAssetId || !receivingAssetId || swap.fromAmount > MAX_U128) return null;
  return { callTo, approveTo, sendingAssetId, receivingAssetId, fromAmount: swap.fromAmount, callData: swap.callData, requiresDeposit: swap.requiresDeposit };
}

function swapCharge(swaps: readonly LifiSwap[], sending: string): { token: string; amount: bigint } | null {
  const same = (left: string, right: string) => left.toLowerCase() === right.toLowerCase();
  const last = swaps.at(-1);
  const pulled = swaps.filter((swap) => swap.requiresDeposit);
  const token = pulled[0]?.sendingAssetId;
  if (!last || !same(last.receivingAssetId, sending) || !token || BigInt(token) === 0n || pulled.some((swap) => !same(swap.sendingAssetId, token))) return null;
  const amount = pulled.reduce((sum, swap) => sum + swap.fromAmount, 0n);
  return amount <= MAX_U128 ? { token, amount } : null;
}

function atMultiplier(amount: bigint, multiplier: bigint): bigint | null {
  const whole = (amount / PAR) * multiplier;
  const part = (amount % PAR) * multiplier;
  const out = whole + part / PAR;
  return [whole, part, out].every((value) => value <= MAX_U128) ? out : null;
}

function lifiCall(data: Hex) {
  const selector = data.slice(0, 10).toLowerCase();
  const args: Hex = `0x${data.slice(10)}`;
  if (selector === LIFI_START) {
    return decoded(() => {
      const [bridge, across] = decodeAbiParameters(LIFI_START_ARGS, args);
      return { start: true, bridge, swaps: [] as readonly SwapWords[], across };
    });
  }
  if (selector !== LIFI_SWAP_AND_START) return null;
  return decoded(() => {
    const [bridge, swaps, across] = decodeAbiParameters(LIFI_SWAP_AND_START_ARGS, args);
    return { start: false, bridge, swaps: swaps as readonly SwapWords[], across };
  });
}

function lifiTerms(data: Hex): BridgeTerms | null {
  const call = lifiCall(data);
  if (!call) return null;
  const { start, bridge, across } = call;
  const amounts = [bridge.minAmount, bridge.destinationChainId, across.outputAmountMultiplier, ...(start ? [across.outputAmount] : [])];
  if (amounts.some((amount) => amount > MAX_U128)) return null;
  const swaps = call.swaps.map(lifiSwap);
  const steps = swaps.filter((swap) => swap !== null);
  const sending = evmAddress(bridge.sendingAssetId);
  const recipient = evmAddress(bridge.receiver);
  const refund = evmAddress(across.refundAddress);
  const outputToken = evmAddress(across.receivingAssetId);
  if (!sending || !recipient || !refund || !outputToken || steps.length !== swaps.length) return null;
  if (evmAddress(across.receiverAddress) !== recipient || evmAddress(across.sendingAssetId) !== sending) return null;
  const charge = start ? { token: sending, amount: bridge.minAmount } : swapCharge(steps, sending);
  const minOutput = start ? across.outputAmount : atMultiplier(bridge.minAmount, across.outputAmountMultiplier);
  if (!charge || minOutput === null) return null;
  const destinationCall = bridge.hasDestinationCall || across.message !== "0x";
  const exclusive = { exclusiveRelayer: across.exclusiveRelayer, exclusivity: across.exclusivityParameter };
  return { provider: "lifi", destinationChainId: bridge.destinationChainId, recipient, refund, charge, inputToken: sending, outputToken, minOutput, outputMultiplier: across.outputAmountMultiplier, ...exclusive, destinationCall, steps };
}

function acrossTerms(data: Hex): BridgeTerms | null {
  const call = decoded(() => decodeFunctionData({ abi: ACROSS_SPOKE_POOL_ABI, data }));
  if (!call) return null;
  const [depositor, recipientWord, inputToken, outputWord, inputAmount, outputAmount, destinationChainId, exclusiveRelayer, , , exclusivity, message] = call.args;
  const recipient = evmAddress(recipientWord);
  const refund = evmAddress(depositor);
  const token = evmAddress(inputToken);
  const outputToken = evmAddress(outputWord);
  if (!recipient || !refund || !token || !outputToken || [inputAmount, outputAmount, destinationChainId].some((amount) => amount > MAX_U128)) return null;
  const charge = { token, amount: inputAmount };
  return { provider: "across", destinationChainId, recipient, refund, charge, inputToken: token, outputToken, minOutput: outputAmount, outputMultiplier: null, exclusiveRelayer, exclusivity, destinationCall: message !== "0x", steps: [] };
}

export function openAcrossDeposit(data: Hex): Hex | null {
  const call = decoded(() => decodeFunctionData({ abi: ACROSS_SPOKE_POOL_ABI, data }));
  if (!call) return null;
  const [depositor, recipient, inputToken, outputToken, inputAmount, outputAmount, destinationChainId, , quoteTimestamp, fillDeadline, , message] = call.args;
  const args = [depositor, recipient, inputToken, outputToken, inputAmount, outputAmount, destinationChainId, pad("0x", { size: 32 }), quoteTimestamp, fillDeadline, 0, message] as const;
  return encodeFunctionData({ abi: ACROSS_SPOKE_POOL_ABI, functionName: "deposit", args });
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
  maxFeeBps: number | undefined;
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
  if (BigInt(terms.exclusiveRelayer) !== 0n || terms.exclusivity !== 0) throw new Error("bridge names an exclusive relayer");
  const stepRefusal = terms.steps.length > 0 ? lifiStepRefusal(input.chainId, terms.steps, terms.charge) : null;
  if (stepRefusal) throw new Error(stepRefusal);
  const pair = same(terms.inputToken, terms.charge.token) ? bridgePair(input.chainId, terms.inputToken, Number(destination), terms.outputToken) : null;
  if (!pair) throw new Error(`bridge sends ${terms.inputToken.toLowerCase()} and delivers ${terms.outputToken.toLowerCase()} on ${chainLabel(destination)}, a pair the bridge token table does not list`);
  if (terms.outputMultiplier !== null && !withinPar(pair, terms.outputMultiplier)) throw new Error(`bridge output multiplier ${terms.outputMultiplier} is above par for ${pair.symbol}`);
  const { maxFeeBps } = input;
  if (maxFeeBps === undefined || !Number.isInteger(maxFeeBps) || maxFeeBps < 0 || maxFeeBps > 10_000) throw new Error("bridge has no fee cap in the signing policy");
  const floor = meetsBridgeFloor(pair, terms.charge.amount, terms.minOutput, maxFeeBps);
  if (floor === null) throw new Error("bridge amounts overflow the bridge fee check");
  if (!floor) {
    throw new Error(`bridge delivers at least ${terms.minOutput} ${pair.symbol} for ${terms.charge.amount}, under the ${maxFeeBps} bps bridge fee cap`);
  }
}
