import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { loadConfig } from "../src/config.js";
import type { SwapIntent } from "../src/domain.js";
import { createExecutor } from "../src/executor-server.js";
import type { HyperliquidAction } from "../src/hyperliquid.js";
import { keystoreSigner, withPolicy } from "../src/managed-signer.js";
import { screenToken } from "../src/screening.js";

type Captured = { captured: string; request: { type: string }; body: { universe: Array<{ name: string; isDelisted?: boolean }> } };

const mainnetMeta = JSON.parse(readFileSync(new URL("../../test/fixtures/hyperliquid-markets/meta.json", import.meta.url), "utf8")) as Captured;
const HL = "https://hl.invalid";

function hyperliquidInfo(asked: Array<{ url: string; body: unknown }>, status = 200): typeof fetch {
  return (async (input: RequestInfo | URL, init?: RequestInit) => {
    asked.push({ url: String(input), body: JSON.parse(String(init?.body)) });
    return new Response(JSON.stringify(mainnetMeta.body), { status });
  }) as typeof fetch;
}

const perp = (contract: string) => ({ chainKey: "hypercore", chain: { kind: "hypercore" as const, market: "perp" as const }, contract });

test("the captured meta is mainnet's main-dex perp universe with delisted rows and no builder-deployed names", () => {
  assert.deepEqual(mainnetMeta.request, { type: "meta" });
  const names = mainnetMeta.body.universe.map((row) => row.name);
  assert.equal(names.indexOf("HYPE"), 159);
  assert.equal(mainnetMeta.body.universe.find((row) => row.name === "MATIC")?.isDelisted, true);
  assert.deepEqual(names.filter((name) => name.includes(":")), []);
});

test("with WHALE_BROADCAST on, a HyperCore perp is allowed only when live meta lists it in the main-dex universe", async () => {
  const config = loadConfig({ WHALE_BROADCAST: "true", HYPERLIQUID_API_URL: HL });
  assert.equal(config.screening, true);
  const asked: Array<{ url: string; body: unknown }> = [];
  const info = hyperliquidInfo(asked);
  assert.equal(await screenToken(config, perp("HYPE"), info), "allow");
  assert.equal(await screenToken(config, perp("BTC"), info), "allow");
  assert.deepEqual(asked[0], { url: `${HL}/info`, body: { type: "meta" } });
  assert.deepEqual(new Set(asked.map((row) => row.url)), new Set([`${HL}/info`]));
  for (const refused of ["MATIC", "FTM", "xyz:TSLA", "xyz:NVDA", "hype", "NOTACOIN", "@107", ""]) {
    assert.equal(await screenToken(config, perp(refused), info), "deny", refused);
  }
});

test("a HyperCore spot token is refused without a lookup, since anyone can deploy a spot token", async () => {
  const config = loadConfig({ WHALE_BROADCAST: "true", HYPERLIQUID_API_URL: HL });
  const asked: Array<{ url: string; body: unknown }> = [];
  const spot = { chainKey: "hypercore", chain: { kind: "hypercore" as const, market: "spot" as const }, contract: "HYPE" };
  assert.equal(await screenToken(config, spot, hyperliquidInfo(asked)), "deny");
  assert.deepEqual(asked, []);
});

test("an unreadable meta denies the perp and is not cached, so the next read can allow it", async () => {
  const config = loadConfig({ WHALE_BROADCAST: "true", HYPERLIQUID_API_URL: HL });
  assert.equal(await screenToken(config, perp("HYPE"), hyperliquidInfo([], 503)), "deny");
  const malformed = (async () => new Response(JSON.stringify({ universe: [{ name: 7 }] }), { status: 200 })) as typeof fetch;
  assert.equal(await screenToken(config, perp("HYPE"), malformed), "deny");
  assert.equal(await screenToken(config, perp("HYPE"), async () => { throw new Error("offline"); }), "deny");
  assert.equal(await screenToken(config, perp("HYPE"), hyperliquidInfo([])), "allow");
});

function perpIntent(coin: string, assetIndex: number): SwapIntent {
  return {
    idempotencyKey: `perp-${coin}`,
    side: "buy",
    notionalUsd: 5,
    slippageBps: 50,
    token: { symbol: coin, address: coin, decimals: null, chain: { kind: "hypercore", market: "perp" }, chainKey: "hypercore", pairMap: { pools: [], top: null } },
    holdings: [],
    hyperliquid: { coin, assetIndex, market: "perp", maxLeverage: 3 },
    receivedAtMs: 0,
  };
}

test("with WHALE_BROADCAST on, the real live executor passes a listed perp through screening and refuses a delisted or unlisted coin before signing", async (t) => {
  const config = loadConfig({ WHALE_BROADCAST: "true", HYPERLIQUID_API_URL: HL, MAX_USD_PER_TRADE: "5" });
  const exchange: unknown[] = [];
  const signed: HyperliquidAction[] = [];
  const inner = keystoreSigner({ evm: null, solana: null, hyperliquid: null, evmAddress: null, solanaAddress: null });
  const signer = withPolicy({ ...inner, signHyperliquid: async (action) => (signed.push(action), { r: "0x01", s: "0x02", v: 27 }) }, config);
  t.mock.method(globalThis, "fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (url === `${HL}/exchange`) {
      exchange.push(JSON.parse(String(init?.body)));
      return new Response(JSON.stringify({ status: "ok", response: { type: "order", data: { statuses: [{ filled: { totalSz: "0.08", avgPx: "60" } }] } } }), { status: 200 });
    }
    assert.equal(url, `${HL}/info`, `no request leaves for ${url}`);
    const { type } = JSON.parse(String(init?.body)) as { type: string };
    if (type === "meta") return new Response(JSON.stringify(mainnetMeta.body), { status: 200 });
    if (type === "allMids") return new Response(JSON.stringify({ HYPE: "60", MATIC: "0.2" }), { status: 200 });
    throw new Error(`unexpected info ${type}`);
  });
  const executor = createExecutor(config, signer, null);
  assert.equal(executor.deps.mode, "live");
  assert.ok(executor.deps.screenToken);

  assert.equal(await executor.deps.screenToken({ chainKey: "hypercore", chain: { kind: "hypercore", market: "perp" }, contract: "HYPE" }), "allow");
  const listed = await executor.execute(perpIntent("HYPE", 159));
  assert.notEqual(listed.reason, "token screening rejected the contract");

  for (const [coin, index] of [["MATIC", mainnetMeta.body.universe.findIndex((row) => row.name === "MATIC")], ["NOTACOIN", 0]] as const) {
    const refused = await executor.execute(perpIntent(coin, index));
    assert.deepEqual([refused.decision, refused.reason], ["skipped", "token screening rejected the contract"], coin);
  }
  assert.deepEqual([signed.length, exchange.length], [0, 0]);
});
