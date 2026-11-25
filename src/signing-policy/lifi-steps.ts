import { decodeAbiParameters, parseAbiParameters, toFunctionSelector, type Hex } from "viem";

export const MAX_LIFI_FEE_BPS = 50n;
export const MAX_U128 = 2n ** 128n - 1n;
const NATIVE = "0x0000000000000000000000000000000000000000";

const FORWARD_ERC20 = toFunctionSelector("function forwardERC20Fees(address _token, (address recipient, uint256 amount)[] _distributions)");
const FORWARD_NATIVE = toFunctionSelector("function forwardNativeFees((address recipient, uint256 amount)[] _distributions) payable");
const ERC20_FEE_WORDS = parseAbiParameters("bytes32 _token, (bytes32 recipient, uint256 amount)[] _distributions");
const NATIVE_FEE_WORDS = parseAbiParameters("(bytes32 recipient, uint256 amount)[] _distributions");

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

export function evmAddress(word: Hex): string | null {
  return /^0x0{24}[0-9a-f]{40}$/i.test(word) ? `0x${word.slice(26)}` : null;
}

const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();

export type LifiCharge = { token: string; amount: bigint };

export function lifiCharge(deposit: LifiCharge | null, value: bigint): LifiCharge {
  return deposit ?? { token: NATIVE, amount: value };
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
  const native = same(charge.token, NATIVE);
  const selector = step.callData.slice(0, 10).toLowerCase();
  const args: Hex = `0x${step.callData.slice(10)}`;
  try {
    if (selector === FORWARD_NATIVE && native) return distributed(decodeAbiParameters(NATIVE_FEE_WORDS, args)[0]);
    if (selector !== FORWARD_ERC20 || native) return null;
    const [token, items] = decodeAbiParameters(ERC20_FEE_WORDS, args);
    const forwarded = evmAddress(token);
    return forwarded && same(forwarded, charge.token) ? distributed(items) : null;
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
      if (fee === null || fees + fee > MAX_U128) return "the LI.FI fee step is not a forwardERC20Fees or forwardNativeFees of the token the swap deposits";
      fees += fee;
      continue;
    }
    if (!listed(step.callTo)) return unlisted("calls", step.callTo);
    if (!listed(step.approveTo)) return unlisted("approves", step.approveTo);
  }
  if (fees * 10_000n > charge.amount * MAX_LIFI_FEE_BPS) return `the LI.FI fee steps forward ${fees}, above ${MAX_LIFI_FEE_BPS} bps of the ${charge.amount} the swap deposits`;
  return null;
}
