import assert from "node:assert/strict";
import { createPrivateKey, createPublicKey, sign } from "node:crypto";
import { request } from "node:http";
import { setTimeout as sleep } from "node:timers/promises";
import test from "node:test";
import bs58 from "bs58";
import { privateKeyToAccount } from "viem/accounts";
import { buildGateway } from "../src/gateway/app.js";
import { unfreezeAction } from "../src/gateway/policy-changes.js";
import { signerCodeAction } from "../src/gateway/routes-signers.js";
import { enqueueJob, LEASE_MS, registrationMessage } from "../src/gateway/signers.js";
import { gatewayConfig, signedInAccount } from "./gateway-fixtures.js";
import { migratedSchema, TEST_DATABASE_URL } from "./pg-schema.js";
import { softAuthenticator } from "./webauthn-fixtures.js";

const RP = { rpId: "whale.example", origin: "https://whale.example" };
const evm = privateKeyToAccount(`0x${"42".repeat(32)}`);
const solanaKey = createPrivateKey({ key: Buffer.concat([Buffer.from("302e020100300506032b657004220420", "hex"), Buffer.alloc(32, 0x24)]), format: "der", type: "pkcs8" });
const solanaAddress = bs58.encode(createPublicKey(solanaKey).export({ format: "der", type: "spki" }).subarray(12));
const officeKeys = {
  evm: privateKeyToAccount(`0x${"43".repeat(32)}`),
  solanaKey: createPrivateKey({ key: Buffer.concat([Buffer.from("302e020100300506032b657004220420", "hex"), Buffer.alloc(32, 0x25)]), format: "der", type: "pkcs8" }),
};

async function proofs(walletId: string, code: string, keys = { evm, solanaKey }) {
  const message = registrationMessage(walletId, code);
  return {
    code,
    walletId,
    evmAddress: keys.evm.address,
    solanaAddress: bs58.encode(createPublicKey(keys.solanaKey).export({ format: "der", type: "spki" }).subarray(12)),
    evmSignature: await keys.evm.signMessage({ message }),
    solanaSignature: bs58.encode(sign(null, Buffer.from(message), keys.solanaKey)),
  };
}

