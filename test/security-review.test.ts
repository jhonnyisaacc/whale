import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import test from "node:test";
import { SETTLERS, landedSend } from "./fixtures.js";
import { Keypair } from "@solana/web3.js";
import { encodeFunctionData, erc20Abi } from "viem";
import { resetProviderGuards } from "../src/aggregators.js";
import { applyBalance, holdingsForTrade } from "../src/balances.js";
import { broadcastRoute } from "../src/broadcast.js";
import { readHiddenLine } from "../src/create-wallet.js";
import { assertLiveEdges, loadConfig } from "../src/config.js";
import { buildPairMap } from "../src/pairs.js";
import { execute, resetExecutorState, type ExecutorDeps } from "../src/executor.js";
import { createExecutorApp } from "../src/executor-server.js";
import { decryptWallet, encryptWallet, createWalletMaterial } from "../src/keystore.js";
import { BODY_LIMIT, REQUEST_TIMEOUT_MS } from "../src/http.js";
import { assertBoot, loadManagedSigner, type TransactionSigner } from "../src/managed-signer.js";
import { redactError, Secret, trackSecret, zeroLoadedSecrets } from "../src/redact.js";
import { assertEvmSigning, DEFAULT_MAX_VALUE_WEI, JUPITER_PROGRAM_ID, SOLANA_BASE_PROGRAMS } from "../src/signing-policy.js";
import { createMemoryJournal, spendDay } from "../src/spend.js";
import { createMemoryWithdrawJournal } from "../src/withdraw-journal.js";
import type { SwapIntent } from "../src/domain.js";

const tokenAuth = "0123456789abcdef";
const adminAuth = "admin-token-0123456";
const owner = "0x1111111111111111111111111111111111111111";
const router = "0x2222222222222222222222222222222222222222";

function intent(): SwapIntent {
  return {
    idempotencyKey: `id-${Math.random()}`,
    side: "buy",
    notionalUsd: 5,
    slippageBps: 50,
    token: {
      symbol: "MPLX",
      address: "mplx",
      decimals: 6,
      chain: { kind: "solana" },
      chainKey: "solana",
      pairMap: buildPairMap([
        {
          poolAddress: "p",
          dex: "raydium",
          chainKey: "solana",
          baseSymbol: "MPLX",
          baseAddress: "mplx",
          quoteSymbol: "SOL",
          quoteAddress: "sol",
          liquidityUsd: 2_000_000,
          priceUsd: 0.2,
          baseDecimals: 6,
        },
      ]),
    },
    holdings: [
      { symbol: "USDC", address: "usdc", amount: 20, usd: 20, native: false, decimals: 6 },
      { symbol: "SOL", address: "sol", amount: 1, usd: 150, native: true },
    ],
    hyperliquid: null,
    receivedAtMs: 1_000,
  };
}

function runtime(config: ReturnType<typeof loadConfig>, sends: string[], quote: ExecutorDeps["quoteHop"]): ExecutorDeps {
  return {
    config,
    mode: "live",
    spentTodayUsd: 0,
    quoteHop: quote,
    markPrice: async () => 1,
    send: async (action) => {
      sends.push(action.kind);
      return landedSend();
    },
    now: () => 1_050,
  };
}




test("live mode does not send a token the screener denies", async () => {
  resetExecutorState();
  const config = loadConfig({ EXECUTOR_AUTH_TOKEN: tokenAuth, RESOLVER_AUTH_TOKEN: "resolver-token-123456", WHALE_BROADCAST: "true" });
  const sends: string[] = [];
  const report = await execute(intent(), {
    ...runtime(config, sends, async () => ({ priceImpactPct: 0.2, feeUsd: 0.01, buyAmount: "10" })),
    screenToken: async () => "deny",
  });
  assert.equal(report.decision, "skipped");
  assert.equal(report.reason, "token screening rejected the contract");
  assert.equal(sends.length, 0);
});


