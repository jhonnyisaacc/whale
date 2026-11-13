import assert from "node:assert/strict";
import test from "node:test";
import type { CommandDeps } from "../src/commands.js";
import { registerHostedRoutes } from "../src/executor-server/hosted.js";
import { buildApp } from "../src/http.js";
import { cachedNetworkCosts, networkCosts, type CostReaders } from "../src/network-costs.js";
import { x402Quote, type JudgePayment } from "../src/gateway/x402.js";

const GWEI = 1_000_000_000n;

function readers(overrides: Partial<CostReaders> = {}): CostReaders {
  return {
    evmGasPriceWei: async (key) => ({ base: GWEI / 100n, arbitrum: GWEI / 50n, ethereum: 20n * GWEI })[key] ?? null,
    solanaPriorityMicroLamports: async () => 1_000,
    nativeUsd: async () => new Map([["ETH", 3_000], ["SOL", 150]]),
    ...overrides,
  };
}

test("live costs rank Solana and the L2s under Ethereum, and fall back to the static ceiling when a read fails", async () => {
  const costs = await networkCosts(["ethereum", "base", "solana", "arbitrum", "polygon"], readers());
  assert.deepEqual(costs.map((cost) => cost.chainKey), ["solana", "base", "arbitrum", "polygon", "ethereum"]);
  const base = costs.find((cost) => cost.chainKey === "base");
  assert.ok(base && Math.abs(base.swapUsd - 0.0054) < 1e-9 && base.source === "live");
  assert.ok(Math.abs((costs.find((cost) => cost.chainKey === "ethereum")?.swapUsd ?? 0) - 10.8) < 1e-9);
  assert.equal(costs.find((cost) => cost.chainKey === "polygon")?.source, "static");
  const solana = costs[0];
  assert.ok(solana && Math.abs(solana.swapUsd - 0.00078) < 1e-12);
  const blind = await networkCosts(["base", "solana"], readers({ nativeUsd: async () => new Map(), solanaPriorityMicroLamports: async () => null }));
  assert.ok(blind.every((cost) => cost.source === "static"));
});

test("costs are cached for thirty seconds per chain set", async () => {
  let reads = 0;
  const counting = readers({ nativeUsd: async () => (reads++, new Map([["ETH", 3_000]])) });
  const start = Date.now() + 10_000_000;
  await cachedNetworkCosts(["base"], counting, start);
  await cachedNetworkCosts(["base"], counting, start + 29_000);
  assert.equal(reads, 1);
  await cachedNetworkCosts(["base"], counting, start + 31_000);
  assert.equal(reads, 2);
});

test("the executor answers a costs command on the hosted route without reaching run()", async () => {
  const app = await buildApp({ authTokens: ["executor-token-123456"], logger: false });
  const depsFor = async (): Promise<CommandDeps> => {
    throw new Error("costs reached run()");
  };
  registerHostedRoutes(app, { token: "h".repeat(40), depsFor, costReaders: readers() });
  try {
    const reply = await app.inject({
      method: "POST",
      url: "/hosted/commands",
      headers: { authorization: `Bearer ${"h".repeat(40)}` },
      payload: { accountId: "5d2b9e14-7c3a-4f61-b8e0-3a9c6d1f2e47", walletId: "8f0c1a52-3f0e-4c7e-9a0b-0d9c1f6a2b31", agentId: "1b6e7d3c-9a2f-4e18-8c55-2f7a9d0e4c6b", command: { kind: "costs", chainKeys: ["base", "dogechain"] } },
    });
    assert.equal(reply.statusCode, 400);
    const valid = await app.inject({
      method: "POST",
      url: "/hosted/commands",
      headers: { authorization: `Bearer ${"h".repeat(40)}` },
      payload: { accountId: "5d2b9e14-7c3a-4f61-b8e0-3a9c6d1f2e47", walletId: "8f0c1a52-3f0e-4c7e-9a0b-0d9c1f6a2b31", agentId: "1b6e7d3c-9a2f-4e18-8c55-2f7a9d0e4c6b", command: { kind: "costs", chainKeys: ["arbitrum", "solana"] } },
    });
    assert.deepEqual(valid.json().networks.map((cost: { chainKey: string }) => cost.chainKey), ["solana", "arbitrum"]);
  } finally {
    await app.close();
  }
});

const BASE_USDC = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";
const fits: JudgePayment = async () => ({ verdict: "fits", reasons: [] });

test("an x402 challenge becomes a plan: the cheapest option that fits, and nothing paid", async () => {
  const challenge = {
    x402Version: 1,
    accepts: [
      { scheme: "exact", network: "base", maxAmountRequired: "20000", asset: BASE_USDC, payTo: "0x2" },
      { scheme: "exact", network: "base-sepolia", maxAmountRequired: "1", asset: BASE_USDC, payTo: "0x3" },
      { scheme: "exact", network: "base", maxAmountRequired: "9000000", asset: BASE_USDC, payTo: "0x4" },
      { scheme: "upto", network: "base", maxAmountRequired: "1", asset: BASE_USDC, payTo: "0x5" },
    ],
  };
  const quote = await x402Quote("https://paid.example/data", fits, async () => ({ status: 402, body: JSON.stringify(challenge) }));
  assert.equal(quote.status, "plan");
  if (quote.status !== "plan") return;
  assert.equal(quote.paid, false);
  assert.deepEqual(quote.best && [quote.best.chain, quote.best.usd, quote.best.payTo], ["base", 0.02, "0x2"]);
  const reasons = quote.options.map((entry) => entry.reasons.join("; "));
  assert.match(reasons[1] ?? "", /not a supported mainnet/);
  assert.match(reasons[3] ?? "", /scheme upto/);
  assert.deepEqual(await x402Quote("https://free.example", fits, async () => ({ status: 200, body: "" })), { status: "no_payment_required", httpStatus: 200 });
  assert.equal((await x402Quote("https://odd.example", fits, async () => ({ status: 402, body: "pay me" }))).status, "unreadable");
  assert.equal((await x402Quote("https://down.example", fits, async () => Promise.reject(new Error("host resolves to a private address")))).status, "unreadable");
});

test("an x402 option that names no amount is refused, never planned as a free payment", async () => {
  const challenge = {
    x402Version: 1,
    accepts: [
      { scheme: "exact", network: "base", asset: BASE_USDC, payTo: "0x6" },
      { scheme: "exact", network: "base", amount: "0", asset: BASE_USDC, payTo: "0x7" },
      { scheme: "exact", network: "base", maxAmountRequired: "50000", asset: BASE_USDC, payTo: "0x8" },
    ],
  };
  const quote = await x402Quote("https://paid.example/data", fits, async () => ({ status: 402, body: JSON.stringify(challenge) }));
  assert.equal(quote.status, "plan");
  if (quote.status !== "plan") return;
  assert.deepEqual(quote.options.map((entry) => entry.verdict), ["refused", "refused", "fits"]);
  assert.match(quote.options[0]?.reasons.join("; ") ?? "", /names no amount/);
  assert.equal(quote.best?.payTo, "0x8");
});
