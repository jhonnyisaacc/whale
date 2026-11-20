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
    openOrders: fixture("open-orders"),
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
    ["clearinghouseState", "metaAndAssetCtxs", "openOrders"],
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
    oid: 611279843652,
    coin: "ZEC",
    side: "buy",
    limitPx: "792.63",
    size: "162.56",
    originalSize: "162.56",
    reduceOnly: null,
    placedAtMs: 1795173781500,
  });
});

test("reduce-only resting orders keep their flag", async () => {
  const { fetchImpl } = infoServer({ openOrders: fixture("open-orders-reduce-only") });
  const account = await read(fetchImpl);
  assert.deepEqual(account.openOrders.map((order) => [order.coin, order.side, order.reduceOnly]), [
    ["ZEC", "sell", true],
    ["NEAR", "sell", true],
  ]);
});

test("an unknown info shape is refused instead of read as empty", async () => {
  const state = fixture("clearinghouse-state") as { assetPositions: { type: string; position: { leverage: { type: string }; liquidationPx: unknown } }[] };
  const variants: [string, Record<string, unknown>, RegExp][] = [
    ["hedge mode", { clearinghouseState: { ...state, assetPositions: [{ ...state.assetPositions[0], type: "twoWay" }] } }, /clearinghouseState has an unknown shape at assetPositions\.0\.type/],
    ["unknown margin mode", { clearinghouseState: { ...state, assetPositions: [{ ...state.assetPositions[0], position: { ...state.assetPositions[0]!.position, leverage: { type: "portfolio", value: 3 } } }] } }, /unknown shape at assetPositions\.0\.position\.leverage/],
    ["numeric price", { clearinghouseState: { ...state, assetPositions: [{ ...state.assetPositions[0], position: { ...state.assetPositions[0]!.position, liquidationPx: 81806.1 } }] } }, /unknown shape at assetPositions\.0\.position\.liquidationPx/],
    ["error object", { openOrders: { error: "rate limited" } }, /openOrders has an unknown shape at the root/],
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
  await assert.rejects(read(fetchImpl), /hyperliquid info (clearinghouseState|openOrders|metaAndAssetCtxs) returned 429/);
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

test("with no account address set, perp_positions reads whale-signer's EVM address", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "whale-perp-"));
  const keystore = path.join(dir, "keystore.json");
  writeFileSync(keystore, JSON.stringify({ evmAddress: ACCOUNT, solanaAddress: "11111111111111111111111111111111" }));
  writeFileSync(path.join(dir, "keystore.token"), "t".repeat(32));
  const { fetchImpl, bodies } = infoServer();
  await run({ kind: "perp_positions" }, commandDeps({ WHALE_SIGNER_KEYSTORE: keystore }, { kind: "perp_positions" }, fetchImpl));
  assert.ok(bodies.some((body) => body.user === ACCOUNT));
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
