import assert from "node:assert/strict";
import test from "node:test";
import { Keypair, VersionedTransaction } from "@solana/web3.js";
import { keccak256, toHex, type Hex } from "viem";
import { rememberApproval, resetApprovals } from "../src/approvals.js";
import { broadcastRoute, lookupAgedTx, receivedFromMeta, solanaRpcOver, withdrawNative, type EvmReceipt, type EvmRpc, type SendIo, type SolanaRpc } from "../src/broadcast.js";
import { loadConfig } from "../src/config.js";
import type { RouteLeg, SwapIntent, TxRecord } from "../src/domain.js";
import { BroadcastError, execute, resetExecutorState, type ExecutorDeps } from "../src/executor.js";
import { buildOrder, cappedLimitPx, floatToWire, nextHyperliquidNonce, orderSize, readExchangeResponse, wirePrice } from "../src/hyperliquid.js";
import type { EvmSignInput, TransactionSigner } from "../src/managed-signer.js";
import { createNonceManager } from "../src/nonce.js";
import { buildPairMap } from "../src/pairs.js";
import { screenToken } from "../src/screening.js";
import { reconcileDecision } from "../src/spend.js";
import { WSOL_MINT } from "../src/signing-policy.js";
import { tagOf, zeroExData } from "./fixtures.js";

const USDC = "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const WETH = "0xcccccccccccccccccccccccccccccccccccccccc";
const TOKEN = "0xdddddddddddddddddddddddddddddddddddddddd";
const ROUTER = "0x1111111111111111111111111111111111111111";
const OWNER = "0x2222222222222222222222222222222222222222";
const DEST = "0x3333333333333333333333333333333333333333";

type FakeChain = {
  rpc: EvmRpc;
  sent: Hex[];
  receipts: Map<string, EvmReceipt>;
  balances: Map<string, bigint>;
  pending: number;
  mined: number;
  depths: number[];
  known: Set<string>;
  onSend: (signed: Hex, hash: string) => void;
  rejectSimulation: (data: Hex) => boolean;
};

const success: EvmReceipt = { status: "success", gasUsed: 21_000n, effectiveGasPrice: 1n };

function fakeChain(): FakeChain {
  const chain: FakeChain = {
    sent: [],
    receipts: new Map(),
    balances: new Map(),
    pending: 7,
    mined: 7,
    depths: [],
    known: new Set(),
    onSend: () => undefined,
    rejectSimulation: () => false,
    rpc: {
      fees: async () => ({ maxFeePerGas: 1_000n, maxPriorityFeePerGas: 100n }),
      pendingNonce: async () => chain.pending,
      confirmedNonce: async (_address, depth) => {
        chain.depths.push(depth);
        return chain.mined;
      },
      estimateGas: async () => 21_000n,
      simulate: async (call) => {
        if (chain.rejectSimulation(call.data)) throw new Error("execution reverted");
      },
      sendRaw: async (signed) => {
        chain.sent.push(signed);
        chain.onSend(signed, keccak256(signed));
        chain.known.add(keccak256(signed));
      },
      receipt: async (hash) => chain.receipts.get(hash) ?? null,
      seen: async (hash) => chain.known.has(hash) || chain.receipts.has(hash),
      balance: async (token) => chain.balances.get(token.toLowerCase()) ?? 10n ** 20n,
    },
  };
  return chain;
}

function clockIo(evm: EvmRpc | null, solana: SolanaRpc | null = null): SendIo {
  let clock = 0;
  return {
    evm: () => {
      if (!evm) throw new Error("no evm rpc");
      return evm;
    },
    solana: () => {
      if (!solana) throw new Error("no solana rpc");
      return solana;
    },
    nonces: createNonceManager(),
    sleep: async (ms) => {
      clock += ms;
    },
    now: () => clock,
    confirmTimeoutMs: 1_000,
    pollMs: 100,
  };
}

function evmSigner(signed: EvmSignInput[]): TransactionSigner {
  return {
    backend: "keystore",
    evmAddress: () => OWNER,
    solanaAddress: () => null,
    async signEvm(input) {
      signed.push(input);
      return toHex(`${signed.length}:${input.nonce}:${input.maxFeePerGas}:${input.data}`);
    },
    async signSolana() {
      throw new Error("solana is not loaded");
    },
    async signHyperliquid() {
      return { r: "0x01", s: "0x02", v: 27 };
    },
  };
}

type Firm = { buyAmount: string; minBuyAmount?: string; data: Hex };

