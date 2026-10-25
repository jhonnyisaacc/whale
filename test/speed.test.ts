import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import test from "node:test";
import { keccak256, toHex, type Hex } from "viem";
import { firmZeroEx, guardFor, jupiterSwap, providersFor, raceProviderQuotes, resetProviderGuards } from "../src/aggregators.js";
import { allowanceCovers, rememberApproval, resetApprovals } from "../src/approvals.js";
import { createBalanceCache } from "../src/balances.js";
import { broadcastRoute, rememberIfFunded, type EvmReceipt, type EvmRpc, type SendIo } from "../src/broadcast.js";
import { assertLiveEdges, configSecrets, loadConfig, type AppConfig } from "../src/config.js";
import type { Holding, RouteLeg, SwapIntent } from "../src/domain.js";
import { BroadcastError, execute, resetExecutorState, type ExecutorDeps } from "../src/executor.js";
import type { EvmSignInput, TransactionSigner } from "../src/managed-signer.js";
import { createNonceManager } from "../src/nonce.js";
import { buildPairMap } from "../src/pairs.js";
import { retryAfterAt } from "../src/provider-guard.js";
import { evmReadClient } from "../src/rpc.js";
import { screenToken } from "../src/screening.js";
import { SETTLERS, kyberData, tagOf, zeroExData } from "./fixtures.js";

const USDC = "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const WETH = "0xcccccccccccccccccccccccccccccccccccccccc";
const TOKEN = "0xdddddddddddddddddddddddddddddddddddddddd";
const ROUTER = "0x1111111111111111111111111111111111111111";
const OWNER = "0x2222222222222222222222222222222222222222";
const LIFI_SPENDER = "0x4444444444444444444444444444444444444444";
const base = { kind: "evm" as const, chainId: 8453 };

function hang(init: RequestInit | undefined): Promise<Response> {
  return new Promise((_, reject) => init?.signal?.addEventListener("abort", () => reject(new Error("aborted"))));
}

function json(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), { status, headers });
}

function byHost(seen: URL[], routes: Record<string, (url: URL, init: RequestInit | undefined) => Promise<Response> | Response>): typeof fetch {
  return async (input, init) => {
    const url = new URL(String(input));
    seen.push(url);
    const route = routes[url.hostname];
    return route ? route(url, init) : json({}, 404);
  };
}

const hop = { sellAddress: USDC, buyAddress: TOKEN, sellAmount: "5000000", chain: base };
const reference = { spentUsd: 5, priceUsd: 0.5, decimals: 6 };

test("the LI.FI race quote carries the wallet as fromAddress and is skipped without one", async () => {
  resetProviderGuards();
  const config = loadConfig({});
  const seen: URL[] = [];
  const fetchImpl = byHost(seen, {});
  await raceProviderQuotes(config, { ...hop, taker: OWNER }, reference, fetchImpl);
  const lifi = seen.find((url) => url.hostname === "li.quest");
  assert.equal(lifi?.searchParams.get("fromAddress"), OWNER);
  seen.length = 0;
  await raceProviderQuotes(config, hop, reference, fetchImpl);
  assert.equal(seen.some((url) => url.hostname === "li.quest"), false);
});

test("0x is not queried without an API key and 1inch is not queried on HyperEVM or Robinhood", async () => {
  resetProviderGuards();
  const keyless = loadConfig({ ONEINCH_API_KEY: "oneinch-key" });
  assert.equal(providersFor(base, keyless).includes("zeroex"), false);
  const seen: URL[] = [];
  await raceProviderQuotes(keyless, hop, reference, byHost(seen, {}));
  assert.equal(seen.some((url) => url.hostname === "api.0x.org"), false);
  assert.equal(seen.some((url) => url.hostname === "api.1inch.com"), true);
  assert.equal(providersFor({ kind: "evm", chainId: 999 }, keyless).includes("oneinch"), false);
  assert.equal(providersFor({ kind: "evm", chainId: 4663 }, keyless).includes("oneinch"), false);
  assert.equal(providersFor(base, loadConfig({ ZEROX_API_KEY: "zeroex-key" })).includes("zeroex"), true);
});

