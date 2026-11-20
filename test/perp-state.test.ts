import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { parseCommand } from "../src/cli.js";
import { commandDeps } from "../src/command-callers.js";
import { run } from "../src/commands.js";
import { createHandler } from "../src/mcp-server.js";
import { readPerpAccount, type PerpAccount } from "../src/perp-state.js";

const ACCOUNT = "0x780825f3f0ad6799e304fb843387934c1fa06e70";

function fixture(name: string): unknown {
  return JSON.parse(readFileSync(new URL(`../../test/fixtures/hyperliquid/${name}.json`, import.meta.url), "utf8")) as unknown;
}

function infoServer(overrides: Record<string, unknown> = {}) {
  const bodies: Record<string, unknown>[] = [];
  const responses: Record<string, unknown> = {
    clearinghouseState: fixture("clearinghouse-state"),
    frontendOpenOrders: fixture("frontend-open-orders"),
    metaAndAssetCtxs: fixture("meta-and-asset-ctxs"),
    ...overrides,
  };
  const fetchImpl: typeof fetch = async (url, init) => {
    assert.equal(String(url), "https://api.hyperliquid.xyz/info");
    const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
    bodies.push(body);
    return new Response(JSON.stringify(responses[String(body.type)]), { status: 200 });
  };
  return { fetchImpl, bodies };
}

const read = (fetchImpl: typeof fetch) => readPerpAccount("https://api.hyperliquid.xyz", ACCOUNT, fetchImpl);

test("a captured mainnet account reads as positions, margin, and resting orders", async () => {
  const { fetchImpl, bodies } = infoServer();
  const account = await read(fetchImpl);
  assert.deepEqual(
    bodies.map((body) => body.type).sort(),
    ["clearinghouseState", "frontendOpenOrders", "metaAndAssetCtxs"],
  );
  assert.ok(bodies.filter((body) => body.type !== "metaAndAssetCtxs").every((body) => body.user === ACCOUNT));
  assert.equal(account.account, ACCOUNT);
  assert.equal(account.asOfMs, 1795175207763);
  assert.deepEqual(account.margin, {
    accountValueUsd: "1616730.047611",
    totalNotionalUsd: "5771793.5965700001",
    marginUsedUsd: "438386.874474",
    withdrawableUsd: "688847.595387",
    crossAccountValueUsd: "1394908.804825",
    crossMarginUsedUsd: "216565.631688",
    crossMaintenanceMarginUsedUsd: "81566.531623",
  });
  assert.deepEqual(account.positions.map((row) => [row.coin, row.side, row.size, row.leverage.mode]), [
    ["BTC", "short", "64.84306", "cross"],
    ["SOL", "short", "14858.89", "cross"],
    ["UNI", "long", "19833.5", "cross"],
    ["ZEC", "short", "731.53", "isolated"],
  ]);
  const btc = account.positions[0]!;
  assert.equal(btc.entryPx, "62783.3");
  assert.equal(btc.liquidationPx, "81806.1171879182");
  assert.equal(btc.markPx, "61802.0");
  assert.equal(btc.funding.hourlyRate, "-0.0000017757");
  assert.equal(account.positions[2]!.liquidationPx, null);
  assert.equal(account.openOrders.length, 34);
  assert.deepEqual(account.openOrders[0], {
    kind: "limit",
    oid: 611279843652,
    coin: "ZEC",
    side: "buy",
    limitPx: "792.63",
    size: "162.56",
    originalSize: "162.56",
    timeInForce: "Gtc",
    reduceOnly: false,
    clientOrderId: null,
    placedAtMs: 1795173781500,
    attached: [],
  });
});

test("a take-profit on the whole position reads as a trigger order covering the position, not a 0-size limit", async () => {
  const { fetchImpl } = infoServer({ frontendOpenOrders: fixture("frontend-open-orders-position-tpsl") });
  const account = await read(fetchImpl);
  assert.deepEqual(account.openOrders.map((order) => order.coin), ["PAXG", "HYPE"]);
  assert.deepEqual(account.openOrders[0], {
    kind: "trigger",
    oid: 611311305455,
    coin: "PAXG",
    side: "buy",
    orderType: "Take Profit Market",
    isMarket: true,
    triggerPx: "3000.0",
    triggerCondition: "Price below 3000",
    limitPx: "3300.0",
    isPositionTpsl: true,
    size: "entire position",
    reduceOnly: true,
    clientOrderId: null,
    placedAtMs: 1795176524675,
    attached: [],
  });
});

test("a sized stop order keeps its size and where it fires", async () => {
  const { fetchImpl } = infoServer({ frontendOpenOrders: fixture("frontend-open-orders-stop") });
  const account = await read(fetchImpl);
  assert.deepEqual(
    account.openOrders.map((order) =>
      order.kind === "trigger" && !order.isPositionTpsl
        ? [order.kind, order.orderType, order.triggerPx, order.triggerCondition, order.size, order.reduceOnly]
        : [order.kind],
    ),
    [
      ["trigger", "Stop Market", "0.0046", "Price above 0.0046", "200000.0", true],
      ["trigger", "Stop Market", "0.004464", "Price above 0.004464", "125000.0", true],
      ["limit"],
    ],
  );
});

test("a take-profit attached to a pending parent order is listed under that order", async () => {
  const [takeProfit] = fixture("frontend-open-orders-position-tpsl") as Record<string, unknown>[];
  const [parent] = fixture("frontend-open-orders") as Record<string, unknown>[];
  const child = { ...takeProfit, coin: "ZEC", isPositionTpsl: false, sz: "162.56", origSz: "162.56" };
  const { fetchImpl } = infoServer({ frontendOpenOrders: [{ ...parent, children: [child] }] });
  const [order] = (await read(fetchImpl)).openOrders;
  assert.equal(order?.kind, "limit");
  assert.deepEqual(order?.attached.map((row) => [row.kind, row.coin, row.size]), [["trigger", "ZEC", "162.56"]]);
});