test("POST /execute uses live mode only when WHALE_BROADCAST is on and still does not send without a balance", async () => {
  resetExecutorState();
  const config = loadConfig({
    EXECUTOR_AUTH_TOKEN: tokenAuth,
    RESOLVER_AUTH_TOKEN: "resolver-token-123456",
    WHALE_BROADCAST: "true",
    TOKEN_SCREENING: "false",
  });
  const sends: string[] = [];
  const app = await createExecutorApp(config, runtime(config, sends, async () => {
    throw new Error("quote must not run");
  }), null, [], []);
  const response = await app.inject({
    method: "POST",
    url: "/execute",
    headers: { authorization: `Bearer ${tokenAuth}`, "content-type": "application/json" },
    payload: intent(),
  });
  assert.equal(response.statusCode, 200);
  assert.equal(response.json().mode, "live");
  assert.equal(sends.length, 0);
  assert.equal(JSON.stringify(response.json()).includes("txHash"), false);
  await app.close();
});

test("/execute stays dry-run, a thrown quote is a generic 500, and plain text is rejected", async () => {
  resetExecutorState();
  const databaseUrl = "postgres://listing:s3cret-db@db.internal:5432/listing";
  const rpc = "https://rpc.example/v2/secret-rpc-key";
  const config = loadConfig({ EXECUTOR_AUTH_TOKEN: tokenAuth, RESOLVER_AUTH_TOKEN: "resolver-token-123456" });
  const sends: string[] = [];
  const app = await createExecutorApp(config, runtime(config, sends, async () => ({ priceImpactPct: 0.2, feeUsd: 0.01, buyAmount: "10" })), null, [databaseUrl, rpc], []);
  const denied = await app.inject({ method: "POST", url: "/execute", payload: intent() });
  assert.equal(denied.statusCode, 401);
  const dry = await app.inject({
    method: "POST",
    url: "/execute",
    headers: { authorization: `Bearer ${tokenAuth}`, "content-type": "application/json" },
    payload: intent(),
  });
  assert.equal(dry.statusCode, 200);
  assert.equal(dry.json().mode, "dry_run");
  assert.equal(sends.length, 0);
  const plain = await app.inject({
    method: "POST",
    url: "/execute",
    headers: { authorization: `Bearer ${tokenAuth}`, "content-type": "text/plain" },
    payload: "hello",
  });
  assert.equal(plain.statusCode, 415);
  assert.equal(plain.json().error, "unsupported media type");
  await app.close();

  const failing = await createExecutorApp(
    config,
    runtime(config, sends, async () => {
      throw new Error(`connect ${databaseUrl} via ${rpc}`);
    }),
    null,
    [databaseUrl, rpc],
    [],
  );
  const crashed = await failing.inject({
    method: "POST",
    url: "/execute",
    headers: { authorization: `Bearer ${tokenAuth}`, "content-type": "application/json" },
    payload: intent(),
  });
  assert.equal(crashed.statusCode, 500);
  assert.deepEqual(crashed.json(), { error: "internal error" });
  assert.equal(BODY_LIMIT <= 64 * 1024, true);
  assert.equal(failing.server.requestTimeout, REQUEST_TIMEOUT_MS);
  await failing.close();
  const redacted = redactError(new Error(`connect ${databaseUrl} via ${rpc}`), [databaseUrl, rpc]);
  assert.equal(redacted, "connect [redacted] via [redacted]");
});

test("WITHDRAW_ENABLED is closed and POST /withdraw is not registered", async () => {
  const config = loadConfig({
    EXECUTOR_AUTH_TOKEN: tokenAuth,
    RESOLVER_AUTH_TOKEN: "resolver-token-123456",
    ADMIN_TOKEN: adminAuth,
    OWNER_WITHDRAW_ADDRESSES: owner,
  });
  const app = await createExecutorApp(config, runtime(config, [], async () => ({ priceImpactPct: null, feeUsd: 0, buyAmount: "0" })), null, [], []);
  const missing = await app.inject({
    method: "POST",
    url: "/withdraw",
    headers: { "content-type": "application/json", "x-admin-token": adminAuth },
    payload: { to: owner, amount: 1, chainKey: "base" },
  });
  assert.equal(missing.statusCode, 404);
  await app.close();
  const allowlisted = { WITHDRAW_ENABLED: "true", OWNER_WITHDRAW_ADDRESSES: owner };
  assert.throws(() => assertBoot(config, "executor", allowlisted), /WITHDRAW_ENABLED/);
  assert.throws(() => assertBoot(config, "executor", { WITHDRAW_ENABLED: "false", OWNER_WITHDRAW_ADDRESSES: owner }), /WITHDRAW_ENABLED/);
  for (const value of ["true", "false", "1", ""]) {
    assert.throws(
      () => loadConfig({ EXECUTOR_AUTH_TOKEN: tokenAuth, RESOLVER_AUTH_TOKEN: "resolver-token-123456", WITHDRAW_ENABLED: value }),
      /WITHDRAW_ENABLED/,
    );
  }
});