test("Velora asks for version 6.2 with both decimals and the partner, and is skipped when decimals are unknown", async () => {
  resetProviderGuards();
  const config = loadConfig({ VELORA_PARTNER: "rocket" });
  const seen: URL[] = [];
  await raceProviderQuotes(config, { ...hop, sellDecimals: 6 }, { ...reference, decimals: 18 }, byHost(seen, {}));
  const velora = seen.find((url) => url.hostname === "api.velora.xyz");
  assert.equal(velora?.searchParams.get("version"), "6.2");
  assert.equal(velora?.searchParams.get("srcDecimals"), "6");
  assert.equal(velora?.searchParams.get("destDecimals"), "18");
  assert.equal(velora?.searchParams.get("partner"), "rocket");
  seen.length = 0;
  await raceProviderQuotes(config, hop, reference, byHost(seen, {}));
  assert.equal(seen.some((url) => url.hostname === "api.velora.xyz"), false);
});

test("the race closes after the first signable quote plus grace and does not wait for slow unsigned providers", async () => {
  resetProviderGuards();
  const config = loadConfig({ ZEROX_API_KEY: "zeroex-key", ONEINCH_API_KEY: "oneinch-key", QUOTE_TIMEOUT_MS: "3000", QUOTE_DEADLINE_MS: "3000", RACE_GRACE_MS: "20" });
  const started = Date.now();
  const quote = await raceProviderQuotes(
    config,
    { ...hop, sellDecimals: 6 },
    reference,
    byHost([], {
      "api.0x.org": () => json({ liquidityAvailable: true, buyAmount: "9990000" }),
      "api.1inch.com": (_url, init) => hang(init),
      "api.velora.xyz": (_url, init) => hang(init),
      "aggregator-api.kyberswap.com": () => json({}, 500),
    }),
  );
  assert.equal(quote.provider, "zeroex");
  assert.ok(Date.now() - started < 1_000, `race took ${Date.now() - started}ms`);
});

test("a firm call times out and counts as a provider failure", async () => {
  resetProviderGuards();
  const config = loadConfig({ ZEROX_API_KEY: "zeroex-key", FIRM_TIMEOUT_MS: "20", PROVIDER_FAILURE_THRESHOLD: "1" });
  const started = Date.now();
  const quote = await firmZeroEx(config, hop, 8453, OWNER, reference, async (_input, init) => hang(init), 100);
  assert.equal(quote.priceImpactPct, null);
  assert.ok(Date.now() - started < 1_000);
  assert.equal(guardFor(config).before("zeroex"), "open");
});

test("a 429 with Retry-After opens that provider until the given time", async () => {
  resetProviderGuards();
  let clock = 1_000_000;
  const config: AppConfig = { ...loadConfig({}), now: () => clock };
  let calls = 0;
  const fetchImpl: typeof fetch = async () => {
    calls += 1;
    return json({ error: "slow down" }, 429, { "retry-after": "120" });
  };
  const solana = { sellAddress: "in", buyAddress: "out", sellAmount: "1000", chain: { kind: "solana" as const } };
  await raceProviderQuotes(config, solana, null, fetchImpl);
  assert.equal(calls, 1);
  clock += 60_000;
  await raceProviderQuotes(config, solana, null, fetchImpl);
  assert.equal(calls, 1);
  clock += 61_000;
  await raceProviderQuotes(config, solana, null, fetchImpl);
  assert.equal(calls, 2);
  const date = new Date(clock + 30_000).toUTCString();
  const at = retryAfterAt(date, clock);
  assert.ok(at !== null && at > clock && at <= clock + 30_000);
  assert.equal(retryAfterAt("soon", clock), null);
});

