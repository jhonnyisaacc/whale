import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import test from "node:test";
import { Keypair } from "@solana/web3.js";
import { privateKeyToAccount } from "viem/accounts";
import { loadConfig } from "../src/config.js";
import type { HyperliquidMarket } from "../src/domain.js";
import { execute, resetExecutorState, type ExecutorDeps, type SendRequest } from "../src/executor.js";
import { localSender } from "../src/local-sends.js";
import { perpIntent } from "../src/local-perps.js";
import { startSignerQueue } from "../src/signer-queue.js";

const TOKEN = "t".repeat(40);
const evm = privateKeyToAccount(`0x${"11".repeat(32)}`);
const solana = Keypair.fromSeed(new Uint8Array(32).fill(3)).publicKey.toBase58();
const ETH: HyperliquidMarket = { coin: "ETH", assetIndex: 1, market: "perp", maxLeverage: 25 };
const BTC: HyperliquidMarket = { coin: "BTC", assetIndex: 0, market: "perp", maxLeverage: 40 };
const SZ_DECIMALS: Record<string, number> = { BTC: 5, ETH: 4 };
const DEFAULT_REFUSAL = "hyperliquid perp orders need at least 10 USD notional, and MAX_USD_PER_TRADE is 5";

async function hyperliquidInfo(): Promise<{ url: string; close: () => Promise<void> }> {
  const server = createServer((request, response) => {
    let body = "";
    request.on("data", (chunk) => (body += chunk));
    request.on("end", () => {
      const { type } = JSON.parse(body) as { type: string };
      const reply = type === "meta" ? { universe: [{ name: "BTC", szDecimals: 5, maxLeverage: 40 }, { name: "ETH", szDecimals: 4, maxLeverage: 25 }] } : type === "allMids" ? { BTC: "91000", ETH: "1750" } : type === "clearinghouseState" ? { assetPositions: [] } : null;
      response.writeHead(reply ? 200 : 404, { "content-type": "application/json" });
      response.end(JSON.stringify(reply));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return { url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, close: () => new Promise((resolve) => server.close(() => resolve())) };
}

test("under the default config a local perp order below the 10 USD venue minimum is refused in dry run and never reaches whale-signer live", async () => {
  const info = await hyperliquidInfo();
  const queue = await startSignerQueue({ token: TOKEN, port: 0, answerTimeoutMs: 1_000 });
  try {
    const send = localSender({ HYPERLIQUID_API_URL: info.url }, queue, { evmAddress: evm.address, solanaAddress: solana, token: TOKEN, port: 0, answerTimeoutMs: 1_000, bitcoinPublicKey: null });
    const order = { kind: "perp", coin: "ETH", side: "buy", notionalUsd: 5, slippageBps: 50 } as const;
    const dry = await send({ ...order, idempotencyKey: "dry", mode: "dry_run" });
    assert.deepEqual([dry.status, dry.reason], ["skipped", DEFAULT_REFUSAL]);

    const live = send({ ...order, idempotencyKey: "live", mode: "live" }).catch((error: unknown) => (error instanceof Error ? error : new Error(String(error))));
    const leased = await fetch(`${queue.url}/signer/v1/jobs?wait=1`, { headers: { authorization: `Bearer ${TOKEN}` } });
    assert.equal(leased.status, 204, "no signing job was queued");
    const result = await live;
    assert.ok(!(result instanceof Error), String(result));
    assert.deepEqual([result.status, result.reason, result.jobs.length], ["skipped", DEFAULT_REFUSAL, 0]);
  } finally {
    await queue.close();
    await info.close();
  }
});

function executorDeps(mode: "dry_run" | "live", env: Record<string, string>, sent: SendRequest[], market = ETH, mark = 1750): ExecutorDeps {
  return {
    config: { ...loadConfig(env), enabledChainKeys: new Set(["hypercore"]) },
    mode,
    liquidityOf: async () => null,
    spentTodayUsd: 0,
    quoteHop: async () => {
      throw new Error("a perp order quotes no DEX hop");
    },
    markPrice: async () => mark,
    hyperMarket: async () => ({ ...market, midKey: market.coin, szDecimals: SZ_DECIMALS[market.coin]! }),
    perpPosition: async () => ({ side: "flat" }),
    send: async (request) => {
      sent.push(request);
      return { venue: "hypercore", txs: [], fill: { totalSz: "1", avgPx: String(mark) } };
    },
    readBalance: async () => 100,
    priceOf: () => 1,
    supportTierFor: () => "live",
    now: () => 1_000,
  };
}

const order = (notionalUsd: number, side: "buy" | "sell" = "buy", market = ETH) => perpIntent({ kind: "perp", idempotencyKey: `perp-${market.coin}-${side}-${notionalUsd}`, coin: market.coin, side, notionalUsd, slippageBps: 50, mode: "live" }, market, 0);

test("the executor refuses a perp order below the venue minimum before it reserves or signs, and names MAX_USD_PER_TRADE only when the cap is what keeps it below", async () => {
  const cases: [Record<string, string>, number, string | null][] = [
    [{}, 5, DEFAULT_REFUSAL],
    [{}, 10, "notional exceeds 5 USD"],
    [{ MAX_USD_PER_TRADE: "20" }, 9.99, "hyperliquid perp orders need at least 10 USD notional"],
    [{ MAX_USD_PER_TRADE: "20" }, 11, null],
    [{ MAX_USD_PER_TRADE: "20" }, 21, "notional exceeds 20 USD"],
  ];
  for (const [env, notionalUsd, reason] of cases) {
    for (const mode of ["dry_run", "live"] as const) {
      resetExecutorState();
      const sent: SendRequest[] = [];
      const reserved: string[] = [];
      const report = await execute(order(notionalUsd), { ...executorDeps(mode, env, sent), recordSpend: async (key) => (reserved.push(key), "reserved") });
      const name = `${mode} ${notionalUsd} ${JSON.stringify(env)}`;
      if (reason === null) {
        assert.equal(report.decision, mode === "live" ? "sent" : "would_send", `${name}: ${report.reason}`);
        continue;
      }
      assert.deepEqual([report.decision, report.reason, sent.length, reserved.length], ["skipped", reason, 0, 0], name);
    }
  }
});

test("the executor refuses a perp order whose lot rounding or slippage limit takes it under 10 USD before it reserves or signs, and a larger order still sends", async () => {
  const cases: [Record<string, string>, ReturnType<typeof order>, number, string | null][] = [
    [{ MAX_USD_PER_TRADE: "10" }, order(10, "sell"), 1750.05, "hyperliquid perp order rounds to 9.92 USD, under the 10 USD minimum"],
    [{ MAX_USD_PER_TRADE: "10" }, order(10, "buy", BTC), 91_000, "hyperliquid perp order rounds to 9.1 USD, under the 10 USD minimum"],
    [{ MAX_USD_PER_TRADE: "20" }, order(10.9, "sell", BTC), 91_000, "hyperliquid perp order rounds to 9.95 USD, under the 10 USD minimum"],
    [{ MAX_USD_PER_TRADE: "11" }, order(11, "sell"), 1750.05, null],
    [{ MAX_USD_PER_TRADE: "12" }, order(12, "buy", BTC), 91_000, null],
  ];
  for (const [env, intent, mark, reason] of cases) {
    for (const mode of ["dry_run", "live"] as const) {
      resetExecutorState();
      const sent: SendRequest[] = [];
      const reserved: string[] = [];
      const market = intent.hyperliquid?.coin === "BTC" ? BTC : ETH;
      const report = await execute({ ...intent, idempotencyKey: `${intent.idempotencyKey}-${mode}` }, { ...executorDeps(mode, env, sent, market, mark), recordSpend: async (key) => (reserved.push(key), "reserved") });
      const name = `${mode} ${intent.idempotencyKey} ${JSON.stringify(env)}`;
      if (reason === null) {
        assert.equal(report.decision, mode === "live" ? "sent" : "would_send", `${name}: ${report.reason}`);
        assert.deepEqual([sent.length, reserved.length], mode === "live" ? [1, 1] : [0, 0], name);
        continue;
      }
      assert.deepEqual([report.decision, report.reason, sent.length, reserved.length], ["skipped", reason, 0, 0], name);
    }
  }
});

test("a local 10 USD ETH sell or BTC buy under MAX_USD_PER_TRADE 10 is refused in dry run and queues no signing job live", async () => {
  const info = await hyperliquidInfo();
  const queue = await startSignerQueue({ token: TOKEN, port: 0, answerTimeoutMs: 1_000 });
  try {
    const send = localSender({ HYPERLIQUID_API_URL: info.url, MAX_USD_PER_TRADE: "10" }, queue, { evmAddress: evm.address, solanaAddress: solana, token: TOKEN, port: 0, answerTimeoutMs: 1_000, bitcoinPublicKey: null });
    const cases = [
      [{ kind: "perp", coin: "ETH", side: "sell", notionalUsd: 10, slippageBps: 50 }, "hyperliquid perp order rounds to 9.92 USD, under the 10 USD minimum"],
      [{ kind: "perp", coin: "BTC", side: "buy", notionalUsd: 10, slippageBps: 50 }, "hyperliquid perp order rounds to 9.1 USD, under the 10 USD minimum"],
    ] as const;
    for (const [perp, reason] of cases) {
      const dry = await send({ ...perp, idempotencyKey: `dry-${perp.coin}`, mode: "dry_run" });
      assert.deepEqual([dry.status, dry.reason], ["skipped", reason], perp.coin);
      const live = send({ ...perp, idempotencyKey: `live-${perp.coin}`, mode: "live" }).catch((error: unknown) => (error instanceof Error ? error : new Error(String(error))));
      const leased = await fetch(`${queue.url}/signer/v1/jobs?wait=1`, { headers: { authorization: `Bearer ${TOKEN}` } });
      assert.equal(leased.status, 204, `${perp.coin}: no signing job was queued`);
      const result = await live;
      assert.ok(!(result instanceof Error), String(result));
      assert.deepEqual([result.status, result.reason, result.jobs.length], ["skipped", reason, 0], perp.coin);
    }
  } finally {
    await queue.close();
    await info.close();
  }
});
