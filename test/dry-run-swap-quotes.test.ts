import assert from "node:assert/strict";
import test from "node:test";
import { resetProviderGuards } from "../src/aggregators.js";
import { parseCommand } from "../src/cli.js";
import { commandDeps } from "../src/command-callers.js";
import { run, type WalletCommand, type WalletResult } from "../src/commands.js";
import { callTool, type McpDeps } from "../src/mcp-server.js";

const NATIVE = `0x${"e".repeat(40)}`;
const DOLLAR = `0x${"b".repeat(40)}`;
const SOL_SELL = "1".repeat(32);
const SOL_BUY = "2".repeat(32);
const EXECUTOR = "http://127.0.0.1:1";
const MCP: McpDeps = { executorUrl: EXECUTOR, executorAuthToken: null };
const ENV = {
  ZEROX_API_KEY: "zeroex-key",
  ONEINCH_API_KEY: "oneinch-key",
  OKX_API_KEY: "okx-key",
  OKX_API_SECRET: "okx-secret",
  OKX_API_PASSPHRASE: "okx-passphrase",
  EXECUTOR_URL: EXECUTOR,
  QUOTE_TIMEOUT_MS: "200",
  QUOTE_DEADLINE_MS: "400",
};

type Answers = Partial<Record<"zeroex" | "kyberswap" | "oneinch" | "okx", string>> & { jupiter?: { outAmount: string; priceImpactPct: string } };

function answer(host: string, answers: Answers): Response {
  const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200 });
  if (host === "api.0x.org" && answers.zeroex) return json({ buyAmount: answers.zeroex, liquidityAvailable: true });
  if (host === "aggregator-api.kyberswap.com" && answers.kyberswap) return json({ data: { routeSummary: { amountOut: answers.kyberswap, routerAddress: `0x${"a".repeat(40)}` } } });
  if (host === "api.1inch.com" && answers.oneinch) return json({ dstAmount: answers.oneinch });
  if (host === "web3.okx.com" && answers.okx) return json({ code: "0", data: [{ toTokenAmount: answers.okx }] });
  if (host === "api.jup.ag" && answers.jupiter) return json(answers.jupiter);
  return new Response("{}", { status: 404 });
}

async function withStubs<T>(answers: Answers, body: (hits: string[]) => Promise<T>, extra: Record<string, string> = {}): Promise<T> {
  resetProviderGuards();
  const saved = { ...process.env };
  const env = { ...ENV, ...extra };
  Object.assign(process.env, env);
  const original = globalThis.fetch;
  const hits: string[] = [];
  globalThis.fetch = async (input) => {
    const url = new URL(String(input));
    hits.push(url.href);
    if (url.origin === EXECUTOR) throw new Error(`the dry run reached the executor at ${url.pathname}`);
    return answer(url.hostname, answers);
  };
  try {
    return await body(hits);
  } finally {
    globalThis.fetch = original;
    for (const key of Object.keys(env)) delete process.env[key];
    Object.assign(process.env, saved);
  }
}

const SIGNABLE_AND_LARGER_UNSIGNABLE: Answers = { zeroex: "3000000000", kyberswap: "3050000000", oneinch: "3300000000", okx: "3400000000" };

function cliSwap(sellChain: string, sell: string, buyChain: string, buy: string, slippageBps = "50"): WalletCommand {
  return parseCommand([
    "swap",
    "--sell-chain", sellChain, "--sell-address", sell, "--sell-symbol", "SELL",
    "--buy-chain", buyChain, "--buy-address", buy, "--buy-symbol", "BUY",
    "--sell-amount", "1000000000000000000", "--slippage-bps", slippageBps, "--idempotency-key", "i107-cli",
  ]);
}

async function runCli(command: WalletCommand): Promise<WalletResult> {
  return run(command, commandDeps(process.env, command));
}

type DryRunSwap = { kind: string; status?: string; reason?: string; quote?: { provider?: string; buyAmount: string; signable?: boolean; priceImpactPct?: number | null } | null };

