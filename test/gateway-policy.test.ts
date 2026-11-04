import assert from "node:assert/strict";
import test from "node:test";
import { newApiKey } from "../src/gateway/agents.js";
import { changeDirection, DEFAULT_POLICY, effectiveLimits, HOSTED_CHAINS, limitsWithin, walletPolicySchema, type WalletPolicy } from "../src/gateway/policy.js";

const EVM = "0x1111111111111111111111111111111111111111";

function policy(overrides: Partial<WalletPolicy> = {}): WalletPolicy {
  return { ...DEFAULT_POLICY, ...overrides };
}

test("the default policy parses and hosted chains exclude HyperCore and zkSync", () => {
  assert.deepEqual(walletPolicySchema.parse(DEFAULT_POLICY), DEFAULT_POLICY);
  assert.ok(HOSTED_CHAINS.includes("base") && HOSTED_CHAINS.includes("solana"));
  assert.equal(HOSTED_CHAINS.includes("hypercore"), false);
  assert.equal(HOSTED_CHAINS.includes("zksync"), false);
});

test("a policy refuses unknown chains, repeats, a daily cap under the per-tx cap, extra keys, and bad addresses", () => {
  const bad = [
    policy({ chains: ["base", "dogechain"] }),
    policy({ chains: ["base", "base"] }),
    policy({ maxTxUsd: 200, dailyUsd: 100 }),
    { ...policy(), unexpected: true },
    policy({ destinations: [{ family: "evm", address: "0x1234", label: "x" }] }),
    policy({ destinations: [{ family: "solana", address: EVM, label: "x" }] }),
    policy({ destinations: [{ family: "evm", address: EVM, label: "a" }, { family: "evm", address: EVM.toUpperCase().replace("0X", "0x"), label: "b" }] }),
    policy({ maxSlippageBps: 5_000 }),
  ];
  for (const candidate of bad) assert.equal(walletPolicySchema.safeParse(candidate).success, false, JSON.stringify(candidate));
});

test("any loosening is a widening, and only tightening is a narrowing", () => {
  const base = policy({ destinations: [{ family: "evm", address: EVM, label: "cold" }], tokenAllowlist: [{ chain: "base", address: EVM }] });
  assert.equal(changeDirection(base, base), "same");
  const widened: Partial<WalletPolicy>[] = [
    { chains: [...base.chains, "optimism"] },
    { actions: ["swap", "transfer"] },
    { maxTxUsd: 60 },
    { dailyUsd: 101 },
    { approvalAboveUsd: null },
    { approvalAboveUsd: 30 },
    { maxSlippageBps: 101 },
    { destinations: [...base.destinations, { family: "evm", address: "0x2222222222222222222222222222222222222222", label: "new" }] },
    { tokenAllowlist: null },
    { tokenAllowlist: [{ chain: "solana", address: "So11111111111111111111111111111111111111112" }] },
    { maxTxUsd: 10, chains: [...base.chains, "optimism"] },
  ];
  for (const change of widened) assert.equal(changeDirection(base, { ...base, ...change }), "widen", JSON.stringify(change));
  const narrowed: Partial<WalletPolicy>[] = [{ chains: ["base"] }, { maxTxUsd: 10 }, { dailyUsd: 50 }, { approvalAboveUsd: 5 }, { destinations: [] }, { tokenAllowlist: [] }];
  for (const change of narrowed) assert.equal(changeDirection(base, { ...base, ...change }), "narrow", JSON.stringify(change));
  assert.equal(changeDirection(policy({ approvalAboveUsd: null }), policy({ approvalAboveUsd: 10 })), "narrow");
  assert.equal(changeDirection(policy({ tokenAllowlist: null }), policy({ tokenAllowlist: [] })), "narrow");
});

test("agent limits must sit inside the wallet policy, and the effective limit is the intersection", () => {
  const wallet = policy();
  const limits = { chains: ["base"], actions: ["swap" as const], maxTxUsd: 20, dailyUsd: 40 };
  assert.equal(limitsWithin(limits, wallet), null);
  assert.match(limitsWithin({ ...limits, chains: ["optimism"] }, wallet) ?? "", /chain/);
  assert.match(limitsWithin({ ...limits, actions: ["transfer"] }, wallet) ?? "", /action/);
  assert.match(limitsWithin({ ...limits, maxTxUsd: 51 }, wallet) ?? "", /maxTxUsd/);
  assert.match(limitsWithin({ ...limits, dailyUsd: 101 }, wallet) ?? "", /dailyUsd/);
  assert.deepEqual(effectiveLimits(limits, policy({ chains: ["solana"], maxTxUsd: 5, dailyUsd: 10 })), { chains: [], actions: ["swap"], maxTxUsd: 5, dailyUsd: 10 });
});

test("API keys carry a public id and a 256-bit secret", () => {
  const first = newApiKey();
  const second = newApiKey();
  assert.match(first.key, /^whale_[0-9a-f]{12}_[A-Za-z0-9_-]{43}$/);
  assert.notEqual(first.secret, second.secret);
  assert.equal(Buffer.from(first.secret, "base64url").byteLength, 32);
});
