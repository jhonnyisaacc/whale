import assert from "node:assert/strict";
import test from "node:test";
import { encodeFunctionData, erc20Abi, parseAbi, type Hex } from "viem";
import { DEFAULT_EVM_FEE_LIMITS } from "../src/chains.js";
import { assertEvmFee, assertEvmSigning, DEFAULT_MAX_VALUE_WEI, evmChainIds } from "../src/signing-policy.js";
import { directSettlerData, kyberData, SETTLER, zeroExData } from "./fixtures.js";

const OWNER = "0x2222222222222222222222222222222222222222";
const ROUTER = "0x1111111111111111111111111111111111111111";
const STRANGER = "0x3333333333333333333333333333333333333333";
const DESTINATION = "0x4444444444444444444444444444444444444444";
const TOKEN = "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const OTHER_TOKEN = "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
const BUY = "0xdddddddddddddddddddddddddddddddddddddddd";
const BASE = "base (chain id 8453)";
const BLAST = "blast (chain id 81457)";
const POLYGON = "polygon (chain id 137)";

const transfer = (to: Hex, amount = 1n) => encodeFunctionData({ abi: erc20Abi, functionName: "transfer", args: [to, amount] });
const approve = (amount: bigint, spender: Hex = ROUTER) => encodeFunctionData({ abi: erc20Abi, functionName: "approve", args: [spender, amount] });
const terms = (recipient: string) => ({ recipient, buyToken: BUY, minOut: 1n });
const execNotSettler = encodeFunctionData({
  abi: parseAbi(["function exec(address operator, address token, uint256 amount, address target, bytes data) payable returns (bytes result)"]),
  functionName: "exec",
  args: [SETTLER, TOKEN, 1000n, SETTLER, "0x12345678"],
});

const swap = {
  chainId: 8453,
  to: ROUTER,
  data: kyberData("0x01", terms(OWNER)),
  value: 0n,
  purpose: "swap" as const,
  routers: [ROUTER],
  settlers: [SETTLER],
  withdrawAllowlist: [DESTINATION],
  maxValueWei: DEFAULT_MAX_VALUE_WEI,
  allowHotApproval: true,
  owner: OWNER,
  allowOpaqueSwap: false,
  recoveryTokens: [TOKEN],
};
const withdraw = { ...swap, purpose: "withdraw" as const, to: TOKEN, data: transfer(DESTINATION) };
const approval = { ...swap, purpose: "approve" as const, to: TOKEN, data: approve(1000n), approval: { token: TOKEN, amount: 1000n } };
const polygonLimit = DEFAULT_EVM_FEE_LIMITS[137];
const fee = { chainId: 137, gas: 300_000n, maxFeePerGas: 100n * 10n ** 9n, maxPriorityFeePerGas: 30n * 10n ** 9n, data: "0x" as Hex };
const baseLimit = DEFAULT_EVM_FEE_LIMITS[8453];
const baseFee = { ...fee, chainId: 8453, maxFeePerGas: baseLimit!.maxFeePerGas, maxPriorityFeePerGas: 1n };

type Refusal = [string, string, string, () => void];

