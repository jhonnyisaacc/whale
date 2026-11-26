import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import test from "node:test";
import { Keypair } from "@solana/web3.js";
import type { Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { agentTypedData, buildOrder, buildWithdraw, withdrawTypedData, type HyperliquidAction, type WithdrawAction } from "../src/hyperliquid.js";
import { localSender } from "../src/local-sends.js";
import { callTool } from "../src/mcp-server.js";
import { startSignerQueue, type SignerQueue } from "../src/signer-queue.js";
import { SignerRefusal, whaleSigner, type SignerJobRecord } from "../src/whale-signer.js";

const TOKEN = "t".repeat(40);
const EVM_KEY = `0x${"11".repeat(32)}` as Hex;
const OTHER_KEY = `0x${"22".repeat(32)}` as Hex;
const evm = privateKeyToAccount(EVM_KEY);
const PERP_CAP = { MAX_USD_PER_TRADE: "10" };
const solana = Keypair.fromSeed(new Uint8Array(32).fill(3)).publicKey.toBase58();

type Job = { id: string; kind: string; payload: { network: string; nonce: number; action: HyperliquidAction | WithdrawAction } };

async function lease(queue: SignerQueue): Promise<Job> {
  const response = await fetch(`${queue.url}/signer/v1/jobs?wait=5`, { headers: { authorization: `Bearer ${TOKEN}` } });
  assert.equal(response.status, 200, "whale-signer leased a job");
  return (await response.json()) as Job;
}

async function answer(queue: SignerQueue, id: string, body: unknown): Promise<void> {
  const response = await fetch(`${queue.url}/signer/v1/jobs/${id}/result`, { method: "POST", headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" }, body: JSON.stringify(body) });
  assert.equal(response.status, 204);
}

async function signJob(job: Job, key: Hex) {
  const account = privateKeyToAccount(key);
  const { network, nonce, action } = job.payload;
  const raw = action.type === "withdraw3" ? await account.signTypedData(withdrawTypedData(action)) : await account.signTypedData(agentTypedData(action, nonce, network === "mainnet"));
  return { r: `0x${raw.slice(2, 66)}`, s: `0x${raw.slice(66, 130)}`, v: Number.parseInt(raw.slice(130, 132), 16) };
}

async function withQueue(run: (queue: SignerQueue, jobs: SignerJobRecord[]) => Promise<void>): Promise<void> {
  const queue = await startSignerQueue({ token: TOKEN, port: 0, answerTimeoutMs: 5_000 });
  try {
    await run(queue, []);
  } finally {
    await queue.close();
  }
}

const order = buildOrder({ asset: 1, isBuy: true, limitPx: 1733.9, size: 0.0023 });

test("a hypercore action goes to whale-signer with its network and nonce, and the signature must recover to the wallet", () =>
  withQueue(async (queue, jobs) => {
    const signer = whaleSigner(queue, { evm: evm.address, solana }, jobs);
    const pending = signer.signHyperliquid(order, 1_795_462_684_784, true);
    const job = await lease(queue);
    assert.deepEqual({ kind: job.kind, payload: job.payload }, { kind: "hypercore", payload: { network: "mainnet", nonce: 1_795_462_684_784, action: order } });
    const signature = await signJob(job, EVM_KEY);
    await answer(queue, job.id, { decision: "signed", result: { signature } });
    assert.deepEqual(await pending, signature);
    assert.equal(jobs[0]?.kind, "hypercore");
    assert.equal(jobs[0]?.decision, "signed");

    const forged = assert.rejects(signer.signHyperliquid(order, 1_795_462_684_785, false), /does not recover to 0x/);
    const next = await lease(queue);
    assert.equal(next.payload.network, "testnet");
    await answer(queue, next.id, { decision: "signed", result: { signature: await signJob(next, OTHER_KEY) } });
    await forged;
    assert.equal(jobs.length, 1, "a forged signature is not recorded as signed");
  }));

test("a withdraw3 goes to whale-signer with the nonce equal to its time, and a refusal is final", () =>
  withQueue(async (queue, jobs) => {
    const signer = whaleSigner(queue, { evm: evm.address, solana }, jobs);
    const action = buildWithdraw({ destination: evm.address, amountUsd: 1.5, time: 1_795_462_700_000, isMainnet: true });
    assert.ok(signer.signHyperliquidWithdraw);
    const pending = signer.signHyperliquidWithdraw(action);
    const job = await lease(queue);
    assert.deepEqual(job.payload, { network: "mainnet", nonce: 1_795_462_700_000, action });
    const signature = await signJob(job, EVM_KEY);
    await answer(queue, job.id, { decision: "signed", result: { signature } });
    assert.deepEqual(await pending, signature);

    const refused = assert.rejects(signer.signHyperliquidWithdraw({ ...action, destination: "0x3333333333333333333333333333333333333333" }), (error: unknown) => error instanceof SignerRefusal && /a withdrawal may only pay this wallet/.test(error.message));
    const next = await lease(queue);
    await answer(queue, next.id, { decision: "refused", reasons: ["hypercore: a withdrawal may only pay this wallet or a listed destination"] });
    await refused;
  }));

test("an mcp perp order reaches the local sender, and without whale-signer it is skipped", async () => {
  const seen: unknown[] = [];
  const deps = { executorUrl: "http://127.0.0.1:1", executorAuthToken: null };
  const args = { idempotencyKey: "p", coin: "ETH", side: "buy", notionalUsd: 10, slippageBps: 50 };
  assert.deepEqual(await callTool(deps, "perp", args), { kind: "perp", status: "skipped", reason: "a perp order needs whale-signer. set WHALE_SIGNER_KEYSTORE and run whale-signer serve" });
  await callTool({ ...deps, localSend: async (command) => (seen.push(command), { kind: "perp", status: "skipped", reason: "", broadcast: false, jobs: [], txs: [] }) }, "perp", { ...args, mode: "live" });
  assert.deepEqual(seen, [{ kind: "perp", ...args, mode: "live" }]);
  await assert.rejects(callTool(deps, "perp", { ...args, vaultAddress: "0x1" }), /vaultAddress/);
});

async function hyperliquidInfo(agents: unknown[] = []): Promise<{ url: string; close: () => Promise<void>; positionReads: string[]; agentReads: string[] }> {
  const positionReads: string[] = [];
  const agentReads: string[] = [];
  const server = createServer((request, response) => {
    let body = "";
    request.on("data", (chunk) => (body += chunk));
    request.on("end", () => {
      const { type, user } = JSON.parse(body) as { type: string; user?: string };
      if (type === "clearinghouseState") positionReads.push(user ?? "");
      if (type === "extraAgents") agentReads.push(user ?? "");
      const reply = type === "extraAgents" ? agents : type === "meta" ? { universe: [{ name: "BTC", szDecimals: 5, maxLeverage: 40 }, { name: "ETH", szDecimals: 4, maxLeverage: 25 }] } : type === "allMids" ? { BTC: "91000", ETH: "1725.3" } : type === "clearinghouseState" ? { assetPositions: [] } : null;
      response.writeHead(reply ? 200 : 404, { "content-type": "application/json" });
      response.end(JSON.stringify(reply));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return { url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, close: () => new Promise((resolve) => server.close(() => resolve())), positionReads, agentReads };
}

test("with WHALE_BROADCAST off, a local perp buy signs updateLeverage and the order through whale-signer and sends neither", async () => {
  const info = await hyperliquidInfo();
  try {
    await withQueue(async (queue) => {
      const send = localSender({ HYPERLIQUID_API_URL: info.url, ...PERP_CAP }, queue, { evmAddress: evm.address, solanaAddress: solana, token: TOKEN, port: 0, answerTimeoutMs: 5_000, bitcoinPublicKey: null });
      const dry = await send({ kind: "perp", idempotencyKey: "dry", coin: "ETH", side: "buy", notionalUsd: 10, slippageBps: 50, mode: "dry_run" });
      assert.equal(dry.status, "would_send");
      assert.match(dry.reason, /hypercore ETH (asset 1 )?leverage 1 isolated limit .* actions updateLeverage,order/);
      assert.deepEqual(info.positionReads, [evm.address]);
      assert.deepEqual(info.agentReads, [], "the key's own account needs no agent check");

      const live = send({ kind: "perp", idempotencyKey: "live", coin: "ETH", side: "buy", notionalUsd: 10, slippageBps: 50, mode: "live" });
      const leverage = await lease(queue);
      assert.deepEqual(leverage.payload.action, { type: "updateLeverage", asset: 1, isCross: false, leverage: 1 });
      await answer(queue, leverage.id, { decision: "signed", result: { signature: await signJob(leverage, EVM_KEY) } });
      const placed = await lease(queue);
      assert.equal(placed.payload.action.type, "order");
      await answer(queue, placed.id, { decision: "signed", result: { signature: await signJob(placed, EVM_KEY) } });
      const result = await live;
      assert.equal(result.status, "signed");
      assert.equal(result.broadcast, false);
      assert.deepEqual(result.txs.map((tx) => [tx.to, tx.outcome, tx.from]), [["updateLeverage", "signed", evm.address], ["order", "signed", evm.address]]);

      const refused = assert.rejects(send({ kind: "perp", idempotencyKey: "refused", coin: "ETH", side: "buy", notionalUsd: 10, slippageBps: 50, mode: "live" }), (error: unknown) => error instanceof SignerRefusal && /above its whole 3000000 daily limit/.test(error.message));
      const first = await lease(queue);
      await answer(queue, first.id, { decision: "signed", result: { signature: await signJob(first, EVM_KEY) } });
      const second = await lease(queue);
      await answer(queue, second.id, { decision: "refused", reasons: ["hypercore: 3985900 of hypercore:usdc is above its whole 3000000 daily limit"] });
      await refused;

      assert.equal((await send({ kind: "perp", idempotencyKey: "nope", coin: "NOPE", side: "buy", notionalUsd: 10, slippageBps: 50, mode: "live" })).reason, "NOPE is not a listed Hyperliquid perp");

      const gated = localSender({ HYPERLIQUID_API_URL: info.url, ...PERP_CAP, SUPPORT_TIERS: "hypercore:dry_run" }, queue, { evmAddress: evm.address, solanaAddress: solana, token: TOKEN, port: 0, answerTimeoutMs: 5_000, bitcoinPublicKey: null });
      const blockedLive = await gated({ kind: "perp", idempotencyKey: "tier-live", coin: "ETH", side: "buy", notionalUsd: 10, slippageBps: 50, mode: "live" });
      assert.deepEqual([blockedLive.status, blockedLive.reason, blockedLive.jobs.length], ["skipped", "chain is not enabled for live sends", 0]);
      assert.equal((await gated({ kind: "perp", idempotencyKey: "tier-dry", coin: "ETH", side: "buy", notionalUsd: 10, slippageBps: 50, mode: "dry_run" })).status, "would_send");
    });
  } finally {
    await info.close();
  }
});

test("a local perp trade on another HYPERLIQUID_ACCOUNT_ADDRESS needs that account to have approved the whale-signer key", async () => {
  const master = "0x3333333333333333333333333333333333333333";
  const setup = { evmAddress: evm.address, solanaAddress: solana, token: TOKEN, port: 0, answerTimeoutMs: 5_000, bitcoinPublicKey: null };
  const dry = { kind: "perp", idempotencyKey: "dry", coin: "ETH", side: "buy", notionalUsd: 10, slippageBps: 50, mode: "dry_run" } as const;
  for (const [agents, approved] of [[[], false], [[{ address: "0x4444444444444444444444444444444444444444", validUntil: null }], false], [[{ address: evm.address.toLowerCase(), validUntil: Date.now() - 1 }], false], [[{ address: evm.address.toLowerCase(), validUntil: Date.now() + 60_000 }], true]] as const) {
    const info = await hyperliquidInfo([...agents]);
    try {
      await withQueue(async (queue) => {
        const send = localSender({ HYPERLIQUID_API_URL: info.url, ...PERP_CAP, HYPERLIQUID_ACCOUNT_ADDRESS: master }, queue, setup);
        if (approved) assert.equal((await send(dry)).status, "would_send");
        else await assert.rejects(send(dry), /^Error: hyperliquid agent is not approved$/);
        assert.deepEqual(info.agentReads, [master]);
        assert.deepEqual(info.positionReads, approved ? [master] : [], "no position is read for an account the key cannot trade");
      });
    } finally {
      await info.close();
    }
  }
  const info = await hyperliquidInfo();
  try {
    await withQueue(async (queue) => {
      const send = localSender({ HYPERLIQUID_API_URL: info.url, ...PERP_CAP, HYPERLIQUID_ACCOUNT_ADDRESS: evm.address.toLowerCase() }, queue, setup);
      assert.equal((await send(dry)).status, "would_send");
      assert.deepEqual(info.agentReads, [], "the key's own address in any case needs no agent check");
    });
  } finally {
    await info.close();
  }
});
