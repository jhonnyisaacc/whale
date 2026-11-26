import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import test from "node:test";
import pg from "pg";
import { decodeFunctionData, encodeFunctionData, erc20Abi, keccak256, pad, parseTransaction, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import type { BridgeCall } from "../src/aggregators/bridge.js";
import { RELAY_QUOTE_ONLY, executeBridge, type BridgeDeps, type BridgeReads, type BridgeSpend } from "../src/bridge/execute.js";
import { bridgeSpend } from "../src/bridge/spend.js";
import type { BridgeStatus } from "../src/bridge/status.js";
import { evmContext, type EvmReceipt, type EvmRpc, type SendIo } from "../src/broadcast/shared.js";
import { loadConfig } from "../src/config.js";
import { withPolicy, type TransactionSigner } from "../src/managed-signer.js";
import { createNonceManager } from "../src/nonce.js";
import type { BridgeProvider, BridgeRoute } from "../src/rebalance.js";
import { ACROSS_SPOKE_POOL_ABI, LIFI_ACROSS_ABI, bridgeTerms } from "../src/signing-policy.js";
import { closeSpendPools, reconcileReserved, spendJournal } from "../src/spend.js";

type Fixture = { route: { amount: string; from: string; recipient: string; sell: string; buy: string }; tx: { to: Hex; data: Hex; value: string } };
const fixture = (name: string) => JSON.parse(readFileSync(new URL(`../../test/fixtures/bridge/${name}.json`, import.meta.url), "utf8")) as Fixture;
const lifi = fixture("lifi-start-base-arbitrum");
const swapAndStart = fixture("lifi-swap-and-start-base-arbitrum");
const across = fixture("across-base-arbitrum");
const account = privateKeyToAccount(`0x${"11".repeat(32)}`);
const OWN = account.address;
const ATTACKER = "0x00000000000000000000000000000000000bad00";
const config = loadConfig({ RPC_URL_8453: "http://base.invalid", ENABLED_CHAINS: "base,arbitrum", ALLOW_HOT_APPROVAL: "true", MAX_BRIDGE_FEE_BPS: "100" });

const route: BridgeRoute = {
  source: { chainKey: "base", address: OWN },
  destination: { chainKey: "arbitrum", address: OWN },
  sell: { symbol: "USDC", address: lifi.route.sell, decimals: 6 },
  buy: { symbol: "USDC", address: lifi.route.buy, decimals: 6 },
  amount: lifi.route.amount,
  amountInUsd: 2,
};

function signer(raw: Hex[], policy = config): TransactionSigner {
  const inner: TransactionSigner = {
    backend: "keystore",
    evmAddress: () => OWN,
    solanaAddress: () => null,
    async signEvm(input) {
      const signed = await account.signTransaction({ chainId: input.chainId, to: input.to, data: input.data, value: input.value, gas: input.gas, nonce: input.nonce, maxFeePerGas: input.maxFeePerGas, maxPriorityFeePerGas: input.maxPriorityFeePerGas, type: "eip1559" });
      raw.push(signed);
      return signed;
    },
    signSolana: async () => {
      throw new Error("no solana");
    },
    signHyperliquid: async () => {
      throw new Error("no hyperliquid");
    },
  };
  return withPolicy(inner, policy);
}

function chain(checkChain: EvmRpc["checkChain"] = async () => undefined, mine = true) {
  const sent: Hex[] = [];
  const receipts = new Map<string, EvmReceipt>();
  const rpc: EvmRpc = {
    fees: async () => ({ maxFeePerGas: 10_000_000n, maxPriorityFeePerGas: 1_000_000n }),
    pendingNonce: async () => 7 + sent.length,
    confirmedNonce: async () => 7,
    estimateGas: async () => 250_000n,
    simulate: async () => undefined,
    sendRaw: async (signed) => {
      sent.push(signed);
      if (mine) receipts.set(keccak256(signed), { status: "success", gasUsed: 200_000n, effectiveGasPrice: 1n, l1Fee: 0n });
    },
    receipt: async (hash) => receipts.get(hash) ?? null,
    seen: async (hash) => receipts.has(hash),
    balance: async () => 10n ** 20n,
    checkChain,
  };
  let clock = 0;
  const io: SendIo = {
    evm: () => rpc,
    solana: () => {
      throw new Error("no solana");
    },
    nonces: createNonceManager(),
    sleep: async (ms) => {
      clock += ms;
    },
    now: () => clock,
    confirmTimeoutMs: 1_000,
    pollMs: 100,
  };
  return { sent, io };
}

type Harness = { deps: BridgeDeps; raw: Hex[]; sent: Hex[]; spend: string[]; simulated: number[] };

function harness(options: { config?: typeof config; call?: BridgeCall | null; allowance?: bigint; screen?: "allow" | "deny"; reserve?: "reserved" | "exists" | "cap"; simulate?: BridgeReads["simulate"]; broadcast?: boolean; statuses?: BridgeStatus["state"][]; checkChain?: EvmRpc["checkChain"]; mine?: boolean } = {}): Harness {
  const raw: Hex[] = [];
  const spend: string[] = [];
  const simulated: number[] = [];
  const { sent, io } = chain(options.checkChain, options.mine);
  const evm = evmContext({ config: options.config ?? config, signer: signer(raw, options.config ?? config), io, onTx: async () => undefined, fetchImpl: fetch, secrets: [] }, "base", ["http://base.invalid"]);
  const ledger: BridgeSpend = {
    reserve: async (key, usd) => (spend.push(`reserve ${key} ${usd}`), options.reserve ?? "reserved"),
    release: async (key) => void spend.push(`release ${key}`),
    commit: async (key) => void spend.push(`commit ${key}`),
    record: async (key, tx) => void spend.push(`record ${key} ${tx.outcome}`),
  };
  const statuses = [...(options.statuses ?? ["pending", "landed"])];
  const deps: BridgeDeps = {
    evm,
    reads: {
      allowance: async () => options.allowance ?? 0n,
      simulate:
        options.simulate ??
        (async (_from, calls) => {
          simulated.push(calls.length);
          return calls.map(() => 200_000n);
        }),
    },
    firm: async () => (options.call === undefined ? { to: lifi.tx.to, data: lifi.tx.data, value: 0n, gas: null } : options.call),
    screen: async () => options.screen ?? "allow",
    spend: ledger,
    status: async (lookup) => ({ provider: lookup.provider, state: statuses.shift() ?? "landed", sourceTx: lookup.txHash, destinationTx: null, detail: "" }),
    broadcast: options.broadcast ?? false,
    trackTimeoutMs: 10_000,
  };
  return { deps, raw, sent, spend, simulated };
}

const order = (provider: BridgeProvider = "lifi") => ({ idempotencyKey: "k1", route, provider });

test("a live bridge with WHALE_BROADCAST off ends at a signed approval and bridge that pay this wallet on Arbitrum", async () => {
  const run = harness();
  const result = await executeBridge(run.deps, order());
  assert.equal(result.status, "signed", JSON.stringify(result));
  assert.deepEqual(result.status === "signed" && result.txs.map((tx) => [tx.purpose, tx.nonce]), [["approve", 7], ["bridge", 8]]);
  assert.deepEqual(run.simulated, [2]);
  assert.deepEqual(run.sent, []);
  assert.deepEqual(run.spend, ["reserve bridge:k1 2", "release bridge:k1"]);
  const [approval, bridge] = run.raw.map((signed) => parseTransaction(signed));
  assert.ok(approval && bridge);
  assert.deepEqual(decodeFunctionData({ abi: erc20Abi, data: approval.data ?? "0x" }).args, [lifi.tx.to, 2_000_000n]);
  assert.equal(bridge.chainId, 8453);
  const terms = bridgeTerms(bridge.data ?? "0x");
  assert.equal(terms?.recipient.toLowerCase(), OWN.toLowerCase());
  assert.equal(terms?.destinationChainId, 42161n);
});

test("the real LI.FI swap-then-bridge quote signs its approval and bridge for the whole deposit, fee step included", async () => {
  const run = harness({ call: { to: swapAndStart.tx.to, data: swapAndStart.tx.data, value: 0n, gas: null } });
  const result = await executeBridge(run.deps, order());
  assert.equal(result.status, "signed", JSON.stringify(result));
  const [approval, bridge] = run.raw.map((signed) => parseTransaction(signed));
  assert.ok(approval && bridge);
  assert.deepEqual(decodeFunctionData({ abi: erc20Abi, data: approval.data ?? "0x" }).args, [swapAndStart.tx.to, 2_000_000n]);
  assert.equal(bridge.data, swapAndStart.tx.data);
  assert.deepEqual(run.spend, ["reserve bridge:k1 2", "release bridge:k1"]);
});

test("a relay that answers another chain refuses a held or live bridge before it signs and releases the spend", async () => {
  for (const broadcast of [false, true]) {
    const run = harness({
      broadcast,
      checkChain: async () => {
        throw new Error("MEV_RPC_URL_8453 answered eth_chainId with chain 1");
      },
    });
    const result = await executeBridge(run.deps, order());
    assert.equal(result.status, "skipped", `broadcast ${broadcast}`);
    assert.match(result.status === "skipped" ? result.reason : "", /answered eth_chainId with chain 1/);
    assert.deepEqual(run.raw, [], `broadcast ${broadcast}`);
    assert.deepEqual(run.sent, []);
    assert.deepEqual(run.spend, ["reserve bridge:k1 2", "release bridge:k1"]);
  }
});

test("an Across bridge whose allowance is already set signs only the deposit", async () => {
  const run = harness({ call: { to: across.tx.to, data: across.tx.data, value: 0n, gas: null }, allowance: 2_000_000n });
  const result = await executeBridge(run.deps, order("across"));
  assert.equal(result.status, "signed", JSON.stringify(result));
  assert.deepEqual(result.status === "signed" && result.txs.map((tx) => tx.purpose), ["bridge"]);
  assert.deepEqual(run.simulated, [1]);
  const signed = bridgeTerms(parseTransaction(run.raw[0] ?? "0x").data ?? "0x");
  assert.equal(signed?.exclusivity, 0);
  assert.equal(BigInt(signed?.exclusiveRelayer ?? "0x1"), 0n);
  assert.equal(bridgeTerms(across.tx.data)?.exclusivity, 3);
});

test("a bridge whose route fee is above MAX_BRIDGE_FEE_BPS is skipped before it reserves or signs", async () => {
  const run = harness({ config: loadConfig({ RPC_URL_8453: "http://base.invalid", ENABLED_CHAINS: "base,arbitrum", ALLOW_HOT_APPROVAL: "true", MAX_BRIDGE_FEE_BPS: "30" }) });
  const result = await executeBridge(run.deps, order());
  assert.equal(result.status, "skipped");
  assert.match(result.status === "skipped" ? result.reason : "", /lifi minimum output is under the 30 bps bridge fee cap/);
  assert.deepEqual(run.spend, []);
  assert.deepEqual(run.raw, []);
});

test("Relay and deBridge stay quote-only and reserve nothing", async () => {
  for (const [provider, reason] of [["relay", RELAY_QUOTE_ONLY], ["debridge", /fixed fee in the source chain's native coin/]] as const) {
    const run = harness();
    const result = await executeBridge(run.deps, order(provider));
    assert.equal(result.status, "skipped");
    assert.match(result.status === "skipped" ? result.reason : "", typeof reason === "string" ? new RegExp(reason.slice(0, 20)) : reason);
    assert.deepEqual(run.spend, []);
  }
});

test("a bridge is refused before any reservation when screening denies a token or the calldata strays from the route", async () => {
  const lifiArgs = decodeFunctionData({ abi: LIFI_ACROSS_ABI, data: lifi.tx.data }).args as unknown as [Record<string, unknown>, Record<string, unknown>];
  const paysAttacker = encodeFunctionData({
    abi: LIFI_ACROSS_ABI,
    functionName: "startBridgeTokensViaAcrossV4",
    args: [{ ...lifiArgs[0], receiver: ATTACKER }, { ...lifiArgs[1], receiverAddress: pad(ATTACKER, { size: 32 }) }] as never,
  });
  const acrossArgs = [...decodeFunctionData({ abi: ACROSS_SPOKE_POOL_ABI, data: across.tx.data }).args];
  acrossArgs[5] = 1_000_000n;
  const lowOutput = encodeFunctionData({ abi: ACROSS_SPOKE_POOL_ABI, functionName: "deposit", args: acrossArgs as never });
  const [bridgeData, swaps, acrossData] = decodeFunctionData({ abi: LIFI_ACROSS_ABI, data: swapAndStart.tx.data }).args as unknown as [Record<string, unknown>, Record<string, unknown>[], Record<string, unknown>];
  const swapToAttacker = encodeFunctionData({ abi: LIFI_ACROSS_ABI, functionName: "swapAndStartBridgeTokensViaAcrossV4", args: [bridgeData, swaps.map((swap) => ({ ...swap, callTo: ATTACKER, approveTo: ATTACKER })), acrossData] as never });
  const cases: [Parameters<typeof harness>[0], BridgeProvider, RegExp][] = [
    [{ screen: "deny" }, "lifi", /screening denied/],
    [{ call: null }, "lifi", /lifi returned no bridge transaction/],
    [{ call: { to: ATTACKER, data: lifi.tx.data, value: 0n, gas: null } }, "lifi", /not its verified contract on base/],
    [{ call: { to: lifi.tx.to, data: paysAttacker, value: 0n, gas: null } }, "lifi", /pays 0x00000000000000000000000000000000000bad00, not the route's destination/],
    [{ call: { to: across.tx.to, data: lowOutput, value: 0n, gas: null } }, "across", /minimum output is under the 100 bps bridge fee cap/],
    [{ call: { to: lifi.tx.to, data: lifi.tx.data, value: 1n, gas: null } }, "lifi", /attached native value/],
    [{ call: { to: swapAndStart.tx.to, data: swapToAttacker, value: 0n, gas: null } }, "lifi", /the LI\.FI swap step calls 0x00000000000000000000000000000000000bad00, which is not a listed LI\.FI step target/],
  ];
  for (const [options, provider, reason] of cases) {
    const run = harness(options);
    const result = await executeBridge(run.deps, order(provider));
    assert.equal(result.status, "skipped", String(reason));
    assert.match(result.status === "skipped" ? result.reason : "", reason);
    assert.deepEqual(run.spend, [], String(reason));
    assert.deepEqual(run.raw, []);
  }
});

test("the daily bridge cap and a repeated key stop the bridge before it signs", async () => {
  for (const [reserve, reason] of [["cap", "bridge daily cap"], ["exists", "duplicate bridge"]] as const) {
    const run = harness({ reserve });
    assert.deepEqual(await executeBridge(run.deps, order()), { status: "skipped", reason });
    assert.deepEqual(run.raw, []);
  }
});

test("a bridge that fails simulation signs nothing and releases its reservation", async () => {
  const run = harness({
    simulate: async () => {
      throw new Error("ERC20: transfer amount exceeds balance");
    },
  });
  const result = await executeBridge(run.deps, order());
  assert.equal(result.status, "skipped");
  assert.match(result.status === "skipped" ? result.reason : "", /simulation rejected the bridge: ERC20: transfer amount exceeds balance/);
  assert.deepEqual(run.spend, ["reserve bridge:k1 2", "release bridge:k1"]);
  assert.deepEqual(run.raw, []);
});

test("with broadcast on, the bridge sends, commits its spend, and tracks the transfer until it lands", async () => {
  const run = harness({ broadcast: true, statuses: ["not_found", "pending", "landed"] });
  const result = await executeBridge(run.deps, order());
  assert.equal(result.status, "sent", JSON.stringify(result));
  assert.equal(run.sent.length, 2);
  assert.deepEqual(run.spend, ["reserve bridge:k1 2", "record bridge:k1 pending", "commit bridge:k1"]);
  assert.equal(result.status === "sent" && result.transfer?.state, "landed");
  assert.equal(result.status === "sent" && result.transfer?.sourceTx, keccak256(run.sent[1] ?? "0x"));
});

test("a bridge whose status stays unknown keeps its reservation once the source transaction lands", async () => {
  const run = harness({ broadcast: true, statuses: Array.from({ length: 200 }, () => "unknown" as const) });
  const result = await executeBridge(run.deps, order());
  assert.equal(result.status, "sent", JSON.stringify(result));
  assert.deepEqual(run.spend, ["reserve bridge:k1 2", "record bridge:k1 pending", "commit bridge:k1"]);
  assert.equal(result.status === "sent" && result.transfer?.state, "unknown");
  assert.equal(result.reason, "bridge unknown");
});

test("a bridge that landed keeps its reservation and reports sent when the spend commit fails", async () => {
  const run = harness({ broadcast: true });
  run.deps.spend = { ...run.deps.spend, commit: async () => Promise.reject(new Error("db connection reset")) };
  const result = await executeBridge(run.deps, order());
  assert.equal(result.status, "sent", JSON.stringify(result));
  assert.equal(run.sent.length, 2);
  assert.match(result.reason, /db connection reset/);
  assert.deepEqual(run.spend, ["reserve bridge:k1 2", "record bridge:k1 pending"]);
});

test("a bridge whose spend record fails sends no bridge transaction and releases its reservation", async () => {
  const run = harness({ broadcast: true, allowance: 2_000_000n });
  run.deps.spend = { ...run.deps.spend, record: async () => Promise.reject(new Error("db connection reset")) };
  const result = await executeBridge(run.deps, order());
  assert.equal(result.status, "skipped", JSON.stringify(result));
  assert.deepEqual(run.sent, []);
  assert.deepEqual(run.spend, ["reserve bridge:k1 2", "release bridge:k1"]);
});

test("reconcile keeps a sent bridge reserved until its source tx lands, after a confirm timeout or a failed commit", { skip: !process.env.TEST_DATABASE_URL }, async () => {
  const databaseUrl = process.env.TEST_DATABASE_URL as string;
  const day = `${2100 + Math.floor(Math.random() * 800)}-03-01`;
  const client = new pg.Client({ connectionString: databaseUrl });
  await client.connect();
  const keys: string[] = [];
  try {
    for (const failure of ["confirm timeout", "commit failed"] as const) {
      const run = harness({ broadcast: true, allowance: 2_000_000n, mine: failure === "commit failed" });
      const spend = bridgeSpend(spendJournal(databaseUrl, 100, () => day), 10);
      run.deps.spend = failure === "commit failed" ? { ...spend, commit: async () => Promise.reject(new Error("db connection reset")) } : spend;
      const id = randomUUID();
      const key = `bridge:${id}`;
      keys.push(key);
      const result = await executeBridge(run.deps, { idempotencyKey: id, route, provider: "lifi" });
      assert.equal(result.status, failure === "commit failed" ? "sent" : "skipped", JSON.stringify(result));
      const hashes = run.sent.map((signed) => keccak256(signed));
      assert.ok(hashes.length > 0, failure);
      await client.query("UPDATE spend_journal SET reserved_at = now() - interval '1 hour' WHERE idempotency_key = $1", [key]);
      const settle = async (outcome: "pending" | "landed") => {
        await reconcileReserved(databaseUrl, 10, async (aged) => (hashes.includes(aged.txHash as Hex) ? outcome : null), () => undefined);
        return (await client.query<{ status: string }>("SELECT status FROM spend_journal WHERE idempotency_key = $1", [key])).rows[0]?.status;
      };
      assert.equal(await settle("pending"), "reserved", `${failure}: a bridge whose source tx is still pending keeps its reservation`);
      assert.equal(await spend.reserve(`bridge:${randomUUID()}`, 9), "cap", `${failure}: the pending bridge still counts against the bridge cap`);
      assert.equal(await settle("landed"), "committed", `${failure}: a landed source tx commits the bridge`);
    }
    const approvalOnly = harness({ broadcast: true, allowance: 0n, mine: false });
    approvalOnly.deps.spend = bridgeSpend(spendJournal(databaseUrl, 100, () => day), 10);
    const approvalId = randomUUID();
    const approvalKey = `bridge:${approvalId}`;
    keys.push(approvalKey);
    assert.equal((await executeBridge(approvalOnly.deps, { idempotencyKey: approvalId, route, provider: "lifi" })).status, "skipped");
    await client.query("UPDATE spend_journal SET reserved_at = now() - interval '1 hour' WHERE idempotency_key = $1", [approvalKey]);
    await reconcileReserved(databaseUrl, 10, async () => "pending", () => undefined);
    assert.equal((await client.query<{ status: string }>("SELECT status FROM spend_journal WHERE idempotency_key = $1", [approvalKey])).rows[0]?.status, "released");
  } finally {
    await client.query("DELETE FROM spend_journal WHERE spent_on = $1::date", [day]);
    await client.query("DELETE FROM signed_tx WHERE idempotency_key = ANY($1)", [keys]);
    await client.end();
    await closeSpendPools();
  }
});

test("a bridge that needs an approval waits for the root-quorum approval while ALLOW_HOT_APPROVAL is off", async () => {
  const run = harness({ config: loadConfig({ RPC_URL_8453: "http://base.invalid", ENABLED_CHAINS: "base,arbitrum", MAX_BRIDGE_FEE_BPS: "100" }) });
  const result = await executeBridge(run.deps, order());
  assert.equal(result.status, "skipped");
  assert.match(result.status === "skipped" ? result.reason : "", /has no USDC allowance and ALLOW_HOT_APPROVAL is off/);
  assert.deepEqual(run.spend, []);
});