const BASE_ASSET = { chain: { kind: "evm", chainId: 8453 }, chainKey: "base", symbol: "?", decimals: null } as const;
const MCP_SWAP = { idempotencyKey: "i107-mcp", sell: { ...BASE_ASSET, address: NATIVE }, buy: { ...BASE_ASSET, address: DOLLAR }, sellAmount: "1000000000000000000", slippageBps: 50 };

test("a CLI dry-run swap on Base returns would_swap with the largest signable route", async () => {
  const result = (await withStubs(SIGNABLE_AND_LARGER_UNSIGNABLE, () => runCli(cliSwap("base", NATIVE, "base", DOLLAR)))) as DryRunSwap;
  assert.equal(result.status, "would_swap", JSON.stringify(result));
  assert.equal(result.quote?.provider, "kyberswap");
  assert.equal(result.quote?.buyAmount, "3050000000");
  assert.equal(result.quote?.signable, true);
  assert.equal(result.quote?.priceImpactPct, null);
  assert.match(result.reason ?? "", /a live swap quotes again with a price check, so it can take another route or refuse\. nothing was signed/);
});

test("an MCP dry-run swap on Base returns would_swap with the largest signable route", async () => {
  const result = (await withStubs(SIGNABLE_AND_LARGER_UNSIGNABLE, () => callTool(MCP, "swap", MCP_SWAP))) as DryRunSwap;
  assert.equal(result.status, "would_swap", JSON.stringify(result));
  assert.equal(result.quote?.provider, "kyberswap");
  assert.equal(result.quote?.signable, true);
});

test("a dry-run swap with no signable route skips with no quote", async () => {
  const result = await withStubs({ oneinch: "3300000000", okx: "3400000000" }, () => callTool(MCP, "swap", MCP_SWAP));
  assert.deepEqual(result, { kind: "swap", status: "skipped", quote: null, reason: "no quote" });
});

test("a dry-run swap on a chain with no swap aggregator skips as unsupported", async () => {
  const result = await withStubs(SIGNABLE_AND_LARGER_UNSIGNABLE, () => runCli(cliSwap("hypercore", "USDC", "hypercore", "BTC")));
  assert.deepEqual(result, { kind: "swap", status: "skipped", quote: null, reason: "hypercore has no swap aggregator" });
});

test("a dry-run swap on a disabled chain skips as unsupported and does not quote", async () => {
  const result = await withStubs(SIGNABLE_AND_LARGER_UNSIGNABLE, async (hits) => {
    const value = await runCli(cliSwap("ethereum", NATIVE, "ethereum", DOLLAR));
    assert.deepEqual(hits, []);
    return value;
  });
  assert.deepEqual(result, { kind: "swap", status: "skipped", quote: null, reason: "chain ethereum is disabled" });
});

test("a dry-run swap across two chains skips and points at bridge", async () => {
  const result = await withStubs(SIGNABLE_AND_LARGER_UNSIGNABLE, () => runCli(cliSwap("base", NATIVE, "arbitrum", DOLLAR)));
  assert.deepEqual(result, { kind: "swap", status: "skipped", quote: null, reason: "a swap sells and buys on one chain. use bridge to move between base and arbitrum" });
});

test("a dry-run swap above the slippage cap skips with the cap", async () => {
  const result = await withStubs(SIGNABLE_AND_LARGER_UNSIGNABLE, () => runCli(cliSwap("base", NATIVE, "base", DOLLAR, "500")));
  assert.deepEqual(result, { kind: "swap", status: "skipped", quote: null, reason: "slippage exceeds 100 bps" });
});

test("a dry-run swap whose only route moves the price past the slippage skips, and one inside it would swap", async () => {
  const outside = await withStubs({ jupiter: { outAmount: "5000", priceImpactPct: "0.05" } }, () => runCli(cliSwap("solana", SOL_SELL, "solana", SOL_BUY)));
  assert.deepEqual(outside, { kind: "swap", status: "skipped", quote: null, reason: "no route inside the slippage cap" });
  const inside = (await withStubs({ jupiter: { outAmount: "5000", priceImpactPct: "0.001" } }, () => runCli(cliSwap("solana", SOL_SELL, "solana", SOL_BUY)))) as DryRunSwap;
  assert.equal(inside.status, "would_swap", JSON.stringify(inside));
  assert.equal(inside.quote?.provider, "jupiter");
});

