import { decodeAbiParameters, decodeFunctionData, parseAbi, parseAbiParameters, type Hex } from "viem";
import { LIFI_STEP_TARGETS } from "./lifi-targets.js";

export * from "./lifi-targets.js";

export const MAX_LIFI_FEE_BPS = 50n;
export const MAX_U128 = 2n ** 128n - 1n;
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

const ERC20_FEE_WORDS = parseAbiParameters("bytes32 _token, (bytes32 recipient, uint256 amount)[] _distributions");
const NATIVE_FEE_WORDS = parseAbiParameters("(bytes32 recipient, uint256 amount)[] _distributions");

export function evmAddress(word: Hex): string | null {
  return /^0x0{24}[0-9a-f]{40}$/i.test(word) ? `0x${word.slice(26)}` : null;
}

function distributed(items: readonly { recipient: Hex; amount: bigint }[]): bigint | null {
  let sum = 0n;
  for (const item of items) {
    sum += item.amount;
    if (!evmAddress(item.recipient) || sum > MAX_U128) return null;
  }
  return sum;
}

function forwardedFee(step: LifiStep, charge: LifiCharge): bigint | null {
  if (!same(step.sendingAssetId, charge.token)) return null;
  try {
    const call = decodeFunctionData({ abi: FEE_FORWARDER_ABI, data: step.callData });
    const args: Hex = `0x${step.callData.slice(10)}`;
    if (call.functionName === "forwardNativeFees") return same(charge.token, NATIVE) ? distributed(decodeAbiParameters(NATIVE_FEE_WORDS, args)[0]) : null;
    const [token, items] = decodeAbiParameters(ERC20_FEE_WORDS, args);
    const forwarded = evmAddress(token);
    return !same(charge.token, NATIVE) && forwarded !== null && same(forwarded, charge.token) ? distributed(items) : null;
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
      if (fee === null || fees + fee > MAX_U128) return "the LI.FI fee step is not a forwardERC20Fees or forwardNativeFees of the token the swap deposits";
      fees += fee;
      continue;
    }
    if (!listed(step.callTo)) return unlisted("calls", step.callTo);
    if (!listed(step.approveTo) && !spender(step.approveTo)) return unlisted("approves", step.approveTo);
  }
  if (fees * 10_000n > charge.amount * MAX_LIFI_FEE_BPS) return `the LI.FI fee steps forward ${fees}, above ${MAX_LIFI_FEE_BPS} bps of the ${charge.amount} the swap deposits`;
  return null;
}
