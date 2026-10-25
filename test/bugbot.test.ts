import assert from "node:assert/strict";
import test from "node:test";
import { QUOTE_ASSETS } from "../src/chains.js";
import { landedSend } from "./fixtures.js";
import { Keypair, PublicKey, TransactionMessage, VersionedTransaction } from "@solana/web3.js";
import { raceProviderQuotes, resetProviderGuards } from "../src/aggregators.js";
import { holdingFitsChain, holdingsForTrade } from "../src/balances.js";
import { planRoutes } from "../src/routing.js";
import { associatedTokenAccount, tokenRecoveryInstructions } from "../src/broadcast.js";
import { loadConfig } from "../src/config.js";
import type { SwapIntent, TokenRecord } from "../src/domain.js";
import { execute, resetExecutorState, type ExecutorDeps } from "../src/executor.js";
import { withPolicy, type TransactionSigner } from "../src/managed-signer.js";
import { buildPairMap } from "../src/pairs.js";
import { holdingsSchema } from "../src/schemas.js";
import { JUPITER_PROGRAM_ID } from "../src/signing-policy.js";
import { fillTokenDecimals, resetTokenDecimals } from "../src/token-decimals.js";
import { createMemoryWithdrawJournal, withdrawJournalAction } from "../src/withdraw-journal.js";

const contract = "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";

function evmToken(decimals: number | null): TokenRecord {
  return {
    id: `base:${contract}`,
    ticker: "MPLX",
    names: ["Metaplex"],
    chainKey: "base",
    chain: { kind: "evm", chainId: 8453 },
    contract,
    decimals,
    pairMap: buildPairMap([
      {
        poolAddress: "pool",
        dex: "uniswap",
        chainKey: "base",
        baseSymbol: "MPLX",
        baseAddress: contract,
        quoteSymbol: "USDC",
        quoteAddress: "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
        liquidityUsd: 200_000,
        priceUsd: 0.2,
        baseDecimals: null,
      },
    ]),
    hyperliquid: null,
    refreshedAt: "2026-10-21T00:00:00.000Z",
  };
}

function asSwap(key: string, token: TokenRecord, alternates: readonly TokenRecord[], holdings: SwapIntent["holdings"], config: ReturnType<typeof loadConfig>): SwapIntent {
  const map = (row: TokenRecord): SwapIntent["token"] => ({
    symbol: row.ticker,
    address: row.contract,
    decimals: row.decimals,
    chain: row.chain,
    chainKey: row.chainKey,
    pairMap: row.pairMap,
  });
  return {
    idempotencyKey: key,
    side: "buy",
    notionalUsd: config.maxUsdPerTrade,
    slippageBps: config.maxSlippageBps,
    token: map(token),
    holdings,
    hyperliquid: token.hyperliquid,
    receivedAtMs: Date.parse("2026-10-21T00:00:00.000Z"),
    alternates: alternates.map(map),
  };
}

function buyIntent(decimals: number | null): SwapIntent {
  return {
    idempotencyKey: `id-${Math.random()}`,
    side: "buy",
    notionalUsd: 5,
    slippageBps: 50,
    token: {
      symbol: "MPLX",
      address: contract,
      decimals,
      chain: { kind: "evm", chainId: 8453 },
      chainKey: "base",
      pairMap: evmToken(decimals).pairMap,
    },
    holdings: [{ symbol: "USDC", address: "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb", amount: 20, usd: 20, native: false, decimals: 6, chainKey: "base" }],
    hyperliquid: null,
    receivedAtMs: 0,
  };
}

function deps(read: (() => Promise<number | null>) | null, seen: Array<number | null>): ExecutorDeps {
  return {
    config: {
      maxUsdPerTrade: 5,
      dailyUsdCap: 25,
      maxSlippageBps: 100,
      slippageHardMaxBps: 300,
      maxLeverage: 1,
      minLiquidityUsd: 75_000,
      killSwitch: false,
      enabledChainKeys: new Set(["base"]),
    },
    mode: "dry_run",
    spentTodayUsd: 0,
    quoteHop: async (_hop, context) => {
      seen.push(context.decimals);
      if (context.decimals !== 6) return { priceImpactPct: null, feeUsd: 0, buyAmount: "0" };
      return { priceImpactPct: 0.2, feeUsd: 0.01, buyAmount: "10", signable: true };
    },
    markPrice: async () => null,
    send: async () => {
      throw new Error("dry-run must not send");
    },
    readTokenDecimals: read ? async () => read() : undefined,
  };
}

function signer(calls: string[], address: string): TransactionSigner {
  return {
    backend: "keystore",
    evmAddress: () => null,
    solanaAddress: () => address,
    async signEvm() {
      return "0x";
    },
    async signSolana() {
      calls.push("solana");
      return new Uint8Array();
    },
    async signHyperliquid() {
      return { r: "0x01", s: "0x02", v: 27 };
    },
  };
}