test("the Jupiter swap body asks for a capped veryHigh priority fee, or a Jito tip when Jito is on", async () => {
  resetProviderGuards();
  const bodies: Array<Record<string, unknown>> = [];
  const fetchImpl: typeof fetch = async (_input, init) => {
    bodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
    return json({ swapTransaction: "AAAA", lastValidBlockHeight: 10 });
  };
  const built = await jupiterSwap(loadConfig({}), { outAmount: "1" }, "owner", fetchImpl);
  assert.equal(built?.lastValidBlockHeight, 10);
  assert.deepEqual(bodies[0]?.prioritizationFeeLamports, { priorityLevelWithMaxLamports: { maxLamports: 1_000_000, priorityLevel: "veryHigh" } });
  await jupiterSwap(loadConfig({ JITO_ENABLED: "true" }), { outAmount: "1" }, "owner", fetchImpl);
  assert.deepEqual(bodies[1]?.prioritizationFeeLamports, { jitoTipLamports: 10_000 });
  assert.throws(() => loadConfig({ JITO_TIP_LAMPORTS: "999" }), /at least 1000/);
  assert.throws(() => loadConfig({ JITO_TIP_LAMPORTS: "5000", SOLANA_MAX_PRIORITY_LAMPORTS: "4000" }), /exceeds SOLANA_MAX_PRIORITY_LAMPORTS/);
});

test("live boot requires a 0x key, a unique Kyber client id, and https on every RPC in a list", () => {
  const live = { LISTING_TRADER_LIVE: "true", ZEROX_API_KEY: "zeroex-key", ZEROX_SETTLER_ALLOWLIST_JSON: SETTLERS, KYBERSWAP_CLIENT_ID: "rocket-trader" };
  assert.doesNotThrow(() => assertLiveEdges(loadConfig(live), {}));
  assert.throws(() => assertLiveEdges(loadConfig({ ...live, ZEROX_API_KEY: "" }), {}), /ZEROX_API_KEY/);
  assert.throws(() => assertLiveEdges(loadConfig({ ...live, ZEROX_SETTLER_ALLOWLIST_JSON: "" }), {}), /ZEROX_SETTLER_ALLOWLIST_JSON/);
  assert.throws(() => loadConfig({ ...live, ZEROX_SETTLER_ALLOWLIST_JSON: JSON.stringify({ "8453": ["settler"] }) }), /ZEROX_SETTLER_ALLOWLIST_JSON is invalid/);
  assert.throws(() => assertLiveEdges(loadConfig({ ...live, KYBERSWAP_CLIENT_ID: "" }), {}), /KYBERSWAP_CLIENT_ID/);
  assert.throws(() => assertLiveEdges(loadConfig({ ...live, RPC_URLS_8453: "https://one.example,http://two.example" }), {}), /live RPC URLs/);
  const listed = loadConfig({ RPC_URL_8453: "https://one.example/k1", RPC_URLS_8453: "https://two.example/k2, https://one.example/k1" });
  assert.deepEqual(listed.rpcUrlsByChainKey.base, ["https://one.example/k1", "https://two.example/k2"]);
  assert.equal(listed.rpcByChainKey.base, "https://one.example/k1");
  assert.ok(configSecrets(listed).some((secret) => secret === "https://two.example/k2"));
});