test("the withdraw journal blocks a duplicate key and a second asset scope keeps its own cap", async () => {
  const journal = createMemoryWithdrawJournal();
  assert.equal(await journal.reserve("withdraw:a", "base:native", 1, "2026-10-21", 1), "reserved");
  assert.equal(await journal.reserve("withdraw:a", "base:native", 1, "2026-10-21", 1), "exists");
  assert.equal(await journal.reserve("withdraw:b", "base:native", 1, "2026-10-21", 1), "cap");
  assert.equal(await journal.reserve("withdraw:b", "solana:native", 1, "2026-10-21", 1), "reserved");
  await journal.release("withdraw:b");
  assert.equal(await journal.reserve("withdraw:b", "solana:native", 1, "2026-10-21", 1), "reserved");
  await journal.commit("withdraw:a");
  assert.equal(await journal.reserve("withdraw:c", "base:native", 1, "2026-10-21", 1), "cap");
});

test("two reservations that share a lock cannot both pass the daily cap", async () => {
  const journal = createMemoryJournal();
  const [first, second] = await Promise.all([journal.reserve("a", 20, "2026-10-21", 25), journal.reserve("b", 20, "2026-10-21", 25)]);
  assert.deepEqual([first, second].sort(), ["cap", "reserved"]);
  const instant = new Date("2026-10-21T02:00:00.000Z");
  assert.equal(spendDay(instant, "UTC"), "2026-10-21");
  assert.equal(spendDay(instant, "America/Argentina/Buenos_Aires"), "2026-10-20");
});

test("a router allowed on one chain is denied on another, and a token sell cannot attach value", () => {
  const config = loadConfig({ ROUTER_ALLOWLIST_JSON: JSON.stringify({ "8453": [router] }) });
  const base = {
    data: "0x" as const,
    settlers: [],
    withdrawAllowlist: [],
    maxValueWei: DEFAULT_MAX_VALUE_WEI,
    allowHotApproval: false,
    owner,
    allowOpaqueSwap: true,
  };
  assert.throws(() => assertEvmSigning({ ...base, chainId: 1, to: router, value: 0n, purpose: "swap", routers: config.routerAllowlist[1] ?? [] }), /router allowlist is empty/);
  assert.doesNotThrow(() => assertEvmSigning({ ...base, chainId: 8453, to: router, value: 0n, purpose: "swap", routers: config.routerAllowlist[8453] ?? [] }));
  assert.throws(
    () => assertEvmSigning({ ...base, chainId: 8453, to: router, value: 1n, purpose: "swap", nativeSell: false, routers: config.routerAllowlist[8453] ?? [] }),
    /token sell must not attach native value/,
  );
  assert.doesNotThrow(() => assertEvmSigning({ ...base, chainId: 8453, to: router, value: 1n, purpose: "swap", nativeSell: true, routers: config.routerAllowlist[8453] ?? [] }));
  const data = encodeFunctionData({ abi: erc20Abi, functionName: "transfer", args: [owner, 1n] });
  assert.throws(
    () =>
      assertEvmSigning({
        ...base,
        chainId: 8453,
        to: "0x4444444444444444444444444444444444444444",
        data,
        value: 0n,
        purpose: "withdraw",
        routers: [],
        withdrawAllowlist: [owner],
        recoveryTokens: [],
      }),
    /recovery allowlist/,
  );
  assert.doesNotThrow(() =>
    assertEvmSigning({
      ...base,
      chainId: 8453,
      to: "0x4444444444444444444444444444444444444444",
      data,
      value: 0n,
      purpose: "withdraw",
      routers: [],
      withdrawAllowlist: [owner],
      recoveryTokens: ["0x4444444444444444444444444444444444444444"],
    }),
  );
  assert.equal(SOLANA_BASE_PROGRAMS.includes(JUPITER_PROGRAM_ID), true);
});