test("a dry-run swap with WHALE_BROADCAST=true quotes, never reaches the executor, and wires no execute", async () => {
  await withStubs(
    SIGNABLE_AND_LARGER_UNSIGNABLE,
    async (hits) => {
      const command = cliSwap("base", NATIVE, "base", DOLLAR);
      assert.equal(commandDeps(process.env, command).execute, undefined);
      const cli = (await runCli(command)) as DryRunSwap;
      const mcp = (await callTool(MCP, "swap", { ...MCP_SWAP, mode: "live", notionalUsd: 5 })) as DryRunSwap;
      assert.equal(cli.status, "would_swap", JSON.stringify(cli));
      assert.equal(mcp.status, "would_swap", JSON.stringify(mcp));
      assert.ok(hits.length > 0, "the dry run quoted aggregators");
      assert.deepEqual(hits.filter((href) => href.startsWith(EXECUTOR)), []);
    },
    { WHALE_BROADCAST: "true" },
  );
});

test("run never calls execute for a dry-run swap, even when one is passed", async () => {
  let executed = 0;
  const result = (await withStubs(SIGNABLE_AND_LARGER_UNSIGNABLE, () => {
    const command = cliSwap("base", NATIVE, "base", DOLLAR);
    return run(command, {
      ...commandDeps(process.env, command),
      execute: async () => {
        executed += 1;
        throw new Error("a dry run reached execute");
      },
    });
  }, { WHALE_BROADCAST: "true" })) as DryRunSwap;
  assert.equal(executed, 0);
  assert.equal(result.status, "would_swap", JSON.stringify(result));
  assert.equal(result.quote?.provider, "kyberswap");
});

test("MCP arguments cannot turn any tool into a live swap, even with WHALE_BROADCAST=true", async () => {
  const forged = { ...MCP_SWAP, kind: "swap", mode: "live", notionalUsd: 5, chainKey: "base", address: NATIVE, asset: MCP_SWAP.sell, to: DOLLAR, amount: "1" };
  await withStubs(
    SIGNABLE_AND_LARGER_UNSIGNABLE,
    async (hits) => {
      for (const name of ["quote", "balance", "transfer", "swap"]) {
        const result = (await callTool(MCP, name, forged).catch((error: unknown) => ({ error: String(error) }))) as { kind?: string; report?: unknown };
        assert.notEqual("report" in result ? result.kind : null, "swap", `${name} returned a live swap report: ${JSON.stringify(result)}`);
      }
      assert.deepEqual(hits.filter((href) => href.startsWith(EXECUTOR)), []);
    },
    { WHALE_BROADCAST: "true" },
  );
});

test("a dry-run swap keeps the live execution reserve out of its slippage", async () => {
  const result = await withStubs({ jupiter: { outAmount: "5000", priceImpactPct: "0.004" } }, () => runCli(cliSwap("solana", SOL_SELL, "solana", SOL_BUY)));
  assert.deepEqual(result, { kind: "swap", status: "skipped", quote: null, reason: "no route inside the slippage cap" });
});

test("a dry-run swap whose quote has an unknown impact still refuses an unsignable or negative-fee route", async () => {
  const swapLimits = { enabledChainKeys: new Set(["base"]), maxSlippageBps: 100, executionReserveBps: 0 };
  const unknown = { planId: "p", kind: "aggregator" as const, hops: ["SELL->BUY"], priceImpactPct: null, feeUsd: 0, buyAmount: "5000" };
  const command = cliSwap("base", NATIVE, "base", DOLLAR);
  for (const quote of [{ ...unknown, signable: false }, { ...unknown, feeUsd: -1 }]) {
    const result = await run(command, { swapLimits, quote: async () => quote });
    assert.deepEqual(result, { kind: "swap", status: "skipped", quote: null, reason: "no signable route" });
  }
  const kept = (await run(command, { swapLimits, quote: async () => ({ ...unknown, signable: true }) })) as DryRunSwap;
  assert.equal(kept.status, "would_swap", JSON.stringify(kept));
  assert.equal(kept.quote?.priceImpactPct, null);
});