function zeroEx(byBuy: Record<string, Firm>, seen: URL[]): typeof fetch {
  return async (input) => {
    const url = new URL(String(input));
    seen.push(url);
    const buyToken = (url.searchParams.get("buyToken") ?? "").toLowerCase();
    const firm = byBuy[buyToken];
    if (!firm) return new Response("{}", { status: 404 });
    const data = firm.minBuyAmount === undefined ? firm.data : zeroExData(firm.data, { recipient: OWNER, buyToken, minOut: BigInt(firm.minBuyAmount) }, { token: url.searchParams.get("sellToken") ?? "", amount: BigInt(url.searchParams.get("sellAmount") ?? "0") });
    return new Response(
      JSON.stringify({ liquidityAvailable: true, buyAmount: firm.buyAmount, minBuyAmount: firm.minBuyAmount, transaction: { to: ROUTER, data, value: "0", gas: "100000" } }),
      { status: 200 },
    );
  };
}

const evmConfig = loadConfig({ RPC_URL_8453: "http://fake.invalid", ZEROX_API_KEY: "zeroex-key" });
const leg1: RouteLeg = { sellAddress: USDC, buyAddress: WETH, sellAmount: "5000000", spentUsd: 5, priceUsd: 2000, decimals: 18, impactPct: 0 };
const leg2: RouteLeg = { sellAddress: WETH, buyAddress: TOKEN, sellAmount: "2500000000000000", spentUsd: 5, priceUsd: 0.5, decimals: 6, impactPct: 0 };
const firmQuotes: Record<string, Firm> = {
  [WETH]: { buyAmount: "2500000000000000", minBuyAmount: "2490000000000000", data: "0x01" },
  [TOKEN]: { buyAmount: "9960000", minBuyAmount: "9910000", data: "0x02" },
};

function approveRouter(): void {
  resetApprovals();
  for (const token of [USDC, WETH]) rememberApproval({ chainId: 8453, token, spender: ROUTER, owner: OWNER }, 10n ** 30n);
}

function deliver(chain: FakeChain, byData: Record<string, { token: string; amount: bigint; receipt?: EvmReceipt }>): void {
  chain.onSend = (signed, hash) => {
    const data = Buffer.from(signed.slice(2), "hex").toString("utf8").split(":")[3] ?? "";
    const effect = byData[tagOf(data as Hex) ?? ""];
    if (!effect) return;
    chain.receipts.set(hash, effect.receipt ?? success);
    const key = effect.token.toLowerCase();
    chain.balances.set(key, (chain.balances.get(key) ?? 0n) + effect.amount);
  };
}

function freshBalances(chain: FakeChain): void {
  chain.balances.set(WETH, 0n);
  chain.balances.set(TOKEN, 0n);
}

const twoHop = { kind: "evm" as const, description: "two", chain: { kind: "evm" as const, chainId: 8453 }, hyperliquidActions: [], provider: "zeroex" };

test("a two-hop send waits for leg 1 and re-quotes leg 2 with the amount it actually received", async () => {
  approveRouter();
  const chain = fakeChain();
  freshBalances(chain);
  deliver(chain, { "0x01": { token: WETH, amount: 2_490_000_000_000_000n }, "0x02": { token: TOKEN, amount: 9_960_000n } });
  const seen: URL[] = [];
  const records: TxRecord[] = [];
  const result = await broadcastRoute(evmConfig, evmSigner([]), { ...twoHop, legs: [leg1, leg2] }, 1, zeroEx(firmQuotes, seen), [], {
    io: clockIo(chain.rpc),
    onTx: async (tx) => {
      records.push(tx);
    },
  });
  assert.equal(seen.length, 2);
  assert.equal(seen[1]?.searchParams.get("sellAmount"), "2490000000000000");
  assert.equal(result.venue, "chain");
  assert.equal(result.venue === "chain" && result.outcome, "landed");
  assert.deepEqual(
    result.txs.map((tx) => tx.outcome),
    ["landed", "landed"],
  );
  assert.deepEqual(
    records.map((tx) => tx.outcome),
    ["pending", "landed", "pending", "landed"],
  );
});

function evmIntent(key: string): SwapIntent {
  return {
    idempotencyKey: key,
    side: "buy",
    notionalUsd: 5,
    slippageBps: 100,
    token: {
      symbol: "TKN",
      address: TOKEN,
      decimals: 6,
      chain: { kind: "evm", chainId: 8453 },
      chainKey: "base",
      pairMap: buildPairMap([
        {
          poolAddress: "pool",
          dex: "uniswap",
          chainKey: "base",
          baseSymbol: "TKN",
          baseAddress: TOKEN,
          quoteSymbol: "WETH",
          quoteAddress: WETH,
          liquidityUsd: 200_000,
          priceUsd: 0.5,
          baseDecimals: 6,
          quotePriceUsd: 2000,
        },
      ]),
    },
    holdings: [{ symbol: "USDC", address: USDC, amount: 20, usd: 20, native: false, decimals: 6, chainKey: "base" }],
    hyperliquid: null,
    receivedAtMs: 0,
  };
}

