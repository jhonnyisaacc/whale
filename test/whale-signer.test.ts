import assert from "node:assert/strict";
import test from "node:test";
import { Keypair, PublicKey, SystemProgram, TransactionMessage, VersionedTransaction } from "@solana/web3.js";
import bs58 from "bs58";
import { keccak256, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { callTool, createHandler } from "../src/mcp-server.js";
import { startSignerQueue, type SignerQueue } from "../src/signer-queue.js";
import { localSender } from "../src/local-sends.js";
import { SignerRefusal, whaleSigner, type SignerJobRecord } from "../src/whale-signer.js";

const TOKEN = "t".repeat(40);
const EVM_KEY = `0x${"11".repeat(32)}` as Hex;
const OTHER_KEY = `0x${"22".repeat(32)}` as Hex;
const evm = privateKeyToAccount(EVM_KEY);
const solana = Keypair.fromSeed(new Uint8Array(32).fill(3));
const BUY_MINT = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";

type Job = { id: string; kind: "evm" | "solana"; payload: Record<string, unknown> };

async function lease(queue: SignerQueue, token = TOKEN): Promise<{ status: number; job: Job | null }> {
  const response = await fetch(`${queue.url}/signer/v1/jobs?wait=2`, { headers: { authorization: `Bearer ${token}` } });
  return { status: response.status, job: response.status === 200 ? ((await response.json()) as Job) : null };
}

async function answer(queue: SignerQueue, id: string, body: unknown): Promise<number> {
  const response = await fetch(`${queue.url}/signer/v1/jobs/${id}/result`, { method: "POST", headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" }, body: JSON.stringify(body) });
  return response.status;
}

async function signEvmJob(job: Job, key: Hex): Promise<Hex> {
  const tx = job.payload.tx as Record<string, string>;
  return privateKeyToAccount(key).signTransaction({
    type: "eip1559",
    chainId: job.payload.chainId as number,
    nonce: Number(tx.nonce),
    to: tx.to as Hex,
    value: BigInt(tx.value as string),
    data: tx.data as Hex,
    gas: BigInt(tx.gas as string),
    maxFeePerGas: BigInt(tx.maxFeePerGas as string),
    maxPriorityFeePerGas: BigInt(tx.maxPriorityFeePerGas as string),
  });
}

const evmInput = { chainId: 1, to: "0x2222222222222222222222222222222222222222" as Hex, data: "0x" as Hex, value: 1000n, gas: 21_000n, nonce: 4, maxFeePerGas: 30n, maxPriorityFeePerGas: 2n, purpose: "withdraw" as const };

function solanaTransfer(): VersionedTransaction {
  const message = new TransactionMessage({
    payerKey: solana.publicKey,
    recentBlockhash: bs58.encode(new Uint8Array(32).fill(9)),
    instructions: [SystemProgram.transfer({ fromPubkey: solana.publicKey, toPubkey: new PublicKey(BUY_MINT), lamports: 5 })],
  }).compileToV0Message();
  return new VersionedTransaction(message);
}

async function withQueue(run: (queue: SignerQueue, jobs: SignerJobRecord[]) => Promise<void>, answerTimeoutMs = 5_000): Promise<void> {
  const queue = await startSignerQueue({ token: TOKEN, port: 0, answerTimeoutMs });
  try {
    await run(queue, []);
  } finally {
    await queue.close();
  }
}

test("an evm job carries the unsigned fields and comes back as a transaction verified against the signer's address", () =>
  withQueue(async (queue, jobs) => {
    const signer = whaleSigner(queue, { evm: evm.address, solana: solana.publicKey.toBase58() }, jobs);
    const pending = signer.signEvm(evmInput);
    const { job } = await lease(queue);
    assert.ok(job);
    assert.deepEqual(job.payload, { chainId: 1, tx: { nonce: "4", to: evmInput.to, value: "1000", data: "0x", gas: "21000", maxFeePerGas: "30", maxPriorityFeePerGas: "2" } });
    const signed = await signEvmJob(job, EVM_KEY);
    assert.equal(await answer(queue, job.id, { decision: "signed", result: { signedTransaction: signed } }), 204);
    assert.equal(await pending, signed);
    assert.deepEqual(jobs, [{ id: job.id, kind: "evm", decision: "signed", hash: keccak256(signed) }]);
  }));

test("a refusal from whale-signer is final and names the job and its reasons", () =>
  withQueue(async (queue, jobs) => {
    const signer = whaleSigner(queue, { evm: evm.address, solana: solana.publicKey.toBase58() }, jobs);
    const pending = assert.rejects(signer.signEvm(evmInput), (error: unknown) => error instanceof SignerRefusal && /refused job .*: a native transfer may only pay a listed destination/.test(error.message));
    const { job } = await lease(queue);
    assert.ok(job);
    assert.equal(await answer(queue, job.id, { decision: "refused", reasons: ["a native transfer may only pay a listed destination"] }), 204);
    await pending;
    assert.equal(jobs[0]?.decision, "refused");
    assert.equal(await answer(queue, job.id, { decision: "signed", result: {} }), 409, "a settled job takes no second answer");
  }));

test("a signature from any other key is rejected, so a stolen token cannot inject a transaction", () =>
  withQueue(async (queue, jobs) => {
    const signer = whaleSigner(queue, { evm: evm.address, solana: solana.publicKey.toBase58() }, jobs);
    const pending = assert.rejects(signer.signEvm(evmInput));
    const { job } = await lease(queue);
    assert.ok(job);
    await answer(queue, job.id, { decision: "signed", result: { signedTransaction: await signEvmJob(job, OTHER_KEY) } });
    await pending;
    assert.deepEqual(jobs, []);
  }));

test("the queue hands jobs only to the configured token", () =>
  withQueue(async (queue) => {
    const signer = whaleSigner(queue, { evm: evm.address, solana: solana.publicKey.toBase58() }, []);
    const pending = signer.signEvm(evmInput).catch(() => undefined);
    assert.equal((await lease(queue, "x".repeat(40))).status, 401);
    const { job } = await lease(queue);
    assert.ok(job);
    await answer(queue, job.id, { decision: "refused", reasons: [] });
    await pending;
  }));

test("a solana job sends the message and buyMint, and the answer becomes a transaction signed by the wallet", () =>
  withQueue(async (queue, jobs) => {
    const signer = whaleSigner(queue, { evm: evm.address, solana: solana.publicKey.toBase58() }, jobs);
    const unsigned = solanaTransfer();
    const pending = signer.signSolana(unsigned.serialize(), { buyMint: BUY_MINT });
    const { job } = await lease(queue);
    assert.ok(job);
    assert.equal(job.kind, "solana");
    assert.equal(job.payload.buyMint, BUY_MINT);
    assert.deepEqual(Buffer.from(job.payload.message as string, "base64"), Buffer.from(unsigned.message.serialize()));
    const signed = solanaTransfer();
    signed.sign([solana]);
    const signature = bs58.encode(signed.signatures[0] as Uint8Array);
    await answer(queue, job.id, { decision: "signed", result: { signature } });
    const out = VersionedTransaction.deserialize(await pending);
    assert.equal(bs58.encode(out.signatures[0] as Uint8Array), signature);
    assert.equal(jobs[0]?.hash, signature);
  }));

test("a job whale-signer never answers times out with the command to run", () =>
  withQueue(async (queue) => {
    const signer = whaleSigner(queue, { evm: evm.address, solana: solana.publicKey.toBase58() }, []);
    await assert.rejects(signer.signEvm(evmInput), /did not answer job .* Run whale-signer serve --gateway http:\/\/127\.0\.0\.1:/);
  }, 200));

test("mcp live sends go to the local sender, and its refusal is a tool error", async () => {
  const seen: unknown[] = [];
  const deps = {
    executorUrl: "http://127.0.0.1:1",
    executorAuthToken: null,
    localSend: async (command: unknown) => {
      seen.push(command);
      throw new SignerRefusal("job-1", ["not a listed destination"]);
    },
  };
  const asset = { chain: { kind: "evm", chainId: 1 }, chainKey: "ethereum", address: "0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee", symbol: "ETH", decimals: 18 };
  const reply = (await createHandler(deps)({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "transfer", arguments: { idempotencyKey: "k", mode: "live", asset, to: "0x3333333333333333333333333333333333333333", amount: "1" } } })) as { result: { isError?: boolean; content: { text: string }[] } };
  assert.equal(reply.result.isError, true);
  assert.match(reply.result.content[0]?.text ?? "", /whale-signer refused job job-1: not a listed destination/);
  assert.equal((seen[0] as { mode: string }).mode, "live");
  await assert.rejects(callTool(deps, "swap", { idempotencyKey: "s", mode: "live", sell: asset, buy: asset, sellAmount: "1", slippageBps: 50 }), /a live swap needs notionalUsd/);
  const dry = (await callTool({ ...deps, runCommand: async (command) => ({ kind: "transfer", status: "would_send", reason: command.kind }) }, "transfer", { idempotencyKey: "d", asset, to: "0x3333333333333333333333333333333333333333", amount: "1" })) as { status: string };
  assert.equal(dry.status, "would_send", "a dry-run transfer never reaches the signer");
  assert.equal(seen.length, 1);
});

test("a local send answers a repeated idempotencyKey once and refuses the key for a different command", () =>
  withQueue(async (queue) => {
    const send = localSender({ OWNER_WITHDRAW_ADDRESSES: "0x2222222222222222222222222222222222222222" }, queue, { evmAddress: evm.address, solanaAddress: solana.publicKey.toBase58(), token: TOKEN, port: 0, answerTimeoutMs: 1_000 });
    const asset = { chain: { kind: "evm" as const, chainId: 8453 }, chainKey: "base", address: "0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee", symbol: "ETH", decimals: 18 };
    const command = { kind: "transfer" as const, idempotencyKey: "same", mode: "live" as const, asset, to: "0x3333333333333333333333333333333333333333", amount: "1" };
    const first = await send(command);
    assert.deepEqual(first, { kind: "transfer", status: "skipped", reason: "destination is not in OWNER_WITHDRAW_ADDRESSES", broadcast: false, jobs: [], txs: [] });
    assert.equal(await send(command), first);
    await assert.rejects(send({ ...command, amount: "2" }), /used for a different command/);
  }));
