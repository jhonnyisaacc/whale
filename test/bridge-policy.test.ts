import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { decodeFunctionData, encodeFunctionData, erc20Abi, pad, parseAbi, type Hex } from "viem";
import { assertEvmSigning } from "../src/signing-policy.js";
import { ACROSS_SPOKE_POOL_ABI, BRIDGE_CONTRACTS, LIFI_ACROSS_ABI, bridgeTerms, openAcrossDeposit } from "../src/signing-policy/bridge-terms.js";
import { BRIDGE_TOKENS } from "../src/signing-policy/bridge-tokens.js";

type Fixture = { route: { fromChainId: number; toChainId: number; sell: string; amount: string; from: string; recipient: string }; tx: { to: Hex; data: Hex; value: string } };
type RelayFixture = { steps: { id: string; txs: { to: Hex; data: Hex; value: string }[] }[] };

function fixture<T = Fixture>(name: string): T {
  return JSON.parse(readFileSync(new URL(`../../test/fixtures/bridge/${name}.json`, import.meta.url), "utf8")) as T;
}

const lifi = fixture("lifi-start-base-arbitrum");
const swapAndStart = fixture("lifi-swap-and-start-base-arbitrum");
const across = fixture("across-base-arbitrum");
const OWN = lifi.route.from;
const ATTACKER = "0x00000000000000000000000000000000000bad00";
const USDC = lifi.route.sell;
const word = (address: string) => pad(address.toLowerCase() as Hex, { size: 32 });

function sign(tx: { to: string; data: Hex; value?: bigint | string }, extra: Partial<Parameters<typeof assertEvmSigning>[0]> = {}) {
  return () =>
    assertEvmSigning({
      chainId: 8453,
      to: tx.to,
      data: tx.data,
      value: BigInt(tx.value ?? 0n),
      purpose: "bridge",
      routers: [],
      settlers: [],
      withdrawAllowlist: [],
      maxValueWei: 0n,
      allowHotApproval: true,
      owner: OWN,
      allowOpaqueSwap: false,
      charge: { token: USDC, amount: 2_000_000n },
      bridgeChainIds: [10, 137, 8453, 42161],
      maxBridgeFeeBps: 100,
      ...extra,
    });
}

function lifiWith(edit: (bridge: Record<string, unknown>, data: Record<string, unknown>) => void): Hex {
  const call = decodeFunctionData({ abi: LIFI_ACROSS_ABI, data: lifi.tx.data });
  const [bridge, data] = call.args as unknown as [Record<string, unknown>, Record<string, unknown>];
  const nextBridge = { ...bridge };
  const nextData = { ...data };
  edit(nextBridge, nextData);
  return encodeFunctionData({ abi: LIFI_ACROSS_ABI, functionName: "startBridgeTokensViaAcrossV4", args: [nextBridge, nextData] as never });
}

function acrossWith(edit: (args: unknown[]) => void): Hex {
  const args = [...decodeFunctionData({ abi: ACROSS_SPOKE_POOL_ABI, data: decodeAndOpen(across.tx.data) }).args];
  edit(args);
  return encodeFunctionData({ abi: ACROSS_SPOKE_POOL_ABI, functionName: "deposit", args: args as never });
}

function decodeAndOpen(data: Hex): Hex {
  const open = openAcrossDeposit(data);
  assert.ok(open);
  return open;
}

const openAcross = { to: across.tx.to, data: decodeAndOpen(across.tx.data) };

test("the real LI.FI and Across Base to Arbitrum calldata decodes to this wallet on Arbitrum", () => {
  for (const [provider, captured] of [["lifi", lifi], ["across", across]] as const) {
    const terms = bridgeTerms(captured.tx.data);
    assert.ok(terms, provider);
    assert.equal(terms.provider, provider);
    assert.equal(terms.destinationChainId, 42161n);
    assert.equal(terms.recipient.toLowerCase(), OWN.toLowerCase());
    assert.equal(terms.refund.toLowerCase(), OWN.toLowerCase());
    assert.equal(terms.charge.token.toLowerCase(), USDC.toLowerCase());
    assert.equal(terms.charge.amount, 2_000_000n);
    assert.equal(terms.destinationCall, false);
    assert.ok(terms.minOutput > 1_900_000n && terms.minOutput < 2_000_000n, `${provider} min output ${terms.minOutput}`);
    assert.equal(captured.tx.to.toLowerCase(), BRIDGE_CONTRACTS[8453]?.[provider]?.toLowerCase());
  }
});