test("an evm quote uses cached erc-20 decimals and skips when they stay unknown", async () => {
  resetTokenDecimals();
  resetExecutorState();
  let reads = 0;
  const filled = await fillTokenDecimals([evmToken(null)], { base: "https://rpc.example" }, async () => {
    reads += 1;
    return 6;
  });
  assert.equal(filled[0]?.decimals, 6);
  await fillTokenDecimals([evmToken(null)], { base: "https://rpc.example" }, async () => {
    reads += 1;
    return 6;
  });
  assert.equal(reads, 1);
  resetTokenDecimals();
  const unknown = await fillTokenDecimals([evmToken(null)], { base: "https://rpc.example" }, async () => null);
  assert.equal(unknown[0]?.decimals, null);

  const seen: Array<number | null> = [];
  const quoted = await execute(buyIntent(null), deps(async () => 6, seen));
  assert.equal(quoted.decision, "would_send");
  assert.deepEqual(seen, [6]);

  resetTokenDecimals();
  resetExecutorState();
  const missed: Array<number | null> = [];
  const skipped = await execute(buyIntent(null), deps(async () => null, missed));
  assert.equal(skipped.decision, "skipped");
  assert.equal(skipped.reason, "no route inside the slippage cap");
  assert.deepEqual(missed, [null]);
});

