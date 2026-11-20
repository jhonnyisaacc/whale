import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import type { Hex } from "viem";
import { buildLeverage, fetchAssetMeta, resetAssetMeta, signL1Action, type HyperliquidAction } from "../src/hyperliquid.js";
import { keystoreSigner, withPolicy } from "../src/managed-signer.js";
import { loadConfig } from "../src/config.js";
import { Secret } from "../src/redact.js";
import { execute, resetExecutorState, type ExecutorDeps, type SendRequest } from "../src/executor.js";
import { buildPairMap } from "../src/pairs.js";
import { intentSchema } from "../src/schemas.js";
import type { HyperliquidMarket, SwapIntent } from "../src/domain.js";

const WALLET_KEY = `0x${"11".repeat(32)}` as Hex;
const material = { evm: null, solana: null, hyperliquid: new Secret(WALLET_KEY), evmAddress: null, solanaAddress: null };
const signerFor = (env: Record<string, string>) => withPolicy(keystoreSigner(material), loadConfig(env));

type HypercoreVector = { name: string; job: { action: HyperliquidAction }; expect: "signed" | "refused"; reason?: string };
const vectors = (name: string) => JSON.parse(readFileSync(new URL(`../../signer/vectors/${name}`, import.meta.url), "utf8")) as unknown;

test("the default config signs isolated 2x leverage and refuses 4x", async () => {
  const signer = signerFor({});
  assert.deepEqual(await signer.signHyperliquid(buildLeverage(4, 2), 1, false), await signL1Action(new Secret(WALLET_KEY), buildLeverage(4, 2), 1, false));
  await signer.signHyperliquid(buildLeverage(4, 3), 1, false);
  await assert.rejects(() => signer.signHyperliquid(buildLeverage(4, 4), 1, false), /^Error: hypercore: leverage 4 exceeds the 3x signing policy$/);
});

test("MAX_PERP_LEVERAGE sets the ceiling, and the old MAX_LEVERAGE name is refused", async () => {
  assert.equal(loadConfig({}).maxLeverage, 3);
  await signerFor({ MAX_PERP_LEVERAGE: "5" }).signHyperliquid(buildLeverage(4, 5), 1, false);
  await assert.rejects(() => signerFor({ MAX_PERP_LEVERAGE: "1" }).signHyperliquid(buildLeverage(4, 2), 1, false), /leverage 2 exceeds the 1x signing policy/);
  assert.throws(() => loadConfig({ MAX_LEVERAGE: "1" }), /^Error: MAX_LEVERAGE is renamed MAX_PERP_LEVERAGE$/);
});

test("the app policy and whale-signer agree on every leverage vector under the default ceiling", async () => {
  const policy = vectors("policy.json") as { hypercore: { maxLeverage: number } };
  assert.equal(policy.hypercore.maxLeverage, loadConfig({}).maxLeverage);
  const cases = (vectors("hypercore.json") as { cases: HypercoreVector[] }).cases.filter((entry) => entry.job.action.type === "updateLeverage");
  assert.deepEqual(cases.map((entry) => [entry.job.action.type === "updateLeverage" && entry.job.action.leverage, entry.expect]), [[1, "signed"], [2, "signed"], [4, "refused"], [2, "signed"]]);
  for (const entry of cases) {
    const verdict = await signerFor({}).signHyperliquid(entry.job.action, 1, false).then(() => "signed", () => "refused");
    assert.equal(verdict, entry.expect, entry.name);
  }
});

test("captured mainnet orders are charged their notional whatever leverage backs them", async () => {
  const order = (a: number, b: boolean, p: string, s: string, r: boolean): HyperliquidAction => ({ type: "order", orders: [{ a, b, p, s, r, t: { limit: { tif: "Ioc" } } }], grouping: "na" });
  const btcBuy = order(0, true, "78752", "0.00638", false);
  await assert.rejects(() => signerFor({}).signHyperliquid(btcBuy, 1, false), /^Error: hypercore: order notional 502\.4377\d* USD exceeds the 5\.15 USD signing policy$/);
  const smallBuy = order(66, true, "2.037", "3.2", true);
  await assert.rejects(() => signerFor({}).signHyperliquid(smallBuy, 1, false), /order notional 6\.518\d* USD exceeds the 5\.15 USD/);
  await signerFor({ MAX_USD_PER_TRADE: "10" }).signHyperliquid(smallBuy, 1, false);
});

const captured = JSON.parse(readFileSync(new URL("../../test/fixtures/hyperliquid/mainnet-meta.json", import.meta.url), "utf8")) as { meta: { universe: { name: string }[] }; mids: Record<string, string> };
const MAINNET = "https://api.hyperliquid.xyz";
const metaFetch = (async () => new Response(JSON.stringify(captured.meta), { status: 200 })) as unknown as typeof fetch;
const perp = (coin: string): HyperliquidMarket => ({ coin, assetIndex: captured.meta.universe.findIndex((row) => row.name === coin), market: "perp", maxLeverage: 50 });

