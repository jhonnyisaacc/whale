import assert from "node:assert/strict";
import test from "node:test";
import { parseCommand } from "../src/cli.js";
import { run, type Asset } from "../src/commands.js";
import type { ExecutionReport, RouteQuote } from "../src/domain.js";

const sell: Asset = { chain: { kind: "evm", chainId: 8453 }, chainKey: "base", address: "0x1111111111111111111111111111111111111111", symbol: "USDC", decimals: 6 };
const buy: Asset = { chain: { kind: "evm", chainId: 8453 }, chainKey: "base", address: "0x2222222222222222222222222222222222222222", symbol: "WETH", decimals: 18 };

const quote = (planId: string, feeUsd: number): RouteQuote => ({
  planId,
  kind: "aggregator",
  hops: ["USDC->WETH"],
  priceImpactPct: 0.1,
  feeUsd,
  buyAmount: "1",
});

test("a quote with no provider skips and does not call out", async () => {
  const result = await run({ kind: "quote", sell, buy, sellAmount: "1000000", taker: null, slippageBps: 50 });
  assert.equal(result.kind, "quote");
  if (result.kind !== "quote") return;
  assert.equal(result.status, "skipped");
  assert.equal(result.quote, null);
});

test("a dry-run swap with no executor does not broadcast", async () => {
  const result = await run({ kind: "swap", idempotencyKey: "s1", sell, buy, sellAmount: "1000000", slippageBps: 50, mode: "dry_run" });
  assert.equal(result.kind, "swap");
  if (result.kind !== "swap") return;
  assert.equal(result.report.decision, "skipped");
  assert.equal(result.report.mode, "dry_run");
  assert.equal(result.report.txs, undefined);
});

test("a dry-run swap uses the injected executor and keeps its report", async () => {
  let called = 0;
  const report: ExecutionReport = {
    idempotencyKey: "s2",
    mode: "dry_run",
    decision: "would_send",
    reason: "quoted",
    venue: "base",
    route: quote("a", 0.1),
    latency: { alertReceivedMs: 1 },
  };
  const result = await run(
    { kind: "swap", idempotencyKey: "s2", sell, buy, sellAmount: "1000000", slippageBps: 50, mode: "dry_run" },
    { execute: async () => { called += 1; return report; } },
  );
  assert.equal(called, 1);
  assert.equal(result.kind, "swap");
  if (result.kind === "swap") assert.equal(result.report.decision, "would_send");
});

test("an empty bridge allowlist skips and the cheaper quote wins without a broadcast", async () => {
  const empty = await run({
    kind: "bridge",
    quotes: [{ provider: "lifi", feeUsd: 1, amountInUsd: 10, destination: "0xabc" }],
    maxBridgeUsd: 100,
    maxFeeBps: 100,
    spentBridgeUsd: 0,
    dailyBridgeCap: 100,
    ownAddresses: ["0xabc"],
    allowlist: [],
  });
  assert.equal(empty.kind, "bridge");
  if (empty.kind !== "bridge") return;
  assert.equal(empty.plan.kind, "skip");

  const ranked = await run({
    kind: "bridge",
    quotes: [
      { provider: "across", feeUsd: 3, amountInUsd: 10, destination: "0xabc" },
      { provider: "lifi", feeUsd: 1, amountInUsd: 10, destination: "0xabc" },
    ],
    maxBridgeUsd: 100,
    maxFeeBps: 5_000,
    spentBridgeUsd: 0,
    dailyBridgeCap: 100,
    ownAddresses: ["0xabc"],
    allowlist: ["0xabc"],
  });
  assert.equal(ranked.kind, "bridge");
  if (ranked.kind !== "bridge" || ranked.plan.kind !== "would_send") return;
  assert.equal(ranked.plan.quote.provider, "lifi");
  assert.equal(ranked.plan.broadcast, false);
});

test("a dry-run transfer would send and a live transfer is skipped", async () => {
  const dry = await run({ kind: "transfer", idempotencyKey: "t1", asset: sell, to: "0xabc", amount: "1", mode: "dry_run" });
  assert.equal(dry.kind, "transfer");
  if (dry.kind === "transfer") assert.equal(dry.status, "would_send");
  const live = await run({ kind: "transfer", idempotencyKey: "t2", asset: sell, to: "0xabc", amount: "1", mode: "live" });
  assert.equal(live.kind, "transfer");
  if (live.kind === "transfer") assert.equal(live.status, "skipped");
});

test("the cli parses a quote and refuses a bridge fetch", () => {
  const command = parseCommand(["quote", "--sell-chain", "base", "--sell-address", sell.address, "--sell-symbol", "USDC", "--sell-decimals", "6", "--buy-chain", "base", "--buy-address", buy.address, "--buy-symbol", "WETH", "--buy-decimals", "18", "--sell-amount", "1000000", "--slippage-bps", "50"]);
  assert.equal(command.kind, "quote");
  assert.throws(() => parseCommand(["bridge"]), /not fetched/);
});
