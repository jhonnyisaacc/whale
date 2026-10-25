import { decodeFunctionData, encodeFunctionData, parseAbi, type Hex } from "viem";
import type { SendResult } from "../src/domain.js";

export function landedSend(): SendResult {
  return {
    venue: "chain",
    outcome: "landed",
    txs: [{ chainKey: "solana", txHash: "sig", from: "owner", to: "router", value: "0", outcome: "landed" }],
    held: null,
    shortfall: false,
  };
}

const ZERO = "0x0000000000000000000000000000000000000000";
export const SETTLER = "0x5555555555555555555555555555555555555555";
export const SETTLERS = JSON.stringify({ "8453": [SETTLER] });

const allowanceHolderAbi = parseAbi(["function exec(address operator, address token, uint256 amount, address target, bytes data) payable returns (bytes result)"]);
const settlerAbi = parseAbi([
  "struct AllowedSlippage { address recipient; address buyToken; uint256 minAmountOut; }",
  "function execute(AllowedSlippage slippage, bytes[] actions, bytes32 zid) payable returns (bool)",
]);
const kyberAbi = parseAbi([
  "struct SwapDescriptionV2 { address srcToken; address dstToken; address[] srcReceivers; uint256[] srcAmounts; address[] feeReceivers; uint256[] feeAmounts; address dstReceiver; uint256 amount; uint256 minReturnAmount; uint256 flags; bytes permit; }",
  "struct SwapExecutionParams { address callTarget; address approveTarget; bytes targetData; SwapDescriptionV2 desc; bytes clientData; }",
  "function swap(SwapExecutionParams execution) payable returns (uint256 returnAmount, uint256 gasUsed)",
]);

export type SwapFixture = { recipient: string; buyToken: string; minOut: bigint };

// Real AllowanceHolder.exec -> Settler.execute calldata; `tag` rides as the only action so fakes can tell legs apart.
export type ExecFixture = { token: string; amount: bigint; operator?: string; target?: string };

export function zeroExData(tag: Hex, terms: SwapFixture, exec: ExecFixture): Hex {
  const settler = encodeFunctionData({
    abi: settlerAbi,
    functionName: "execute",
    args: [{ recipient: terms.recipient as Hex, buyToken: terms.buyToken as Hex, minAmountOut: terms.minOut }, [tag], `0x${"00".repeat(32)}`],
  });
  const args = [(exec.operator ?? SETTLER) as Hex, exec.token as Hex, exec.amount, (exec.target ?? SETTLER) as Hex, settler] as const;
  return encodeFunctionData({ abi: allowanceHolderAbi, functionName: "exec", args });
}

export function kyberData(tag: Hex, terms: SwapFixture): Hex {
  return encodeFunctionData({
    abi: kyberAbi,
    functionName: "swap",
    args: [
      {
        callTarget: ZERO,
        approveTarget: ZERO,
        targetData: tag,
        desc: {
          srcToken: ZERO,
          dstToken: terms.buyToken as Hex,
          srcReceivers: [],
          srcAmounts: [],
          feeReceivers: [],
          feeAmounts: [],
          dstReceiver: terms.recipient as Hex,
          amount: 0n,
          minReturnAmount: terms.minOut,
          flags: 0n,
          permit: "0x",
        },
        clientData: "0x",
      },
    ],
  });
}

export function tagOf(data: Hex | undefined): Hex | undefined {
  if (!data) return data;
  try {
    const exec = decodeFunctionData({ abi: allowanceHolderAbi, data });
    return decodeFunctionData({ abi: settlerAbi, data: exec.args[4] }).args[1][0];
  } catch {
    try {
      return decodeFunctionData({ abi: kyberAbi, data }).args[0].targetData;
    } catch {
      return data;
    }
  }
}
