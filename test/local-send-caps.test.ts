import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import test from "node:test";
import { Keypair } from "@solana/web3.js";
import { decodeFunctionData, erc20Abi, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { resetSendClients } from "../src/broadcast.js";
import { loadConfig } from "../src/config.js";
import type { SwapIntent } from "../src/domain.js";
import { execute, resetExecutorState, type ExecutorDeps } from "../src/executor.js";
import { createExecutor } from "../src/executor-server.js";
import { localSender } from "../src/local-sends.js";
import { startSignerQueue, type SignerQueue } from "../src/signer-queue.js";
import { resetTokenDecimals, resolveTokenDecimals } from "../src/token-decimals.js";

const TOKEN = "t".repeat(40);
const evm = privateKeyToAccount(`0x${"11".repeat(32)}` as Hex);
const solana = Keypair.fromSeed(new Uint8Array(32).fill(3));
const DEST = "0x2222222222222222222222222222222222222222";
const USDC = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";
const TKN = "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const ETH = "0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee";
const DECIMALS_SELECTOR = "0x313ce567";

type Job = { id: string; payload: Record<string, unknown> };
type Chain = { url: string; sent: string[]; close: () => Promise<void> };

const word = (value: bigint) => `0x${value.toString(16).padStart(64, "0")}`;

function rpcResult(method: string, params: unknown[], sent: string[]): unknown {
  switch (method) {
    case "eth_chainId":
      return "0x2105";
    case "eth_getBlockByNumber":
      return { number: "0x10", baseFeePerGas: "0x1000", hash: `0x${"ab".repeat(32)}`, timestamp: "0x1", transactions: [] };
    case "eth_blockNumber":
      return "0x10";
    case "eth_maxPriorityFeePerGas":
      return "0x1";
    case "eth_gasPrice":
      return "0x1000";
    case "eth_estimateGas":
      return "0xc350";
    case "eth_getBalance":
      return "0xde0b6b3a7640000";
    case "eth_call": {
      const call = (params[0] ?? {}) as { data?: string; input?: string };
      return (call.data ?? call.input ?? "").startsWith(DECIMALS_SELECTOR) ? word(6n) : word(1n);
    }
    case "eth_simulateV1":
      return [{ number: "0x11", hash: `0x${"ab".repeat(32)}`, timestamp: "0x2", gasLimit: "0x1c9c380", gasUsed: "0xc350", baseFeePerGas: "0x1", calls: [{ status: "0x1", returnData: "0x", gasUsed: "0xc350", logs: [] }] }];
    case "eth_getTransactionCount":
      return "0x7";
    case "eth_sendRawTransaction":
      sent.push(String(params[0]));
      return `0x${"cd".repeat(32)}`;
    case "eth_getTransactionReceipt":
      return { status: "0x1", gasUsed: "0x5208", effectiveGasPrice: "0x1", blockNumber: "0x10", transactionHash: `0x${"cd".repeat(32)}`, logs: [], type: "0x2", cumulativeGasUsed: "0x5208", from: evm.address, to: DEST, contractAddress: null, logsBloom: `0x${"0".repeat(512)}`, blockHash: `0x${"ab".repeat(32)}`, transactionIndex: "0x0" };
    default:
      return null;
  }
}

async function fakeChain(sendFails = false): Promise<Chain> {
  const sent: string[] = [];
  const server: Server = createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk) => chunks.push(chunk as Buffer));
    request.on("end", () => {
      const url = new URL(request.url ?? "/", "http://x");
      response.setHeader("content-type", "application/json");
      if (url.pathname.startsWith("/simple/price")) return response.end(JSON.stringify({ ethereum: { usd: 3000 } }));
      if (url.pathname.startsWith("/simple/token_price")) {
        const address = url.searchParams.get("contract_addresses") ?? "";
        return response.end(JSON.stringify({ [address]: { usd: 1 }, [address.toLowerCase()]: { usd: 1 } }));
      }
      if (url.pathname.startsWith("/token-pairs")) return response.end("[]");
      const text = Buffer.concat(chunks).toString("utf8");
      if (sendFails && text.includes("eth_sendRawTransaction")) {
        response.statusCode = 502;
        return response.end("{}");
      }
      const body = JSON.parse(text || "null") as unknown;
      const one = (call: { id: number; method: string; params?: unknown[] }) => ({ jsonrpc: "2.0", id: call.id, result: rpcResult(call.method, call.params ?? [], sent) });
      response.end(JSON.stringify(Array.isArray(body) ? body.map(one) : one(body as { id: number; method: string })));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return { url, sent, close: () => new Promise((resolve) => { server.close(() => resolve()); server.closeAllConnections(); }) };
}

function signEveryJob(queue: SignerQueue, seen: Job[]): () => void {
  let stopped = false;
  void (async () => {
    while (!stopped) {
      const response = await fetch(`${queue.url}/signer/v1/jobs?wait=1`, { headers: { authorization: `Bearer ${TOKEN}` } }).catch(() => null);
      if (!response || response.status !== 200) continue;
      const job = (await response.json()) as Job;
      seen.push(job);
      const tx = job.payload.tx as Record<string, string>;
      const signed = await evm.signTransaction({ type: "eip1559", chainId: job.payload.chainId as number, nonce: Number(tx.nonce), to: tx.to as Hex, value: BigInt(tx.value as string), data: tx.data as Hex, gas: BigInt(tx.gas as string), maxFeePerGas: BigInt(tx.maxFeePerGas as string), maxPriorityFeePerGas: BigInt(tx.maxPriorityFeePerGas as string) });
      await fetch(`${queue.url}/signer/v1/jobs/${job.id}/result`, { method: "POST", headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" }, body: JSON.stringify({ decision: "signed", result: { signedTransaction: signed } }) }).catch(() => null);
    }
  })();
  return () => {
    stopped = true;
  };
}

async function withLocalSender(env: Record<string, string>, run: (send: ReturnType<typeof localSender>, chain: Chain, jobs: Job[]) => Promise<void>, sendFails = false): Promise<void> {
  resetSendClients();
  resetTokenDecimals();
  const chain = await fakeChain(sendFails);
  const queue = await startSignerQueue({ token: TOKEN, port: 0, answerTimeoutMs: 5_000 });
  const jobs: Job[] = [];
  const stop = signEveryJob(queue, jobs);
  try {
    const send = localSender({ OWNER_WITHDRAW_ADDRESSES: DEST, RPC_URL_8453: chain.url, COINGECKO_API_BASE: chain.url, DEXSCREENER_API_BASE: chain.url, ...env }, queue, { evmAddress: evm.address, solanaAddress: solana.publicKey.toBase58(), token: TOKEN, port: 0, answerTimeoutMs: 5_000 });
    await run(send, chain, jobs);
  } finally {
    stop();
    await queue.close();
    await chain.close();
  }
}

const onBase = (address: string, symbol: string, decimals: number | null) => ({ chain: { kind: "evm" as const, chainId: 8453 }, chainKey: "base", address, symbol, decimals });

test("a token transfer is priced with the chain's decimals, so a caller's decimals cannot shrink 1,000,000 USDC under a 5 USD cap", () =>
  withLocalSender({ MAX_USD_PER_TRADE: "5", DAILY_USD_CAP: "25", TOKEN_RECOVERY_ALLOWLIST: USDC }, async (send, chain, jobs) => {
    const lied = await send({ kind: "transfer", idempotencyKey: "lie", mode: "live", asset: onBase(USDC, "USDC", 30), to: DEST, amount: "1000000000000" });
    assert.equal(lied.status, "skipped", JSON.stringify(lied));
    assert.match(lied.reason, /USDC decimals 30 do not match the chain's 6/);
    const unstated = await send({ kind: "transfer", idempotencyKey: "unstated", mode: "live", asset: onBase(USDC, "USDC", null), to: DEST, amount: "1000000000000" });
    assert.match(unstated.reason, /notional exceeds 5 USD/);
    const small = await send({ kind: "transfer", idempotencyKey: "small", mode: "live", asset: onBase(USDC, "USDC", 6), to: DEST, amount: "4000000" });
    assert.equal(small.status, "signed", JSON.stringify(small));
    assert.equal(jobs.length, 1);
    const data = (jobs[0]?.payload.tx as { data: Hex }).data;
    assert.equal(decodeFunctionData({ abi: erc20Abi, data }).args?.[1], 4_000_000n);
    assert.deepEqual(chain.sent, []);
  }));

test("concurrent live transfers reserve the daily cap before signing, so four 4.50 USD transfers cannot pass a 10 USD cap", () =>
  withLocalSender({ WHALE_BROADCAST: "true", MAX_USD_PER_TRADE: "5", DAILY_USD_CAP: "10" }, async (send, chain) => {
    const one = (key: string) => send({ kind: "transfer", idempotencyKey: key, mode: "live", asset: onBase(ETH, "ETH", 18), to: DEST, amount: "1500000000000000" });
    const results = await Promise.all(["c1", "c2", "c3", "c4"].map(one));
    assert.equal(results.filter((item) => item.status === "sent").length, 2, JSON.stringify(results.map((item) => [item.status, item.reason])));
    assert.equal(results.filter((item) => item.reason === "daily cap 10 USD").length, 2);
    assert.equal(chain.sent.length, 2);
    assert.equal((await one("c5")).reason, "daily cap 10 USD");
  }));

test("a refused or held transfer gives its reservation back", () =>
  withLocalSender({ MAX_USD_PER_TRADE: "5", DAILY_USD_CAP: "5" }, async (send) => {
    const first = await send({ kind: "transfer", idempotencyKey: "h1", mode: "live", asset: onBase(ETH, "ETH", 18), to: DEST, amount: "1500000000000000" });
    const second = await send({ kind: "transfer", idempotencyKey: "h2", mode: "live", asset: onBase(ETH, "ETH", 18), to: DEST, amount: "1500000000000000" });
    assert.equal(first.status, "signed");
    assert.equal(second.status, "signed", "a held transfer spent nothing, so it does not use up the cap");
  }));

test("a transfer whose broadcast may have gone out keeps its reservation", () =>
  withLocalSender({ WHALE_BROADCAST: "true", MAX_USD_PER_TRADE: "5", DAILY_USD_CAP: "5" }, async (send) => {
    const one = (key: string) => send({ kind: "transfer", idempotencyKey: key, mode: "live", asset: onBase(ETH, "ETH", 18), to: DEST, amount: "1500000000000000" });
    await assert.rejects(one("lost"));
    assert.equal((await one("next")).reason, "daily cap 5 USD");
  }, true));

function swapIntent(key: string, sellDecimals: number, buyDecimals: number | null): SwapIntent {
  const pairMap = { pools: [], top: { poolAddress: "", dex: "whale-price", chainKey: "base", baseSymbol: "TKN", baseAddress: TKN, quoteSymbol: "USD", quoteAddress: "", liquidityUsd: 0, priceUsd: 1, baseDecimals: buyDecimals } };
  return {
    idempotencyKey: key,
    side: "buy",
    notionalUsd: 5,
    slippageBps: 50,
    token: { symbol: "TKN", address: TKN, decimals: buyDecimals, chain: { kind: "evm", chainId: 8453 }, chainKey: "base", pairMap },
    holdings: [{ symbol: "USDC", address: USDC, amount: 0, usd: 0, native: false, decimals: sellDecimals, chainKey: "base" }],
    hyperliquid: null,
    receivedAtMs: 0,
  };
}

function liveSwapDeps(sends: string[], settle: () => Promise<void> = async () => undefined): Partial<ExecutorDeps> & Pick<ExecutorDeps, "config" | "mode" | "spentTodayUsd" | "quoteHop" | "markPrice" | "send"> {
  return {
    config: { maxUsdPerTrade: 5, dailyUsdCap: 10, maxSlippageBps: 100, slippageHardMaxBps: 300, maxLeverage: 1, minLiquidityUsd: 75_000, killSwitch: false, enabledChainKeys: new Set(["base"]) },
    mode: "live",
    spentTodayUsd: 0,
    quoteHop: async () => ({ priceImpactPct: 0.1, feeUsd: 0.01, buyAmount: "5000000", signable: true }),
    markPrice: async () => null,
    send: async (request) => {
      await settle();
      sends.push(request.legs[0]?.sellAmount ?? "");
      return { venue: "chain", outcome: "landed", txs: [{ chainKey: "base", txHash: "0x01", from: "owner", to: "router", value: "0", outcome: "landed" }], held: null, shortfall: false };
    },
    readBalance: async () => 1_000_000,
    priceOf: () => 1,
    liquidityOf: async () => 1_000_000,
    readTokenDecimals: async () => 6,
    supportTierFor: () => "live",
  };
}

test("a live swap sizes the sell from the chain's decimals and refuses a caller's sell decimals that differ", async () => {
  resetExecutorState();
  resetTokenDecimals();
  const sends: string[] = [];
  const lied = await execute(swapIntent("sell-lie", 12, 6), liveSwapDeps(sends) as ExecutorDeps);
  assert.equal(lied.decision, "skipped");
  assert.match(lied.reason, /USDC decimals 12 do not match the chain's 6/);
  assert.deepEqual(sends, []);
  const honest = await execute(swapIntent("sell-honest", 6, 6), liveSwapDeps(sends) as ExecutorDeps);
  assert.equal(honest.decision, "sent", honest.reason);
  assert.deepEqual(sends, ["5000000"]);
});

test("a live swap refuses a caller's buy decimals that differ from the chain's, and does not remember them", async () => {
  resetExecutorState();
  resetTokenDecimals();
  const sends: string[] = [];
  const lied = await execute(swapIntent("buy-lie", 6, 2), liveSwapDeps(sends) as ExecutorDeps);
  assert.match(lied.reason, /TKN decimals 2 do not match the chain's 6/);
  const later = await execute(swapIntent("buy-unstated", 6, null), liveSwapDeps(sends) as ExecutorDeps);
  assert.equal(later.decision, "sent", later.reason);
  assert.deepEqual(sends, ["5000000"]);
});

test("concurrent live swaps reserve the daily cap before sending", async () => {
  resetTokenDecimals();
  const config = loadConfig({ MAX_USD_PER_TRADE: "5", DAILY_USD_CAP: "10", ENABLED_CHAINS: "base", TOKEN_SCREENING: "false" });
  const executor = createExecutor(config, null, null);
  const sends: string[] = [];
  const overrides = { ...liveSwapDeps(sends, () => new Promise((resolve) => setTimeout(resolve, 20))), config };
  const reports = await Promise.all(["s1", "s2", "s3"].map((key) => executor.execute(swapIntent(key, 6, 6), overrides)));
  assert.equal(sends.length, 2, JSON.stringify(reports.map((report) => [report.decision, report.reason])));
  assert.equal(reports.filter((report) => report.reason === "daily cap 10 USD").length, 1);
});

test("solana mint decimals are read from the parsed mint account", async () => {
  resetTokenDecimals();
  const mint = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
  const server = createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk) => chunks.push(chunk as Buffer));
    request.on("end", () => {
      const call = JSON.parse(Buffer.concat(chunks).toString("utf8")) as { id: number; params: [string] };
      const data = call.params[0] === mint ? { program: "spl-token", parsed: { type: "mint", info: { decimals: 6 } }, space: 82 } : { program: "spl-token", parsed: { type: "account", info: {} }, space: 165 };
      response.setHeader("content-type", "application/json");
      response.end(JSON.stringify({ jsonrpc: "2.0", id: call.id, result: { context: { slot: 1 }, value: { data, executable: false, lamports: 1, owner: "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA", rentEpoch: 0 } } }));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const rpc = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  try {
    assert.equal(await resolveTokenDecimals("solana", mint, { kind: "solana" }, rpc), 6);
    assert.equal(await resolveTokenDecimals("solana", solana.publicKey.toBase58(), { kind: "solana" }, rpc), null, "a token account is not a mint");
  } finally {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  }
});
