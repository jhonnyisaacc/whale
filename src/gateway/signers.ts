import { createPublicKey, randomBytes, timingSafeEqual, verify } from "node:crypto";
import type pg from "pg";
import { parseTransaction, recoverMessageAddress, recoverTransactionAddress, serializeTransaction, type Hex } from "viem";
import { z } from "zod";
import bs58 from "bs58";
import { audit, inTransaction } from "./accounts.js";
import { secretHash } from "./agents.js";

export const REGISTRATION_TTL_MS = 10 * 60 * 1000;
export const LEASE_MS = 60 * 1000;
const SIGNER_TOKEN = /^wsig_([0-9a-f]{16})_([A-Za-z0-9_-]{43})$/;
const ED25519_SPKI_PREFIX = Buffer.from("302a300506032b6570032100", "hex");

// The text both keys sign at registration. It names the wallet and the one-time code, so a proof cannot be replayed
// for another wallet or another registration.
export function registrationMessage(walletId: string, code: string): string {
  return `Whale signer registration\nwallet:${walletId}\ncode:${code}`;
}

export async function newRegistrationCode(pool: pg.Pool, accountId: string, walletId: string, now = Date.now()): Promise<string | null> {
  const wallet = await pool.query("SELECT 1 FROM wallets WHERE id = $1 AND account_id = $2 AND level = 'self_hosted' AND status = 'pending'", [walletId, accountId]);
  if ((wallet.rowCount ?? 0) === 0) return null;
  const code = `wreg_${randomBytes(24).toString("base64url")}`;
  await pool.query("INSERT INTO signer_registrations (code_hash, account_id, wallet_id, expires_at) VALUES ($1, $2, $3, $4)", [secretHash(code), accountId, walletId, new Date(now + REGISTRATION_TTL_MS)]);
  await audit(pool, { accountId, walletId, actor: "user", action: "signer.code_issued" });
  return code;
}

async function provesEvm(message: string, address: string, signature: string): Promise<boolean> {
  if (!/^0x[0-9a-fA-F]{40}$/.test(address) || !/^0x[0-9a-fA-F]{130}$/.test(signature)) return false;
  try {
    return (await recoverMessageAddress({ message, signature: signature as Hex })).toLowerCase() === address.toLowerCase();
  } catch {
    return false;
  }
}

function provesSolana(message: string | Buffer, address: string, signature: string): boolean {
  try {
    const key = Buffer.from(bs58.decode(address));
    const sig = Buffer.from(bs58.decode(signature));
    if (key.byteLength !== 32 || sig.byteLength !== 64) return false;
    return verify(null, Buffer.from(message), createPublicKey({ key: Buffer.concat([ED25519_SPKI_PREFIX, key]), format: "der", type: "spki" }), sig);
  } catch {
    return false;
  }
}

export type Registration = { code: string; walletId: string; evmAddress: string; solanaAddress: string; evmSignature: string; solanaSignature: string };

export async function registerSigner(pool: pg.Pool, input: Registration, now = Date.now()): Promise<{ signerId: string; token: string } | string> {
  return inTransaction(pool, (client) => registerLocked(client, input, now));
}

