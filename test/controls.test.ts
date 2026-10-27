import assert from "node:assert/strict";
import { QUOTE_ASSETS } from "../src/chains.js";
import { readFileSync } from "node:fs";
import test from "node:test";
import { landedSend, zeroExData } from "./fixtures.js";
import { Keypair, PublicKey, SystemProgram, TransactionInstruction, TransactionMessage, VersionedTransaction } from "@solana/web3.js";
import { resetApprovals, rememberApproval } from "../src/approvals.js";
import { PROVIDER_REGISTRY, providersFor, raceProviderQuotes, resetProviderGuards } from "../src/aggregators.js";
import { broadcastRoute } from "../src/broadcast.js";
import { loadConfig } from "../src/config.js";
import { BroadcastError } from "../src/executor.js";
import { REDACT_PATHS } from "../src/log.js";
import { assertBoot, loadManagedSigner, withPolicy, type TransactionSigner } from "../src/managed-signer.js";
import { classifyHttp, ProviderGuard } from "../src/provider-guard.js";
import { BRIDGE_PROVIDERS, planRebalance } from "../src/rebalance.js";
import { pickRoute, planRoutes } from "../src/routing.js";
import { buildPairMap } from "../src/pairs.js";
import { screenToken } from "../src/screening.js";
import {
  assertEvmSigning,
  assertHyperliquidSigning,
  associatedTokenAddress,
  DEFAULT_MAX_VALUE_WEI,
  JITO_TIP_ACCOUNTS,
  JUPITER_PROGRAM_ID,
  turnkeyPolicyDocument,
  turnkeyPolicyTemplate,
  wrappedSolAccount,
} from "../src/signing-policy.js";
import { RESERVE_LOCK_SQL, RESERVE_SUM_SQL, reserveDecision } from "../src/spend.js";
import { createExecutorApp } from "../src/executor-server.js";
import type { ExecutorDeps } from "../src/executor.js";

const tokenAuth = "0123456789abcdef";

function signer(calls: string[]): TransactionSigner {
  return {
    backend: "keystore",
    evmAddress: () => "0x2222222222222222222222222222222222222222",
    solanaAddress: () => null,
    async signEvm() {
      calls.push("evm");
      return "0x";
    },
    async signSolana() {
      calls.push("solana");
      return new Uint8Array();
    },
    async signHyperliquid() {
      calls.push("hyper");
      return { r: "0x01", s: "0x02", v: 27 };
    },
  };
}

test("the route picker prefers net output and drops an unsigned quote", () => {
  const shared = { kind: "aggregator" as const, hops: ["USDC->MPLX"], feeUsd: 0.01, buyAmount: "1" };
  const picked = pickRoute(
    [
      { ...shared, planId: "thin", priceImpactPct: 0.1, netOutputUsd: 1, signable: true },
      { ...shared, planId: "thick", priceImpactPct: 0.4, netOutputUsd: 4, signable: true },
      { ...shared, planId: "unsigned", priceImpactPct: 0.01, netOutputUsd: 9, signable: false },
    ],
    100,
  );
  assert.equal("planId" in picked && picked.planId, "thick");
});

test("a holding tagged for another chain is not spent on this chain", () => {
  const plans = planRoutes({
    tokenSymbol: "MPLX",
    tokenAddress: "mplx",
    pairMap: buildPairMap([]),
    holdings: [
      { symbol: "USDC", address: "sol-usdc", amount: 20, usd: 20, native: false, decimals: 6, chainKey: "solana" },
      { symbol: "USDC", address: "base-usdc", amount: 20, usd: 20, native: false, decimals: 6, chainKey: "base" },
      { symbol: "USDC", address: "shared", amount: 20, usd: 20, native: false, decimals: 6 },
    ],
    minNativeReserve: 0,
    notionalUsd: 5,
    quoteAssets: QUOTE_ASSETS,
    chainKey: "base",
  });
  const sells = plans.map((plan) => (plan.kind === "aggregator" ? plan.hop.sellAddress : ""));
  assert.deepEqual(sells.sort(), ["base-usdc", "shared"]);
});

