import assert from "node:assert/strict";
import test from "node:test";
import { loadConfig } from "../src/config.js";
import type { ExecutorDeps } from "../src/executor.js";
import { createExecutorApp } from "../src/executor-server.js";
import { planRebalance, type ChainAddress } from "../src/rebalance.js";
import { landedSend } from "./fixtures.js";

const mint = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
const lookalike = mint.replace("EPj", "Epj");
const evm = "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48";

function plan(destination: ChainAddress, ownAddresses: readonly ChainAddress[], allowlist: readonly ChainAddress[]) {
  return planRebalance({
    quotes: [{ provider: "lifi", feeUsd: 0.01, amountInUsd: 10, destination }],
    maxBridgeUsd: 25,
    maxFeeBps: 50,
    spentBridgeUsd: 0,
    dailyBridgeCap: 50,
    ownAddresses,
    allowlist,
  });
}

test("a solana destination that differs only in case is refused, and the exact one keeps its case", () => {
  const owner = { chainKey: "solana", address: mint };
  const refused = plan({ chainKey: "solana", address: lookalike }, [owner, { chainKey: "solana", address: lookalike }], [owner]);
  assert.equal(refused.kind, "skip");
  const sent = plan(owner, [owner], [owner]);
  assert.equal(sent.kind, "would_send");
  assert.deepEqual(sent.quote?.destination, { chainKey: "solana", address: mint });
});

test("the same address on two chains is two identities", () => {
  const onBase = { chainKey: "base", address: evm };
  const onArbitrum = { chainKey: "arbitrum", address: evm };
  assert.equal(plan(onArbitrum, [onBase, onArbitrum], [onBase]).kind, "skip");
  assert.equal(plan(onArbitrum, [onBase], [onBase, onArbitrum]).kind, "skip");
  assert.equal(plan(onArbitrum, [onArbitrum], [onArbitrum]).kind, "would_send");
});

test("evm addresses still compare without case", () => {
  const destination = { chainKey: "base", address: evm };
  const result = plan(destination, [{ chainKey: "base", address: evm.toLowerCase() }], [{ chainKey: "base", address: evm.toUpperCase().replace("0X", "0x") }]);
  assert.equal(result.kind, "would_send");
  assert.equal(result.quote?.destination.address, evm);
});

test("/rebalance refuses a case-variant of an owner solana address", async () => {
  const token = "0123456789abcdef";
  const config = loadConfig({ EXECUTOR_AUTH_TOKEN: token, RESOLVER_AUTH_TOKEN: "resolver-token-123456", OWNER_WITHDRAW_ADDRESSES: mint });
  const runtime: ExecutorDeps = {
    config,
    mode: "dry_run",
    spentTodayUsd: 0,
    quoteHop: async () => ({ priceImpactPct: null, feeUsd: 0, buyAmount: "0" }),
    markPrice: async () => null,
    send: async () => landedSend(),
  };
  const app = await createExecutorApp(config, runtime, null, [], []);
  const post = (address: string) =>
    app.inject({
      method: "POST",
      url: "/rebalance",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      payload: { quotes: [{ provider: "lifi", feeUsd: 0.01, amountInUsd: 10, destination: { chainKey: "solana", address } }], ownAddresses: [{ chainKey: "solana", address }] },
    });
  assert.equal((await post(lookalike)).json().kind, "skip");
  assert.equal((await post(mint)).json().kind, "would_send");
  await app.close();
});