test("a self-hosted signer registers with a passkey-issued code and proofs of both keys, then pulls and answers jobs", { skip: !TEST_DATABASE_URL }, async () => {
  const { pool, drop } = await migratedSchema();
  let clock = Date.now();
  const app = await buildGateway({ config: gatewayConfig(), pool, logger: false, keys: { key: async () => null }, executor: null, turnkey: null, delegation: null, now: () => clock, signerPollMs: 10 });
  try {
    const user = await signedInAccount(pool);
    const authenticator = softAuthenticator(RP);
    const options = (await app.inject({ method: "POST", url: "/api/passkeys/options", headers: user.headers, payload: {} })).json();
    await app.inject({ method: "POST", url: "/api/passkeys", headers: user.headers, payload: { credential: authenticator.register(options.challenge), label: "Mac" } });
    const wallet = (await app.inject({ method: "POST", url: "/api/wallets", headers: user.headers, payload: { label: "home", level: "self_hosted" } })).json();
    const approve = async (walletId: string) => {
      const stepUp = (await app.inject({ method: "POST", url: "/api/passkeys/step-up", headers: user.headers, payload: { action: signerCodeAction(walletId) } })).json();
      return authenticator.assert(stepUp.challenge);
    };

    assert.equal((await app.inject({ method: "POST", url: `/api/wallets/${wallet.id}/signer/code`, headers: user.headers, payload: {} })).statusCode, 428);
    const wrongWallet = await app.inject({ method: "POST", url: `/api/wallets/${wallet.id}/signer/code`, headers: user.headers, payload: { assertion: await approve("00000000-0000-4000-8000-000000000000") } });
    assert.equal(wrongWallet.statusCode, 403);
    const first = (await app.inject({ method: "POST", url: `/api/wallets/${wallet.id}/signer/code`, headers: user.headers, payload: { assertion: await approve(wallet.id) } })).json();
    assert.match(first.command, /whale-signer connect/);

    const forged = await app.inject({ method: "POST", url: "/signer/v1/register", payload: { ...(await proofs(wallet.id, first.code)), solanaAddress: bs58.encode(Buffer.alloc(32, 9)) } });
    assert.match(forged.json().detail, /Solana signature/);
    const burned = await app.inject({ method: "POST", url: "/signer/v1/register", payload: await proofs(wallet.id, first.code) });
    assert.match(burned.json().detail, /unknown, used/);

    const second = (await app.inject({ method: "POST", url: `/api/wallets/${wallet.id}/signer/code`, headers: user.headers, payload: { assertion: await approve(wallet.id) } })).json();
    const registered = await app.inject({ method: "POST", url: "/signer/v1/register", payload: await proofs(wallet.id, second.code) });
    assert.equal(registered.statusCode, 201);
    const token = registered.json().token as string;
    const listed = (await app.inject({ method: "GET", url: "/api/wallets", headers: user.headers })).json().wallets[0];
    assert.equal(listed.status, "active");
    assert.deepEqual(listed.addresses.map((entry: { address: string }) => entry.address), [evm.address, solanaAddress]);

    const pull = () => app.inject({ method: "GET", url: "/signer/v1/jobs?wait=0", headers: { authorization: `Bearer ${token}` } });
    assert.equal((await pull()).statusCode, 204);
    assert.equal((await app.inject({ method: "GET", url: "/signer/v1/jobs", headers: { authorization: "Bearer wsig_0000000000000000_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA" } })).statusCode, 401);
    const jobId = await enqueueJob(pool, { accountId: user.accountId, walletId: wallet.id, kind: "evm", payload: { chainId: 8453 }, ttlMs: 10 * 60_000 }, clock);
    const pulled = await pull();
    assert.equal(pulled.statusCode, 200, pulled.body);
    const job = pulled.json();
    assert.deepEqual([job.id, job.kind, job.payload.chainId], [jobId, "evm", 8453]);
    assert.equal((await pull()).statusCode, 204, "a leased job is not handed out twice");
    clock += LEASE_MS + 1;
    assert.equal((await pull()).json().id, jobId, "an expired lease puts the job back");
    const answer = (payload: unknown) => app.inject({ method: "POST", url: `/signer/v1/jobs/${jobId}/result`, headers: { authorization: `Bearer ${token}` }, payload: payload as Record<string, unknown> });
    assert.equal((await answer({ decision: "refused", reasons: ["chain 8453 is not in the policy"] })).statusCode, 204);
    assert.equal((await answer({ decision: "signed", result: {} })).statusCode, 409);
    const stored = await pool.query("SELECT status, result FROM signing_jobs WHERE id = $1", [jobId]);
    assert.deepEqual(stored.rows[0], { status: "refused", result: { reasons: ["chain 8453 is not in the policy"] } });

    await app.inject({ method: "POST", url: `/api/wallets/${wallet.id}/freeze`, headers: user.headers, payload: {} });
    await enqueueJob(pool, { accountId: user.accountId, walletId: wallet.id, kind: "solana", payload: {}, ttlMs: 60_000 }, clock);
    assert.equal((await pull()).statusCode, 204, "a frozen wallet's signer gets no work");
    await pool.query("UPDATE signers SET revoked_at = now()");
    assert.equal((await pull()).statusCode, 401);
    const actions = (await pool.query("SELECT action FROM audit_events WHERE action LIKE 'signer.%' ORDER BY id")).rows.map((row) => row.action);
    assert.deepEqual(actions, ["signer.code_issued", "signer.code_issued", "signer.registered", "signer.refused"]);
  } finally {
    await app.close();
    await drop();
  }
});