test("a quote that misses the deadline is dropped and a fast quote is kept", async () => {
  resetProviderGuards();
  const config = loadConfig({ QUOTE_TIMEOUT_MS: "30", QUOTE_DEADLINE_MS: "60", ZEROX_API_KEY: "zeroex-key" });
  const quote = await raceProviderQuotes(
    config,
    { sellAddress: "0xusdc", buyAddress: "0xtoken", sellAmount: "5000000", chain: { kind: "evm", chainId: 8453 } },
    { spentUsd: 5, priceUsd: 1, decimals: 6 },
    async (input, init) => {
      const host = new URL(String(input)).hostname;
      if (host !== "api.0x.org") {
        await new Promise((resolve, reject) => {
          const timer = setTimeout(resolve, 400);
          init?.signal?.addEventListener("abort", () => {
            clearTimeout(timer);
            reject(new Error("aborted"));
          });
        });
      }
      return new Response(JSON.stringify({ buyAmount: "5000000", liquidityAvailable: true }), { status: 200 });
    },
  );
  assert.equal(quote.provider, "zeroex");
  assert.ok((quote.netOutputUsd ?? 0) > 0);
});

test("a compliance response opens the breaker and is not retried", async () => {
  resetProviderGuards();
  const config = loadConfig({});
  let calls = 0;
  const fetchImpl: typeof fetch = async () => {
    calls += 1;
    return new Response("restricted jurisdiction", { status: 403 });
  };
  const hop = { sellAddress: "usdc", buyAddress: "mplx", sellAmount: "5000000", chain: { kind: "solana" as const } };
  await raceProviderQuotes(config, hop, null, fetchImpl);
  await raceProviderQuotes(config, hop, null, fetchImpl);
  assert.equal(calls, 1);
  assert.equal(classifyHttp(451, ""), "compliance");
  assert.equal(classifyHttp(200, "ofac"), "ok");
});

test("odos is not called and bridges are the four off-path providers", () => {
  assert.equal(PROVIDER_REGISTRY.odos.calls, false);
  assert.equal(PROVIDER_REGISTRY.jumper.calls, false);
  assert.equal(providersFor({ kind: "solana" }, loadConfig({})).includes("odos" as never), false);
  assert.deepEqual([...BRIDGE_PROVIDERS], ["lifi", "across", "relay", "debridge"]);
});

test("rebalance refuses an empty allowlist and a foreign destination", () => {
  const quote = { provider: "lifi" as const, feeUsd: 0.01, amountInUsd: 10, destination: "0xabc" };
  assert.equal(planRebalance({ quotes: [quote], maxBridgeUsd: 25, maxFeeBps: 50, spentBridgeUsd: 0, dailyBridgeCap: 50, ownAddresses: ["0xabc"], allowlist: [] }).kind, "skip");
  const foreign = planRebalance({
    quotes: [quote],
    maxBridgeUsd: 25,
    maxFeeBps: 50,
    spentBridgeUsd: 0,
    dailyBridgeCap: 50,
    ownAddresses: ["0xabc"],
    allowlist: ["0xdef"],
  });
  assert.equal(foreign.kind, "skip");
});

test("the hot path does not plan a bridge", () => {
  const source = readFileSync(new URL("../../src/executor.ts", import.meta.url), "utf8");
  assert.equal(source.includes("planRebalance"), false);
});