const refusals: Refusal[] = [
  ["a chain with no fee limit", BLAST, "chain has no EVM fee limit in the signing policy", () => assertEvmFee(DEFAULT_EVM_FEE_LIMITS[81457], { ...baseFee, chainId: 81457 })],
  ["an L1 data fee chain without an L1 fee budget", BASE, "chain charges an L1 data fee and has no L1 fee budget in the signing policy", () => assertEvmFee({ maxGas: baseLimit!.maxGas, maxFeePerGas: baseLimit!.maxFeePerGas }, baseFee)],
  ["calldata above the L1 fee budget cap", BASE, `calldata is above the ${baseLimit!.l1!.maxDataBytes}-byte cap the L1 fee budget covers`, () => assertEvmFee(baseLimit, { ...baseFee, data: `0x${"ab".repeat(baseLimit!.l1!.maxDataBytes + 1)}` })],
  ["a zero gas limit", POLYGON, "EVM fee fields are invalid", () => assertEvmFee(polygonLimit, { ...fee, gas: 0n })],
  ["a priority fee above the max fee", POLYGON, "priority fee exceeds maxFeePerGas", () => assertEvmFee(polygonLimit, { ...fee, maxPriorityFeePerGas: fee.maxFeePerGas + 1n })],
  ["gas above the chain limit", POLYGON, "EVM gas limit exceeds the signing policy", () => assertEvmFee(polygonLimit, { ...fee, gas: polygonLimit!.maxGas + 1n })],
  ["a fee per gas above the chain limit", POLYGON, "EVM maxFeePerGas exceeds the signing policy", () => assertEvmFee(polygonLimit, { ...fee, maxFeePerGas: polygonLimit!.maxFeePerGas + 1n })],
  ["a chain outside the table", "unknown (chain id 12345)", "chain is not in the signing policy", () => assertEvmSigning({ ...swap, chainId: 12345 })],
  ["native value above the cap", BASE, "native value exceeds the signing policy", () => assertEvmSigning({ ...swap, value: DEFAULT_MAX_VALUE_WEI + 1n, nativeSell: true })],
  ["a native withdraw to a stranger", BASE, "withdraw destination is not allowlisted", () => assertEvmSigning({ ...withdraw, to: STRANGER, data: "0x" })],
  ["a token withdraw with native value", BASE, "token withdraw must not attach native value", () => assertEvmSigning({ ...withdraw, value: 1n })],
  ["a withdraw that is not a transfer", BASE, "withdraw calldata is not a transfer", () => assertEvmSigning({ ...withdraw, data: approve(1n) })],
  ["a token withdraw to a stranger", BASE, "withdraw destination is not allowlisted", () => assertEvmSigning({ ...withdraw, data: transfer(STRANGER) })],
  ["a withdraw of a token outside recovery", BASE, "token is not in the recovery allowlist", () => assertEvmSigning({ ...withdraw, to: OTHER_TOKEN })],
  ["a token sell with native value", BASE, "token sell must not attach native value", () => assertEvmSigning({ ...swap, value: 1n })],
  ["an empty router list", BASE, "router allowlist is empty", () => assertEvmSigning({ ...swap, routers: [] })],
  ["a swap to an unlisted router", BASE, "transaction destination is not an allowlisted router", () => assertEvmSigning({ ...swap, to: STRANGER })],
  ["a swap paying a stranger", BASE, "swap recipient is not the hot wallet", () => assertEvmSigning({ ...swap, data: kyberData("0x01", terms(STRANGER)) })],
  ["a direct Settler call", BASE, "direct Settler calls are not accepted without decodable actions", () => assertEvmSigning({ ...swap, data: directSettlerData("0x01", terms(OWNER)) })],
  ["a 0x exec that does not call a Settler", BASE, "0x exec does not call a Settler", () => assertEvmSigning({ ...swap, data: execNotSettler })],
  ["an opaque swap", BASE, "swap calldata does not name a checkable recipient", () => assertEvmSigning({ ...swap, data: "0x12345678" })],
  ["a 0x exec whose operator is not its target", BASE, "0x exec operator is not its target", () => assertEvmSigning({ ...swap, data: zeroExData("0x01", terms(OWNER), { token: TOKEN, amount: 1000n, operator: STRANGER }) })],
  ["a 0x exec into an unpinned Settler", BASE, "0x target is not a pinned Settler", () => assertEvmSigning({ ...swap, settlers: [], data: zeroExData("0x01", terms(OWNER), { token: TOKEN, amount: 1000n }) })],
  ["an approval with native value", BASE, "approval must not attach native value", () => assertEvmSigning({ ...approval, value: 1n })],
  ["an approval of another token", BASE, "approval target is not the sold token", () => assertEvmSigning({ ...approval, approval: undefined })],
  ["an approval that is not approve", BASE, "approval calldata is not approve", () => assertEvmSigning({ ...approval, data: transfer(ROUTER) })],
  ["a revoke with an amount", BASE, "revoke amount is not zero", () => assertEvmSigning({ ...approval, purpose: "revoke", data: approve(1n) })],
  ["an approval that is not cached", BASE, "approval is not cached", () => assertEvmSigning({ ...approval, allowHotApproval: false })],
  ["an approval above the sell amount", BASE, "approval amount is not the exact sell amount", () => assertEvmSigning({ ...approval, data: approve(1001n) })],
  ["an approval to a stranger", BASE, "approval spender is not an allowlisted router", () => assertEvmSigning({ ...approval, data: approve(1000n, STRANGER) })],
];

const accepted: [string, () => void][] = [
  ["a fee within the polygon limit", () => assertEvmFee(polygonLimit, fee)],
  ["a fee within the base limit and its L1 fee budget", () => assertEvmFee(baseLimit, baseFee)],
  ["a kyber swap to the hot wallet", () => assertEvmSigning(swap)],
  ["a 0x exec into a pinned Settler", () => assertEvmSigning({ ...swap, data: zeroExData("0x01", terms(OWNER), { token: TOKEN, amount: 1000n }) })],
  ["an opaque swap that is opted in", () => assertEvmSigning({ ...swap, data: "0x12345678", allowOpaqueSwap: true })],
  ["a native sell", () => assertEvmSigning({ ...swap, value: 1n, nativeSell: true })],
  ["a native withdraw to an allowlisted address", () => assertEvmSigning({ ...withdraw, to: DESTINATION, data: "0x" })],
  ["a token withdraw to an allowlisted address", () => assertEvmSigning(withdraw)],
  ["an exact approval", () => assertEvmSigning(approval)],
  ["a revoke", () => assertEvmSigning({ ...approval, purpose: "revoke", data: approve(0n), allowHotApproval: false })],
  ...evmChainIds().map((chainId): [string, () => void] => [`a kyber swap on chain ${chainId}`, () => assertEvmSigning({ ...swap, chainId })]),
];

test("every EVM signing refusal names its chain key and chain id and keeps its reason", () => {
  for (const [name, chain, reason, check] of refusals) {
    assert.throws(check, (error: unknown) => error instanceof Error && error.message === `${chain}: ${reason}`, `${name}: expected "${chain}: ${reason}"`);
  }
});

test("naming the chain changes no EVM signing decision", () => {
  for (const [name, , reason, check] of refusals) {
    assert.throws(check, (error: unknown) => error instanceof Error && error.message.endsWith(reason), `${name} is still refused for ${reason}`);
  }
  for (const [name, check] of accepted) assert.doesNotThrow(check, `${name} is still signed`);
});