test("the signing policy signs the real bridge calls that pay this wallet and charges exactly the deposit", () => {
  sign(lifi.tx)();
  sign(openAcross)();
  assert.throws(sign(across.tx), /bridge names an exclusive relayer/);
  assert.throws(sign(lifi.tx, { charge: { token: USDC, amount: 1_999_999n } }), /bridge charges 2000000 of 0x833589fcd6edb6e08f4c7c32d4f71b54bda02913, not the 1999999 reserved/);
  assert.throws(sign(openAcross, { charge: undefined }), /bridge has no reserved charge/);
});

test("a bridge to an allowlisted destination signs only when that destination is allowlisted", () => {
  const destination = fixture("lifi-start-base-arbitrum-destination");
  const allowlisted = fixture("across-base-arbitrum-destination");
  const openAllowlisted = { to: allowlisted.tx.to, data: decodeAndOpen(allowlisted.tx.data) };
  for (const tx of [destination.tx, openAllowlisted]) {
    assert.throws(sign(tx), /bridge recipient 0x1111111111111111111111111111111111111111 on arbitrum \(chain id 42161\) is not this wallet or an allowlisted destination/);
    sign(tx, { withdrawAllowlist: [destination.route.recipient] })();
  }
});

test("the signing policy refuses a bridge call that pays, refunds, or lands anywhere else", () => {
  const cases: [string, Hex, string, RegExp][] = [
    ["LI.FI receiver", lifiWith((bridge, data) => ((bridge.receiver = ATTACKER), (data.receiverAddress = word(ATTACKER)))), lifi.tx.to, /bridge recipient 0x00000000000000000000000000000000000bad00/],
    ["LI.FI receivers disagree", lifiWith((_, data) => (data.receiverAddress = word(ATTACKER))), lifi.tx.to, /bridge calldata is not a call the signing policy decodes/],
    ["LI.FI refund", lifiWith((_, data) => (data.refundAddress = word(ATTACKER))), lifi.tx.to, /bridge refund address is not this wallet/],
    ["LI.FI destination chain", lifiWith((bridge) => (bridge.destinationChainId = 31337n)), lifi.tx.to, /bridge destination chain 31337 is not in the signing policy/],
    ["LI.FI same chain", lifiWith((bridge) => (bridge.destinationChainId = 8453n)), lifi.tx.to, /bridge destination chain 8453 is not in the signing policy/],
    ["LI.FI destination call", lifiWith((bridge, data) => ((bridge.hasDestinationCall = true), (data.message = "0x1234"))), lifi.tx.to, /bridge runs a call on the destination chain/],
    ["Across recipient", acrossWith((args) => (args[1] = word(ATTACKER))), across.tx.to, /bridge recipient 0x00000000000000000000000000000000000bad00/],
    ["Across refund", acrossWith((args) => (args[0] = word(ATTACKER))), across.tx.to, /bridge refund address is not this wallet/],
    ["Across destination chain", acrossWith((args) => (args[6] = 31337n)), across.tx.to, /bridge destination chain 31337 is not in the signing policy/],
    ["Across message", acrossWith((args) => (args[11] = "0xabcd")), across.tx.to, /bridge runs a call on the destination chain/],
    ["Across non-EVM recipient", acrossWith((args) => (args[1] = `0x${"ab".repeat(32)}`)), across.tx.to, /bridge calldata is not a call the signing policy decodes/],
    ["Across sent to the LI.FI diamond", across.tx.data, lifi.tx.to, /bridge contract is not the verified across contract for base \(chain id 8453\)/],
    ["LI.FI sent to the SpokePool", lifi.tx.data, across.tx.to, /bridge contract is not the verified lifi contract for base \(chain id 8453\)/],
  ];
  for (const [name, data, to, reason] of cases) assert.throws(sign({ to, data }), reason, name);
  assert.throws(sign({ ...openAcross, value: 1n }, { maxValueWei: 10n }), /bridge must not attach native value/);
  assert.throws(sign({ ...across.tx, data: acrossWith((args) => (args[4] = 9_000_000n)) }), /bridge charges 9000000/);
});