function journalDeps(spend: Map<string, string>, records: TxRecord[]) {
  return {
    recordSpend: async (key: string) => {
      const status = spend.get(key);
      if (status === "reserved" || status === "committed") return "exists" as const;
      spend.set(key, "reserved");
      return "reserved" as const;
    },
    commitSpend: async (key: string) => {
      if (spend.get(key) === "reserved") spend.set(key, "committed");
    },
    releaseSpend: async (key: string) => {
      if (spend.get(key) === "reserved") spend.set(key, "released");
    },
    recordTx: async (_key: string | null, tx: TxRecord) => {
      records.push(tx);
    },
  };
}

function liveDeps(send: ExecutorDeps["send"], spend: Map<string, string>, records: TxRecord[], twoHopOnly: boolean): ExecutorDeps {
  let clock = 1_000;
  return {
    config: { ...evmConfig, enabledChainKeys: new Set(["base"]), minExecutionSlippageBps: 20, quoteAssets: { base: [{ address: WETH, symbol: "WETH", decimals: 18 }] } },
    mode: "live",
    spentTodayUsd: 0,
    quoteHop: async (hop) => {
      if (hop.sellAddress === USDC && hop.buyAddress === TOKEN) {
        return twoHopOnly ? { priceImpactPct: null, feeUsd: 0, buyAmount: "0" } : { priceImpactPct: 0, feeUsd: 0, buyAmount: "10000000", signable: true };
      }
      if (hop.buyAddress === WETH) return { priceImpactPct: twoHopOnly ? 0 : null, feeUsd: 0, buyAmount: "2500000000000000", signable: true };
      return { priceImpactPct: 0, feeUsd: 0, buyAmount: "10000000", signable: true };
    },
    markPrice: async () => null,
    send,
    readBalance: async () => 20,
    priceOf: () => 1,
    now: () => (clock += 10),
    ...journalDeps(spend, records),
  };
}

test("a leg-2 failure after leg 1 landed keeps the spend committed, reports the held token, and blocks a retry", async () => {
  resetExecutorState();
  approveRouter();
  const chain = fakeChain();
  freshBalances(chain);
  deliver(chain, { "0x01": { token: WETH, amount: 2_500_000_000_000_000n } });
  chain.rejectSimulation = (data) => tagOf(data) === "0x02";
  const spend = new Map<string, string>();
  const records: TxRecord[] = [];
  const io = clockIo(chain.rpc);
  const deps = liveDeps((request, onTx) => broadcastRoute(evmConfig, evmSigner([]), request, 1, zeroEx(firmQuotes, []), [], { io, onTx }), spend, records, true);
  const report = await execute(evmIntent("partial"), deps);
  assert.equal(report.decision, "sent");
  assert.equal(spend.get("partial"), "committed");
  assert.deepEqual(report.held, { token: WETH, amount: "2500000000000000" });
  assert.match(report.reason, /simulation rejected/);
  assert.equal(chain.sent.length, 1);
  assert.ok(report.latency.confirmedMs !== undefined && report.latency.sentMs !== undefined && report.latency.confirmedMs > report.latency.sentMs);
  resetExecutorState();
  const retry = await execute(evmIntent("partial"), deps);
  assert.equal(retry.decision, "skipped");
  assert.equal(retry.reason, "duplicate spend");
  assert.equal(chain.sent.length, 1);
});

test("an ambiguous broadcast keeps the spend reserved and the retry returns the same report", async () => {
  resetExecutorState();
  const spend = new Map<string, string>();
  let sends = 0;
  const deps = liveDeps(
    async () => {
      sends += 1;
      throw new BroadcastError("rpc timed out", true);
    },
    spend,
    [],
    false,
  );
  const report = await execute(evmIntent("ambiguous"), deps);
  assert.equal(spend.get("ambiguous"), "reserved");
  assert.equal(await execute(evmIntent("ambiguous"), deps), report);
  assert.equal(sends, 1);
});

test("a landed trade that delivers less than the minimum output flags the token", async () => {
  resetExecutorState();
  approveRouter();
  const chain = fakeChain();
  freshBalances(chain);
  deliver(chain, { "0x03": { token: TOKEN, amount: 9_000_000n } });
  const quotes = { [TOKEN]: { buyAmount: "10000000", minBuyAmount: "9950000", data: "0x03" as Hex } };
  const spend = new Map<string, string>();
  const records: TxRecord[] = [];
  const io = clockIo(chain.rpc);
  const deps = liveDeps((request, onTx) => broadcastRoute(evmConfig, evmSigner([]), request, 1, zeroEx(quotes, []), [], { io, onTx }), spend, records, false);
  const report = await execute(evmIntent("short"), deps);
  assert.equal(report.decision, "sent");
  assert.match(report.reason, /token flagged/);
  assert.match(records.at(-1)?.note ?? "", /below minimum 9950000/);
  const next = await execute(evmIntent("after-short"), deps);
  assert.equal(next.decision, "skipped");
  assert.match(next.reason, /flagged/);
});

