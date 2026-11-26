import assert from "node:assert/strict";
import test from "node:test";
import type { Hex } from "viem";
import { buildLeverage, buildOrder, type HyperliquidAction } from "../src/hyperliquid.js";
import { broadcastRoute } from "../src/broadcast.js";
import { keystoreSigner, withPolicy, type TransactionSigner } from "../src/managed-signer.js";
import { loadConfig } from "../src/config.js";
import { Secret } from "../src/redact.js";
import type { SendRequest } from "../src/executor.js";

const WALLET_KEY = `0x${"11".repeat(32)}` as Hex;
const HL = "http://127.0.0.1:1";
const leverage = buildLeverage(1, 1);
const sell = buildOrder({ asset: 1, isBuy: false, limitPx: 1700, size: 0.002 });
const request: SendRequest = { kind: "hypercore", description: "ETH sell", chain: { kind: "hypercore", market: "perp" }, legs: [], hyperliquidActions: [leverage, sell] };
const filled = { status: "ok", response: { type: "order", data: { statuses: [{ filled: { totalSz: "0.002", avgPx: "1700" } }] } } };

function wallet(env: Record<string, string>, refuse: (action: HyperliquidAction) => boolean = () => false) {
  const signedTypes: string[] = [];
  const posted: string[] = [];
  const inner = keystoreSigner({ evm: null, solana: null, hyperliquid: new Secret(WALLET_KEY), evmAddress: null, solanaAddress: null });
  const signer: TransactionSigner = {
    ...inner,
    async signHyperliquid(action, nonce, isMainnet) {
      if (refuse(action)) throw new Error(`whale-signer refused ${action.type}`);
      signedTypes.push(action.type);
      return inner.signHyperliquid(action, nonce, isMainnet);
    },
  };
  const fetchImpl = (async (_url: string, init: { body: string }) => {
    const { action } = JSON.parse(init.body) as { action: HyperliquidAction };
    posted.push(action.type);
    return new Response(JSON.stringify(action.type === "order" ? filled : { status: "ok", response: { type: "default" } }), { status: 200 });
  }) as unknown as typeof fetch;
  const config = loadConfig({ HYPERLIQUID_API_URL: HL, ...env });
  const send = (hold = false) => broadcastRoute(config, withPolicy(signer, config), request, 1, fetchImpl, [], { hold });
  return { send, signedTypes, posted };
}

test("a perp sell the sell limit refuses signs and sends no updateLeverage", async () => {
  const { send, signedTypes, posted } = wallet({});
  await assert.rejects(send(), /^Error: hypercore: no limit is set for hypercore:perp:1:sold$/);
  assert.deepEqual(signedTypes, []);
  assert.deepEqual(posted, []);
  await assert.rejects(send(true), /no limit is set/);
  assert.deepEqual(signedTypes, []);
});

test("a perp sell whose order the signer refuses sends no updateLeverage", async () => {
  const { send, signedTypes, posted } = wallet({ HYPERCORE_SELL_LIMITS: '{"hypercore:perp:1:sold":"1000000"}' }, (action) => action.type === "order");
  await assert.rejects(send(), /whale-signer refused order/);
  assert.deepEqual(signedTypes, ["updateLeverage"]);
  assert.deepEqual(posted, []);
});

test("a perp sell inside every limit signs both actions, then sends updateLeverage before the order", async () => {
  const { send, signedTypes, posted } = wallet({ HYPERCORE_SELL_LIMITS: '{"hypercore:perp:1:sold":"1000000"}' });
  const result = await send();
  assert.deepEqual(signedTypes, ["updateLeverage", "order"]);
  assert.deepEqual(posted, ["updateLeverage", "order"]);
  assert.equal(result.venue, "hypercore");
  assert.deepEqual(result.venue === "hypercore" && result.fill, { totalSz: "0.002", avgPx: "1700" });
  assert.deepEqual(result.txs.map((tx) => [tx.to, tx.outcome]), [["updateLeverage", "landed"], ["order", "landed"]]);
});