test("live mode pins aggregator hosts and private service URLs", () => {
  const live = { WHALE_BROADCAST: "true", EXECUTOR_AUTH_TOKEN: tokenAuth, RESOLVER_AUTH_TOKEN: "resolver-token-123456", ZEROX_API_KEY: "zeroex-key", ZEROX_SETTLER_ALLOWLIST_JSON: SETTLERS, KYBERSWAP_CLIENT_ID: "listing-trader-test" };
  assert.throws(() => assertBoot(loadConfig({ ...live, JUPITER_API_BASE: "https://evil.example/swap/v1" }), "executor"), /pins jupiterBase/);
  assert.throws(() => assertBoot(loadConfig({ ...live, RESOLVER_URL: "http://evil.example/alert" }), "executor"), /https or a railway.internal host/);
  assert.doesNotThrow(() => assertBoot(loadConfig({ ...live, RESOLVER_URL: "http://resolver.railway.internal:8080" }), "executor"));
  assert.doesNotThrow(() => assertLiveEdges(loadConfig({ EXECUTOR_AUTH_TOKEN: tokenAuth, RESOLVER_AUTH_TOKEN: "resolver-token-123456", RESOLVER_URL: "http://127.0.0.1:8080" }), {}));
});

test("the kill switch skips a live buy and a missing balance read does not trade", async () => {
  resetExecutorState();
  const config = loadConfig({ EXECUTOR_AUTH_TOKEN: tokenAuth, RESOLVER_AUTH_TOKEN: "resolver-token-123456", WHALE_BROADCAST: "true", RESOLVER_URL: "http://resolver.railway.internal:8080" });
  const sends: string[] = [];
  const stopped = await execute(intent(), { ...runtime(config, sends, async () => ({ priceImpactPct: 0.2, feeUsd: 0.01, buyAmount: "10" })), killSwitchEnabled: async () => true });
  assert.equal(stopped.decision, "skipped");
  assert.equal(stopped.reason, "kill switch is on");
  assert.equal(sends.length, 0);

  const holding = { symbol: "USDC", address: "usdc", amount: 20, usd: 20, native: false, decimals: 6 };
  assert.equal(applyBalance(holding, 1, 1).amount, 1);
  assert.equal(applyBalance(holding, 1, 1).usd, 1);
  const unread = await holdingsForTrade(true, [holding], null, "solana", () => 1);
  assert.equal(unread.ok, false);
  const blocked = await execute(intent(), runtime(config, sends, async () => ({ priceImpactPct: 0.2, feeUsd: 0.01, buyAmount: "10" })));
  assert.equal(blocked.reason, "balance was not read");
  assert.equal(sends.length, 0);
});

test("keystore headers are authenticated, buffers zero, and the passphrase prompt does not echo", async () => {
  const material = createWalletMaterial();
  const file = encryptWallet(material, "correct horse battery");
  const opened = decryptWallet(file, "correct horse battery");
  assert.equal(opened.evmAddress, file.addresses.evm);
  assert.equal(opened.solanaAddress, file.addresses.solana);
  assert.equal(file.n, 131072);
  assert.throws(() => decryptWallet({ ...file, addresses: { ...file.addresses, evm: owner } }, "correct horse battery"), /keystore/);
  const secret = trackSecret(new Secret("supersecretvalue"));
  zeroLoadedSecrets();
  assert.equal(secret.reveal(), "");
  const env = { KEYSTORE_PASSPHRASE: "correct horse battery", ALLOW_LOCAL_SIGNER: "true" };
  assert.throws(() => loadManagedSigner(env, loadConfig({ WHALE_BROADCAST: "true", ALLOW_LOCAL_SIGNER: "true", EXECUTOR_AUTH_TOKEN: tokenAuth, RESOLVER_AUTH_TOKEN: "resolver-token-123456" })), /refuses raw key material in KEYSTORE_PASSPHRASE/);
  assert.equal(env.KEYSTORE_PASSPHRASE, undefined);
  let written = "";
  const listeners = new Set<(chunk: Buffer) => void>();
  const stdin = {
    isRaw: false,
    setRawMode() {},
    resume() {},
    pause() {},
    on(_event: "data", listener: (chunk: Buffer) => void) {
      listeners.add(listener);
    },
    off(_event: "data", listener: (chunk: Buffer) => void) {
      listeners.delete(listener);
    },
  };
  const pending = readHiddenLine(stdin, {
    write(chunk: string) {
      written += chunk;
    },
  });
  for (const listener of listeners) listener(Buffer.from("hunter2\n"));
  assert.equal(await pending, "hunter2");
  assert.equal(written.includes("hunter2"), false);
});

