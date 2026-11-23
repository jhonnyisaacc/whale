import assert from "node:assert/strict";
import test from "node:test";
import { recoverTypedDataAddress, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { actionHash, buildLeverage, buildOrder, buildWithdraw, signL1Action, signWithdraw, withdrawTypedData, type HyperliquidAction } from "../src/hyperliquid.js";
import { assertHyperliquidSigning, assertHyperliquidWithdraw } from "../src/signing-policy.js";
import { withdrawHypercore } from "../src/broadcast.js";
import { keystoreSigner, withPolicy } from "../src/managed-signer.js";
import { loadConfig } from "../src/config.js";
import { Secret } from "../src/redact.js";
import { createMemoryWithdrawJournal } from "../src/withdraw-journal.js";
import { execute, resetExecutorState, type ExecutorDeps, type SendRequest } from "../src/executor.js";
import type { SwapIntent } from "../src/domain.js";
import { hyperMarketAt } from "./fixtures.js";

const SDK_KEY = new Secret(`0x${"0123456789".repeat(6)}0123`);
const WALLET_KEY = `0x${"11".repeat(32)}` as Hex;
const OWN = privateKeyToAccount(WALLET_KEY).address.toLowerCase();
const LISTED = "0x2222222222222222222222222222222222222222";
const ATTACKER = "0x00000000000000000000000000000000000bad00";
const TESTNET = "https://api.hyperliquid-testnet.xyz";
const word = (hex: string) => `0x${hex.slice(2).padStart(64, "0")}`;
const sdkOrder = (tif: "Ioc" | "Gtc", p: string, s: string, a: number): HyperliquidAction => ({ type: "order", orders: [{ a, b: true, p, s, r: false, t: { limit: { tif } } }], grouping: "na" });
const limits = { maxLeverage: 1, maxOrderUsd: 100, sellLimits: { "hypercore:perp:4:sold": 50_000_000_000n } };
const perpSell = (a: number, p: string, s: string, r: boolean) => ({ type: "order", orders: [{ a, b: false, p, s, r, t: { limit: { tif: "Ioc" } } }], grouping: "na" });

test("the app hashes and signs L1 actions to the Hyperliquid SDK vectors", async () => {
  assert.equal(actionHash(sdkOrder("Ioc", "1670.1", "0.0147", 4), null, 1677777606040, null), "0x0fcbeda5ae3c4950a548021552a4fea2226858c4453571bf3f24ba017eac2908");
  const mainnet = await signL1Action(SDK_KEY, sdkOrder("Gtc", "100", "100", 1), 0, true);
  assert.deepEqual(mainnet, { r: word("0xd65369825a9df5d80099e513cce430311d7d26ddf477f5b3a33d2806b100d78e"), s: word("0x2b54116ff64054968aa237c20ca9ff68000f977c93289157748a3162b6ea940e"), v: 28 });
  const testnet = await signL1Action(SDK_KEY, sdkOrder("Gtc", "100", "100", 1), 0, false);
  assert.deepEqual(testnet, { r: word("0x82b2ba28e76b3d761093aaded1b1cdad4960b3af30212b343fb2e6cdfa4e3d54"), s: word("0x6b53878fc99d26047f4d7e8c90eb98955a109f44209163f52d8dc4278cbbd9f5"), v: 27 });
});

test("the app builds and signs a withdrawal to the Hyperliquid SDK vector", async () => {
  const action = buildWithdraw({ destination: "0x5E9EE1089755c3435139848e47e6635505d5a13a", amountUsd: 1, time: 1687816341423, isMainnet: false });
  assert.deepEqual(action, { type: "withdraw3", hyperliquidChain: "Testnet", signatureChainId: "0x66eee", destination: "0x5e9ee1089755c3435139848e47e6635505d5a13a", amount: "1", time: 1687816341423 });
  assert.deepEqual(await signWithdraw(SDK_KEY, action), { r: word("0x8363524c799e90ce9bc41022f7c39b4e9bdba786e5f9c72b20e43e1462c37cf9"), s: word("0x58b1411a775938b83e29182e8ef74975f9054c8e97ebf5ec2dc8d51bfc893881"), v: 28 });
  assert.throws(() => buildWithdraw({ destination: OWN, amountUsd: 1.0000001, time: 1, isMainnet: false }), /hypercore/);
});

test("the signing policy bounds every HyperCore action Whale builds and refuses the rest", () => {
  assertHyperliquidSigning(buildLeverage(4, 1), limits);
  assertHyperliquidSigning(buildOrder({ asset: 4, isBuy: true, limitPx: 1670.1, size: 0.0147 }), limits);
  assertHyperliquidSigning(buildOrder({ asset: 4, isBuy: false, limitPx: 0.2, size: 250, reduceOnly: true }), limits);
  assertHyperliquidSigning(buildOrder({ asset: 4, isBuy: false, limitPx: 0.2, size: 250 }), limits);
  assertHyperliquidSigning({ type: "cancel", cancels: [{ a: 4, o: 9 }] } as { type: string }, limits);
  const refusals: [string, unknown, string][] = [
    ["a resting order", sdkOrder("Gtc", "1", "1", 4), "only immediate-or-cancel limit orders are signed"],
    ["an order above the per-trade cap", sdkOrder("Ioc", "101", "1", 4), "order notional 101 USD exceeds the 100 USD signing policy"],
    ["a builder-deployed perp", sdkOrder("Ioc", "1", "1", 110_000), "builder-deployed perps are not signed"],
    ["an order with a client id", { type: "order", orders: [{ a: 4, b: true, p: "1", s: "1", r: false, t: { limit: { tif: "Ioc" } }, c: "0x01" }], grouping: "na" }, "order has fields the signer does not decode"],
    ["an order paying a builder fee", { ...sdkOrder("Ioc", "1", "1", 4), builder: { b: ATTACKER, f: 10 } }, "order action has fields the signer does not decode"],
    ["a reduce-only perp dump at a near-zero price", perpSell(4, "0.00000001", "99999999999", true), "9999999999900000000 of hypercore:perp:4:sold is above its 50000000000 limit"],
    ["a reduce-only perp dump below the per-trade notional", perpSell(4, "0.0000000001", "99999999999", true), "9999999999900000000 of hypercore:perp:4:sold is above its 50000000000 limit"],
    ["a perp short with no size limit", perpSell(5, "0.2", "250", false), "no limit is set for hypercore:perp:5:sold"],
    ["two perp sells past the size limit together", { type: "order", orders: [...perpSell(4, "0.2", "250", false).orders, ...perpSell(4, "0.2", "251", true).orders], grouping: "na" }, "50100000000 of hypercore:perp:4:sold is above its 50000000000 limit"],
    ["cross leverage", { type: "updateLeverage", asset: 4, isCross: true, leverage: 1 }, "only isolated leverage is signed"],
    ["leverage above the cap", buildLeverage(4, 2), "leverage exceeds the signing policy"],
    ["a withdrawal through the agent path", { type: "withdraw3" }, "refusing hyperliquid action withdraw3"],
    ["an unknown action", { type: "noop" }, "unsupported hyperliquid action noop"],
  ];
  for (const [name, action, reason] of refusals) {
    assert.throws(() => assertHyperliquidSigning(action as { type: string }, limits), (error: unknown) => error instanceof Error && error.message === `hypercore: ${reason}`, name);
  }
});

test("the signing policy charges every spot sell by its size, as whale-signer does", () => {
  const spotDump = { type: "order", orders: [{ a: 10107, b: false, p: "0.00000001", s: "5000000000", r: false, t: { limit: { tif: "Ioc" } } }], grouping: "na" };
  assert.throws(() => assertHyperliquidSigning(spotDump, { maxLeverage: 1, maxOrderUsd: 50.5, sellLimits: {} }), /^Error: hypercore: no limit is set for hypercore:spot:10107:sold$/);
  const spotLimits = { maxLeverage: 1, maxOrderUsd: 50.5, sellLimits: { "hypercore:spot:10107:sold": 100_000_000_000n } };
  assert.throws(() => assertHyperliquidSigning(spotDump, spotLimits), /^Error: hypercore: 500000000000000000 of hypercore:spot:10107:sold is above its 100000000000 limit$/);
  const split = { type: "order", orders: [...perpSell(10107, "0.01", "600", false).orders, ...perpSell(10107, "0.01", "500", false).orders], grouping: "na" };
  assert.throws(() => assertHyperliquidSigning(split, spotLimits), /^Error: hypercore: 110000000000 of hypercore:spot:10107:sold is above its 100000000000 limit$/);
  assertHyperliquidSigning(perpSell(10107, "0.01", "1000", false), spotLimits);
  assert.throws(() => assertHyperliquidSigning(perpSell(10107, "0.01", "1000", false), { ...spotLimits, sellLimits: { "hypercore:perp:10107:sold": 100_000_000_000n } }), /^Error: hypercore: no limit is set for hypercore:spot:10107:sold$/);
});

test("the withdraw policy pays only this wallet or the allowlist, within the cap", () => {
  const policy = { owner: OWN, withdrawAllowlist: [LISTED], maxWithdrawUsd: 25, isMainnet: false };
  const at = (destination: string, amountUsd = 10) => buildWithdraw({ destination, amountUsd, time: 5, isMainnet: false });
  assertHyperliquidWithdraw(at(OWN), policy);
  assertHyperliquidWithdraw(at(LISTED), policy);
  const refusals: [string, unknown, string][] = [
    ["an attacker", at(ATTACKER), "withdraw destination is not this wallet or allowlisted"],
    ["above the cap", at(OWN, 26), "withdraw amount 26 USD exceeds the 25 USD signing policy"],
    ["the other network", buildWithdraw({ destination: OWN, amountUsd: 1, time: 5, isMainnet: true }), "withdraw names Mainnet but the signer is on Testnet"],
    ["an extra field", { ...at(OWN), nonce: 1 }, "withdraw has fields the signer does not decode"],
    ["another signature chain", { ...at(OWN), signatureChainId: "0x1" }, "withdraw signatureChainId is not 0x66eee"],
  ];
  for (const [name, action, reason] of refusals) {
    assert.throws(() => assertHyperliquidWithdraw(action as never, policy), (error: unknown) => error instanceof Error && error.message === `hypercore: ${reason}`, name);
  }
});

function wallet() {
  const config = loadConfig({ HYPERLIQUID_API_URL: TESTNET, OWNER_WITHDRAW_ADDRESSES: LISTED, MAX_WITHDRAW_AMOUNT: "25", MAX_WITHDRAW_DAILY_AMOUNT: "30" });
  const signer = withPolicy(keystoreSigner({ evm: new Secret(WALLET_KEY), solana: null, hyperliquid: null, evmAddress: privateKeyToAccount(WALLET_KEY).address, solanaAddress: null }), config);
  const posts: { url: string; body: { action: Parameters<typeof withdrawTypedData>[0]; nonce: number; signature: { r: Hex; s: Hex; v: number } } }[] = [];
  let reply: unknown = { status: "ok", response: { type: "default" } };
  const fetchImpl = (async (url: string, init: { body: string }) => {
    posts.push({ url, body: JSON.parse(init.body) });
    return new Response(JSON.stringify(reply), { status: 200 });
  }) as unknown as typeof fetch;
  return { config, signer, posts, fetchImpl, journal: createMemoryWithdrawJournal(), reply: (value: unknown) => (reply = value) };
}

test("a HyperCore withdrawal to this wallet's Arbitrum address is signed by it and charged to the daily cap", async () => {
  const { config, signer, posts, fetchImpl, journal, reply } = wallet();
  const send = (key: string, to: string, amount: number) => withdrawHypercore({ config, signer, to, amount, key, day: "2026-11-19", journal, fetchImpl, now: () => 1_793_664_000_000 });
  const record = await send("w1", OWN, 20);
  assert.equal(posts[0]?.url, `${TESTNET}/exchange`);
  const posted = posts[0]!.body;
  assert.equal(posted.nonce, posted.action.time);
  const recovered = await recoverTypedDataAddress({ ...withdrawTypedData(posted.action), signature: { r: posted.signature.r, s: posted.signature.s, v: BigInt(posted.signature.v) } });
  assert.equal(recovered.toLowerCase(), OWN);
  assert.equal(record.outcome, "landed");
  await assert.rejects(() => send("w2", LISTED, 11), /^Error: hypercore: daily withdraw cap 30 USD$/);
  await assert.rejects(() => send("w3", ATTACKER, 1), /^Error: hypercore: withdraw destination is not this wallet or allowlisted$/);
  assert.equal(posts.length, 1);
  reply({ status: "err", response: "Insufficient balance" });
  await assert.rejects(() => send("w4", LISTED, 10), /hypercore: hyperliquid rejected the withdrawal: Insufficient balance/);
  reply({ status: "ok", response: { type: "default" } });
  await send("w5", LISTED, 10);
  assert.equal(posts.length, 3);
});

test("a HyperCore perp sell with no long opens a short, as on main, and the signing policy charges it by size", async () => {
  const sent: SendRequest[] = [];
  const intent = (side: "buy" | "sell"): SwapIntent => ({
    idempotencyKey: `hyper-${side}`,
    side,
    notionalUsd: 5,
    slippageBps: 50,
    token: { symbol: "TKN", address: "TKN", decimals: null, chain: { kind: "hypercore", market: "perp" }, chainKey: "hypercore", pairMap: { pools: [], top: null } },
    holdings: [{ symbol: "USDC", address: "usdc", amount: 20, usd: 20, native: false, decimals: 6, chainKey: "solana" }],
    hyperliquid: { coin: "TKN", assetIndex: 4, market: "perp", maxLeverage: 5 },
    receivedAtMs: 0,
  });
  const deps: ExecutorDeps = {
    config: { maxUsdPerTrade: 5, dailyUsdCap: 25, maxSlippageBps: 100, slippageHardMaxBps: 300, maxLeverage: 1, minLiquidityUsd: 75_000, killSwitch: false, enabledChainKeys: new Set(["solana", "hypercore"]) },
    mode: "live",
    liquidityOf: async () => 100,
    spentTodayUsd: 0,
    quoteHop: async () => ({ priceImpactPct: 0.2, feeUsd: 0.01, buyAmount: "10", signable: true }),
    markPrice: async () => 1,
    hyperMarket: hyperMarketAt(4),
    send: async (request) => {
      sent.push(request);
      return { venue: "hypercore", txs: [], fill: { totalSz: "1", avgPx: "1" } };
    },
    readBalance: async () => 20,
    priceOf: () => 1,
    supportTierFor: () => "live",
    now: () => 1_050,
  };
  for (const side of ["buy", "sell"] as const) {
    resetExecutorState();
    assert.equal((await execute(intent(side), deps)).decision, "sent", side);
  }
  const orders = sent.map((request) => request.hyperliquidActions.find((action) => action.type === "order"));
  assert.deepEqual(orders.map((order) => order?.type === "order" && [order.orders[0]?.b, order.orders[0]?.r, order.orders[0]?.s]), [[true, false, "5"], [false, false, "5"]]);
  for (const request of sent) for (const action of request.hyperliquidActions) assertHyperliquidSigning(action, { maxLeverage: 1, maxOrderUsd: 5.15, sellLimits: { "hypercore:perp:4:sold": 500_000_000n } });
  assert.throws(() => assertHyperliquidSigning(orders[1]!, { maxLeverage: 1, maxOrderUsd: 5.15, sellLimits: {} }), /^Error: hypercore: no limit is set for hypercore:perp:4:sold$/);
});

test("HYPERCORE_SELL_LIMITS sets each perp and spot sell size limit in 1e-8 units, refuses keys no sell would use, and the policy refuses a sell without one", async () => {
  assert.deepEqual(loadConfig({}).hypercoreSellLimits, {});
  assert.deepEqual(loadConfig({ HYPERCORE_SELL_LIMITS: '{"hypercore:perp:4:sold":"500000000"}' }).hypercoreSellLimits, { "hypercore:perp:4:sold": 500_000_000n });
  assert.throws(() => loadConfig({ HYPERCORE_SELL_LIMITS: '{"hypercore:perp:4:sold":"5.5"}' }), /^Error: HYPERCORE_SELL_LIMITS/);
  assert.throws(() => loadConfig({ HYPERCORE_SELL_LIMITS: '{"hypercore:spot:4:sold":"5"}' }), /^Error: HYPERCORE_SELL_LIMITS/);
  assert.deepEqual(loadConfig({ HYPERCORE_SELL_LIMITS: '{"hypercore:spot:10107:sold":"500000000","hypercore:perp:0:sold":"1"}' }).hypercoreSellLimits, { "hypercore:spot:10107:sold": 500_000_000n, "hypercore:perp:0:sold": 1n });
  for (const key of ["hypercore:perp:04:sold", "hypercore:spot:010107:sold", "hypercore:perp:99999:sold", "hypercore:perp:10000:sold", "hypercore:spot:9999:sold", "hypercore:spot:100000:sold", "hypercore:perp:100000:sold", "hypercore:usdc"]) {
    assert.throws(() => loadConfig({ HYPERCORE_SELL_LIMITS: JSON.stringify({ [key]: "5" }) }), (error: unknown) => error instanceof Error && error.message.startsWith(`HYPERCORE_SELL_LIMITS key ${key} `), key);
  }
  const material = { evm: null, solana: null, hyperliquid: new Secret(WALLET_KEY), evmAddress: null, solanaAddress: null };
  const short = buildOrder({ asset: 4, isBuy: false, limitPx: 1, size: 5 });
  await assert.rejects(() => withPolicy(keystoreSigner(material), loadConfig({})).signHyperliquid(short, 1, false), /^Error: hypercore: no limit is set for hypercore:perp:4:sold$/);
  const signed = await withPolicy(keystoreSigner(material), loadConfig({ HYPERCORE_SELL_LIMITS: '{"hypercore:perp:4:sold":"500000000"}' })).signHyperliquid(short, 1, false);
  assert.deepEqual(signed, await signL1Action(new Secret(WALLET_KEY), short, 1, false));
});