test("screening verdicts are cached per contract, denials included, but an outage is not", async () => {
  let clock = 0;
  const config: AppConfig = { ...loadConfig({ TOKEN_SCREENING: "true", MAX_TOKEN_TAX: "0.1" }), now: () => clock };
  let calls = 0;
  const reply = (row: Record<string, string> | null, status = 200): typeof fetch =>
    async () => {
      calls += 1;
      return json(row ? { code: 1, result: { [TOKEN]: row } } : {}, status);
    };
  const token = { chainKey: "base", chain: base, contract: TOKEN };
  const clean = { is_honeypot: "0", cannot_sell_all: "0", buy_tax: "0", sell_tax: "0" };
  assert.equal(await screenToken(config, token, reply(clean)), "allow");
  assert.equal(await screenToken(config, token, reply(clean)), "allow");
  assert.equal(calls, 1);
  clock += 11 * 60 * 1000;
  const honeypot = { ...token, contract: WETH };
  const denyRow: typeof fetch = async () => {
    calls += 1;
    return json({ code: 1, result: { [WETH]: { ...clean, is_honeypot: "1" } } });
  };
  assert.equal(await screenToken(config, honeypot, denyRow), "deny");
  assert.equal(await screenToken(config, honeypot, denyRow), "deny");
  assert.equal(calls, 2);
  const outage = { ...token, contract: USDC };
  assert.equal(await screenToken(config, outage, reply(null, 503)), "deny");
  assert.equal(await screenToken(config, outage, reply(null, 503)), "deny");
  assert.equal(calls, 4);
  assert.equal(await screenToken(config, token, reply(clean)), "allow");
  assert.equal(calls, 5);
});

test("balance reads are cached briefly and a send from that chain drops the cache", async () => {
  let clock = 0;
  let reads = 0;
  const cache = createBalanceCache(async () => {
    reads += 1;
    return 20;
  }, 3_000, () => clock);
  const usdc: Holding = { symbol: "USDC", address: USDC, amount: 0, usd: 0, native: false, decimals: 6, chainKey: "base" };
  await cache.read(usdc);
  await cache.read(usdc);
  assert.equal(reads, 1);
  cache.invalidate("ethereum");
  await cache.read(usdc);
  assert.equal(reads, 1);
  cache.invalidate("base");
  await cache.read(usdc);
  assert.equal(reads, 2);
  clock += 3_000;
  await cache.read(usdc);
  assert.equal(reads, 3);
});

function rpcServer(handler: (body: { id: number; method: string }) => { status: number; body: unknown }): Promise<{ server: Server; url: string; hits: () => number }> {
  let hits = 0;
  const server = createServer((request, response) => {
    let raw = "";
    request.on("data", (chunk) => (raw += String(chunk)));
    request.on("end", () => {
      hits += 1;
      const reply = handler(JSON.parse(raw) as { id: number; method: string });
      response.writeHead(reply.status, { "content-type": "application/json" });
      response.end(JSON.stringify(reply.body));
    });
  });
  return new Promise((resolve) =>
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : 0;
      resolve({ server, url: `http://127.0.0.1:${port}`, hits: () => hits });
    }),
  );
}

test("an EVM read falls back to the second RPC when the first fails", async () => {
  const bad = await rpcServer(() => ({ status: 500, body: { error: "down" } }));
  const good = await rpcServer((body) => ({ status: 200, body: { jsonrpc: "2.0", id: body.id, result: "0x2105" } }));
  try {
    assert.equal(await evmReadClient([bad.url, good.url]).getChainId(), 8453);
    assert.ok(bad.hits() >= 1);
    assert.ok(good.hits() >= 1);
  } finally {
    bad.server.close();
    good.server.close();
  }
});

type Chain = { rpc: EvmRpc; sent: Hex[] };

function fakeChain(failSend = false): Chain {
  const receipts = new Map<string, EvmReceipt>();
  const chain: Chain = {
    sent: [],
    rpc: {
      fees: async () => ({ maxFeePerGas: 1_000n, maxPriorityFeePerGas: 100n }),
      pendingNonce: async () => 1,
      confirmedNonce: async () => 1,
      estimateGas: async () => 21_000n,
      simulate: async () => undefined,
      sendRaw: async (signed) => {
        if (failSend) throw new Error("connection refused");
        chain.sent.push(signed);
        receipts.set(keccak256(signed), { status: "success", gasUsed: 21_000n, effectiveGasPrice: 1n });
      },
      receipt: async (hash) => receipts.get(hash) ?? null,
      seen: async (hash) => receipts.has(hash),
      balance: async () => 10n ** 20n,
    },
  };
  return chain;
}