test("a provider minimum output below ours is refused before signing", async () => {
  approveRouter();
  const chain = fakeChain();
  const signed: EvmSignInput[] = [];
  const quotes = { [TOKEN]: { buyAmount: "10000000", minBuyAmount: "9800000", data: "0x04" as Hex } };
  const single = { ...leg2, sellAddress: USDC, sellAmount: "5000000" };
  await assert.rejects(
    () => broadcastRoute(evmConfig, evmSigner(signed), { ...twoHop, legs: [single] }, 1, zeroEx(quotes, []), [], { io: clockIo(chain.rpc) }),
    (error: unknown) => error instanceof BroadcastError && /below ours/.test(error.message) && !error.broadcast,
  );
  const missing = { [TOKEN]: { buyAmount: "10000000", data: "0x04" as Hex } };
  await assert.rejects(
    () => broadcastRoute(evmConfig, evmSigner(signed), { ...twoHop, legs: [single] }, 1, zeroEx(missing, []), [], { io: clockIo(chain.rpc) }),
    /swap calldata is not decodable/,
  );
  assert.equal(signed.length, 0);
  assert.equal(chain.sent.length, 0);
});

test("concurrent evm sends get distinct nonces and a rejected nonce resyncs", async () => {
  const chain = fakeChain();
  chain.onSend = (_signed, hash) => chain.receipts.set(hash, success);
  const signed: EvmSignInput[] = [];
  const io = clockIo(chain.rpc);
  const signer = evmSigner(signed);
  const send = () => withdrawNative({ config: evmConfig, signer, chainKey: "base", to: DEST, amount: 0.0001, io });
  await Promise.all([send(), send(), send()]);
  assert.deepEqual(
    signed.map((input) => input.nonce).sort(),
    [7, 8, 9],
  );
  const manager = createNonceManager();
  let pending = 3;
  let reads = 0;
  const read = async () => {
    reads += 1;
    return pending;
  };
  pending = 3;
  await assert.rejects(() => manager.use(1, OWNER, read, async () => Promise.reject(new BroadcastError("nonce too low", false))));
  pending = 11;
  assert.equal(await manager.use(1, OWNER, read, async (nonce) => nonce), 11);
  assert.equal(await manager.use(1, OWNER, read, async (nonce) => nonce), 12);
  assert.equal(reads, 2);
  pending = 13;
  await assert.rejects(() => manager.use(1, OWNER, read, async () => Promise.reject(new BroadcastError("rpc timed out", true))));
  assert.equal(await manager.use(1, OWNER, read, async (nonce) => nonce), 13, "a failed send re-reads the pending count instead of skipping a nonce");
  assert.equal(reads, 3);
});

test("a rejected or unconfirmed evm send leaves no nonce gap", async () => {
  const chain = fakeChain();
  const failures = ["insufficient funds for gas * price + value", "fetch failed: socket hang up"];
  chain.rpc.sendRaw = async (signed) => {
    const failure = failures.shift();
    if (failure) throw new Error(failure);
    chain.sent.push(signed);
    chain.onSend(signed, keccak256(signed));
  };
  const signed: EvmSignInput[] = [];
  const io = clockIo(chain.rpc);
  const send = () => withdrawNative({ config: evmConfig, signer: evmSigner(signed), chainKey: "base", to: DEST, amount: 0.0001, io });
  await assert.rejects(send, (error: unknown) => error instanceof BroadcastError && !error.broadcast);
  await assert.rejects(send, (error: unknown) => error instanceof BroadcastError && error.broadcast);
  const stuck = await send();
  assert.equal(stuck.outcome, "pending");
  chain.onSend = (_signed, hash) => chain.receipts.set(hash, success);
  const landed = await send();
  assert.equal(landed.outcome, "landed");
  assert.deepEqual(
    signed.map((input) => input.nonce),
    [7, 7, 7, 7, 7],
    "the pending count stayed 7, so every attempt, the fee-bumped replacement included, reused nonce 7",
  );
});