async function registerLocked(client: pg.PoolClient, input: Registration, now: number): Promise<{ signerId: string; token: string } | string> {
  const wallet = await client.query<{ status: string }>("SELECT status FROM wallets WHERE id = $1 FOR UPDATE", [input.walletId]);
  const spent = await client.query<{ account_id: string; wallet_id: string }>(
    "UPDATE signer_registrations SET used_at = $2 WHERE code_hash = $1 AND used_at IS NULL AND expires_at > $2 RETURNING account_id, wallet_id",
    [secretHash(input.code), new Date(now)],
  );
  const row = spent.rows[0];
  if (!row || row.wallet_id !== input.walletId) return "the registration code is unknown, used, expired, or for another wallet";
  if (wallet.rows[0]?.status !== "pending") return "the wallet is not waiting for a signer";
  const message = registrationMessage(input.walletId, input.code);
  if (!(await provesEvm(message, input.evmAddress, input.evmSignature))) return "the EVM signature does not prove the EVM address";
  if (!provesSolana(message, input.solanaAddress, input.solanaSignature)) return "the Solana signature does not prove the Solana address";
  const own = await client.query<{ family: string; address: string }>("SELECT family, address FROM wallet_addresses WHERE wallet_id = $1", [row.wallet_id]);
  const ownEvm = own.rows.find((entry) => entry.family === "evm")?.address;
  const ownSolana = own.rows.find((entry) => entry.family === "solana")?.address;
  if (own.rows.length > 0 && (ownEvm?.toLowerCase() !== input.evmAddress.toLowerCase() || ownSolana !== input.solanaAddress)) return "this wallet's addresses belong to other keys";
  const taken = await client.query(
    "SELECT 1 FROM wallet_addresses WHERE wallet_id <> $3 AND ((family = 'evm' AND lower(address) = lower($1)) OR (family = 'solana' AND address = $2))",
    [input.evmAddress, input.solanaAddress, row.wallet_id],
  );
  if ((taken.rowCount ?? 0) > 0) return "these keys already belong to another wallet";
  const signerId = randomBytes(8).toString("hex");
  const secret = randomBytes(32).toString("base64url");
  await client.query("INSERT INTO signers (id, account_id, wallet_id, token_hash, evm_address, solana_address) VALUES ($1, $2, $3, $4, $5, $6)", [
    signerId,
    row.account_id,
    row.wallet_id,
    secretHash(secret),
    input.evmAddress,
    input.solanaAddress,
  ]);
  if (own.rows.length === 0) {
    await client.query("INSERT INTO wallet_addresses (wallet_id, family, address) VALUES ($1, 'evm', $2), ($1, 'solana', $3)", [row.wallet_id, input.evmAddress, input.solanaAddress]);
  }
  await client.query("UPDATE wallets SET status = 'active' WHERE id = $1 AND status = 'pending'", [row.wallet_id]);
  await audit(client, { accountId: row.account_id, walletId: row.wallet_id, actor: "system", action: "signer.registered", detail: { signerId } });
  return { signerId, token: `wsig_${signerId}_${secret}` };
}

export type SignerContext = { signerId: string; accountId: string; walletId: string };

export async function authenticateSigner(pool: pg.Pool, presented: string, now = Date.now()): Promise<SignerContext | null> {
  const match = SIGNER_TOKEN.exec(presented);
  if (!match) return null;
  const [, id, secret] = match as unknown as [string, string, string];
  const found = await pool.query<{ token_hash: Buffer; account_id: string; wallet_id: string }>(
    `SELECT s.token_hash, s.account_id, s.wallet_id FROM signers s JOIN wallets w ON w.id = s.wallet_id AND w.status IN ('active', 'frozen')
     JOIN accounts a ON a.id = s.account_id AND a.status = 'active' WHERE s.id = $1 AND s.revoked_at IS NULL`,
    [id],
  );
  const row = found.rows[0];
  if (!row || !timingSafeEqual(row.token_hash, secretHash(secret))) return null;
  await pool.query("UPDATE signers SET last_seen_at = $2 WHERE id = $1", [id, new Date(now)]);
  return { signerId: id, accountId: row.account_id, walletId: row.wallet_id };
}

export async function enqueueJob(pool: pg.Pool, input: { accountId: string; walletId: string; kind: "evm" | "solana"; payload: unknown; ttlMs: number }, now = Date.now()): Promise<string> {
  const created = await pool.query<{ id: string }>(
    "INSERT INTO signing_jobs (account_id, wallet_id, kind, payload, expires_at, created_at) VALUES ($1, $2, $3, $4, $5, $6) RETURNING id",
    [input.accountId, input.walletId, input.kind, JSON.stringify(input.payload), new Date(now + input.ttlMs), new Date(now)],
  );
  return created.rows[0]?.id as string;
}

// A lease that runs out puts the job back, so a signer that crashed mid-job does not strand it. A frozen wallet's
// signer still polls but gets nothing.
export async function leaseJob(pool: pg.Pool, signer: SignerContext, now = Date.now()): Promise<{ id: string; kind: string; payload: unknown } | null> {
  const leased = await pool.query<{ id: string; kind: string; payload: unknown }>(
    `UPDATE signing_jobs SET status = 'leased', lease_expires_at = $3 WHERE id = (
       SELECT j.id FROM signing_jobs j JOIN wallets w ON w.id = j.wallet_id AND w.status = 'active'
       WHERE j.wallet_id = $1 AND j.expires_at > $2 AND (j.status = 'queued' OR (j.status = 'leased' AND j.lease_expires_at <= $2))
       ORDER BY j.created_at LIMIT 1 FOR UPDATE OF j SKIP LOCKED
     ) RETURNING id, kind, payload`,
    [signer.walletId, new Date(now), new Date(now + LEASE_MS)],
  );
  return leased.rows[0] ?? null;
}