function io(route: (rpcs: readonly string[]) => EvmRpc): SendIo {
  let clock = 0;
  return {
    evm: (_chainId, rpcs) => route(rpcs),
    solana: () => {
      throw new Error("no solana rpc");
    },
    nonces: createNonceManager(),
    sleep: async (ms) => {
      clock += ms;
    },
    now: () => clock,
    confirmTimeoutMs: 1_000,
    pollMs: 100,
  };
}

function signer(signed: EvmSignInput[]): TransactionSigner {
  return {
    backend: "keystore",
    evmAddress: () => OWNER,
    solanaAddress: () => null,
    async signEvm(input) {
      signed.push(input);
      return toHex(`${signed.length}:${input.data}`);
    },
    async signSolana() {
      throw new Error("solana is not loaded");
    },
    async signHyperliquid() {
      return { r: "0x01", s: "0x02", v: 27 };
    },
  };
}

const zeroExBody = (data: Hex, minBuyAmount = "9950000", issues: unknown = { allowance: { spender: ROUTER, actual: "0" } }) => ({
  liquidityAvailable: true,
  buyAmount: "10000000",
  minBuyAmount,
  issues,
  transaction: { to: ROUTER, data: zeroExData(data, { recipient: OWNER, buyToken: TOKEN, minOut: BigInt(minBuyAmount) }, { token: USDC, amount: 5_000_000n }), value: "0", gas: "100000" },
});

const request = (legs: RouteLeg[], provider = "zeroex") => ({ kind: "evm" as const, description: "swap", chain: base, hyperliquidActions: [], provider, legs });

function storedLeg(provider: string, raw: unknown, quotedAtMs: number): RouteLeg {
  return {
    sellAddress: USDC,
    buyAddress: TOKEN,
    sellAmount: "5000000",
    spentUsd: 5,
    priceUsd: 0.5,
    decimals: 6,
    impactPct: 0,
    quote: { provider, raw, quotedAtMs, sellAmount: "5000000", taker: OWNER },
  };
}

test("a fresh race quote is signed without a re-quote, and a stale or too-loose one is re-quoted", async () => {
  resetProviderGuards();
  resetApprovals();
  rememberApproval({ chainId: 8453, token: USDC, spender: ROUTER, owner: OWNER }, 10n ** 30n);
  let clock = 10_000;
  const config: AppConfig = { ...loadConfig({ RPC_URL_8453: "http://fake.invalid", ZEROX_API_KEY: "zeroex-key" }), now: () => clock };
  const firm: URL[] = [];
  const fetchImpl = byHost(firm, { "api.0x.org": () => json(zeroExBody("0x06")) });
  const chain = fakeChain();
  const signed: EvmSignInput[] = [];
  const fresh = await broadcastRoute(config, signer(signed), request([storedLeg("zeroex", zeroExBody("0x05"), 9_000)]), 1, fetchImpl, [], { io: io(() => chain.rpc) });
  assert.equal(fresh.venue === "chain" && fresh.outcome, "landed");
  assert.equal(firm.length, 0);
  assert.equal(tagOf(signed[0]?.data), "0x05");
  clock = 11_500;
  await broadcastRoute(config, signer(signed), request([storedLeg("zeroex", zeroExBody("0x05"), 9_000)]), 1, fetchImpl, [], { io: io(() => chain.rpc) });
  assert.equal(firm.length, 1);
  assert.equal(tagOf(signed[1]?.data), "0x06");
  clock = 9_500;
  await broadcastRoute(config, signer(signed), request([storedLeg("zeroex", zeroExBody("0x05", "9000000"), 9_000)]), 1, fetchImpl, [], { io: io(() => chain.rpc) });
  assert.equal(firm.length, 2);
  assert.equal(tagOf(signed[2]?.data), "0x06");
});

