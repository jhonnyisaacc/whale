import { decodeFunctionData, parseAbi, type Hex } from "viem";

// KyberSwap MetaAggregationRouterV2, from the verified router ABI (0x6131B5fae19EA4f9D964eAc0408E4408b66337b5).
const KYBER_ABI = parseAbi([
  "struct SwapDescriptionV2 { address srcToken; address dstToken; address[] srcReceivers; uint256[] srcAmounts; address[] feeReceivers; uint256[] feeAmounts; address dstReceiver; uint256 amount; uint256 minReturnAmount; uint256 flags; bytes permit; }",
  "struct SwapExecutionParams { address callTarget; address approveTarget; bytes targetData; SwapDescriptionV2 desc; bytes clientData; }",
  "function swap(SwapExecutionParams execution) payable returns (uint256 returnAmount, uint256 gasUsed)",
  "function swapSimpleMode(address caller, SwapDescriptionV2 desc, bytes executorData, bytes clientData) returns (uint256 returnAmount, uint256 gasUsed)",
]);

// 0x AllowanceHolder.exec and Settler.execute, from 0xProject/0x-settler IAllowanceHolder.sol and ISettlerTakerSubmitted.sol.
const ALLOWANCE_HOLDER_ABI = parseAbi(["function exec(address operator, address token, uint256 amount, address target, bytes data) payable returns (bytes result)"]);
const SETTLER_ABI = parseAbi([
  "struct AllowedSlippage { address recipient; address buyToken; uint256 minAmountOut; }",
  "function execute(AllowedSlippage slippage, bytes[] actions, bytes32 zid) payable returns (bool)",
]);

export type ZeroExExec = { operator: string; token: string; amount: bigint; target: string };

export type SwapTerms =
  | { provider: "kyberswap"; recipient: string; buyToken: string; minOut: bigint }
  | { provider: "zeroex"; recipient: string; buyToken: string; minOut: bigint; exec: ZeroExExec | null };

function decoded<T>(read: () => T): T | null {
  try {
    return read();
  } catch {
    return null;
  }
}

// Recipient, bought token, and minimum output read from swap calldata, or null when the shape is not one we decode.
export function swapTerms(data: Hex): SwapTerms | null {
  const kyber = decoded(() => decodeFunctionData({ abi: KYBER_ABI, data }));
  if (kyber) {
    const desc = kyber.functionName === "swap" ? kyber.args[0].desc : kyber.args[1];
    return { provider: "kyberswap", recipient: desc.dstReceiver, buyToken: desc.dstToken, minOut: desc.minReturnAmount };
  }
  const exec = decoded(() => decodeFunctionData({ abi: ALLOWANCE_HOLDER_ABI, data }));
  const settler = decoded(() => decodeFunctionData({ abi: SETTLER_ABI, data: exec ? exec.args[4] : data }));
  if (!settler) return null;
  const slippage = settler.args[0];
  return {
    provider: "zeroex",
    recipient: slippage.recipient,
    buyToken: slippage.buyToken,
    minOut: slippage.minAmountOut,
    exec: exec ? { operator: exec.args[0], token: exec.args[1], amount: exec.args[2], target: exec.args[3] } : null,
  };
}

export function isAllowanceHolderExec(data: Hex): boolean {
  return decoded(() => decodeFunctionData({ abi: ALLOWANCE_HOLDER_ABI, data })) !== null;
}
