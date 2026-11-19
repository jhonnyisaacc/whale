import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { decodeFunctionData, encodeFunctionData, erc20Abi, pad, type Hex } from "viem";
import { assertEvmSigning } from "../src/signing-policy.js";
import { ACROSS_SPOKE_POOL_ABI, BRIDGE_CONTRACTS, LIFI_ACROSS_ABI, bridgeTerms } from "../src/signing-policy/bridge-terms.js";

type Fixture = { route: { fromChainId: number; toChainId: number; sell: string; amount: string; from: string; recipient: string }; tx: { to: Hex; data: Hex; value: string } };
type RelayFixture = { steps: { id: string; txs: { to: Hex; data: Hex; value: string }[] }[] };

function fixture<T = Fixture>(name: string): T {
  return JSON.parse(readFileSync(new URL(`../../test/fixtures/bridge/${name}.json`, import.meta.url), "utf8")) as T;
}

const lifi = fixture("lifi-across-base-arbitrum");
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
      ...extra,
    });
}

function lifiWith(edit: (bridge: Record<string, unknown>, data: Record<string, unknown>) => void): Hex {
  const call = decodeFunctionData({ abi: LIFI_ACROSS_ABI, data: lifi.tx.data });
  assert.equal(call.functionName, "swapAndStartBridgeTokensViaAcrossV4");
  const [bridge, swaps, data] = call.args as unknown as [Record<string, unknown>, unknown, Record<string, unknown>];
  const nextBridge = { ...bridge };
  const nextData = { ...data };
  edit(nextBridge, nextData);
  return encodeFunctionData({ abi: LIFI_ACROSS_ABI, functionName: "swapAndStartBridgeTokensViaAcrossV4", args: [nextBridge, swaps, nextData] as never });
}

function acrossWith(edit: (args: unknown[]) => void): Hex {
  const call = decodeFunctionData({ abi: ACROSS_SPOKE_POOL_ABI, data: across.tx.data });
  const args = [...call.args];
  edit(args);
  return encodeFunctionData({ abi: ACROSS_SPOKE_POOL_ABI, functionName: "deposit", args: args as never });
}

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
  sign(across.tx)();
  assert.throws(sign(lifi.tx, { charge: { token: USDC, amount: 1_999_999n } }), /bridge charges 2000000 of 0x833589fcd6edb6e08f4c7c32d4f71b54bda02913, not the 1999999 reserved/);
  assert.throws(sign(across.tx, { charge: undefined }), /bridge has no reserved charge/);
});

test("a bridge to an allowlisted destination signs only when that destination is allowlisted", () => {
  const destination = fixture("lifi-across-base-arbitrum-destination");
  const allowlisted = fixture("across-base-arbitrum-destination");
  for (const tx of [destination.tx, allowlisted.tx]) {
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
  assert.throws(sign({ ...across.tx, value: 1n }, { maxValueWei: 10n }), /bridge must not attach native value/);
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
  sign(approve(across.tx.to, 2_000_000n), approval)();
  assert.throws(sign(approve(ATTACKER, 2_000_000n), approval), /approval spender is not an allowlisted router/);
  assert.throws(sign(approve(across.tx.to, 2n ** 255n), { ...approval, approval: { token: USDC, amount: 2n ** 255n } }), /approval amount is not the exact sell amount/);
});

test("the app's bridge rule and whale-signer decide every bridge vector the same way", () => {
  type Vector = { name: string; expect: string; reason?: string; job: { chainId: number; tx: { to: string; data: Hex; value: string } } };
  const vectors = JSON.parse(readFileSync(new URL("../../signer/vectors/evm.json", import.meta.url), "utf8")) as { own: string; cases: Vector[] };
  const policy = JSON.parse(readFileSync(new URL("../../signer/vectors/policy.json", import.meta.url), "utf8")) as { evm: { destinations: string[] } };
  const bridges = vectors.cases.filter((entry) => / bridge |Across|Relay/.test(entry.name) && entry.job.tx.to.toLowerCase() !== USDC.toLowerCase() && !entry.reason?.includes("daily limit"));
  assert.ok(bridges.length >= 18, `found ${bridges.length} bridge vectors`);
  for (const entry of bridges) {
    const { chainId, tx } = entry.job;
    const charge = bridgeTerms(tx.data)?.charge;
    const decide = sign({ to: tx.to, data: tx.data, value: tx.value }, { chainId, owner: vectors.own, withdrawAllowlist: policy.evm.destinations, maxValueWei: 10n, ...(charge ? { charge } : {}) });
    let decision = "signed";
    try {
      decide();
    } catch {
      decision = "refused";
    }
    assert.equal(decision, entry.expect, entry.name);
  }
});