test("a fresh Kyber route summary goes straight to the build call", async () => {
  resetProviderGuards();
  resetApprovals();
  rememberApproval({ chainId: 8453, token: USDC, spender: ROUTER, owner: OWNER }, 10n ** 30n);
  const config: AppConfig = { ...loadConfig({ RPC_URL_8453: "http://fake.invalid" }), now: () => 1_000 };
  const seen: URL[] = [];
  const builds: Array<Record<string, unknown>> = [];
  const fetchImpl = byHost(seen, {
    "aggregator-api.kyberswap.com": (url, init) => {
      if (!url.pathname.endsWith("/route/build")) return json({}, 500);
      builds.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
      return json({ data: { data: kyberData("0x07", { recipient: OWNER, buyToken: TOKEN, minOut: 9_950_000n }), routerAddress: ROUTER, amountOut: "10000000" } });
    },
  });
  const routes = { data: { routeSummary: { amountOut: "10000000", routerAddress: ROUTER } } };
  const signed: EvmSignInput[] = [];
  const chain = fakeChain();
  await broadcastRoute(config, signer(signed), request([storedLeg("kyberswap", routes, 900)], "kyberswap"), 1, fetchImpl, [], { io: io(() => chain.rpc) });
  assert.deepEqual(
    seen.map((url) => url.pathname),
    ["/base/api/v1/route/build"],
  );
  assert.deepEqual(builds[0]?.routeSummary, routes.data.routeSummary);
  assert.equal(tagOf(signed[0]?.data), "0x07");
});

test("a Kyber build that pays someone else or lowers the minimum is refused before signing", async () => {
  const config: AppConfig = { ...loadConfig({ RPC_URL_8453: "http://fake.invalid" }), now: () => 1_000 };
  const routes = { data: { routeSummary: { amountOut: "10000000", routerAddress: ROUTER } } };
  const cases = [
    { terms: { recipient: "0x9999999999999999999999999999999999999999", buyToken: TOKEN, minOut: 9_950_000n }, error: /recipient is not the hot wallet/ },
    { terms: { recipient: OWNER, buyToken: TOKEN, minOut: 1n }, error: /below ours/ },
    { terms: { recipient: OWNER, buyToken: WETH, minOut: 9_950_000n }, error: /buys a different token/ },
  ];
  for (const { terms, error } of cases) {
    resetProviderGuards();
    resetApprovals();
    rememberApproval({ chainId: 8453, token: USDC, spender: ROUTER, owner: OWNER }, 10n ** 30n);
    const fetchImpl = byHost([], {
      "aggregator-api.kyberswap.com": (url) =>
        url.pathname.endsWith("/route/build") ? json({ data: { data: kyberData("0x07", terms), routerAddress: ROUTER, amountOut: "10000000" } }) : json(routes),
    });
    const signed: EvmSignInput[] = [];
    await assert.rejects(
      () => broadcastRoute(config, signer(signed), request([storedLeg("kyberswap", routes, 900)], "kyberswap"), 1, fetchImpl, [], { io: io(() => fakeChain().rpc) }),
      (thrown: unknown) => thrown instanceof BroadcastError && !thrown.broadcast && error.test(thrown.message),
    );
    assert.equal(signed.length, 0);
  }
});

test("a 0x exec that spends another token or amount than the leg is refused before signing", async () => {
  const config: AppConfig = { ...loadConfig({ RPC_URL_8453: "http://fake.invalid", ZEROX_API_KEY: "zeroex-key" }), now: () => 10_000 };
  const terms = { recipient: OWNER, buyToken: TOKEN, minOut: 9_950_000n };
  for (const exec of [
    { token: USDC, amount: 2n ** 255n },
    { token: WETH, amount: 5_000_000n },
  ]) {
    resetProviderGuards();
    resetApprovals();
    const raw = { ...zeroExBody("0x0a"), transaction: { to: ROUTER, data: zeroExData("0x0a", terms, exec), value: "0", gas: "100000" } };
    const signed: EvmSignInput[] = [];
    await assert.rejects(
      () => broadcastRoute(config, signer(signed), request([storedLeg("zeroex", raw, 9_000)]), 1, byHost([], { "api.0x.org": () => json(raw) }), [], { io: io(() => fakeChain().rpc) }),
      (thrown: unknown) => thrown instanceof BroadcastError && !thrown.broadcast && /does not spend the leg's sell amount/.test(thrown.message),
    );
    assert.equal(signed.length, 0);
  }
});