test("insufficient funds on every sender releases the reserved spend", async () => {
  resetExecutorState();
  approveRouter();
  const chain = fakeChain();
  chain.rpc.sendRaw = async () => {
    throw new Error("The total cost (gas * gas fee + value) of executing this transaction exceeds the balance of the account.");
  };
  const spend = new Map<string, string>();
  const io = clockIo(chain.rpc);
  const quotes = { [TOKEN]: { buyAmount: "10000000", minBuyAmount: "9950000", data: "0x0a" as Hex } };
  const deps = liveDeps((request, onTx) => broadcastRoute(evmConfig, evmSigner([]), request, 1, zeroEx(quotes, []), [], { io, onTx }), spend, [], false);
  const report = await execute(evmIntent("broke"), deps);
  assert.equal(report.decision, "skipped");
  assert.equal(spend.get("broke"), "released");
});

test("a receipt timeout sends one replacement at the same nonce with fees bumped at least 12.5%", async () => {
  const chain = fakeChain();
  let count = 0;
  chain.onSend = (_signed, hash) => {
    count += 1;
    if (count === 2) chain.receipts.set(hash, success);
  };
  const signed: EvmSignInput[] = [];
  const records: TxRecord[] = [];
  const tx = await withdrawNative({
    config: evmConfig,
    signer: evmSigner(signed),
    chainKey: "base",
    to: DEST,
    amount: 0.0001,
    io: clockIo(chain.rpc),
    onTx: async (record) => {
      records.push(record);
    },
  });
  assert.equal(signed.length, 2);
  const [first, second] = signed;
  assert.ok(first && second);
  assert.equal(second.nonce, first.nonce);
  assert.ok(second.maxFeePerGas * 1000n >= first.maxFeePerGas * 1125n);
  assert.ok(second.maxPriorityFeePerGas * 1000n >= first.maxPriorityFeePerGas * 1125n);
  assert.equal(tx.outcome, "landed");
  assert.equal(tx.txHash, keccak256(chain.sent[1] as Hex));
  assert.equal(records.find((record) => record.txHash === keccak256(chain.sent[0] as Hex) && record.outcome !== "pending")?.outcome, "expired");
});

test("a reverted receipt is reported as reverted and releases the spend", async () => {
  const chain = fakeChain();
  chain.onSend = (_signed, hash) => chain.receipts.set(hash, { ...success, status: "reverted" });
  const tx = await withdrawNative({ config: evmConfig, signer: evmSigner([]), chainKey: "base", to: DEST, amount: 0.0001, io: clockIo(chain.rpc) });
  assert.equal(tx.outcome, "reverted");
  resetExecutorState();
  approveRouter();
  const swapChain = fakeChain();
  freshBalances(swapChain);
  deliver(swapChain, { "0x05": { token: TOKEN, amount: 0n, receipt: { ...success, status: "reverted" } } });
  const quotes = { [TOKEN]: { buyAmount: "10000000", minBuyAmount: "9950000", data: "0x05" as Hex } };
  const spend = new Map<string, string>();
  const io = clockIo(swapChain.rpc);
  const report = await execute(
    evmIntent("reverted"),
    liveDeps((request, onTx) => broadcastRoute(evmConfig, evmSigner([]), request, 1, zeroEx(quotes, []), [], { io, onTx }), spend, [], false),
  );
  assert.equal(report.decision, "skipped");
  assert.match(report.reason, /transaction reverted/);
  assert.equal(spend.get("reverted"), "released");
});

test("a solana send whose blockhash expires is reported as expired", async () => {
  const keypair = Keypair.generate();
  let height = 95;
  const sent: Uint8Array[] = [];
  const rpc: SolanaRpc = {
    simulate: async () => null,
    sendRaw: async (signed) => {
      sent.push(signed);
    },
    latestBlockhash: async () => ({ blockhash: Keypair.generate().publicKey.toBase58(), lastValidBlockHeight: 100 }),
    blockHeight: async () => (height += 1),
    status: async () => null,
    received: async () => null,
    lamports: async () => 10_000_000_000n,
    tokenAccount: async () => null,
  };
  const signer: TransactionSigner = {
    backend: "keystore",
    evmAddress: () => null,
    solanaAddress: () => keypair.publicKey.toBase58(),
    async signEvm() {
      return "0x";
    },
    async signSolana(serialized) {
      const tx = VersionedTransaction.deserialize(serialized);
      tx.sign([keypair]);
      return tx.serialize();
    },
    async signHyperliquid() {
      return { r: "0x01", s: "0x02", v: 27 };
    },
  };
  const tx = await withdrawNative({
    config: loadConfig({ SOLANA_RPC_URL: "http://fake.invalid" }),
    signer,
    chainKey: "solana",
    to: Keypair.generate().publicKey.toBase58(),
    amount: 0.01,
    io: clockIo(null, rpc),
  });
  assert.equal(sent.length, 1);
  assert.equal(tx.outcome, "expired");
  assert.ok(height > 100);
});