test("Relay stays quote-only because its deposit names no destination chain or recipient", () => {
  const relay = fixture<RelayFixture>("relay-base-arbitrum");
  const deposit = relay.steps.find((step) => step.id === "deposit")?.txs[0];
  assert.ok(deposit);
  assert.equal(bridgeTerms(deposit.data), null);
  assert.throws(sign(deposit), /bridge calldata is not a call the signing policy decodes/);
});

test("a bridge approval may name only the verified contract and the exact deposit", () => {
  const approve = (spender: string, amount: bigint) => ({ to: USDC, data: encodeFunctionData({ abi: erc20Abi, functionName: "approve", args: [spender as Hex, amount] }) });
  const approval = { approval: { token: USDC, amount: 2_000_000n }, purpose: "approve" as const };
  sign(approve(lifi.tx.to, 2_000_000n), approval)();
  sign(approve(openAcross.to, 2_000_000n), approval)();
  assert.throws(sign(approve(ATTACKER, 2_000_000n), approval), /approval spender is not an allowlisted router/);
  assert.throws(sign(approve(across.tx.to, 2n ** 255n), { ...approval, approval: { token: USDC, amount: 2n ** 255n } }), /approval amount is not the exact sell amount/);
});

test("the app's bridge rule and whale-signer decide every bridge vector the same way", () => {
  type Vector = { name: string; expect: string; reason?: string; job: { chainId: number; tx: { to: string; data: Hex; value: string } } };
  const vectors = JSON.parse(readFileSync(new URL("../../signer/vectors/evm.json", import.meta.url), "utf8")) as { own: string; cases: Vector[] };
  const policy = JSON.parse(readFileSync(new URL("../../signer/vectors/policy.json", import.meta.url), "utf8")) as { evm: { destinations: string[]; chains: number[]; maxBridgeFeeBps: number } };
  const bridges = vectors.cases.filter((entry) => / bridge |Across|Relay/.test(entry.name) && entry.job.tx.to.toLowerCase() !== USDC.toLowerCase() && !entry.reason?.includes("daily limit"));
  assert.ok(bridges.length >= 30, `found ${bridges.length} bridge vectors`);
  for (const entry of bridges) {
    const { chainId, tx } = entry.job;
    const charge = bridgeTerms(tx.data)?.charge;
    const decide = sign({ to: tx.to, data: tx.data, value: tx.value }, { chainId, owner: vectors.own, withdrawAllowlist: policy.evm.destinations, bridgeChainIds: policy.evm.chains, maxBridgeFeeBps: policy.evm.maxBridgeFeeBps, maxValueWei: 10n, ...(charge ? { charge } : {}) });
    let decision = "signed";
    try {
      decide();
    } catch {
      decision = "refused";
    }
    assert.equal(decision, entry.expect, entry.name);
  }
});

