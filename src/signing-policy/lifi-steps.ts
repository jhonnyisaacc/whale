import { decodeFunctionData, parseAbi, type Hex } from "viem";

export const MAX_LIFI_FEE_BPS = 50n;
const NATIVE = "0x0000000000000000000000000000000000000000";

const FEE_FORWARDER_ABI = parseAbi([
  "function forwardERC20Fees(address _token, (address recipient, uint256 amount)[] _distributions)",
  "function forwardNativeFees((address recipient, uint256 amount)[] _distributions) payable",
]);

export type LifiStepTable = { feeForwarder: string; targets: readonly string[] };

export const LIFI_STEP_TARGETS: Readonly<Record<number, LifiStepTable>> = {
  324: {
    feeForwarder: "0x24A72DD17De0f92dA5460c46CC2948e3a5cB755d",
    targets: [
      "0x6fd4383cB451173D5f9304F041C7BCBf27d561fF",
      "0x35E98C2b3894D71D3D4D7edb8b30E4f36E2f9179",
      "0x46eDEcEa0228f04Ab88dC34BE98314863bA40bE0",
      "0xc67879F4065d3B9fe1C09EE990B891Aa8E3a4c2f",
      "0xf15485ada1a1826fA46225032b13F6A972eC73C1",
    ],
  },
  8453: {
    feeForwarder: "0xDe2b920506EE931a6A2ABDF566526220214FBbAE",
    targets: [
      "0x111111125421cA6dc452d289314280a0f8842A65",
      "0xAC4c6e212A361c968F1725b4d055b47E63F80b75",
      "0xC87De04e2EC1F4282dFF2933A2D58199f688fC3d",
      "0x6131B5fae19EA4f9D964eAc0408E4408b66337b5",
      "0x20f6ee51340adeed01a59b0e65cb3703f3dc860c",
      "0x5215E9fd223BC909083fbdB2860213873046e45d",
    ],
  },
  42161: {
    feeForwarder: "0xDe2b920506EE931a6A2ABDF566526220214FBbAE",
    targets: [
      "0xAC4c6e212A361c968F1725b4d055b47E63F80b75",
      "0x57f96440f1b1cAD53B40A8924BD540b1279A491c",
      "0x09f94b5Fc68e227C323A6FbaE3Bd98C97fD8c849",
      "0x70cBb871E8f30Fc8Ce23609E9E0Ea87B6b222F58",
      "0x6A000F20005980200259B80c5102003040001068",
      "0x111111125421cA6dc452d289314280a0f8842A65",
      "0x6131B5fae19EA4f9D964eAc0408E4408b66337b5",
      "0x20f6ee51340adeed01a59b0e65cb3703f3dc860c",
      "0x5215E9fd223BC909083fbdB2860213873046e45d",
    ],
  },
};

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
    if (!listed(step.approveTo)) return unlisted("approves", step.approveTo);
  }
  if (fees * 10_000n > charge.amount * MAX_LIFI_FEE_BPS) return `the LI.FI fee steps forward ${fees}, above ${MAX_LIFI_FEE_BPS} bps of the ${charge.amount} the swap deposits`;
  return null;
}