test("a 0x quote whose allowance issue is null counts as funded", async () => {
  resetProviderGuards();
  resetApprovals();
  const config = loadConfig({ RPC_URL_8453: "http://fake.invalid", ZEROX_API_KEY: "zeroex-key" });
  const chain = fakeChain();
  const leg: RouteLeg = { sellAddress: USDC, buyAddress: TOKEN, sellAmount: "5000000", spentUsd: 5, priceUsd: 0.5, decimals: 6, impactPct: 0 };
  const result = await broadcastRoute(config, signer([]), request([leg]), 1, byHost([], { "api.0x.org": () => json(zeroExBody("0x08", "9950000", { allowance: null })) }), [], {
    io: io(() => chain.rpc),
  });
  assert.equal(result.venue === "chain" && result.outcome, "landed");
  assert.equal(allowanceCovers({ chainId: 8453, token: USDC, spender: ROUTER, owner: OWNER }, 5_000_000n), true);
});

test("a LI.FI sell is checked against its approvalAddress, not the transaction target", () => {
  resetApprovals();
  const raw = { estimate: { approvalAddress: LIFI_SPENDER } };
  rememberApproval({ chainId: 8453, token: USDC, spender: ROUTER, owner: OWNER }, 10n ** 30n);
  assert.throws(() => rememberIfFunded("lifi", raw, 8453, USDC, OWNER, 1_000n, ROUTER), /approval is not cached/);
  rememberApproval({ chainId: 8453, token: USDC, spender: LIFI_SPENDER, owner: OWNER }, 10n ** 30n);
  assert.doesNotThrow(() => rememberIfFunded("lifi", raw, 8453, USDC, OWNER, 1_000n, ROUTER));
});

test("without a MEV RPC a send goes to every RPC and the first success wins", async () => {
  resetProviderGuards();
  resetApprovals();
  rememberApproval({ chainId: 8453, token: USDC, spender: ROUTER, owner: OWNER }, 10n ** 30n);
  const config = loadConfig({ RPC_URLS_8453: "http://a.invalid,http://b.invalid", ZEROX_API_KEY: "zeroex-key" });
  const good = fakeChain();
  const down = fakeChain(true);
  const leg: RouteLeg = { sellAddress: USDC, buyAddress: TOKEN, sellAmount: "5000000", spentUsd: 5, priceUsd: 0.5, decimals: 6, impactPct: 0 };
  const result = await broadcastRoute(config, signer([]), request([leg]), 1, byHost([], { "api.0x.org": () => json(zeroExBody("0x09")) }), [], {
    io: io((rpcs) => (rpcs.length === 1 && rpcs[0] === "http://a.invalid" ? down.rpc : good.rpc)),
  });
  assert.equal(result.venue === "chain" && result.outcome, "landed");
  assert.equal(good.sent.length, 1);
});

function intent(key: string, alternates: SwapIntent["alternates"] = []): SwapIntent {
  return {
    idempotencyKey: key,
    side: "buy",
    notionalUsd: 5,
    slippageBps: 100,
    token: {
      symbol: "TKN",
      address: TOKEN,
      decimals: 6,
      chain: base,
      chainKey: "base",
      pairMap: buildPairMap([
        {
          poolAddress: "pool",
          dex: "uniswap",
          chainKey: "base",
          baseSymbol: "TKN",
          baseAddress: TOKEN,
          quoteSymbol: "WETH",
          quoteAddress: WETH,
          liquidityUsd: 200_000,
          priceUsd: 0.5,
          baseDecimals: 6,
          quotePriceUsd: 2000,
        },
      ]),
    },
    holdings: [
      { symbol: "USDC", address: USDC, amount: 20, usd: 20, native: false, decimals: 6, chainKey: "base" },
      { symbol: "USDC", address: USDC, amount: 20, usd: 20, native: false, decimals: 6, chainKey: "ethereum" },
    ],
    hyperliquid: null,
    receivedAtMs: 0,
    alternates,
  };
}