test("a holding without chainKey is read on the buy chain", async () => {
  const row = { symbol: "USDC", address: "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb", amount: 20, usd: 20, native: false, decimals: 6 };
  assert.equal(holdingsSchema.safeParse([row]).success, true);
  assert.equal(holdingsSchema.safeParse([{ ...row, chainKey: "base" }]).success, true);
  assert.equal(holdingsSchema.safeParse([{ ...row, chainKey: "nope" }]).success, false);
  const seen: Array<string | undefined> = [];
  const read = await holdingsForTrade(
    true,
    [row],
    async (holding) => {
      seen.push(holding.chainKey);
      return holding.chainKey === "base" ? 4 : null;
    },
    "base",
    () => 1,
  );
  assert.equal(read.ok, true);
  if (read.ok) {
    assert.equal(read.holdings[0]?.amount, 4);
    assert.equal(read.holdings[0]?.chainKey, "base");
  }
  const tagged = await holdingsForTrade(
    true,
    [{ ...row, chainKey: "solana" }],
    async (holding) => {
      seen.push(holding.chainKey);
      return 2;
    },
    "base",
    () => 1,
  );
  assert.equal(tagged.ok, true);
  if (tagged.ok) assert.equal(tagged.holdings.length, 0);
  const onSolana = await holdingsForTrade(
    true,
    [{ ...row, address: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v", chainKey: "solana" }],
    async (holding) => {
      seen.push(holding.chainKey);
      return 2;
    },
    "solana",
    () => 1,
  );
  assert.equal(onSolana.ok, true);
  if (onSolana.ok) {
    assert.equal(onSolana.holdings[0]?.amount, 2);
    assert.equal(onSolana.holdings[0]?.chainKey, "solana");
  }
  assert.equal("chainKey" in row, false);
  assert.deepEqual(seen, ["base", "solana"]);
});

test("a native holding is read only on chains of its own asset", async () => {
  const sol = { symbol: "SOL", address: "sol", amount: 1, usd: 150, native: true, decimals: 9 };
  const eth = { symbol: "ETH", address: "eth", amount: 0.1, usd: 300, native: true, decimals: 18 };
  const bnb = { symbol: "BNB", address: "bnb", amount: 0.2, usd: 100, native: true, decimals: 18 };
  const pol = { symbol: "POL", address: "pol", amount: 10, usd: 5, native: true, decimals: 18 };
  const mon = { symbol: "MON", address: "mon", amount: 1, usd: 2, native: true, decimals: 18 };
  const hype = { symbol: "HYPE", address: "hype", amount: 1, usd: 20, native: true, decimals: 18 };
  assert.equal(holdingFitsChain(sol, "solana"), true);
  assert.equal(holdingFitsChain(sol, "base"), false);
  assert.equal(holdingFitsChain({ ...sol, address: "So11111111111111111111111111111111111111112" }, "ethereum"), false);
  assert.equal(holdingFitsChain(eth, "base"), true);
  assert.equal(holdingFitsChain(eth, "ethereum"), true);
  assert.equal(holdingFitsChain(eth, "arbitrum"), true);
  assert.equal(holdingFitsChain(eth, "bnb"), false);
  assert.equal(holdingFitsChain(eth, "solana"), false);
  assert.equal(holdingFitsChain(bnb, "bnb"), true);
  assert.equal(holdingFitsChain(bnb, "base"), false);
  assert.equal(holdingFitsChain(pol, "polygon"), true);
  assert.equal(holdingFitsChain(pol, "ethereum"), false);
  assert.equal(holdingFitsChain(mon, "monad"), true);
  assert.equal(holdingFitsChain(mon, "base"), false);
  assert.equal(holdingFitsChain(hype, "hyperevm"), true);
  assert.equal(holdingFitsChain(hype, "hypercore"), false);
  assert.equal(holdingFitsChain(eth, "robinhood"), true);
  assert.equal(holdingFitsChain(eth, "polygon"), false);
  assert.equal(holdingFitsChain(eth, "hyperevm"), false);
  assert.equal(holdingFitsChain({ ...eth, address: "0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee" }, "base"), true);
  assert.equal(holdingFitsChain({ ...eth, address: "0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee" }, "bnb"), false);
  assert.equal(holdingFitsChain({ ...sol, symbol: "sol", address: "SOL" }, "solana"), true);
  assert.equal(holdingFitsChain({ symbol: "GAS", address: "0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee", amount: 1, usd: 1, native: true }, "base"), false);
  const hyperUsdc = { symbol: "USDC", address: "usdc", amount: 1, usd: 1, native: true, chainKey: "hypercore" };
  assert.equal(holdingFitsChain(hyperUsdc, "hypercore"), true);
  assert.equal(holdingFitsChain(hyperUsdc, "solana"), false);
  assert.equal(holdingsSchema.safeParse([sol, eth]).success, true);
  assert.equal(holdingsSchema.safeParse([{ symbol: "GAS", address: "0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee", amount: 1, usd: 1, native: true }]).success, false);
  assert.equal(holdingsSchema.safeParse([{ symbol: "GAS", address: "0x0000000000000000000000000000000000000000", amount: 1, usd: 1, native: true, chainKey: "base" }]).success, false);
  assert.equal(holdingsSchema.safeParse([{ ...sol, chainKey: "base" }]).success, false);
  assert.equal(holdingsSchema.safeParse([{ ...eth, address: "So11111111111111111111111111111111111111112" }]).success, false);
  assert.equal(holdingsSchema.safeParse([{ ...eth, address: "0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee" }]).success, true);
  assert.equal(holdingsSchema.safeParse([{ symbol: "USDC", address: "usdc", amount: 1, usd: 1, native: true }]).success, false);
  assert.equal(holdingsSchema.safeParse([{ symbol: "MATIC", address: "matic", amount: 1, usd: 1, native: true }]).success, false);
  assert.equal(holdingsSchema.safeParse([{ ...sol, decimals: 6 }]).success, false);
  assert.equal(holdingsSchema.safeParse([{ ...eth, decimals: 9 }]).success, false);
  assert.equal(holdingsSchema.safeParse([hyperUsdc]).success, true);
  assert.equal(holdingsSchema.safeParse([{ symbol: "USDC", address: "sol", amount: 1, usd: 1, native: true }]).success, false);
  const plans = planRoutes({
    tokenSymbol: "MPLX",
    tokenAddress: "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    pairMap: buildPairMap([]),
    holdings: [sol, eth, { symbol: "USDC", address: "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb", amount: 20, usd: 20, native: false, decimals: 6 }],
    minNativeReserve: 0,
    notionalUsd: 5,
    quoteAssets: QUOTE_ASSETS,
    chainKey: "base",
  });
  const sells = plans.map((plan) => (plan.kind === "aggregator" ? plan.hop.sellSymbol : ""));
  assert.deepEqual(sells.sort(), ["ETH", "USDC"]);
  const seen: string[] = [];
  const read = await holdingsForTrade(true, [sol, eth], async (holding) => {
    seen.push(`${holding.symbol}:${holding.chainKey}`);
    return 1;
  }, "base", () => 1);
  assert.equal(read.ok, true);
  if (read.ok) assert.deepEqual(read.holdings.map((holding) => holding.symbol), ["ETH"]);
  assert.deepEqual(seen, ["ETH:base"]);
  assert.equal("chainKey" in sol, false);
  assert.equal("chainKey" in eth, false);
  const seenSol: string[] = [];
  const onSolana = await holdingsForTrade(true, [sol, eth], async (holding) => {
    seenSol.push(`${holding.symbol}:${holding.chainKey}`);
    return 1;
  }, "solana", () => 1);
  assert.equal(onSolana.ok, true);
  if (onSolana.ok) assert.deepEqual(onSolana.holdings.map((holding) => holding.symbol), ["SOL"]);
  assert.deepEqual(seenSol, ["SOL:solana"]);
  const seenTagged: string[] = [];
  const taggedOnEthereum = await holdingsForTrade(true, [sol, { ...eth, chainKey: "base" }], async (holding) => {
    seenTagged.push(`${holding.symbol}:${holding.chainKey}`);
    return 1;
  }, "ethereum", () => 1);
  assert.equal(taggedOnEthereum.ok, true);
  if (taggedOnEthereum.ok) assert.deepEqual(taggedOnEthereum.holdings, []);
  assert.deepEqual(seenTagged, []);
  const taggedAway = planRoutes({
    tokenSymbol: "MPLX",
    tokenAddress: "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    pairMap: buildPairMap([]),
    holdings: [sol, { ...eth, chainKey: "base" }],
    minNativeReserve: 0,
    notionalUsd: 5,
    quoteAssets: QUOTE_ASSETS,
    chainKey: "ethereum",
  });
  assert.deepEqual(taggedAway, []);
});

test("an untagged holding funds an alternate chain", async () => {
  resetExecutorState();
  const auth = "0123456789abcdef";
  const holding: { symbol: string; address: string; amount: number; usd: number; native: boolean; decimals: number; chainKey?: string } = {
    symbol: "USDC",
    address: "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
    amount: 20,
    usd: 20,
    native: false,
    decimals: 6,
  };
  const solHolding = { ...holding, address: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v" };
  const config = loadConfig({
    EXECUTOR_AUTH_TOKEN: auth, RESOLVER_AUTH_TOKEN: "resolver-token-123456",
    LISTING_TRADER_LIVE: "true",
    RESOLVER_URL: "http://resolver.railway.internal:8080",
  });
  const resolution = {
    kind: "hit",
    token: evmToken(6),
    alternates: [
      {
        id: "solana:mint",
        ticker: "MPLX",
        names: ["Metaplex"],
        chainKey: "solana",
        chain: { kind: "solana" },
        contract: "mint",
        decimals: 6,
        pairMap: buildPairMap([
          {
            poolAddress: "pool",
            dex: "raydium",
            chainKey: "solana",
            baseSymbol: "MPLX",
            baseAddress: "mint",
            quoteSymbol: "USDC",
            quoteAddress: "usdc",
            liquidityUsd: 200_000,
            priceUsd: 0.2,
            baseDecimals: 6,
          },
        ]),
        hyperliquid: null,
        refreshedAt: "2026-10-21T00:00:00.000Z",
      },
    ],
  };
  const kinds: string[] = [];
  const runtime: ExecutorDeps = {
    config,
    mode: "live",
    spentTodayUsd: 0,
    quoteHop: async (hop) => {
      kinds.push(hop.chain.kind);
      return { priceImpactPct: 0.2, feeUsd: 0.01, buyAmount: "10", signable: true };
    },
    markPrice: async () => null,
    send: async () => landedSend(),
    now: () => 1_050,
    priceOf: () => 1,
  };
  const response = await execute(asSwap("untagged-alt", resolution.token, resolution.alternates as TokenRecord[], [holding, solHolding], config), {
    ...runtime,
    readBalance: async () => 20,
  });
  assert.equal(response.decision, "sent");
  assert.deepEqual(kinds.slice().sort(), ["evm", "solana"]);
  assert.equal(holding.chainKey, undefined);
  assert.equal(solHolding.chainKey, undefined);

  resetExecutorState();
  const taggedKinds: string[] = [];
  const tagged = { ...holding, chainKey: "base" };
  const taggedResponse = await execute(asSwap("tagged-base", resolution.token, resolution.alternates as TokenRecord[], [tagged], config), {
    ...runtime,
    quoteHop: async (hop) => {
      taggedKinds.push(hop.chain.kind);
      return { priceImpactPct: 0.2, feeUsd: 0.01, buyAmount: "10", signable: true };
    },
    readBalance: async (row) => (row.chainKey === "base" ? 20 : null),
  });
  assert.equal(taggedResponse.decision, "sent");
  assert.deepEqual(taggedKinds, ["evm"]);
});

test("a null or thrown read skips that holding and the other chain still quotes", async () => {
  const evm = "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
  const other = "0xcccccccccccccccccccccccccccccccccccccccc";
  const sol = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
  const row = { symbol: "USDC", amount: 20, usd: 20, native: false, decimals: 6 };
  const seen: string[] = [];
  const partial = await holdingsForTrade(
    true,
    [
      { ...row, address: evm },
      { ...row, address: other },
    ],
    async (holding) => (holding.address === evm ? 4 : null),
    "base",
    () => 1,
  );
  assert.equal(partial.ok, true);
  if (partial.ok) {
    assert.equal(partial.holdings.length, 1);
    assert.equal(partial.holdings[0]?.amount, 4);
  }
  const wsol = "So11111111111111111111111111111111111111112";
  const thrown = await holdingsForTrade(
    true,
    [
      { ...row, address: evm },
      { ...row, address: sol },
      { ...row, address: wsol },
    ],
    async (holding) => {
      seen.push(holding.address);
      if (holding.address === sol) throw new Error("invalid public key");
      return 5;
    },
    "solana",
    () => 1,
  );
  assert.equal(thrown.ok, true);
  if (thrown.ok) {
    assert.equal(thrown.holdings.length, 1);
    assert.equal(thrown.holdings[0]?.address, wsol);
  }
  assert.deepEqual(seen, [sol, wsol]);
  const unread = await holdingsForTrade(true, [{ ...row, address: sol }], async () => {
    throw new Error("rpc down");
  }, "solana", () => 1);
  assert.equal(unread.ok, false);

  resetExecutorState();
  const auth = "0123456789abcdef";
  const config = loadConfig({
    EXECUTOR_AUTH_TOKEN: auth, RESOLVER_AUTH_TOKEN: "resolver-token-123456",
    LISTING_TRADER_LIVE: "true",
    RESOLVER_URL: "http://resolver.railway.internal:8080",
  });
  const resolution = {
    kind: "hit",
    token: evmToken(6),
    alternates: [
      {
        id: "solana:mint",
        ticker: "MPLX",
        names: ["Metaplex"],
        chainKey: "solana",
        chain: { kind: "solana" },
        contract: "mint",
        decimals: 6,
        pairMap: buildPairMap([
          {
            poolAddress: "pool",
            dex: "raydium",
            chainKey: "solana",
            baseSymbol: "MPLX",
            baseAddress: "mint",
            quoteSymbol: "USDC",
            quoteAddress: sol,
            liquidityUsd: 200_000,
            priceUsd: 0.2,
            baseDecimals: 6,
          },
        ]),
        hyperliquid: null,
        refreshedAt: "2026-10-21T00:00:00.000Z",
      },
    ],
  };
  const kinds: string[] = [];
  const response = await execute(
    asSwap("chain-failure", resolution.token, resolution.alternates as TokenRecord[], [
      { ...row, address: evm },
      { ...row, address: sol },
    ], config),
    {
      config,
      mode: "live",
      spentTodayUsd: 0,
      quoteHop: async (hop) => {
        if (hop.chain.kind === "solana") throw new Error("solana quote failed");
        kinds.push(hop.chain.kind);
        return { priceImpactPct: 0.2, feeUsd: 0.01, buyAmount: "10", signable: true };
      },
      markPrice: async () => null,
      send: async () => landedSend(),
      now: () => 1_050,
      priceOf: () => 1,
      readBalance: async () => 20,
    },
  );
  assert.equal(response.decision, "sent");
  assert.deepEqual(kinds, ["evm"]);
});

function tierToken(chainKey: string, chainId: number): SwapIntent["token"] {
  return {
    symbol: "TKN",
    address: contract,
    decimals: 6,
    chain: { kind: "evm", chainId },
    chainKey,
    pairMap: buildPairMap([
      {
        poolAddress: "pool",
        dex: "uniswap",
        chainKey,
        baseSymbol: "TKN",
        baseAddress: contract,
        quoteSymbol: "USDC",
        quoteAddress: "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
        liquidityUsd: 200_000,
        priceUsd: 0.5,
        baseDecimals: 6,
      },
    ]),
  };
}

test("live support tiers fall through to a live alternate and never quote a non-live alternate", async () => {
  const tiers = (chainKey: string): "live" | "dry_run" | "disabled" => (chainKey === "zksync" ? "dry_run" : chainKey === "monad" ? "disabled" : "live");
  const tierIntent = (key: string, primary: SwapIntent["token"], alternates: SwapIntent["alternates"]): SwapIntent => ({
    idempotencyKey: key,
    side: "buy",
    notionalUsd: 5,
    slippageBps: 50,
    token: primary,
    holdings: ["zksync", "base", "monad"].map((chainKey) => ({
      symbol: "USDC",
      address: "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
      amount: 20,
      usd: 20,
      native: false,
      decimals: 6,
      chainKey,
    })),
    hyperliquid: null,
    receivedAtMs: 0,
    alternates,
  });
  const tierDeps = (quoted: number[], sends: string[]): ExecutorDeps => ({
    config: {
      maxUsdPerTrade: 5,
      dailyUsdCap: 25,
      maxSlippageBps: 100,
      slippageHardMaxBps: 300,
      maxLeverage: 1,
      minLiquidityUsd: 75_000,
      killSwitch: false,
      enabledChainKeys: new Set(["zksync", "base", "monad"]),
    },
    mode: "live",
    spentTodayUsd: 0,
    quoteHop: async (hop) => {
      const chainId = hop.chain.kind === "evm" ? hop.chain.chainId : 0;
      quoted.push(chainId);
      return { priceImpactPct: chainId === 143 ? 0.1 : 0.2, feeUsd: 0.01, buyAmount: "10", signable: true };
    },
    markPrice: async () => null,
    send: async (request) => {
      sends.push(request.chain.kind === "evm" ? String(request.chain.chainId) : request.chain.kind);
      return landedSend();
    },
    readBalance: async () => 20,
    priceOf: () => 1,
    supportTierFor: tiers,
    now: () => 1_050,
  });

  resetExecutorState();
  const fallthroughQuoted: number[] = [];
  const fallthroughSends: string[] = [];
  const fallthrough = await execute(tierIntent("tier-fallthrough", tierToken("zksync", 324), [tierToken("base", 8453)]), tierDeps(fallthroughQuoted, fallthroughSends));
  assert.equal(fallthrough.decision, "sent");
  assert.equal(fallthrough.venue, "base");
  assert.deepEqual(fallthroughQuoted, [8453]);
  assert.deepEqual(fallthroughSends, ["8453"]);

  resetExecutorState();
  const disabledQuoted: number[] = [];
  const disabledSends: string[] = [];
  const disabledAlternate = await execute(tierIntent("tier-disabled-alternate", tierToken("base", 8453), [tierToken("monad", 143)]), tierDeps(disabledQuoted, disabledSends));
  assert.equal(disabledAlternate.decision, "sent");
  assert.equal(disabledAlternate.venue, "base");
  assert.deepEqual(disabledQuoted, [8453]);
  assert.deepEqual(disabledSends, ["8453"]);

  resetExecutorState();
  const blockedQuoted: number[] = [];
  const blockedSends: string[] = [];
  const blocked = await execute(tierIntent("tier-blocked", tierToken("zksync", 324), [tierToken("monad", 143)]), tierDeps(blockedQuoted, blockedSends));
  assert.equal(blocked.decision, "skipped");
  assert.equal(blocked.reason, "chain is not enabled for live sends");
  assert.deepEqual(blockedQuoted, []);
  assert.deepEqual(blockedSends, []);
});

test("a flagged alternate is never quoted or sent, and a disabled hypercore route is never sent", async () => {
  const holdings = ["ethereum", "base"].map((chainKey) => ({
    symbol: "USDC",
    address: "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
    amount: 20,
    usd: 20,
    native: false,
    decimals: 6,
    chainKey,
  }));
  const baseDeps = (quoted: number[], sends: string[], shortfall: boolean): ExecutorDeps => ({
    config: {
      maxUsdPerTrade: 5,
      dailyUsdCap: 25,
      maxSlippageBps: 100,
      slippageHardMaxBps: 300,
      maxLeverage: 1,
      minLiquidityUsd: 75_000,
      killSwitch: false,
      enabledChainKeys: new Set(["ethereum", "base"]),
    },
    mode: "live",
    spentTodayUsd: 0,
    quoteHop: async (hop) => {
      const chainId = hop.chain.kind === "evm" ? hop.chain.chainId : 0;
      quoted.push(chainId);
      return { priceImpactPct: chainId === 8453 ? 0.1 : 0.2, feeUsd: 0.01, buyAmount: "10", signable: true };
    },
    markPrice: async () => null,
    send: async (request) => {
      sends.push(request.chain.kind === "evm" ? String(request.chain.chainId) : request.chain.kind);
      return { venue: "chain", outcome: "landed", txs: [{ chainKey: "base", txHash: "0x01", from: "owner", to: "router", value: "0", outcome: "landed" }], held: null, shortfall };
    },
    readBalance: async () => 20,
    priceOf: () => 1,
    now: () => 1_050,
  });
  const swap = (key: string, primary: SwapIntent["token"], alternates: SwapIntent["alternates"]): SwapIntent => ({
    idempotencyKey: key,
    side: "buy",
    notionalUsd: 5,
    slippageBps: 50,
    token: primary,
    holdings,
    hyperliquid: null,
    receivedAtMs: 0,
    alternates,
  });

  resetExecutorState();
  const flagQuoted: number[] = [];
  const flagSends: string[] = [];
  const flagged = await execute(swap("flag-source", tierToken("base", 8453), []), baseDeps(flagQuoted, flagSends, true));
  assert.equal(flagged.decision, "sent");
  const altQuoted: number[] = [];
  const altSends: string[] = [];
  const picked = await execute(swap("flag-alternate", tierToken("ethereum", 1), [tierToken("base", 8453)]), baseDeps(altQuoted, altSends, false));
  assert.equal(picked.decision, "sent");
  assert.equal(picked.venue, "ethereum");
  assert.deepEqual(altQuoted, [1]);
  assert.deepEqual(altSends, ["1"]);

  const hyperToken: SwapIntent["token"] = {
    symbol: "TKN",
    address: "mint",
    decimals: 6,
    chain: { kind: "solana" },
    chainKey: "solana",
    pairMap: buildPairMap([
      { poolAddress: "p", dex: "raydium", chainKey: "solana", baseSymbol: "TKN", baseAddress: "mint", quoteSymbol: "SOL", quoteAddress: "So11111111111111111111111111111111111111112", liquidityUsd: 100, priceUsd: 0.5, baseDecimals: 6 },
    ]),
  };
  const hyperIntent = (key: string): SwapIntent => ({
    idempotencyKey: key,
    side: "buy",
    notionalUsd: 5,
    slippageBps: 50,
    token: hyperToken,
    holdings: [{ symbol: "USDC", address: "usdc", amount: 20, usd: 20, native: false, decimals: 6, chainKey: "solana" }],
    hyperliquid: { coin: "TKN", assetIndex: 4, market: "perp", maxLeverage: 5 },
    receivedAtMs: 0,
    alternates: [{ ...tierToken("base", 8453), pairMap: buildPairMap([{ poolAddress: "p", dex: "uniswap", chainKey: "base", baseSymbol: "TKN", baseAddress: contract, quoteSymbol: "USDC", quoteAddress: "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb", liquidityUsd: 100, priceUsd: 0.5, baseDecimals: 6 }]) }],
  });
  const hyperDeps = (sends: string[], enabled: string[], tier: "live" | "disabled"): ExecutorDeps => ({
    config: {
      maxUsdPerTrade: 5,
      dailyUsdCap: 25,
      maxSlippageBps: 100,
      slippageHardMaxBps: 300,
      maxLeverage: 1,
      minLiquidityUsd: 75_000,
      killSwitch: false,
      enabledChainKeys: new Set(enabled),
    },
    mode: "live",
    spentTodayUsd: 0,
    quoteHop: async () => ({ priceImpactPct: 0.2, feeUsd: 0.01, buyAmount: "10", signable: true }),
    markPrice: async () => 1,
    szDecimals: async () => 2,
    send: async () => {
      sends.push("hypercore");
      return { venue: "hypercore", txs: [], fill: { totalSz: "1", avgPx: "1" } };
    },
    readBalance: async () => 20,
    priceOf: () => 1,
    supportTierFor: (chainKey) => (chainKey === "hypercore" ? tier : "live"),
    now: () => 1_050,
  });

  resetExecutorState();
  const tierSends: string[] = [];
  const tierOff = await execute(hyperIntent("hyper-tier-off"), hyperDeps(tierSends, ["solana", "base", "hypercore"], "disabled"));
  assert.equal(tierOff.decision, "skipped");
  assert.deepEqual(tierSends, []);

  resetExecutorState();
  const disabledSends: string[] = [];
  const disabled = await execute(hyperIntent("hyper-disabled"), hyperDeps(disabledSends, ["solana", "base"], "live"));
  assert.equal(disabled.decision, "skipped");
  assert.deepEqual(disabledSends, []);
});

test("SOLANA_PROGRAM_ALLOWLIST adds to the base programs", () => {
  const extra = "Extra111111111111111111111111111111111111";
  const config = loadConfig({ SOLANA_PROGRAM_ALLOWLIST: extra });
  assert.equal(config.solanaProgramAllowlist.includes(JUPITER_PROGRAM_ID), true);
  assert.equal(config.solanaProgramAllowlist.includes(extra), true);
});

test("a bad jupiter body does not abort the other quotes", async () => {
  resetProviderGuards();
  const config = loadConfig({ OKX_API_KEY: "k", OKX_API_SECRET: "s", OKX_API_PASSPHRASE: "p" });
  const quote = await raceProviderQuotes(
    config,
    { sellAddress: "in", buyAddress: "out", sellAmount: "1000", chain: { kind: "solana" } },
    { spentUsd: 5, priceUsd: 1, decimals: 6 },
    async (input) => {
      const host = new URL(String(input)).hostname;
      if (host === "api.jup.ag") return new Response(JSON.stringify({ outAmount: "10", priceImpactPct: "nope" }), { status: 200 });
      return new Response(JSON.stringify({ code: "0", data: [{ toTokenAmount: "1000" }] }), { status: 200 });
    },
  );
  assert.equal(quote.provider, "okx");
  assert.equal(quote.priceImpactPct !== null, true);
});

test("spl recovery pays the destination associated token account", async () => {
  const payer = Keypair.generate();
  const destination = Keypair.generate().publicKey;
  const mint = Keypair.generate().publicKey;
  const source = Keypair.generate().publicKey;
  const program = new PublicKey("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA");
  const input = {
    payer: payer.publicKey,
    destinationOwner: destination,
    mint,
    source,
    program,
    amount: 1000n,
    decimals: 6,
  };
  const instructions = tokenRecoveryInstructions(input);
  const again = tokenRecoveryInstructions(input);
  const ata = associatedTokenAccount(destination, mint, program);
  assert.notEqual(ata.toBase58(), destination.toBase58());
  assert.equal(instructions[0]?.data[0], 1);
  assert.equal(instructions[1]?.data[0], 12);
  assert.equal(instructions[1]?.data[9], 6);
  assert.equal(instructions[1]?.keys[2]?.pubkey.toBase58(), ata.toBase58());
  assert.deepEqual(
    again.map((item) => item.data.toString("hex")),
    instructions.map((item) => item.data.toString("hex")),
  );
  const raw = new VersionedTransaction(
    new TransactionMessage({
      payerKey: payer.publicKey,
      recentBlockhash: "11111111111111111111111111111111",
      instructions,
    }).compileToV0Message(),
  ).serialize();
  const calls: string[] = [];
  const allowed = withPolicy(signer(calls, payer.publicKey.toBase58()), loadConfig({ OWNER_WITHDRAW_ADDRESSES: destination.toBase58() }));
  await allowed.signSolana(raw);
  assert.deepEqual(calls, ["solana"]);
  const stranger = Keypair.generate().publicKey;
  const denied = withPolicy(signer(calls, payer.publicKey.toBase58()), loadConfig({ OWNER_WITHDRAW_ADDRESSES: stranger.toBase58() }));
  await assert.rejects(() => denied.signSolana(raw), /not allowlisted/);
  assert.deepEqual(calls, ["solana"]);
});

test("screening a denied primary still sends a clean alternate", async () => {
  const screenDeps = (sends: string[], deny: ReadonlySet<string>): ExecutorDeps => ({
    config: {
      maxUsdPerTrade: 5,
      dailyUsdCap: 25,
      maxSlippageBps: 100,
      slippageHardMaxBps: 300,
      maxLeverage: 1,
      minLiquidityUsd: 75_000,
      killSwitch: false,
      enabledChainKeys: new Set(["ethereum", "base"]),
    },
    mode: "live",
    spentTodayUsd: 0,
    quoteHop: async () => ({ priceImpactPct: 0.2, feeUsd: 0.01, buyAmount: "10", signable: true }),
    markPrice: async () => null,
    send: async (request) => {
      sends.push(request.chain.kind === "evm" ? String(request.chain.chainId) : request.chain.kind);
      return landedSend();
    },
    readBalance: async () => 20,
    priceOf: () => 1,
    screenToken: async (token) => (deny.has(token.chainKey) ? "deny" : "allow"),
    now: () => 1_050,
  });
  const screenIntent = (key: string): SwapIntent => ({
    idempotencyKey: key,
    side: "buy",
    notionalUsd: 5,
    slippageBps: 50,
    token: tierToken("ethereum", 1),
    holdings: ["ethereum", "base"].map((chainKey) => ({
      symbol: "USDC",
      address: "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
      amount: 20,
      usd: 20,
      native: false,
      decimals: 6,
      chainKey,
    })),
    hyperliquid: null,
    receivedAtMs: 0,
    alternates: [tierToken("base", 8453)],
  });

  resetExecutorState();
  const fallthroughSends: string[] = [];
  const fallthrough = await execute(screenIntent("screen-fallthrough"), screenDeps(fallthroughSends, new Set(["ethereum"])));
  assert.equal(fallthrough.decision, "sent");
  assert.equal(fallthrough.venue, "base");
  assert.deepEqual(fallthroughSends, ["8453"]);

  resetExecutorState();
  const blockedSends: string[] = [];
  const blocked = await execute(screenIntent("screen-blocked"), screenDeps(blockedSends, new Set(["ethereum", "base"])));
  assert.equal(blocked.decision, "skipped");
  assert.equal(blocked.reason, "token screening rejected the contract");
  assert.deepEqual(blockedSends, []);
});

test("a reverted withdraw releases its reservation and a pending one keeps it", async () => {
  assert.equal(withdrawJournalAction("landed"), "commit");
  assert.equal(withdrawJournalAction("pending"), "keep");
  assert.equal(withdrawJournalAction("reverted"), "release");
  assert.equal(withdrawJournalAction("expired"), "release");

  const journal = createMemoryWithdrawJournal();
  assert.equal(await journal.reserve("withdraw:reverted", "base:native", 1, "2026-10-21", 1), "reserved");
  await journal.release("withdraw:reverted");
  assert.equal(await journal.reserve("withdraw:reverted", "base:native", 1, "2026-10-21", 1), "reserved");
  await journal.commit("withdraw:reverted");
  assert.equal(await journal.reserve("withdraw:next", "base:native", 1, "2026-10-21", 1), "cap");
});