test("spot orders from the same frontendOpenOrders call are left out of the perp orders", async () => {
  const { fetchImpl } = infoServer({ frontendOpenOrders: fixture("frontend-open-orders-with-spot") });
  const account = await read(fetchImpl);
  assert.deepEqual(account.openOrders.map((order) => order.coin), ["ETH", "XRP", "BTC", "HYPE", "SOL"]);
});

test("an unknown info shape is refused instead of read as empty", async () => {
  const state = fixture("clearinghouse-state") as { assetPositions: { type: string; position: { leverage: { type: string }; liquidationPx: unknown } }[] };
  const variants: [string, Record<string, unknown>, RegExp][] = [
    ["hedge mode", { clearinghouseState: { ...state, assetPositions: [{ ...state.assetPositions[0], type: "twoWay" }] } }, /clearinghouseState has an unknown shape at assetPositions\.0\.type/],
    ["unknown margin mode", { clearinghouseState: { ...state, assetPositions: [{ ...state.assetPositions[0], position: { ...state.assetPositions[0]!.position, leverage: { type: "portfolio", value: 3 } } }] } }, /unknown shape at assetPositions\.0\.position\.leverage/],
    ["numeric price", { clearinghouseState: { ...state, assetPositions: [{ ...state.assetPositions[0], position: { ...state.assetPositions[0]!.position, liquidationPx: 81806.1 } }] } }, /unknown shape at assetPositions\.0\.position\.liquidationPx/],
    ["error object", { frontendOpenOrders: { error: "rate limited" } }, /frontendOpenOrders has an unknown shape at the root/],
    ["unknown order type", { frontendOpenOrders: [{ ...(fixture("frontend-open-orders-stop") as object[])[0], orderType: "Twap" }] }, /frontendOpenOrders has an unknown shape at 0/],
    ["missing contexts", { metaAndAssetCtxs: [(fixture("meta-and-asset-ctxs") as unknown[])[0], []] }, /metaAndAssetCtxs has an unknown shape/],
  ];
  for (const [label, overrides, message] of variants) {
    await assert.rejects(read(infoServer(overrides).fetchImpl), message, label);
  }
});

test("a position on a coin with no market context is refused", async () => {
  const [meta, ctxs] = fixture("meta-and-asset-ctxs") as [{ universe: { name: string }[] }, unknown[]];
  const universe = meta.universe.map((asset) => (asset.name === "UNI" ? { ...asset, name: "UNI-OLD" } : asset));
  await assert.rejects(read(infoServer({ metaAndAssetCtxs: [{ ...meta, universe }, ctxs] }).fetchImpl), /no market context for UNI/);
});

test("a failed info call names the request type", async () => {
  const fetchImpl: typeof fetch = async () => new Response("busy", { status: 429 });
  await assert.rejects(read(fetchImpl), /hyperliquid info (clearinghouseState|frontendOpenOrders|metaAndAssetCtxs) returned 429/);
});

test("the account must be an EVM address", async () => {
  await assert.rejects(readPerpAccount("https://api.hyperliquid.xyz", "not-an-address", infoServer().fetchImpl), /not an evm address/);
});

test("perp_positions reads the configured account through the command path", async () => {
  const { fetchImpl, bodies } = infoServer();
  const env = { HYPERLIQUID_ACCOUNT_ADDRESS: "0x780825F3F0AD6799E304FB843387934C1FA06E70" };
  const result = await run({ kind: "perp_positions" }, commandDeps(env, { kind: "perp_positions" }, fetchImpl));
  assert.equal(result.kind, "perp_positions");
  assert.equal((result as { account: PerpAccount }).account.positions.length, 4);
  assert.ok(bodies.some((body) => body.user === ACCOUNT));
});

test("with no account address set, perp_positions reads whale-signer's EVM address and needs no signer token", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "whale-perp-"));
  const keystore = path.join(dir, "keystore.json");
  writeFileSync(keystore, JSON.stringify({ evmAddress: ACCOUNT, solanaAddress: "11111111111111111111111111111111" }));
  for (const env of [{ WHALE_SIGNER_KEYSTORE: keystore }, { WHALE_SIGNER_KEYSTORE: keystore, HYPERLIQUID_ACCOUNT_ADDRESS: " " }]) {
    const { fetchImpl, bodies } = infoServer();
    await run({ kind: "perp_positions" }, commandDeps(env, { kind: "perp_positions" }, fetchImpl));
    assert.ok(bodies.some((body) => body.user === ACCOUNT));
  }
});

test("perp_positions with no configured account fails with what to set", async () => {
  await assert.rejects(run({ kind: "perp_positions" }, commandDeps({}, { kind: "perp_positions" })), /set HYPERLIQUID_ACCOUNT_ADDRESS or WHALE_SIGNER_KEYSTORE/);
});

test("the CLI and the MCP server expose perp positions", async () => {
  assert.deepEqual(parseCommand(["perp-positions"]), { kind: "perp_positions" });
  const handle = createHandler({
    executorUrl: "http://executor",
    executorAuthToken: null,
    runCommand: async (command) => {
      assert.deepEqual(command, { kind: "perp_positions" });
      return { kind: "perp_positions", account: await read(infoServer().fetchImpl) };
    },
  });
  const reply = (await handle({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "perp_positions", arguments: {} } })) as { result: { content: { text: string }[] } };
  const value = JSON.parse(reply.result.content[0]!.text) as { kind: string; account: PerpAccount };
  assert.equal(value.kind, "perp_positions");
  assert.equal(value.account.openOrders.length, 34);
});
