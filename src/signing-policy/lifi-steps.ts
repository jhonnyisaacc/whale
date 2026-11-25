import { decodeFunctionData, parseAbi, type Hex } from "viem";
import { LIFI_STEP_TARGETS } from "./lifi-targets.js";

export * from "./lifi-targets.js";

export const MAX_LIFI_FEE_BPS = 50n;
const NATIVE = "0x0000000000000000000000000000000000000000";

const FEE_FORWARDER_ABI = parseAbi([
  "function forwardERC20Fees(address _token, (address recipient, uint256 amount)[] _distributions)",
  "function forwardNativeFees((address recipient, uint256 amount)[] _distributions) payable",
]);

export type LifiStep = { callTo: string; approveTo: string; sendingAssetId: string; fromAmount: bigint; callData: Hex };

const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();

export type LifiCharge = { token: string; amount: bigint };

export function lifiCharge(deposit: LifiCharge | null, value: bigint): LifiCharge {
  return deposit ?? { token: NATIVE, amount: value };
}

function forwardedFee(step: LifiStep, charge: LifiCharge): bigint | null {
  if (!same(step.sendingAssetId, charge.token)) return null;
  try {
    const call = decodeFunctionData({ abi: FEE_FORWARDER_ABI, data: step.callData });
    if (call.functionName === "forwardNativeFees") return same(charge.token, NATIVE) ? call.args[0].reduce((sum, item) => sum + item.amount, 0n) : null;
    if (same(charge.token, NATIVE) || !same(call.args[0], charge.token)) return null;
    return call.args[1].reduce((sum, item) => sum + item.amount, 0n);
  } catch {
    return null;
  }
}

const unlisted = (what: string, address: string) => `the LI.FI swap step ${what} 0x${address.slice(2).toLowerCase()}, which is not a listed LI.FI step target`;

export function lifiStepRefusal(chainId: number, steps: readonly LifiStep[], charge: LifiCharge): string | null {
  const table = LIFI_STEP_TARGETS[chainId];
  if (!table) return `chain ${chainId} lists no LI.FI swap step targets`;
  const listed = (address: string) => table.targets.some((target) => same(target, address));
  const spender = (address: string) => table.spenders.some((item) => same(item, address));
  let fees = 0n;
  for (const step of steps) {
    if (same(step.callTo, table.feeForwarder)) {
      if (!same(step.approveTo, table.feeForwarder)) return unlisted("approves", step.approveTo);
      const fee = forwardedFee(step, charge);
      if (fee === null) return "the LI.FI fee step is not a forwardERC20Fees or forwardNativeFees of the token the swap deposits";
      fees += fee;
      continue;
    }
    if (!listed(step.callTo)) return unlisted("calls", step.callTo);
    if (!listed(step.approveTo) && !spender(step.approveTo)) return unlisted("approves", step.approveTo);
  }
  if (fees * 10_000n > charge.amount * MAX_LIFI_FEE_BPS) return `the LI.FI fee steps forward ${fees}, above ${MAX_LIFI_FEE_BPS} bps of the ${charge.amount} the swap deposits`;
  return null;
}