test("an uncached erc-20 sell is not signed", async () => {
  resetApprovals();
  const calls: string[] = [];
  const config = loadConfig({
    EXECUTOR_AUTH_TOKEN: tokenAuth, RESOLVER_AUTH_TOKEN: "resolver-token-123456",
    RPC_URL_8453: "http://127.0.0.1:9",
    ZEROX_API_KEY: "zeroex-key",
    ROUTER_ALLOWLIST: "0x1111111111111111111111111111111111111111",
  });
  const router = "0x1111111111111111111111111111111111111111";
  const sell = "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
  await assert.rejects(
    () =>
      broadcastRoute(
        config,
        withPolicy(signer(calls), config),
        {
          kind: "evm",
          description: "swap",
          chain: { kind: "evm", chainId: 8453 },
          provider: "zeroex",
          hyperliquidActions: [],
          legs: [{ sellAddress: sell, buyAddress: "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb", sellAmount: "1000", spentUsd: 5, priceUsd: 1, decimals: 6 }],
        },
        1,
        async () =>
          new Response(
            JSON.stringify({
              buyAmount: "5000000",
              minBuyAmount: "4975000",
              liquidityAvailable: true,
              transaction: { to: router, data: zeroExData("0x01", { recipient: "0x2222222222222222222222222222222222222222", buyToken: "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb", minOut: 4_975_000n }, { token: sell, amount: 1000n }), value: "0", gas: "21000" },
              issues: { allowance: { spender: router, actual: "0" } },
            }),
            { status: 200 },
          ),
      ),
    (error: unknown) => error instanceof BroadcastError && error.message === "approval is not cached" && error.broadcast === false,
  );
  assert.deepEqual(calls, []);
  rememberApproval({ chainId: 8453, token: sell, spender: router, owner: "0x2222222222222222222222222222222222222222" }, 1000n);
  await assert.rejects(
    () =>
      broadcastRoute(
        config,
        withPolicy(signer(calls), config),
        {
          kind: "evm",
          description: "swap",
          chain: { kind: "evm", chainId: 8453 },
          provider: "zeroex",
          hyperliquidActions: [],
          legs: [{ sellAddress: sell, buyAddress: "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb", sellAmount: "1000", spentUsd: 5, priceUsd: 1, decimals: 6 }],
        },
        1,
        async () =>
          new Response(
            JSON.stringify({
              buyAmount: "5000000",
              minBuyAmount: "4975000",
              liquidityAvailable: true,
              transaction: { to: router, data: zeroExData("0x01", { recipient: "0x2222222222222222222222222222222222222222", buyToken: "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb", minOut: 4_975_000n }, { token: sell, amount: 1000n }), value: "0", gas: "21000" },
              issues: { allowance: { spender: router, actual: "0" } },
            }),
            { status: 200 },
          ),
      ),
    (error: unknown) => error instanceof BroadcastError && error.message !== "approval is not cached",
  );
});

test("signing policy denies an empty router list, a foreign router, and a hyperliquid withdraw", () => {
  assert.throws(
    () => assertEvmSigning({ chainId: 8453, to: "0x1111111111111111111111111111111111111111", data: "0x", value: 0n, purpose: "swap", routers: [], settlers: [], withdrawAllowlist: [], maxValueWei: DEFAULT_MAX_VALUE_WEI, allowHotApproval: false, owner: "0x2222222222222222222222222222222222222222", allowOpaqueSwap: false }),
    /router allowlist is empty/,
  );
  assert.throws(
    () =>
      assertEvmSigning({
        chainId: 8453,
        to: "0x2222222222222222222222222222222222222222",
        data: "0x",
        value: 0n,
        purpose: "swap",
        routers: ["0x1111111111111111111111111111111111111111"],
        settlers: [],
        withdrawAllowlist: [],
        maxValueWei: DEFAULT_MAX_VALUE_WEI,
        allowHotApproval: false,
        owner: "0x2222222222222222222222222222222222222222",
        allowOpaqueSwap: false,
      }),
    /not an allowlisted router/,
  );
  assert.throws(() => assertHyperliquidSigning({ type: "withdraw3" }, 1), /withdraw3/);
});

test("live mode refuses the local keystore", () => {
  const live = loadConfig({ WHALE_BROADCAST: "true", EXECUTOR_AUTH_TOKEN: tokenAuth, RESOLVER_AUTH_TOKEN: "resolver-token-123456" });
  assert.throws(() => loadManagedSigner({}, live), /live mode requires Turnkey/);
  const flagged = loadConfig({ WHALE_BROADCAST: "true", ALLOW_LOCAL_SIGNER: "true", EXECUTOR_AUTH_TOKEN: tokenAuth, RESOLVER_AUTH_TOKEN: "resolver-token-123456" });
  assert.throws(() => loadManagedSigner({ ALLOW_LOCAL_SIGNER: "true" }, flagged), /live mode requires Turnkey/);
});

test("a solana native transfer to a stranger is denied before the backend signs", async () => {
  const payer = Keypair.generate();
  const stranger = Keypair.generate().publicKey;
  const message = new TransactionMessage({
    payerKey: payer.publicKey,
    recentBlockhash: "11111111111111111111111111111111",
    instructions: [SystemProgram.transfer({ fromPubkey: payer.publicKey, toPubkey: stranger, lamports: 1 })],
  }).compileToV0Message();
  const raw = new VersionedTransaction(message).serialize();
  const calls: string[] = [];
  const inner = signer(calls);
  inner.solanaAddress = () => payer.publicKey.toBase58();
  const wrapped = withPolicy(inner, loadConfig({}));
  await assert.rejects(() => wrapped.signSolana(raw), /not allowlisted/);
  assert.deepEqual(calls, []);
  const bad = new VersionedTransaction(
    new TransactionMessage({
      payerKey: payer.publicKey,
      recentBlockhash: "11111111111111111111111111111111",
      instructions: [new TransactionInstruction({ programId: new PublicKey(Keypair.generate().publicKey), keys: [], data: Buffer.alloc(0) })],
    }).compileToV0Message(),
  ).serialize();
  await assert.rejects(() => wrapped.signSolana(bad), /solana program is not allowlisted/);
});