test("solana received amounts come from the transaction's own balance changes", () => {
  const owner = "owner";
  const meta = {
    fee: 5_000,
    preBalances: [1_000_000, 0],
    postBalances: [1_495_000, 0],
    preTokenBalances: [{ mint: "mint", owner, uiTokenAmount: { amount: "10" } }],
    postTokenBalances: [
      { mint: "mint", owner, uiTokenAmount: { amount: "60" } },
      { mint: "mint", owner: "someone", uiTokenAmount: { amount: "999" } },
    ],
  };
  assert.equal(receivedFromMeta(meta, owner, "mint"), 50n);
  assert.equal(receivedFromMeta(meta, owner, WSOL_MINT), 500_000n);
});

test("hyperliquid sizes 100/3.7 and 250/0.01234 produce valid wire values", () => {
  assert.throws(() => floatToWire(100 / 3.7));
  const first = buildOrder({ asset: 1, isBuy: true, limitPx: wirePrice(cappedLimitPx(3.7, true, 50), 2, "perp", true), size: orderSize(100, 3.7, 2) });
  assert.equal(first.orders[0].s, "27.02");
  assert.equal(first.orders[0].p, "3.7185");
  const second = buildOrder({ asset: 2, isBuy: true, limitPx: wirePrice(cappedLimitPx(0.01234, true, 50), 0, "perp", true), size: orderSize(250, 0.01234, 0) });
  assert.equal(second.orders[0].s, "20259");
  assert.equal(second.orders[0].p, "0.012401");
  assert.equal(wirePrice(123_456.7, 0, "perp", true), 123_456);
  assert.equal(wirePrice(0.000123456, 0, "spot", false), 0.00012346);
  assert.throws(() => orderSize(0.001, 3.7, 0), /rounds to zero/);
  const nonce = nextHyperliquidNonce(5);
  assert.ok(nextHyperliquidNonce(5) > nonce);
});

function hyperIntent(key: string): SwapIntent {
  return {
    ...evmIntent(key),
    token: { ...evmIntent(key).token, pairMap: buildPairMap([{ ...evmIntent(key).token.pairMap.pools[0], liquidityUsd: 100 }]) },
    hyperliquid: { coin: "TKN", assetIndex: 4, market: "perp", maxLeverage: 5 },
  };
}

function exchange(orderReply: unknown, seen: unknown[]): typeof fetch {
  return async (_input, init) => {
    const body = JSON.parse(String(init?.body)) as { action: { type: string } };
    seen.push(body.action);
    const reply = body.action.type === "order" ? orderReply : { status: "ok", response: { type: "default" } };
    return new Response(JSON.stringify(reply), { status: 200 });
  };
}

test("hyperliquid replies decide commit or release", async () => {
  const hyperConfig = loadConfig({ HYPERLIQUID_API_URL: "https://hl.invalid" });
  const run = async (key: string, reply: unknown) => {
    resetExecutorState();
    const spend = new Map<string, string>();
    const seen: unknown[] = [];
    const deps: ExecutorDeps = {
      ...liveDeps((request, onTx) => broadcastRoute(hyperConfig, evmSigner([]), request, 1, exchange(reply, seen), [], { onTx }), spend, [], false),
      config: { ...hyperConfig, enabledChainKeys: new Set(["base", "hypercore"]) },
      markPrice: async () => 1,
      szDecimals: async () => 2,
    };
    const report = await execute(hyperIntent(key), deps);
    return { report, spend: spend.get(key), seen };
  };
  const err = await run("hl-err", { status: "err", response: "Insufficient margin" });
  assert.equal(err.report.decision, "skipped");
  assert.match(err.report.reason, /Insufficient margin/);
  assert.equal(err.spend, "released");
  const rejected = await run("hl-rejected", { status: "ok", response: { type: "order", data: { statuses: [{ error: "Order could not immediately match" }] } } });
  assert.equal(rejected.report.decision, "skipped");
  assert.equal(rejected.spend, "released");
  const filled = await run("hl-filled", { status: "ok", response: { type: "order", data: { statuses: [{ filled: { totalSz: "5", avgPx: "1.001", oid: 9 } }] } } });
  assert.equal(filled.report.decision, "sent");
  assert.equal(filled.spend, "committed");
  assert.deepEqual(filled.report.fill, { totalSz: "5", avgPx: "1.001" });
  assert.equal((filled.seen[1] as { orders: Array<{ s: string; p: string }> }).orders[0]?.s, "5");
  assert.equal(readExchangeResponse({ status: "ok", response: { data: { statuses: [{ resting: { oid: 1 } }] } } }).status, "ok");
});

