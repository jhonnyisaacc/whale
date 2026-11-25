import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import type { Hex } from "viem";
import { buildLeverage, fetchPerpPosition, signL1Action, type HyperliquidAction } from "../src/hyperliquid.js";
import { fetchHyperMarket, resetHyperMeta } from "../src/hyperliquid-markets.js";
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
  assert.equal(loadConfig({ MAX_PERP_LEVERAGE: "50" }).maxLeverage, 50);
  assert.throws(() => loadConfig({ MAX_PERP_LEVERAGE: "51" }), /^Error: MAX_PERP_LEVERAGE must be a whole number from 1 to 50$/);
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
const ACCOUNT = `0x${"22".repeat(20)}`;
type Clearinghouse = { assetPositions: { position: { coin: string; szi: string; leverage: { type: string; value: number } } }[] };
const accounts = JSON.parse(readFileSync(new URL("../../test/fixtures/hyperliquid/mainnet-clearinghouse.json", import.meta.url), "utf8")) as Record<"isolated" | "cross" | "flat", Clearinghouse>;
const stateFetch = (state: Clearinghouse) => (async () => new Response(JSON.stringify(state), { status: 200 })) as unknown as typeof fetch;
const holding = (from: Clearinghouse, sourceCoin: string, coin: string, szi?: string): Clearinghouse => {
  const row = from.assetPositions.find((item) => item.position.coin === sourceCoin)!;
  return { ...from, assetPositions: [{ ...row, position: { ...row.position, coin, szi: szi ?? row.position.szi } }] };
};
const metaFetch = (async () => new Response(JSON.stringify(captured.meta), { status: 200 })) as unknown as typeof fetch;
const perp = (coin: string): HyperliquidMarket => ({ coin, assetIndex: captured.meta.universe.findIndex((row) => row.name === coin), market: "perp", maxLeverage: 50 });

function perpIntent(coin: string, leverage: number | undefined, liquidityUsd = 100, side: "buy" | "sell" = "buy"): SwapIntent {
  const solanaToken = {
    symbol: coin,
    address: "mint",
    decimals: 6,
    chain: { kind: "solana" },
    chainKey: "solana",
    pairMap: buildPairMap([{ poolAddress: "p", dex: "raydium", chainKey: "solana", baseSymbol: coin, baseAddress: "mint", quoteSymbol: "SOL", quoteAddress: "So11111111111111111111111111111111111111112", liquidityUsd, priceUsd: 1, baseDecimals: 6 }]),
  };
  const hypercoreToken = { symbol: coin, address: coin, decimals: null, chain: { kind: "hypercore", market: "perp" }, chainKey: "hypercore", pairMap: { pools: [], top: null } };
  return intentSchema.parse({
    idempotencyKey: `${coin}-${side}-${leverage}-${liquidityUsd}`,
    side,
    notionalUsd: 5,
    slippageBps: 50,
    leverage,
    token: liquidityUsd < loadConfig({}).minLiquidityUsd ? hypercoreToken : solanaToken,
    holdings: [{ symbol: "USDC", address: "usdc", amount: 20, usd: 20, native: false, decimals: 6, chainKey: "solana" }],
    hyperliquid: perp(coin),
    receivedAtMs: 0,
  });
}

function perpDeps(mode: "dry_run" | "live", env: Record<string, string>, sent: SendRequest[], liquidityUsd = 100, account: Clearinghouse = accounts.flat): ExecutorDeps {
  return {
    config: { ...loadConfig(env), enabledChainKeys: new Set(["solana", "hypercore"]) },
    mode,
    liquidityOf: async () => liquidityUsd,
    spentTodayUsd: 0,
    quoteHop: async () => ({ priceImpactPct: 0.2, feeUsd: 0.01, buyAmount: "10", signable: true }),
    markPrice: async (coin) => Number(captured.mids[coin]),
    hyperMarket: (query) => fetchHyperMarket(MAINNET, query, metaFetch),
    perpPosition: (coin) => fetchPerpPosition(MAINNET, ACCOUNT, coin, stateFetch(account)),
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
  resetHyperMeta();
  const report = await execute(perpIntent("ETH", 2), perpDeps("dry_run", {}, []));
  assert.equal(report.decision, "would_send");
  assert.equal(report.reason, "hypercore ETH asset 1 leverage 2 isolated limit 1758.8 actions updateLeverage,order");
  const fallback = await execute(perpIntent("ETH", undefined), perpDeps("dry_run", {}, []));
  assert.equal(fallback.reason, "hypercore ETH asset 1 leverage 1 isolated limit 1758.8 actions updateLeverage,order");
});