test("the signing policy refuses a bridge that lets the relayer keep the deposit", () => {
  const year = 4_000_000_000;
  const cases: [string, { to: string; data: Hex }, RegExp][] = [
    ["Across 1 wei out to an exclusive attacker relayer", { to: across.tx.to, data: acrossWith((args) => ((args[5] = 1n), (args[7] = word(ATTACKER)), (args[10] = year))) }, /bridge names an exclusive relayer/],
    ["Across 1 wei out", { to: across.tx.to, data: acrossWith((args) => (args[5] = 1n)) }, /bridge delivers at least 1 USDC for 2000000, under the 100 bps bridge fee cap/],
    ["Across 0 out", { to: across.tx.to, data: acrossWith((args) => (args[5] = 0n)) }, /under the 100 bps bridge fee cap/],
    ["Across attacker output token", { to: across.tx.to, data: acrossWith((args) => ((args[3] = word(ATTACKER)), (args[5] = 2_000_000n))) }, /delivers 0x00000000000000000000000000000000000bad00 on arbitrum \(chain id 42161\), a pair the bridge token table does not list/],
    ["Across Arbitrum WETH out for Base USDC", { to: across.tx.to, data: acrossWith((args) => (args[3] = word("0x82aF49447D8a07e3bd95BD0d56f35241523fBab1"))) }, /a pair the bridge token table does not list/],
    ["Across exclusivity without a relayer", { to: across.tx.to, data: acrossWith((args) => (args[10] = 3)) }, /bridge names an exclusive relayer/],
    ["LI.FI 1 wei out to an exclusive attacker relayer", { to: lifi.tx.to, data: lifiWith((_, data) => ((data.outputAmount = 1n), (data.exclusiveRelayer = word(ATTACKER)), (data.exclusivityParameter = year))) }, /bridge names an exclusive relayer/],
    ["LI.FI 0 out", { to: lifi.tx.to, data: lifiWith((_, data) => (data.outputAmount = 0n)) }, /bridge delivers at least 0 USDC for 2000000/],
    ["LI.FI 2% under par", { to: lifi.tx.to, data: lifiWith((_, data) => (data.outputAmount = 1_960_000n)) }, /under the 100 bps bridge fee cap/],
    ["LI.FI charge under the reserved amount", { to: lifi.tx.to, data: lifiWith((bridge) => (bridge.minAmount = 1n)) }, /bridge charges 1 of 0x833589fcd6edb6e08f4c7c32d4f71b54bda02913, not the 2000000 reserved/],
    ["LI.FI attacker receiving asset", { to: lifi.tx.to, data: lifiWith((_, data) => (data.receivingAssetId = word(ATTACKER))) }, /a pair the bridge token table does not list/],
    ["LI.FI exclusive relayer alone", { to: lifi.tx.to, data: lifiWith((_, data) => (data.exclusiveRelayer = word(ATTACKER))) }, /bridge names an exclusive relayer/],
  ];
  for (const [name, tx, reason] of cases) assert.throws(sign(tx), reason, name);
});

test("the bridge fee cap is signer policy and bounds the real routes", () => {
  assert.throws(sign(lifi.tx, { maxBridgeFeeBps: 30 }), /bridge delivers at least 1993409 USDC for 2000000, under the 30 bps bridge fee cap/);
  sign(lifi.tx, { maxBridgeFeeBps: 50 })();
  sign(openAcross, { maxBridgeFeeBps: 50 })();
  assert.throws(sign(openAcross, { maxBridgeFeeBps: 30 }), /under the 30 bps bridge fee cap/);
  assert.throws(sign(openAcross, { maxBridgeFeeBps: undefined }), /bridge has no fee cap in the signing policy/);
});

test("a bridge may land only on a chain the wallet enables", () => {
  const toEthereum = { to: across.tx.to, data: acrossWith((args) => ((args[3] = word("0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48")), (args[6] = 1n))) };
  assert.throws(sign(toEthereum), /bridge destination chain 1 is not in the signing policy/);
  sign(toEthereum, { bridgeChainIds: [1, 8453, 42161] })();
  assert.throws(sign(openAcross, { bridgeChainIds: [8453] }), /bridge destination chain 42161 is not in the signing policy/);
  assert.throws(sign(openAcross, { bridgeChainIds: undefined }), /bridge destination chain 42161 is not in the signing policy/);
});

