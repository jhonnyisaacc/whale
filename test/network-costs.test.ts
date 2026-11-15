import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import test from "node:test";
import type { CommandDeps } from "../src/commands.js";
import { registerHostedRoutes } from "../src/executor-server/hosted.js";
import { buildApp } from "../src/http.js";
import { cachedNetworkCosts, envCostReaders, networkCosts, type CostReaders } from "../src/network-costs.js";
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

test("a gas price or native price of zero is unreadable, so that chain falls back instead of ranking free", async () => {
  const costs = await networkCosts(["base", "arbitrum", "solana"], readers({ evmGasPriceWei: async (key) => (key === "base" ? 0n : GWEI / 50n), nativeUsd: async () => new Map([["ETH", 3_000], ["SOL", 0]]) }));
  assert.equal(costs.find((cost) => cost.chainKey === "base")?.source, "static");
  assert.equal(costs.find((cost) => cost.chainKey === "solana")?.source, "static");
  assert.equal(costs.find((cost) => cost.chainKey === "arbitrum")?.source, "live");
  assert.ok(costs.every((cost) => cost.swapUsd > 0));
});

test("a price feed that answers 200 with a body that is not JSON falls back to the static ceiling", async () => {
  const html: typeof fetch = async () => new Response("<html>rate limited</html>", { status: 200, headers: { "content-type": "text/html" } });
  const costs = await networkCosts(["base"], { ...envCostReaders({}, html), evmGasPriceWei: async () => GWEI / 100n });
  assert.deepEqual(costs.map((cost) => [cost.chainKey, cost.source]), [["base", "static"]]);
});

test("live gas reads use the RPC_URLS_<id> list, falling through to the next URL when one fails", async () => {
  const server = createServer((request, response) => {
    let raw = "";
    request.on("data", (chunk: Buffer) => (raw += chunk.toString()));
    request.on("end", () => {
      if (request.url === "/down") return response.writeHead(500).end();
      const body = JSON.parse(raw) as { id: number };
      response.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ jsonrpc: "2.0", id: body.id, result: "0x3b9aca00" }));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  try {
    const live = envCostReaders({ RPC_URLS_8453: `http://127.0.0.1:${port}/down,http://127.0.0.1:${port}/up` });
    assert.equal(await live.evmGasPriceWei("base"), GWEI);
  } finally {
    server.close();
  }
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

test("concurrent callers share one read, and two chain sets keep their own cache entries", async () => {
  let reads = 0;
  const counting = readers({ nativeUsd: async () => (reads++, await new Promise((resolve) => setTimeout(resolve, 20)), new Map([["ETH", 3_000]])) });
  const start = Date.now() + 20_000_000;
  await Promise.all([cachedNetworkCosts(["optimism"], counting, start), cachedNetworkCosts(["optimism"], counting, start)]);
  assert.equal(reads, 1);
  await cachedNetworkCosts(["polygon"], counting, start + 1_000);
  await cachedNetworkCosts(["optimism"], counting, start + 2_000);
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
    const perp = await app.inject({
      method: "POST",
      url: "/hosted/commands",
      headers: { authorization: `Bearer ${"h".repeat(40)}` },
      payload: { accountId: "5d2b9e14-7c3a-4f61-b8e0-3a9c6d1f2e47", walletId: "8f0c1a52-3f0e-4c7e-9a0b-0d9c1f6a2b31", agentId: "1b6e7d3c-9a2f-4e18-8c55-2f7a9d0e4c6b", command: { kind: "costs", chainKeys: ["base", "hypercore"] } },
    });
    assert.deepEqual(perp.json().networks.map((cost: { chainKey: string }) => cost.chainKey), ["base"]);
    assert.equal(perp.json().skipped[0].chainKey, "hypercore");
    assert.match(perp.json().skipped[0].reason, /not gas/);
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
  const quote = await x402Quote("https://paid.example/data", fits, async () => ({ status: 402, body: JSON.stringify(challenge), truncated: false }));
  assert.equal(quote.status, "plan");
  if (quote.status !== "plan") return;
  assert.equal(quote.paid, false);
  assert.deepEqual(quote.best && [quote.best.chain, quote.best.usd, quote.best.payTo], ["base", 0.02, "0x2"]);
  const reasons = quote.options.map((entry) => entry.reasons.join("; "));
  assert.match(reasons[1] ?? "", /not a supported mainnet/);
  assert.match(reasons[3] ?? "", /scheme upto/);
  assert.deepEqual(await x402Quote("https://free.example", fits, async () => ({ status: 200, body: "", truncated: false })), { status: "no_payment_required", httpStatus: 200 });
  assert.equal((await x402Quote("https://odd.example", fits, async () => ({ status: 402, body: "pay me", truncated: false }))).status, "unreadable");
  assert.equal((await x402Quote("https://down.example", fits, async () => Promise.reject(new Error("host resolves to a private address")))).status, "unreadable");
});

test("an x402 option cannot impersonate a Solana stablecoin by changing address case", async () => {
  const canonical = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
  const impersonator = canonical.replace("EPj", "Epj");
  let judged = false;
  const quote = await x402Quote(
    "https://paid.example/data",
    async () => {
      judged = true;
      return { verdict: "fits", reasons: [] };
    },
    async () => ({ status: 402, body: JSON.stringify({ x402Version: 1, accepts: [{ scheme: "exact", network: "solana", maxAmountRequired: "1000000", asset: impersonator, payTo: "SomeDestination11111111111111111111111111111" }] }), truncated: false }),
  );
  assert.equal(quote.status, "plan");
  if (quote.status !== "plan") return;
  assert.equal(quote.options[0]?.verdict, "refused");
  assert.match(quote.options[0]?.reasons.join("; ") ?? "", /not a known stablecoin/);
  assert.equal(quote.options[0]?.symbol, null);
  assert.equal(judged, false);
  assert.notEqual(canonical, impersonator);
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
  const quote = await x402Quote("https://paid.example/data", fits, async () => ({ status: 402, body: JSON.stringify(challenge), truncated: false }));
  assert.equal(quote.status, "plan");
  if (quote.status !== "plan") return;
  assert.deepEqual(quote.options.map((entry) => entry.verdict), ["refused", "refused", "fits"]);
  assert.match(quote.options[0]?.reasons.join("; ") ?? "", /names no amount/);
  assert.equal(quote.best?.payTo, "0x8");
});

test("an x402 challenge cut short at the size cap is unreadable, not parsed", async () => {
  const quote = await x402Quote("https://paid.example/data", fits, async () => ({ status: 402, body: JSON.stringify({ x402Version: 1, accepts: [{ scheme: "exact", network: "base", maxAmountRequired: "1000", asset: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913", payTo: "0x000000000000000000000000000000000000dEaD" }] }), truncated: true }));
  assert.equal(quote.status, "unreadable");
});