function concurrency(expected: number) {
  let inflight = 0;
  let peak = 0;
  let started = 0;
  const waiters: Array<() => void> = [];
  return {
    peak: () => peak,
    async enter(): Promise<void> {
      inflight += 1;
      started += 1;
      peak = Math.max(peak, inflight);
      if (started >= expected) for (const wake of waiters.splice(0)) wake();
      else await Promise.race([new Promise<void>((resolve) => waiters.push(resolve)), new Promise<void>((resolve) => setTimeout(resolve, 200))]);
      inflight -= 1;
    },
  };
}

const quoteConfig = {
  ...loadConfig({}),
  enabledChainKeys: new Set(["base", "ethereum"]),
  minExecutionSlippageBps: 20,
  quoteAssets: { base: [{ address: WETH, symbol: "WETH", decimals: 18 }] },
};

test("route plans and candidate chains are quoted at the same time", async () => {
  resetExecutorState();
  const gate = concurrency(3);
  const alternate = { ...intent("x").token, chain: { kind: "evm" as const, chainId: 1 }, chainKey: "ethereum", pairMap: buildPairMap([{ ...intent("x").token.pairMap.pools[0]!, chainKey: "ethereum", quoteAddress: TOKEN }]) };
  const deps: ExecutorDeps = {
    config: quoteConfig,
    mode: "dry_run",
    spentTodayUsd: 0,
    quoteHop: async (quoted) => {
      if (quoted.sellAddress === WETH) return { priceImpactPct: 0, feeUsd: 0, buyAmount: "10000000", signable: true };
      await gate.enter();
      return { priceImpactPct: quoted.buyAddress === WETH ? 0 : 0.1, feeUsd: 0, buyAmount: quoted.buyAddress === WETH ? "2500000000000000" : "9990000", signable: true };
    },
    markPrice: async () => null,
    send: async () => {
      throw new Error("dry run");
    },
  };
  const report = await execute(intent("parallel", [alternate]), deps);
  assert.equal(gate.peak(), 3);
  assert.equal(report.decision, "would_send");
  assert.equal(report.route?.legs?.some((leg) => "quote" in leg), false);
});

test("screening runs alongside quoting and a deny blocks the send", async () => {
  resetExecutorState();
  const events: string[] = [];
  let quoted!: () => void;
  const quoting = new Promise<void>((resolve) => (quoted = resolve));
  let sends = 0;
  const live = (verdict: "allow" | "deny"): ExecutorDeps => ({
    config: { ...quoteConfig, enabledChainKeys: new Set(["base"]) },
    mode: "live",
    spentTodayUsd: 0,
    quoteHop: async () => {
      events.push("quote");
      quoted();
      return { priceImpactPct: 0, feeUsd: 0, buyAmount: "10000000", signable: true };
    },
    screenToken: async () => {
      await Promise.race([quoting, new Promise((resolve) => setTimeout(resolve, 200))]);
      events.push(`screen ${verdict}`);
      return verdict;
    },
    readBalance: async () => 20,
    priceOf: () => 1,
    markPrice: async () => null,
    send: async () => {
      sends += 1;
      return { venue: "chain", outcome: "landed", txs: [{ chainKey: "base", txHash: "0x01", from: OWNER, to: ROUTER, value: "0", outcome: "landed" }], held: null, shortfall: false };
    },
  });
  const denied = await execute(intent("deny"), live("deny"));
  assert.equal(denied.reason, "token screening rejected the contract");
  assert.equal(sends, 0);
  assert.equal(events[0], "quote");
  assert.equal(events.at(-1), "screen deny");
  const allowed = await execute(intent("allow"), live("allow"));
  assert.equal(allowed.decision, "sent");
  assert.equal(sends, 1);
});
