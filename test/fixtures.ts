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

export type SwapFixture = { recipient: string; buyToken: string; minOut: bigint; sellToken?: string; sellAmount?: bigint };

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

export function directSettlerData(tag: Hex, terms: SwapFixture): Hex {
  return encodeFunctionData({
    abi: settlerAbi,
    functionName: "execute",
    args: [{ recipient: terms.recipient as Hex, buyToken: terms.buyToken as Hex, minAmountOut: terms.minOut }, [tag], `0x${"00".repeat(32)}`],
  });
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
          srcToken: (terms.sellToken ?? ZERO) as Hex,
          dstToken: terms.buyToken as Hex,
          srcReceivers: [],
          srcAmounts: [],
          feeReceivers: [],
          feeAmounts: [],
          dstReceiver: terms.recipient as Hex,
          amount: terms.sellAmount ?? 0n,
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

// LI.FI GenericSwapFacetV3, from lifinance/contracts src/Facets/GenericSwapFacetV3.sol and LibSwap.SwapData.
const LIFI_HEAD = "bytes32 _transactionId, string _integrator, string _referrer, address _receiver, uint256 _minAmountOut";
const LIFI_SWAP = "(address callTo, address approveTo, address sendingAssetId, address receivingAssetId, uint256 fromAmount, bytes callData, bool requiresDeposit)";
export const LIFI_V3_ABI = parseAbi([
  `function swapTokensSingleV3ERC20ToERC20(${LIFI_HEAD}, ${LIFI_SWAP} _swapData)`,
  `function swapTokensSingleV3ERC20ToNative(${LIFI_HEAD}, ${LIFI_SWAP} _swapData)`,
  `function swapTokensSingleV3NativeToERC20(${LIFI_HEAD}, ${LIFI_SWAP} _swapData)`,
  `function swapTokensMultipleV3ERC20ToERC20(${LIFI_HEAD}, ${LIFI_SWAP}[] _swapData)`,
  `function swapTokensMultipleV3ERC20ToNative(${LIFI_HEAD}, ${LIFI_SWAP}[] _swapData)`,
  `function swapTokensMultipleV3NativeToERC20(${LIFI_HEAD}, ${LIFI_SWAP}[] _swapData)`,
] as const);

export type LifiSwap = { sell: string; buy: string; amount: bigint; deposit?: boolean };
export type LifiFunction = (typeof LIFI_V3_ABI)[number] extends infer Item ? (Item extends { name: infer Name } ? Name : never) : never;

export function lifiData(functionName: LifiFunction, recipient: string, minOut: bigint, swaps: readonly LifiSwap[], tag: Hex = "0x01"): Hex {
  const data = swaps.map((swap) => ({
    callTo: SETTLER as Hex,
    approveTo: SETTLER as Hex,
    sendingAssetId: swap.sell as Hex,
    receivingAssetId: swap.buy as Hex,
    fromAmount: swap.amount,
    callData: tag,
    requiresDeposit: swap.deposit ?? false,
  }));
  const head = [`0x${"00".repeat(32)}`, "whale", "", recipient as Hex, minOut] as const;
  const swapData = functionName.startsWith("swapTokensSingle") ? data[0] : data;
  return encodeFunctionData({ abi: LIFI_V3_ABI, functionName, args: [...head, swapData] } as Parameters<typeof encodeFunctionData>[0]);
}