test("the image digest is pinned and jayson can load its json parser", () => {
  const docker = readFileSync(new URL("../../Dockerfile", import.meta.url), "utf8");
  assert.match(docker, /node:22-bookworm-slim@sha256:3ed98443660ff48413b5af19ecefce3b9d50845a901a43420d47cc63a9fddbe9/);
  assert.match(docker, /npm ci --ignore-scripts/);
  assert.match(docker, /npm ci --omit=dev --ignore-scripts/);
  const pkg = JSON.parse(readFileSync(new URL("../../package.json", import.meta.url), "utf8")) as { overrides?: { uuid?: string; "stream-json"?: string } };
  assert.equal(pkg.overrides?.uuid, "11.1.1");
  execFileSync(process.execPath, ["-e", "require('jayson/lib/utils')"], { cwd: new URL("../..", import.meta.url) });
});

test("jupiter quotes with the slippage left after impact and refuses a quote without a minimum", async () => {
  resetProviderGuards();
  const config = loadConfig({ EXECUTOR_AUTH_TOKEN: tokenAuth, RESOLVER_AUTH_TOKEN: "resolver-token-123456", SOLANA_RPC_URL: "http://127.0.0.1:9", MAX_SLIPPAGE_BPS: "100" });
  const quotes: string[] = [];
  const swaps: string[] = [];
  const signer: TransactionSigner = {
    backend: "keystore",
    evmAddress: () => null,
    solanaAddress: () => Keypair.generate().publicKey.toBase58(),
    async signEvm() {
      return "0x";
    },
    async signSolana() {
      return new Uint8Array();
    },
    async signHyperliquid() {
      return { r: "0x01", s: "0x02", v: 27 };
    },
  };
  await assert.rejects(
    () =>
      broadcastRoute(
        config,
        signer,
        {
          kind: "solana",
          description: "swap",
          chain: { kind: "solana" },
          hyperliquidActions: [],
          legs: [{ sellAddress: "usdc", buyAddress: "mint", sellAmount: "1000", spentUsd: 5, priceUsd: 1, decimals: 6, impactPct: 0.3 }],
        },
        1,
        async (input) => {
          const url = String(input);
          if (url.endsWith("/swap")) {
            swaps.push(url);
            return new Response(JSON.stringify({ swapTransaction: "aaaa" }), { status: 200 });
          }
          quotes.push(url);
          return new Response(JSON.stringify({ outAmount: "4990000", priceImpactPct: "0.001" }), { status: 200 });
        },
      ),
    /no checkable minimum output/,
  );
  assert.equal(new URL(quotes[0] ?? "http://x").searchParams.get("slippageBps"), "70");
  assert.deepEqual(swaps, []);
});

test("loadConfig throws when LISTING_TRADER_LIVE is set", () => {
  assert.throws(() => loadConfig({ LISTING_TRADER_LIVE: "true" }), /LISTING_TRADER_LIVE/);
  assert.throws(() => loadConfig({ LISTING_TRADER_LIVE: "false" }), /LISTING_TRADER_LIVE/);
});

test("loadConfig throws when STRATEGY_CAPS_JSON is set", () => {
  assert.throws(
    () => loadConfig({ STRATEGY_CAPS_JSON: JSON.stringify({ copy1: { dailyUsdCap: 50, maxUsdPerTrade: 10, token: "strategy-token-123456" } }) }),
    /STRATEGY_CAPS_JSON/,
  );
  assert.throws(() => loadConfig({ STRATEGY_CAPS_JSON: "" }), /STRATEGY_CAPS_JSON/);
});
