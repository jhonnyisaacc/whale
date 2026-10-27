import assert from "node:assert/strict";
import test from "node:test";
import { parseCommand } from "../src/cli.js";
import { commandDeps, readAddressBalance } from "../src/command-callers.js";
import { run, type Asset } from "../src/commands.js";
import type { ExecutionReport, RouteQuote, SwapIntent } from "../src/domain.js";
import { intentSchema } from "../src/schemas.js";

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

const swapArgs = ["swap", "--sell-chain", "base", "--sell-address", sell.address, "--sell-symbol", "USDC", "--sell-decimals", "6", "--buy-chain", "base", "--buy-address", buy.address, "--buy-symbol", "WETH", "--buy-decimals", "18", "--sell-amount", "1000000", "--slippage-bps", "50", "--idempotency-key", "s1"];

test("a dry-run swap says nothing was broadcast and does not call execute", async () => {
  let called = 0;
  const result = await run(
    { kind: "swap", idempotencyKey: "s1", sell, buy, sellAmount: "1000000", slippageBps: 50, mode: "dry_run" },
    {
      execute: async () => {
        called += 1;
        throw new Error("execute");
      },
    },
  );
  assert.equal(called, 0);
  assert.equal(result.kind, "swap");
  if (result.kind !== "swap") return;
  assert.equal(result.report.decision, "skipped");
  assert.equal(result.report.mode, "dry_run");
  assert.match(result.report.reason, /nothing was broadcast/);
  assert.equal(result.report.txs, undefined);
});

test("a live swap calls execute once with a positive notional and the stub does not send", async () => {
  let called = 0;
  const result = await run(
    { kind: "swap", idempotencyKey: "s-live", sell, buy, sellAmount: "1000000", slippageBps: 50, mode: "live", notionalUsd: 1 },
    {
      execute: async (intent: SwapIntent) => {
        called += 1;
        assert.equal(intent.notionalUsd > 0, true);
        assert.equal(intentSchema.safeParse(intent).success, true);
        const report: ExecutionReport = {
          idempotencyKey: intent.idempotencyKey,
          mode: "live",
          decision: "skipped",
          reason: "stub",
          venue: "base",
          route: null,
          latency: { alertReceivedMs: 1 },
        };
        return report;
      },
    },
  );
  assert.equal(called, 1);
  assert.equal(result.kind, "swap");
  if (result.kind === "swap") assert.equal(result.report.reason, "stub");
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

test("swap stays dry-run unless --live carries a positive notional", () => {
  const dry = parseCommand(swapArgs);
  assert.equal(dry.kind, "swap");
  if (dry.kind === "swap") assert.equal(dry.mode, "dry_run");
  const live = parseCommand([...swapArgs, "--live", "--notional-usd", "1"]);
  assert.equal(live.kind, "swap");
  if (live.kind === "swap" && live.mode === "live") assert.equal(live.notionalUsd, 1);
  assert.throws(() => parseCommand([...swapArgs, "--live"]), /--notional-usd must be a positive number/);
  assert.throws(() => parseCommand([...swapArgs, "--live", "--notional-usd", "0"]), /--notional-usd must be a positive number/);
  const transfer = parseCommand(["transfer", "--idempotency-key", "t1", "--to", "0xabc", "--amount", "1", "--asset-chain", "base", "--asset-address", sell.address, "--asset-symbol", "USDC", "--asset-decimals", "6", "--live"]);
  assert.equal(transfer.kind, "transfer");
  if (transfer.kind === "transfer") assert.equal(transfer.mode, "dry_run");
});

test("a quote with no provider key stays unwired and a missing rpc url names that variable", async () => {
  const quoteCommand = parseCommand(["quote", "--sell-chain", "base", "--sell-address", sell.address, "--sell-symbol", "USDC", "--sell-decimals", "6", "--buy-chain", "base", "--buy-address", buy.address, "--buy-symbol", "WETH", "--buy-decimals", "18", "--sell-amount", "1000000", "--slippage-bps", "50"]);
  assert.equal(commandDeps({}, quoteCommand).quote, undefined);
  const read = await readAddressBalance({}, "base", sell.address);
  assert.deepEqual(read.holdings, []);
  assert.match(read.reason ?? "", /RPC_URL_8453/);
  const result = await run({ kind: "balance", chainKey: "base", address: sell.address }, { readBalance: async () => read });
  assert.equal(result.kind, "balance");
  if (result.kind === "balance") {
    assert.deepEqual(result.holdings, []);
    assert.match(result.reason ?? "", /RPC_URL_8453/);
  }
});