async function registeredSigner(options: { signerPollMs?: number; spareCode?: boolean } = {}) {
  const { pool, drop } = await migratedSchema();
  const clock = { now: Date.now() };
  const app = await buildGateway({ config: gatewayConfig(), pool, logger: false, keys: { key: async () => null }, executor: null, turnkey: null, delegation: null, now: () => clock.now, signerPollMs: options.signerPollMs ?? 10 });
  const user = await signedInAccount(pool);
  const authenticator = softAuthenticator(RP);
  const passkeyOptions = (await app.inject({ method: "POST", url: "/api/passkeys/options", headers: user.headers, payload: {} })).json();
  await app.inject({ method: "POST", url: "/api/passkeys", headers: user.headers, payload: { credential: authenticator.register(passkeyOptions.challenge), label: "Mac" } });
  const approve = async (action: Record<string, unknown>) => {
    const stepUp = (await app.inject({ method: "POST", url: "/api/passkeys/step-up", headers: user.headers, payload: { action } })).json();
    return authenticator.assert(stepUp.challenge);
  };
  const newWallet = async (label: string) => (await app.inject({ method: "POST", url: "/api/wallets", headers: user.headers, payload: { label, level: "self_hosted" } })).json().id as string;
  const issueCode = async (walletId: string) =>
    (await app.inject({ method: "POST", url: `/api/wallets/${walletId}/signer/code`, headers: user.headers, payload: { assertion: await approve(signerCodeAction(walletId)) } })).json().code as string;
  const walletId = await newWallet("home");
  const spareCode = options.spareCode ? await issueCode(walletId) : null;
  const registered = await app.inject({ method: "POST", url: "/signer/v1/register", payload: await proofs(walletId, await issueCode(walletId)) });
  assert.equal(registered.statusCode, 201, registered.body);
  const auth = { authorization: `Bearer ${registered.json().token as string}` };
  const pull = () => app.inject({ method: "GET", url: "/signer/v1/jobs?wait=0", headers: auth });
  const answer = (jobId: string, payload: Record<string, unknown>) => app.inject({ method: "POST", url: `/signer/v1/jobs/${jobId}/result`, headers: auth, payload });
  const status = async (id = walletId) => (await app.inject({ method: "GET", url: "/api/wallets", headers: user.headers })).json().wallets.find((wallet: { id: string }) => wallet.id === id).status as string;
  const close = async () => {
    await app.close();
    await drop();
  };
  return { app, pool, clock, user, approve, newWallet, issueCode, walletId, spareCode, auth, pull, answer, status, close };
}

test("a self-hosted wallet with a registered signer comes back active after a freeze and unfreeze", { skip: !TEST_DATABASE_URL }, async () => {
  const signer = await registeredSigner();
  try {
    const { app, user, walletId } = signer;
    assert.equal((await app.inject({ method: "POST", url: `/api/wallets/${walletId}/freeze`, headers: user.headers, payload: {} })).statusCode, 200);
    const thawed = await app.inject({ method: "POST", url: `/api/wallets/${walletId}/unfreeze`, headers: user.headers, payload: { assertion: await signer.approve(unfreezeAction(walletId)) } });
    assert.equal(thawed.statusCode, 200, thawed.body);
    assert.equal(await signer.status(), "active");
    const jobId = await enqueueJob(signer.pool, { accountId: user.accountId, walletId, kind: "evm", payload: {}, ttlMs: 60_000 }, signer.clock.now);
    const pulled = await signer.pull();
    assert.equal(pulled.statusCode, 200, pulled.body);
    assert.equal(pulled.json().id, jobId);
  } finally {
    await signer.close();
  }
});

test("a second registration for a wallet, or the same keys on another wallet, is refused rather than failing", { skip: !TEST_DATABASE_URL }, async () => {
  const signer = await registeredSigner({ spareCode: true });
  try {
    const { app, walletId } = signer;
    const again = await app.inject({ method: "POST", url: "/signer/v1/register", payload: await proofs(walletId, signer.spareCode as string) });
    assert.equal(again.statusCode, 400, again.body);
    assert.match(again.json().detail, /not waiting for a signer/);
    const other = await signer.newWallet("office");
    const reused = await app.inject({ method: "POST", url: "/signer/v1/register", payload: await proofs(other, await signer.issueCode(other)) });
    assert.equal(reused.statusCode, 400, reused.body);
    assert.match(reused.json().detail, /another wallet/);
    assert.equal(await signer.status(other), "pending");
  } finally {
    await signer.close();
  }
});