test("a 2x ETH buy sends isolated 2x and an order sized on its 5 USD notional, and both sign under the default policy", async () => {
  resetExecutorState();
  resetHyperMeta();
  const sent: SendRequest[] = [];
  assert.equal((await execute(perpIntent("ETH", 2), perpDeps("live", {}, sent))).decision, "sent");
  const [lever, order] = sent[0]!.hyperliquidActions;
  assert.deepEqual(lever, { type: "updateLeverage", asset: 1, isCross: false, leverage: 2 });
  assert.deepEqual(order, { type: "order", orders: [{ a: 1, b: true, p: "1758.8", s: "0.0028", r: false, t: { limit: { tif: "Ioc" } } }], grouping: "na" });
  for (const action of sent[0]!.hyperliquidActions) await signerFor({}).signHyperliquid(action, 1, false);
});

test("leverage above min(MAX_PERP_LEVERAGE, the asset's maxLeverage from meta) is refused before anything is signed", async () => {
  resetHyperMeta();
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
  resetHyperMeta();
  const report = await execute(perpIntent("ETH", 2, 2_000_000), perpDeps("live", {}, [], 2_000_000));
  assert.equal(report.decision, "skipped");
  assert.equal(report.reason, "leverage above 1 applies only to a HyperCore perp");
  assert.throws(() => perpIntent("ETH", 1.5), /expected int/);
  assert.throws(() => perpIntent("ETH", 0), /Too small/);
});

const label = (action: HyperliquidAction) => (action.type === "order" ? `order ${action.orders[0]!.b ? "buy" : "sell"}` : action.type === "updateLeverage" ? `updateLeverage ${action.leverage}` : action.type);

test("closing a 3x long with a sell that leaves out leverage sends only the sell, never an updateLeverage decrease", async () => {
  resetExecutorState();
  resetHyperMeta();
  const sent: SendRequest[] = [];
  const env = { HYPERCORE_SELL_LIMITS: JSON.stringify({ "hypercore:perp:1:sold": "100000000" }) };
  assert.equal((await execute(perpIntent("ETH", 3), perpDeps("live", env, sent))).decision, "sent");
  const close = await execute(perpIntent("ETH", undefined, 100, "sell"), perpDeps("live", env, sent, 100, holding(accounts.isolated, "HYPE", "ETH")));
  assert.equal(close.decision, "sent", close.reason);
  assert.deepEqual(sent.map((request) => request.hyperliquidActions.map(label)), [["updateLeverage 3", "order buy"], ["order sell"]]);
});

test("captured clearinghouseState responses parse to the position Whale plans against", async () => {
  const read = (account: Clearinghouse, coin: string) => fetchPerpPosition(MAINNET, ACCOUNT, coin, stateFetch(account));
  assert.deepEqual(await read(accounts.isolated, "ETH"), { side: "short", margin: "isolated", leverage: 3 });
  assert.deepEqual(await read(accounts.isolated, "HYPE"), { side: "long", margin: "isolated", leverage: 3 });
  assert.deepEqual(await read(accounts.cross, "ETH"), { side: "long", margin: "cross", leverage: 10 });
  assert.deepEqual(await read(accounts.cross, "WLD"), { side: "short", margin: "cross", leverage: 10 });
  assert.deepEqual(await read(accounts.flat, "ETH"), { side: "flat" });
  assert.deepEqual(await read(accounts.isolated, "BTC"), { side: "flat" });
  await assert.rejects(() => read({ assetPositions: [{ position: { coin: "ETH", szi: "1", leverage: { type: "margin", value: 3 } } }] }, "ETH"));
  const down = (async () => new Response("busy", { status: 502 })) as unknown as typeof fetch;
  await assert.rejects(() => fetchPerpPosition(MAINNET, ACCOUNT, "ETH", down), /clearinghouseState failed/);
});

test("a position read waits out a slow large account, and a read that never answers still fails closed", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const answerAfter = (delayMs: number) =>
    ((_url: string, init?: RequestInit) =>
      new Promise<Response>((resolve, reject) => {
        const timer = setTimeout(() => resolve(new Response(JSON.stringify(accounts.cross), { status: 200 })), delayMs);
        init?.signal?.addEventListener("abort", () => (clearTimeout(timer), reject(init.signal?.reason)), { once: true });
      })) as unknown as typeof fetch;
  const slow = fetchPerpPosition(MAINNET, ACCOUNT, "ETH", answerAfter(4_000));
  t.mock.timers.tick(4_000);
  assert.deepEqual(await slow, { side: "long", margin: "cross", leverage: 10 });

  let settled = false;
  const silent = fetchPerpPosition(MAINNET, ACCOUNT, "ETH", answerAfter(60_000)).finally(() => (settled = true));
  t.mock.timers.tick(4_999);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(settled, false, "the read is still waiting just under 5 s");
  t.mock.timers.tick(1);
  await assert.rejects(silent, /timeout after 5000ms/);
});