test("a jupiter swap may wrap SOL to the owner account and tip a jito account", async () => {
  const payer = Keypair.generate();
  const ata = new PublicKey(wrappedSolAccount(payer.publicKey.toBase58()));
  assert.notEqual(ata.toBase58(), payer.publicKey.toBase58());
  const tip = new PublicKey(JITO_TIP_ACCOUNTS[0]);
  const mint = new PublicKey("So11111111111111111111111111111111111111112");
  const tokenProgram = new PublicKey("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA");
  const outMint = Keypair.generate().publicKey;
  const outAta = new PublicKey(associatedTokenAddress(payer.publicKey.toBase58(), outMint.toBase58(), tokenProgram.toBase58()));
  const budget = Buffer.alloc(5);
  budget.writeUInt8(2, 0);
  budget.writeUInt32LE(200_000, 1);
  const message = new TransactionMessage({
    payerKey: payer.publicKey,
    recentBlockhash: "11111111111111111111111111111111",
    instructions: [
      new TransactionInstruction({ programId: new PublicKey("ComputeBudget111111111111111111111111111111"), keys: [], data: budget }),
      new TransactionInstruction({
        programId: new PublicKey("ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL"),
        keys: [
          { pubkey: payer.publicKey, isSigner: true, isWritable: true },
          { pubkey: ata, isSigner: false, isWritable: true },
          { pubkey: payer.publicKey, isSigner: false, isWritable: false },
          { pubkey: mint, isSigner: false, isWritable: false },
          { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
          { pubkey: tokenProgram, isSigner: false, isWritable: false },
        ],
        data: Buffer.from([1]),
      }),
      SystemProgram.transfer({ fromPubkey: payer.publicKey, toPubkey: ata, lamports: 1_000_000 }),
      new TransactionInstruction({
        programId: tokenProgram,
        keys: [
          { pubkey: ata, isSigner: false, isWritable: true },
          { pubkey: payer.publicKey, isSigner: false, isWritable: false },
        ],
        data: Buffer.from([17]),
      }),
      new TransactionInstruction({
        programId: new PublicKey(JUPITER_PROGRAM_ID),
        keys: [
          { pubkey: tokenProgram, isSigner: false, isWritable: false },
          { pubkey: payer.publicKey, isSigner: true, isWritable: true },
          { pubkey: ata, isSigner: false, isWritable: true },
          { pubkey: outAta, isSigner: false, isWritable: true },
          { pubkey: new PublicKey(JUPITER_PROGRAM_ID), isSigner: false, isWritable: false },
          { pubkey: outMint, isSigner: false, isWritable: false },
          { pubkey: new PublicKey(JUPITER_PROGRAM_ID), isSigner: false, isWritable: false },
          { pubkey: Keypair.generate().publicKey, isSigner: false, isWritable: false },
          { pubkey: new PublicKey(JUPITER_PROGRAM_ID), isSigner: false, isWritable: false },
        ],
        data: Buffer.concat([Buffer.from("e517cb977ae3ad2a", "hex"), Buffer.alloc(24)]),
      }),
      new TransactionInstruction({
        programId: tokenProgram,
        keys: [
          { pubkey: ata, isSigner: false, isWritable: true },
          { pubkey: payer.publicKey, isSigner: false, isWritable: true },
          { pubkey: payer.publicKey, isSigner: true, isWritable: false },
        ],
        data: Buffer.from([9]),
      }),
      SystemProgram.transfer({ fromPubkey: payer.publicKey, toPubkey: tip, lamports: 1000 }),
    ],
  }).compileToV0Message();
  const calls: string[] = [];
  const inner = signer(calls);
  inner.solanaAddress = () => payer.publicKey.toBase58();
  const wrapped = withPolicy(inner, loadConfig({}));
  await wrapped.signSolana(new VersionedTransaction(message).serialize());
  assert.deepEqual(calls, ["solana"]);
  const stolen = new VersionedTransaction(
    new TransactionMessage({
      payerKey: payer.publicKey,
      recentBlockhash: "11111111111111111111111111111111",
      instructions: [SystemProgram.transfer({ fromPubkey: payer.publicKey, toPubkey: new PublicKey(wrappedSolAccount(Keypair.generate().publicKey.toBase58())), lamports: 1 })],
    }).compileToV0Message(),
  ).serialize();
  await assert.rejects(() => wrapped.signSolana(stolen), /not allowlisted/);
});

test("boot requires a long token and refuses a public Railway domain", () => {
  assert.throws(() => assertBoot(loadConfig({ EXECUTOR_AUTH_TOKEN: "short", RESOLVER_AUTH_TOKEN: "resolver-token-123456" }), "executor"), /EXECUTOR_AUTH_TOKEN/);
  assert.throws(() => assertBoot(loadConfig({ EXECUTOR_AUTH_TOKEN: tokenAuth, RESOLVER_AUTH_TOKEN: "resolver-token-123456" }), "executor", { RAILWAY_PUBLIC_DOMAIN: "example.up.railway.app" }), /public Railway domain/);
});

test("mutating routes require a bearer token, a valid body, and a small payload", async () => {
  const config = loadConfig({ EXECUTOR_AUTH_TOKEN: tokenAuth, RESOLVER_AUTH_TOKEN: "resolver-token-123456" });
  const runtime: ExecutorDeps = {
    config,
    mode: "dry_run",
    spentTodayUsd: 0,
    quoteHop: async () => ({ priceImpactPct: null, feeUsd: 0, buyAmount: "0" }),
    markPrice: async () => null,
    send: async () => landedSend(),
  };
  const app = await createExecutorApp(config, runtime, null, [], []);
  const health = await app.inject({ method: "GET", url: "/health" });
  assert.equal(health.statusCode, 200);
  const missing = await app.inject({ method: "POST", url: "/execute", payload: {} });
  assert.equal(missing.statusCode, 401);
  const invalid = await app.inject({
    method: "POST",
    url: "/execute",
    headers: { authorization: `Bearer ${tokenAuth}`, "content-type": "application/json" },
    payload: { side: "buy" },
  });
  assert.equal(invalid.statusCode, 400);
  const huge = await app.inject({
    method: "POST",
    url: "/execute",
    headers: { authorization: `Bearer ${tokenAuth}`, "content-type": "application/json" },
    payload: { pad: "x".repeat(40_000) },
  });
  assert.equal(huge.statusCode, 413);
  let limited = 0;
  for (let i = 0; i < 11; i += 1) {
    const response = await app.inject({
      method: "POST",
      url: "/rebalance",
      headers: { authorization: `Bearer ${tokenAuth}`, "content-type": "application/json" },
      payload: { quotes: [], ownAddresses: [] },
    });
    limited = response.statusCode;
  }
  assert.equal(limited, 429);
  await app.close();
});

test("screening fails closed on a bad body, a honeypot, and a Blockaid warning", async () => {
  const config = loadConfig({ TOKEN_SCREENING: "true", EXECUTOR_AUTH_TOKEN: tokenAuth, RESOLVER_AUTH_TOKEN: "resolver-token-123456" });
  const token = { chainKey: "base", chain: { kind: "evm" as const, chainId: 8453 }, contract: "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" };
  assert.equal(await screenToken(config, token, async () => new Response("{}", { status: 200 })), "deny");
  assert.equal(
    await screenToken(config, token, async () => new Response(JSON.stringify({ code: 1, result: { [token.contract]: { is_honeypot: "1" } } }), { status: 200 })),
    "deny",
  );
  const benign = loadConfig({ TOKEN_SCREENING: "true", BLOCKAID_API_KEY: "blockaid-test", EXECUTOR_AUTH_TOKEN: tokenAuth, RESOLVER_AUTH_TOKEN: "resolver-token-123456" });
  assert.equal(
    await screenToken(benign, token, async (input) => {
      if (new URL(String(input)).hostname === "api.gopluslabs.io") {
        return new Response(JSON.stringify({ code: 1, result: { [token.contract]: { is_honeypot: "0", cannot_sell_all: "0" } } }), { status: 200 });
      }
      return new Response(JSON.stringify({ result_type: "Warning" }), { status: 200 });
    }),
    "deny",
  );
  assert.equal(await screenToken(loadConfig({ TOKEN_SCREENING: "false" }), token, async () => { throw new Error("offline"); }), "allow");
  assert.equal(
    await screenToken(
      config,
      token,
      async () => new Response(JSON.stringify({ code: 1, result: { [token.contract]: { is_honeypot: "0", buy_tax: "0.5", sell_tax: "0" } } }), { status: 200 }),
    ),
    "deny",
  );
  const live = loadConfig({ WHALE_BROADCAST: "true", EXECUTOR_AUTH_TOKEN: tokenAuth, RESOLVER_AUTH_TOKEN: "resolver-token-123456" });
  assert.equal(live.screening, true);
  assert.equal(loadConfig({ EXECUTOR_AUTH_TOKEN: tokenAuth, RESOLVER_AUTH_TOKEN: "resolver-token-123456" }).screening, false);
});

test("spend reservation locks the day and counts reserved plus committed rows", () => {
  assert.match(RESERVE_LOCK_SQL, /pg_advisory_xact_lock/);
  assert.match(RESERVE_SUM_SQL, /reserved/);
  assert.match(RESERVE_SUM_SQL, /committed/);
  assert.equal(reserveDecision({ existing: null, spent: 20, usd: 5, cap: 25 }), "reserved");
  assert.equal(reserveDecision({ existing: null, spent: 21, usd: 5, cap: 25 }), "cap");
  assert.equal(reserveDecision({ existing: "committed", spent: 0, usd: 5, cap: 25 }), "exists");
  assert.equal(reserveDecision({ existing: "released", spent: 0, usd: 5, cap: 25 }), "reserved");
});

test("the checked-in Turnkey policy matches the code", () => {
  const file = JSON.parse(readFileSync(new URL("../../policies/turnkey.json", import.meta.url), "utf8"));
  assert.deepEqual(file, turnkeyPolicyTemplate());
  const base = "0x1111111111111111111111111111111111111111";
  const other = "0x2222222222222222222222222222222222222222";
  const sample = {
    userId: "6f1c2a9e-4b7d-4c1e-9a3f-2d8e5b7c1a40",
    wallets: { evm: "0b5d7e2c-1a3f-4e6b-8c9d-7f2a1b3c4d5e", solana: "1c6e8f3d-2b4a-4f7c-9d0e-8a3b2c4d5e6f", hyperliquid: "2d7f9a4e-3c5b-4a8d-8e1f-9b4c3d5e6f70" },
    solanaAddress: Keypair.generate().publicKey.toBase58(),
    routers: { 8453: [base], 1: [other] },
    maxValueWei: 123_456n,
  };
  const filled = JSON.stringify(turnkeyPolicyDocument(sample));
  assert.equal(/<[A-Z_]+>/.test(filled), false);
  assert.match(filled, /eth\.tx\.chain_id == 8453 && \(eth\.tx\.to == '0x1111111111111111111111111111111111111111'\)/);
  assert.match(filled, /eth\.tx\.chain_id == 1 && \(eth\.tx\.to == '0x2222222222222222222222222222222222222222'\)/);
  assert.throws(() => turnkeyPolicyDocument({ ...sample, userId: "<TURNKEY_API_USER_ID>" }), /placeholder/);
  assert.throws(() => turnkeyPolicyDocument({ ...sample, userId: "api-user" }), /placeholder/);
  assert.throws(() => turnkeyPolicyDocument({ ...sample, wallets: { ...sample.wallets, evm: "00000000-0000-0000-0000-000000000000" } }), /placeholder/);
});

test("logs redact authorization and exchange signatures", () => {
  assert.ok(REDACT_PATHS.includes("req.headers.authorization"));
  assert.ok(REDACT_PATHS.some((path) => path.includes("ok-access-sign")));
});

test("three provider failures open the circuit", () => {
  let now = 1_000;
  const guard = new ProviderGuard({ budget: 30, windowMs: 60_000, failureThreshold: 3, openMs: 30_000, now: () => now });
  assert.equal(guard.before("kyberswap"), "allow");
  guard.failure("kyberswap");
  guard.failure("kyberswap");
  assert.equal(guard.before("kyberswap"), "allow");
  guard.failure("kyberswap");
  assert.equal(guard.before("kyberswap"), "open");
  now += 30_001;
  assert.equal(guard.before("kyberswap"), "allow");
});
