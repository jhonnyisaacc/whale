import { decodeFunctionData, encodeFunctionData, parseAbi } from "viem";

const BRIDGE_DATA =
  "(bytes32 transactionId, string bridge, string integrator, address referrer, address sendingAssetId, address receiver, uint256 minAmount, uint256 destinationChainId, bool hasSourceSwaps, bool hasDestinationCall)";
const ACROSS_V4_DATA =
  "(bytes32 receiverAddress, bytes32 refundAddress, bytes32 sendingAssetId, bytes32 receivingAssetId, uint256 outputAmount, uint128 outputAmountMultiplier, bytes32 exclusiveRelayer, uint32 quoteTimestamp, uint32 fillDeadline, uint32 exclusivityParameter, bytes message)";
const SWAP = "(address callTo, address approveTo, address sendingAssetId, address receivingAssetId, uint256 fromAmount, bytes callData, bool requiresDeposit)";
const abi = parseAbi([
  `function startBridgeTokensViaAcrossV4(${BRIDGE_DATA} _bridgeData, ${ACROSS_V4_DATA} _acrossData) payable`,
  `function swapAndStartBridgeTokensViaAcrossV4(${BRIDGE_DATA} _bridgeData, ${SWAP}[] _swapData, ${ACROSS_V4_DATA} _acrossData) payable`,
]);
const PAR = 10n ** 18n;

export function lifiStartCall(data, charge) {
  const call = decodeFunctionData({ abi, data });
  if (call.functionName !== "swapAndStartBridgeTokensViaAcrossV4") throw new Error(`LI.FI quoted ${call.functionName}, not swapAndStartBridgeTokensViaAcrossV4`);
  const [bridge, , across] = call.args;
  const outputAmount = (charge * across.outputAmountMultiplier) / PAR;
  return encodeFunctionData({ abi, functionName: "startBridgeTokensViaAcrossV4", args: [{ ...bridge, minAmount: charge, hasSourceSwaps: false }, { ...across, outputAmount }] });
}