test("a fresh sell opens its short at isolated 1x, and the buy that closes it sends no updateLeverage", async () => {
  resetExecutorState();
  resetHyperMeta();
  const sent: SendRequest[] = [];
  const env = { HYPERCORE_SELL_LIMITS: JSON.stringify({ "hypercore:perp:1:sold": "100000000" }) };
  const open = await execute(perpIntent("ETH", undefined, 100, "sell"), perpDeps("live", env, sent));
  assert.equal(open.decision, "sent", open.reason);
  const short = holding(accounts.isolated, "ETH", "ETH", "-0.0028");
  const close = await execute(perpIntent("ETH", undefined), perpDeps("live", env, sent, 100, short));
  assert.equal(close.decision, "sent", close.reason);
  const crossShort = holding(accounts.cross, "WLD", "ETH");
  assert.equal((await execute(perpIntent("ETH", 2), perpDeps("live", env, sent, 100, crossShort))).decision, "sent");
  assert.deepEqual(sent.map((request) => request.hyperliquidActions.map(label)), [["updateLeverage 1", "order sell"], ["order buy"], ["order buy"]]);
  assert.deepEqual(sent[0]!.hyperliquidActions[0], buildLeverage(1, 1));
});

test("a buy on an open isolated long changes leverage only when the intent sets it, and never on a cross long", async () => {
  resetExecutorState();
  resetHyperMeta();
  const sent: SendRequest[] = [];
  const long = holding(accounts.isolated, "HYPE", "ETH");
  assert.equal((await execute(perpIntent("ETH", undefined), perpDeps("live", {}, sent, 100, long))).decision, "sent");
  assert.equal((await execute(perpIntent("ETH", 2), perpDeps("live", {}, sent, 100, long))).decision, "sent");
  assert.deepEqual(sent.map((request) => request.hyperliquidActions.map(label)), [["order buy"], ["updateLeverage 2", "order buy"]]);
  resetExecutorState();
  const cross = await execute(perpIntent("ETH", 2), perpDeps("live", {}, sent, 100, accounts.cross));
  assert.equal(cross.decision, "skipped");
  assert.equal(cross.reason, "leverage cannot be set on the open cross ETH long");
  assert.equal(sent.length, 2);
});

test("a perp trade whose position cannot be read is skipped before anything is signed", async () => {
  resetHyperMeta();
  const down = (async () => new Response("busy", { status: 502 })) as unknown as typeof fetch;
  const cases: [string, Partial<ExecutorDeps>][] = [
    ["info down", { perpPosition: (coin) => fetchPerpPosition(MAINNET, ACCOUNT, coin, down) }],
    ["no account", { perpPosition: undefined }],
  ];
  for (const [name, override] of cases) {
    for (const side of ["buy", "sell"] as const) {
      resetExecutorState();
      const sent: SendRequest[] = [];
      const report = await execute(perpIntent("ETH", undefined, 100, side), { ...perpDeps("live", {}, sent), ...override });
      assert.equal(report.decision, "skipped", name);
      assert.equal(report.reason, "hyperliquid position unreadable", name);
      assert.equal(sent.length, 0, name);
    }
  }
});

test("a buy that leaves out leverage opens at isolated 1x, and leverage on a sell is refused", async () => {
  resetExecutorState();
  resetHyperMeta();
  const sent: SendRequest[] = [];
  const env = { HYPERCORE_SELL_LIMITS: JSON.stringify({ "hypercore:perp:1:sold": "100000000" }) };
  assert.equal((await execute(perpIntent("ETH", undefined), perpDeps("live", env, sent))).decision, "sent");
  assert.deepEqual(sent[0]!.hyperliquidActions.map((action) => action.type), ["updateLeverage", "order"]);
  assert.deepEqual(sent[0]!.hyperliquidActions[0], buildLeverage(1, 1));
  const sell = await execute(perpIntent("ETH", 2, 100, "sell"), perpDeps("live", env, sent));
  assert.equal(sell.decision, "skipped");
  assert.equal(sell.reason, "leverage applies only to a HyperCore perp buy");
  assert.equal(sent.length, 1);
});