test("a code issued before a freeze registers nothing, and the wallet comes back still waiting for a signer", { skip: !TEST_DATABASE_URL }, async () => {
  const signer = await registeredSigner();
  try {
    const { app, pool, user } = signer;
    const walletId = await signer.newWallet("office");
    const code = await signer.issueCode(walletId);
    const unused = await signer.issueCode(walletId);
    assert.equal((await app.inject({ method: "POST", url: `/api/wallets/${walletId}/freeze`, headers: user.headers, payload: {} })).statusCode, 200);
    const refused = await app.inject({ method: "POST", url: "/signer/v1/register", payload: await proofs(walletId, code, officeKeys) });
    assert.equal(refused.statusCode, 400, refused.body);
    assert.equal(refused.json().error, "registration_refused");
    const thawed = await app.inject({ method: "POST", url: `/api/wallets/${walletId}/unfreeze`, headers: user.headers, payload: { assertion: await signer.approve(unfreezeAction(walletId)) } });
    assert.equal(thawed.statusCode, 200, thawed.body);
    assert.equal(await signer.status(walletId), "pending");
    const left = await pool.query("SELECT (SELECT count(*)::int FROM signers WHERE wallet_id = $1) AS signers, (SELECT count(*)::int FROM wallet_addresses WHERE wallet_id = $1) AS addresses", [walletId]);
    assert.deepEqual(left.rows[0], { signers: 0, addresses: 0 });
    const voided = await app.inject({ method: "POST", url: "/signer/v1/register", payload: await proofs(walletId, unused, officeKeys) });
    assert.equal(voided.statusCode, 400, voided.body);
    assert.match(voided.json().detail, /unknown, used, expired/);
  } finally {
    await signer.close();
  }
});

test("a wallet whose signer was revoked comes back waiting, and only the same keys register for it again", { skip: !TEST_DATABASE_URL }, async () => {
  const signer = await registeredSigner();
  try {
    const { app, pool, user, walletId } = signer;
    assert.equal((await app.inject({ method: "POST", url: `/api/wallets/${walletId}/freeze`, headers: user.headers, payload: {} })).statusCode, 200);
    await pool.query("UPDATE signers SET revoked_at = now() WHERE wallet_id = $1", [walletId]);
    const thawed = await app.inject({ method: "POST", url: `/api/wallets/${walletId}/unfreeze`, headers: user.headers, payload: { assertion: await signer.approve(unfreezeAction(walletId)) } });
    assert.equal(thawed.statusCode, 200, thawed.body);
    assert.equal(await signer.status(), "pending");
    const swapped = await app.inject({ method: "POST", url: "/signer/v1/register", payload: await proofs(walletId, await signer.issueCode(walletId), officeKeys) });
    assert.equal(swapped.statusCode, 400, swapped.body);
    assert.match(swapped.json().detail, /other keys/);
    const again = await app.inject({ method: "POST", url: "/signer/v1/register", payload: await proofs(walletId, await signer.issueCode(walletId)) });
    assert.equal(again.statusCode, 201, again.body);
    assert.equal(await signer.status(), "active");
    assert.equal((await signer.pull()).statusCode, 401);
    const renewed = await app.inject({ method: "GET", url: "/signer/v1/jobs?wait=0", headers: { authorization: `Bearer ${again.json().token as string}` } });
    assert.equal(renewed.statusCode, 204, renewed.body);
  } finally {
    await signer.close();
  }
});