test("a hyperliquid spot buy sends only the order, with no leverage action", async () => {
  resetExecutorState();
  const hyperConfig = loadConfig({ HYPERLIQUID_API_URL: "https://hl.invalid" });
  const seen: unknown[] = [];
  const filled = { status: "ok", response: { type: "order", data: { statuses: [{ filled: { totalSz: "5", avgPx: "1.001", oid: 9 } }] } } };
  const deps: ExecutorDeps = {
    ...liveDeps((request, onTx) => broadcastRoute(hyperConfig, evmSigner([]), request, 1, exchange(filled, seen), [], { onTx }), new Map(), [], false),
    config: { ...hyperConfig, enabledChainKeys: new Set(["base", "hypercore"]) },
    markPrice: async () => 1,
    szDecimals: async () => 2,
  };
  const spot = { ...hyperIntent("hl-spot"), hyperliquid: { coin: "TKN", assetIndex: 10_004, market: "spot" as const, maxLeverage: 1 } };
  const report = await execute(spot, deps);
  assert.equal(report.decision, "sent");
  assert.deepEqual(
    seen.map((action) => (action as { type: string }).type),
    ["order"],
  );
});

test("a solana expiry is rechecked on every rpc before it is declared", async () => {
  const keypair = Keypair.generate();
  let height = 95;
  const confirmed = { slot: 1, confirmations: null, err: null, confirmationStatus: "confirmed" as const };
  const connection = (knows: boolean) =>
    ({
      getLatestBlockhash: async () => ({ blockhash: Keypair.generate().publicKey.toBase58(), lastValidBlockHeight: 100 }),
      getBlockHeight: async () => (height += 1),
      getBalance: async () => 10_000_000_000,
      sendRawTransaction: async () => "sig",
      getSignatureStatuses: async (_sigs: string[], options?: { searchTransactionHistory?: boolean }) => ({
        context: { slot: 1 },
        value: [knows && options?.searchTransactionHistory ? confirmed : null],
      }),
    }) as never;
  const signer: TransactionSigner = {
    backend: "keystore",
    evmAddress: () => null,
    solanaAddress: () => keypair.publicKey.toBase58(),
    async signEvm() {
      return "0x";
    },
    async signSolana(serialized) {
      const tx = VersionedTransaction.deserialize(serialized);
      tx.sign([keypair]);
      return tx.serialize();
    },
    async signHyperliquid() {
      return { r: "0x01", s: "0x02", v: 27 };
    },
  };
  const tx = await withdrawNative({
    config: loadConfig({ SOLANA_RPC_URL: "http://fake.invalid" }),
    signer,
    chainKey: "solana",
    to: Keypair.generate().publicKey.toBase58(),
    amount: 0.01,
    io: clockIo(null, solanaRpcOver([connection(false), connection(true)])),
  });
  assert.ok(height > 100, "the blockhash had expired on the first rpc");
  assert.equal(tx.outcome, "landed", "the second rpc's history shows the signature landed");
});

test("a hyperliquid sizing failure is skipped, not thrown", async () => {
  resetExecutorState();
  const report = await execute(hyperIntent("hl-size"), {
    ...liveDeps(async () => assert.fail("must not send"), new Map(), [], false),
    config: { ...evmConfig, enabledChainKeys: new Set(["base", "hypercore"]) },
    markPrice: async () => 1,
    szDecimals: async () => null,
  });
  assert.equal(report.decision, "skipped");
  assert.match(report.reason, /szDecimals/);
});

test("live screening denies a token whose tax fields are missing", async () => {
  const row = async () => new Response(JSON.stringify({ code: 1, result: { [TOKEN]: { is_honeypot: "0", cannot_sell_all: "0" } } }), { status: 200 });
  const token = { chainKey: "base", chain: { kind: "evm" as const, chainId: 8453 }, contract: TOKEN };
  assert.equal(await screenToken(loadConfig({ LISTING_TRADER_LIVE: "true" }), token, row), "deny");
  assert.equal(await screenToken(loadConfig({ TOKEN_SCREENING: "true" }), token, row), "allow");
  const taxed = async () => new Response(JSON.stringify({ code: 1, result: { [TOKEN]: { is_honeypot: "0", buy_tax: "0.01", sell_tax: "0" } } }), { status: 200 });
  assert.equal(await screenToken(loadConfig({ LISTING_TRADER_LIVE: "true" }), token, taxed), "deny");
});