const quantity = z.string().regex(/^(0x[0-9a-fA-F]+|[0-9]+)$/).transform(BigInt);
const hexBytes = z.string().regex(/^0x([0-9a-fA-F]{2})*$/);
const evmPayload = z.object({
  chainId: z.number().int().positive(),
  tx: z.object({ nonce: quantity, to: z.string().regex(/^0x[0-9a-fA-F]{40}$/), value: quantity, data: hexBytes.optional(), gas: quantity, maxFeePerGas: quantity, maxPriorityFeePerGas: quantity }),
});
const evmResult = z.object({ signedTransaction: hexBytes });
const solanaPayload = z.object({ message: z.base64() });
const solanaResult = z.object({ signature: z.string().max(90) });

async function signsEvmPayload(payload: unknown, result: unknown, address: string): Promise<boolean> {
  const job = evmPayload.safeParse(payload);
  const signed = evmResult.safeParse(result);
  if (!job.success || !signed.success) return false;
  const raw = signed.data.signedTransaction.toLowerCase() as Hex;
  try {
    const parsed = parseTransaction(raw);
    if (parsed.type !== "eip1559" || parsed.r === undefined || parsed.s === undefined || parsed.yParity === undefined) return false;
    const { tx, chainId } = job.data;
    const expected = serializeTransaction(
      { type: "eip1559", chainId, nonce: Number(tx.nonce), to: tx.to as Hex, value: tx.value, data: (tx.data ?? "0x") as Hex, gas: tx.gas, maxFeePerGas: tx.maxFeePerGas, maxPriorityFeePerGas: tx.maxPriorityFeePerGas, accessList: [] },
      { r: parsed.r, s: parsed.s, yParity: parsed.yParity },
    );
    if (expected !== raw) return false;
    return (await recoverTransactionAddress({ serializedTransaction: expected })).toLowerCase() === address.toLowerCase();
  } catch {
    return false;
  }
}

function signsSolanaPayload(payload: unknown, result: unknown, address: string): boolean {
  const job = solanaPayload.safeParse(payload);
  const signed = solanaResult.safeParse(result);
  return job.success && signed.success && provesSolana(Buffer.from(job.data.message, "base64"), address, signed.data.signature);
}

export type CompleteRefusal = "not_leased" | "wallet_frozen" | "expired" | "result_mismatch";

export async function completeJob(pool: pg.Pool, signer: SignerContext, jobId: string, result: { decision: "signed" | "refused"; body: unknown }, now = Date.now()): Promise<true | CompleteRefusal> {
  return inTransaction(pool, async (client) => {
    const found = await client.query<{ kind: string; payload: unknown; expires_at: Date; wallet_status: string; evm_address: string; solana_address: string }>(
      `SELECT j.kind, j.payload, j.expires_at, w.status AS wallet_status, s.evm_address, s.solana_address FROM signing_jobs j
       JOIN wallets w ON w.id = j.wallet_id JOIN signers s ON s.id = $3
       WHERE j.id = $1 AND j.wallet_id = $2 AND j.status = 'leased' FOR UPDATE OF j FOR SHARE OF w`,
      [jobId, signer.walletId, signer.signerId],
    );
    const job = found.rows[0];
    if (!job) return "not_leased";
    if (job.wallet_status !== "active") return "wallet_frozen";
    if (job.expires_at.getTime() <= now) {
      await client.query("UPDATE signing_jobs SET status = 'expired', lease_expires_at = NULL WHERE id = $1", [jobId]);
      return "expired";
    }
    if (result.decision === "signed") {
      const matches = job.kind === "evm" ? await signsEvmPayload(job.payload, result.body, job.evm_address) : signsSolanaPayload(job.payload, result.body, job.solana_address);
      if (!matches) return "result_mismatch";
    }
    await client.query("UPDATE signing_jobs SET status = $2, result = $3, completed_at = $4 WHERE id = $1", [jobId, result.decision, JSON.stringify(result.body), new Date(now)]);
    await audit(client, { accountId: signer.accountId, walletId: signer.walletId, actor: "system", action: `signer.${result.decision}`, detail: { jobId } });
    return true;
  });
}