test("the same keys registering on two wallets at once is refused rather than failing", { skip: !TEST_DATABASE_URL }, async () => {
  const signer = await registeredSigner();
  try {
    const { app, pool } = signer;
    const office = await signer.newWallet("office");
    const lab = await signer.newWallet("lab");
    const payload = await proofs(office, await signer.issueCode(office), officeKeys);
    const blocker = await pool.connect();
    try {
      await blocker.query("BEGIN");
      await blocker.query("INSERT INTO wallet_addresses (wallet_id, family, address) VALUES ($1, 'evm', $2)", [lab, officeKeys.evm.address]);
      const racing = app.inject({ method: "POST", url: "/signer/v1/register", payload });
      await sleep(300);
      await blocker.query("COMMIT");
      const raced = await racing;
      assert.equal(raced.statusCode, 400, raced.body);
      assert.match(raced.json().detail, /another wallet/);
    } finally {
      blocker.release();
    }
    assert.equal(await signer.status(office), "pending");
  } finally {
    await signer.close();
  }
});

test("a refusal with many long reasons is stored, trimmed, and not handed out again", { skip: !TEST_DATABASE_URL }, async () => {
  const signer = await registeredSigner();
  try {
    const jobId = await enqueueJob(signer.pool, { accountId: signer.user.accountId, walletId: signer.walletId, kind: "evm", payload: {}, ttlMs: 10 * 60_000 }, signer.clock.now);
    assert.equal((await signer.pull()).json().id, jobId);
    const reasons = Array.from({ length: 25 }, (_, index) => `${index}:${"x".repeat(400)}`);
    const answered = await signer.answer(jobId, { decision: "refused", reasons });
    assert.equal(answered.statusCode, 204, answered.body);
    const stored = (await signer.pool.query("SELECT status, result FROM signing_jobs WHERE id = $1", [jobId])).rows[0];
    assert.equal(stored.status, "refused");
    assert.deepEqual(stored.result.reasons, reasons.slice(0, 20).map((reason) => reason.slice(0, 300)));
    signer.clock.now += LEASE_MS + 1;
    assert.equal((await signer.pull()).statusCode, 204);
  } finally {
    await signer.close();
  }
});

test("a long-poll whose client hung up does not lease the next job to it", { skip: !TEST_DATABASE_URL }, async () => {
  const signer = await registeredSigner({ signerPollMs: 20 });
  try {
    const address = await signer.app.listen({ host: "127.0.0.1", port: 0 });
    const hungUp = request(`${address}/signer/v1/jobs?wait=25`, { headers: signer.auth });
    hungUp.on("error", () => {});
    hungUp.end();
    await sleep(100);
    hungUp.destroy();
    await sleep(50);
    const jobId = await enqueueJob(signer.pool, { accountId: signer.user.accountId, walletId: signer.walletId, kind: "evm", payload: {}, ttlMs: 10 * 60_000 }, signer.clock.now);
    await sleep(200);
    const pulled = await signer.pull();
    assert.equal(pulled.statusCode, 200, "the job is still queued for a live signer");
    assert.equal(pulled.json().id, jobId);
  } finally {
    await signer.close();
  }
});