const FEE_FORWARDER = "0xDe2b920506EE931a6A2ABDF566526220214FBbAE";
const LIFI_SWAP_AND_START_ABI = parseAbi([
  "function swapAndStartBridgeTokensViaAcrossV4((bytes32 transactionId, string bridge, string integrator, address referrer, address sendingAssetId, address receiver, uint256 minAmount, uint256 destinationChainId, bool hasSourceSwaps, bool hasDestinationCall) _bridgeData, (address callTo, address approveTo, address sendingAssetId, address receivingAssetId, uint256 fromAmount, bytes callData, bool requiresDeposit)[] _swapData, (bytes32 receiverAddress, bytes32 refundAddress, bytes32 sendingAssetId, bytes32 receivingAssetId, uint256 outputAmount, uint128 outputAmountMultiplier, bytes32 exclusiveRelayer, uint32 quoteTimestamp, uint32 fillDeadline, uint32 exclusivityParameter, bytes message) _acrossData) payable",
  "function forwardERC20Fees(address token, (address recipient, uint256 amount)[] fees)",
]);

test("the signing policy refuses every LI.FI swap-then-bridge call, the real quote and the fee forwarder leak alike", () => {
  const call = decodeFunctionData({ abi: LIFI_SWAP_AND_START_ABI, data: swapAndStart.tx.data });
  assert.equal(call.functionName, "swapAndStartBridgeTokensViaAcrossV4");
  const [bridge, swaps, data] = call.args as unknown as [Record<string, unknown>, Record<string, unknown>[], Record<string, unknown>];
  const forward = encodeFunctionData({ abi: LIFI_SWAP_AND_START_ABI, functionName: "forwardERC20Fees", args: [USDC as Hex, [{ recipient: ATTACKER, amount: 1_999_999n }]] });
  const leak = encodeFunctionData({
    abi: LIFI_SWAP_AND_START_ABI,
    functionName: "swapAndStartBridgeTokensViaAcrossV4",
    args: [{ ...bridge, minAmount: 1n }, [{ ...swaps[0], callTo: FEE_FORWARDER, approveTo: FEE_FORWARDER, fromAmount: 2_000_000n, callData: forward }], { ...data, outputAmountMultiplier: 2_000_000n * 10n ** 18n }] as never,
  });
  for (const [name, tx] of [["real quote", swapAndStart.tx], ["fee forwarder leak", { to: swapAndStart.tx.to, data: leak }]] as const) {
    assert.equal(bridgeTerms(tx.data), null, name);
    assert.throws(sign(tx), /bridge calldata is not a call the signing policy decodes/, name);
  }
});

test("a LI.FI start call may not set an output multiplier above par", () => {
  sign({ to: lifi.tx.to, data: lifiWith((_, data) => (data.outputAmountMultiplier = 10n ** 18n)) })();
  assert.throws(sign({ to: lifi.tx.to, data: lifiWith((_, data) => (data.outputAmountMultiplier = 10n ** 18n + 1n)) }), /bridge output multiplier 1000000000000000001 is above par for USDC/);
  assert.throws(sign({ to: lifi.tx.to, data: lifiWith((_, data) => (data.outputAmountMultiplier = 2n * 10n ** 24n)) }), /bridge output multiplier 2000000000000000000000000 is above par for USDC/);
});

test("the TypeScript bridge token table and whale-signer's vector table are the same table", () => {
  const vectors = JSON.parse(readFileSync(new URL("../../signer/vectors/bridge-tokens.json", import.meta.url), "utf8")) as { symbol: string; chainId: number; address: string; decimals: number }[];
  const table: Record<string, Record<number, { address: string; decimals: number }>> = {};
  for (const { symbol, chainId, address, decimals } of vectors) (table[symbol] ??= {})[chainId] = { address, decimals };
  const typescript = Object.fromEntries(Object.entries(BRIDGE_TOKENS).map(([symbol, byChain]) => [symbol, Object.fromEntries(Object.entries(byChain).map(([chainId, token]) => [chainId, { address: token.address.toLowerCase(), decimals: token.decimals }]))]));
  assert.deepEqual(typescript, table);
});