test("reconciliation commits landed rows, releases dead ones, and keeps what it cannot prove", () => {
  const row = { idempotencyKey: "k", txHash: "0xabc", chainKey: "base", legacy: false };
  assert.equal(reconcileDecision(row, ["landed"]), "commit");
  assert.equal(reconcileDecision(row, ["reverted"]), "release");
  assert.equal(reconcileDecision(row, ["expired"]), "release");
  assert.equal(reconcileDecision(row, ["pending"]), "keep");
  assert.equal(reconcileDecision(row, [null]), "keep");
  assert.equal(reconcileDecision(row, ["expired", "landed"]), "commit", "a replacement that landed commits even though the original died");
  assert.equal(reconcileDecision(row, ["expired", "pending"]), "keep");
  assert.equal(reconcileDecision({ ...row, txHash: null }, []), "release");
  assert.equal(reconcileDecision({ ...row, txHash: null, legacy: true }, []), "keep");
});

test("an aged evm hash is dead only once the mined nonce has passed it", async () => {
  const chain = fakeChain();
  const config = evmConfig;
  const io = clockIo(chain.rpc);
  const aged = { chainKey: "base", txHash: "0xdead", from: OWNER, nonce: 7 };
  chain.mined = 7;
  assert.equal(await lookupAgedTx(config, aged, io), "pending");
  chain.mined = 8;
  assert.equal(await lookupAgedTx(config, aged, io), "expired");
  assert.equal(await lookupAgedTx(config, { ...aged, nonce: null }, io), "pending", "without a recorded nonce the row stays held");
  chain.receipts.set("0xdead", success);
  assert.equal(await lookupAgedTx(config, aged, io), "landed");
  assert.deepEqual(chain.depths, [3, 3, 3], "base reads the nonce three blocks below the head");
});

test("an aged evm hash is not released while any RPC has its receipt, and the nonce is read at the chain's reorg depth", async () => {
  const lagging = fakeChain();
  const fresh = fakeChain();
  lagging.mined = 8;
  fresh.mined = 8;
  fresh.receipts.set("0xdead", success);
  const config = loadConfig({ RPC_URLS_137: "http://lagging.invalid,http://fresh.invalid" });
  const io: SendIo = { ...clockIo(lagging.rpc), evm: (_chainId, rpcs) => (rpcs.length === 1 && rpcs[0] === "http://fresh.invalid" ? fresh.rpc : lagging.rpc) };
  const aged = { chainKey: "polygon", txHash: "0xdead", from: OWNER, nonce: 7 };
  assert.equal(await lookupAgedTx(config, aged, io), "landed", "the lagging node's missing receipt does not outvote the node that has it");
  assert.deepEqual(lagging.depths, [64]);
  fresh.receipts.clear();
  assert.equal(await lookupAgedTx(config, aged, io), "expired");
  fresh.rpc.receipt = async () => {
    throw new Error("fetch failed");
  };
  await assert.rejects(() => lookupAgedTx(config, aged, io), /fetch failed/, "an RPC that cannot answer leaves the row held");
  await lookupAgedTx(loadConfig({ RPC_URLS_137: "http://lagging.invalid", REORG_DEPTH_JSON: JSON.stringify({ "137": 128 }) }), aged, io);
  assert.deepEqual(lagging.depths, [64, 64, 64, 128]);
});

test("a definite rejection for a hash some RPC already has is treated as broadcast", async () => {
  const chain = fakeChain();
  chain.rpc.sendRaw = async (signed) => {
    chain.known.add(keccak256(signed));
    throw new Error("nonce too low");
  };
  const io = clockIo(chain.rpc);
  const send = () => withdrawNative({ config: evmConfig, signer: evmSigner([]), chainKey: "base", to: DEST, amount: 0.0001, io });
  await assert.rejects(send, (error: unknown) => error instanceof BroadcastError && error.broadcast);
  chain.known.clear();
  chain.rpc.sendRaw = async () => {
    throw new Error("nonce too low");
  };
  await assert.rejects(send, (error: unknown) => error instanceof BroadcastError && !error.broadcast);
  chain.rpc.seen = async () => {
    throw new Error("fetch failed");
  };
  await assert.rejects(send, (error: unknown) => error instanceof BroadcastError && error.broadcast, "a lookup that fails cannot prove the hash is nowhere");
});

test("a definite rejection from a private relay keeps the send counted as broadcast", async () => {
  const chain = fakeChain();
  chain.rpc.sendRaw = async () => {
    throw new Error("nonce too low");
  };
  const config = loadConfig({ RPC_URL_8453: "http://fake.invalid", MEV_RPC_URL_8453: "http://relay.invalid", ZEROX_API_KEY: "zeroex-key" });
  const send = () => withdrawNative({ config, signer: evmSigner([]), chainKey: "base", to: DEST, amount: 0.0001, io: clockIo(chain.rpc) });
  await assert.rejects(send, (error: unknown) => error instanceof BroadcastError && error.broadcast);
});