const evmJob = {
  chainId: 8453,
  tx: { nonce: "7", to: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913", value: "0", data: "0xa9059cbb", gas: "100000", maxFeePerGas: "1000000000", maxPriorityFeePerGas: "1000000" },
};

function signEvm(job: typeof evmJob, key = evm) {
  return key.signTransaction({
    type: "eip1559",
    chainId: job.chainId,
    nonce: Number(job.tx.nonce),
    to: job.tx.to as `0x${string}`,
    value: BigInt(job.tx.value),
    data: job.tx.data as `0x${string}`,
    gas: BigInt(job.tx.gas),
    maxFeePerGas: BigInt(job.tx.maxFeePerGas),
    maxPriorityFeePerGas: BigInt(job.tx.maxPriorityFeePerGas),
  });
}

test("a signed result is stored only when it signs exactly the job's payload with the wallet's own key", { skip: !TEST_DATABASE_URL }, async () => {
  const signer = await registeredSigner();
  try {
    const queue = async (kind: "evm" | "solana", payload: unknown) => {
      const jobId = await enqueueJob(signer.pool, { accountId: signer.user.accountId, walletId: signer.walletId, kind, payload, ttlMs: 10 * 60_000 }, signer.clock.now);
      assert.equal((await signer.pull()).json().id, jobId);
      return jobId;
    };
    const row = async (jobId: string) => (await signer.pool.query("SELECT status, result FROM signing_jobs WHERE id = $1", [jobId])).rows[0];

    const evmId = await queue("evm", evmJob);
    const otherRecipient = await signEvm({ ...evmJob, tx: { ...evmJob.tx, to: "0x0000000000000000000000000000000000000001" } });
    const otherKey = await signEvm(evmJob, privateKeyToAccount(`0x${"43".repeat(32)}`));
    for (const signedTransaction of [otherRecipient, otherKey, "0x02"]) {
      const refused = await signer.answer(evmId, { decision: "signed", result: { signedTransaction } });
      assert.equal(refused.statusCode, 422, refused.body);
      assert.equal(refused.json().error, "result_mismatch");
    }
    assert.equal((await row(evmId)).status, "leased");
    const signedTransaction = await signEvm(evmJob);
    assert.equal((await signer.answer(evmId, { decision: "signed", result: { signedTransaction } })).statusCode, 204);
    assert.deepEqual(await row(evmId), { status: "signed", result: { signedTransaction } });

    const message = Buffer.from("a solana message").toString("base64");
    const solanaId = await queue("solana", { message });
    const forged = await signer.answer(solanaId, { decision: "signed", result: { signature: bs58.encode(sign(null, Buffer.from("another message"), solanaKey)) } });
    assert.equal(forged.statusCode, 422, forged.body);
    const signature = bs58.encode(sign(null, Buffer.from(message, "base64"), solanaKey));
    assert.equal((await signer.answer(solanaId, { decision: "signed", result: { signature } })).statusCode, 204);
    assert.deepEqual(await row(solanaId), { status: "signed", result: { signature } });
  } finally {
    await signer.close();
  }
});

test("a result is not stored for a frozen wallet or a job past its expiry", { skip: !TEST_DATABASE_URL }, async () => {
  const signer = await registeredSigner();
  try {
    const { app, user, walletId } = signer;
    const signedTransaction = await signEvm(evmJob);
    const frozenId = await enqueueJob(signer.pool, { accountId: user.accountId, walletId, kind: "evm", payload: evmJob, ttlMs: 10 * 60_000 }, signer.clock.now);
    assert.equal((await signer.pull()).json().id, frozenId);
    await app.inject({ method: "POST", url: `/api/wallets/${walletId}/freeze`, headers: user.headers, payload: {} });
    const frozen = await signer.answer(frozenId, { decision: "signed", result: { signedTransaction } });
    assert.equal(frozen.statusCode, 409, frozen.body);
    assert.equal(frozen.json().error, "wallet_frozen");
    assert.deepEqual((await signer.pool.query("SELECT status, result FROM signing_jobs WHERE id = $1", [frozenId])).rows[0], { status: "leased", result: null });

    await signer.pool.query("UPDATE signing_jobs SET status = 'expired' WHERE id = $1", [frozenId]);
    await signer.pool.query("UPDATE wallets SET status = 'active' WHERE id = $1", [walletId]);
    const lateId = await enqueueJob(signer.pool, { accountId: user.accountId, walletId, kind: "evm", payload: evmJob, ttlMs: 30_000 }, signer.clock.now);
    assert.equal((await signer.pull()).json().id, lateId);
    signer.clock.now += 30_001;
    const late = await signer.answer(lateId, { decision: "signed", result: { signedTransaction } });
    assert.equal(late.statusCode, 409, late.body);
    assert.equal(late.json().error, "expired");
    assert.deepEqual((await signer.pool.query("SELECT status, result FROM signing_jobs WHERE id = $1", [lateId])).rows[0], { status: "expired", result: null });
  } finally {
    await signer.close();
  }
});