function perpIntent(coin: string, leverage: number | undefined, liquidityUsd = 100): SwapIntent {
  return intentSchema.parse({
    idempotencyKey: `${coin}-${leverage}-${liquidityUsd}`,
    side: "buy",
    notionalUsd: 5,
    slippageBps: 50,
    leverage,
    token: {
      symbol: coin,
      address: "mint",
      decimals: 6,
      chain: { kind: "solana" },
      chainKey: "solana",
      pairMap: buildPairMap([{ poolAddress: "p", dex: "raydium", chainKey: "solana", baseSymbol: coin, baseAddress: "mint", quoteSymbol: "SOL", quoteAddress: "So11111111111111111111111111111111111111112", liquidityUsd, priceUsd: 1, baseDecimals: 6 }]),
    },
    holdings: [{ symbol: "USDC", address: "usdc", amount: 20, usd: 20, native: false, decimals: 6, chainKey: "solana" }],
    hyperliquid: perp(coin),
    receivedAtMs: 0,
  });
}

function perpDeps(mode: "dry_run" | "live", env: Record<string, string>, sent: SendRequest[], liquidityUsd = 100): ExecutorDeps {
  return {
    config: { ...loadConfig(env), enabledChainKeys: new Set(["solana", "hypercore"]) },
    mode,
    liquidityOf: async () => liquidityUsd,
    spentTodayUsd: 0,
    quoteHop: async () => ({ priceImpactPct: 0.2, feeUsd: 0.01, buyAmount: "10", signable: true }),
    markPrice: async (coin) => Number(captured.mids[coin]),
    assetMeta: (market) => fetchAssetMeta(MAINNET, market, metaFetch),
    send: async (request) => {
      sent.push(request);
      return { venue: "hypercore", txs: [], fill: { totalSz: "1", avgPx: "1" } };
    },
    readBalance: async () => 20,
    priceOf: () => 1,
    supportTierFor: () => "live",
    now: () => 1_050,
  };
}

test("a dry run on captured mainnet meta plans updateLeverage at the asked leverage, then the order", async () => {
  resetExecutorState();
  resetAssetMeta();
  const report = await execute(perpIntent("ETH", 2), perpDeps("dry_run", {}, []));
  assert.equal(report.decision, "would_send");
  assert.equal(report.reason, "hypercore ETH leverage 2 isolated limit 1758.8 actions updateLeverage,order");
  const fallback = await execute(perpIntent("ETH", undefined), perpDeps("dry_run", {}, []));
  assert.match(fallback.reason, /^hypercore ETH leverage 1 isolated /);
});

test("a 2x ETH buy sends isolated 2x and an order sized on its 5 USD notional, and both sign under the default policy", async () => {
  resetExecutorState();
  resetAssetMeta();
  const sent: SendRequest[] = [];
  assert.equal((await execute(perpIntent("ETH", 2), perpDeps("live", {}, sent))).decision, "sent");
  const [lever, order] = sent[0]!.hyperliquidActions;
  assert.deepEqual(lever, { type: "updateLeverage", asset: 1, isCross: false, leverage: 2 });
  assert.deepEqual(order, { type: "order", orders: [{ a: 1, b: true, p: "1758.8", s: "0.0028", r: false, t: { limit: { tif: "Ioc" } } }], grouping: "na" });
  for (const action of sent[0]!.hyperliquidActions) await signerFor({}).signHyperliquid(action, 1, false);
});

test("leverage above min(MAX_PERP_LEVERAGE, the asset's maxLeverage from meta) is refused before anything is signed", async () => {
  resetAssetMeta();
  const cases: [string, number, Record<string, string>, string][] = [
    ["ETH", 4, {}, "leverage exceeds 3"],
    ["GMX", 4, { MAX_PERP_LEVERAGE: "5" }, "leverage 4 exceeds the 3x maxLeverage of GMX"],
  ];
  for (const [coin, leverage, env, reason] of cases) {
    resetExecutorState();
    const sent: SendRequest[] = [];
    const report = await execute(perpIntent(coin, leverage), perpDeps("live", env, sent));
    assert.equal(report.decision, "skipped", coin);
    assert.equal(report.reason, reason, coin);
    assert.equal(sent.length, 0, coin);
  }
  resetExecutorState();
  const sent: SendRequest[] = [];
  assert.equal((await execute(perpIntent("GMX", 3), perpDeps("live", { MAX_PERP_LEVERAGE: "5" }, sent))).decision, "sent");
  assert.deepEqual(sent[0]!.hyperliquidActions[0], { type: "updateLeverage", asset: 23, isCross: false, leverage: 3 });
});

test("leverage on a trade that routes to a DEX is refused, not dropped to 1x", async () => {
  resetExecutorState();
  resetAssetMeta();
  const report = await execute(perpIntent("ETH", 2, 2_000_000), perpDeps("live", {}, [], 2_000_000));
  assert.equal(report.decision, "skipped");
  assert.equal(report.reason, "leverage above 1 applies only to a HyperCore perp");
  assert.throws(() => perpIntent("ETH", 1.5), /expected int/);
  assert.throws(() => perpIntent("ETH", 0), /Too small/);
});
