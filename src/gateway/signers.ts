import { createPublicKey, randomBytes, timingSafeEqual, verify } from "node:crypto";
import type pg from "pg";
import { recoverMessageAddress, type Hex } from "viem";
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

function provesSolana(message: string, address: string, signature: string): boolean {
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

// The code is spent before the proofs are checked, so a guessed or stolen code gets one try.
export async function registerSigner(pool: pg.Pool, input: Registration, now = Date.now()): Promise<{ signerId: string; token: string } | string> {
  return inTransaction(pool, async (client) => {
    const spent = await client.query<{ account_id: string; wallet_id: string }>(
      "UPDATE signer_registrations SET used_at = $2 WHERE code_hash = $1 AND used_at IS NULL AND expires_at > $2 RETURNING account_id, wallet_id",
      [secretHash(input.code), new Date(now)],
    );
    const row = spent.rows[0];
    if (!row || row.wallet_id !== input.walletId) return "the registration code is unknown, used, expired, or for another wallet";
    const message = registrationMessage(input.walletId, input.code);
    if (!(await provesEvm(message, input.evmAddress, input.evmSignature))) return "the EVM signature does not prove the EVM address";
    if (!provesSolana(message, input.solanaAddress, input.solanaSignature)) return "the Solana signature does not prove the Solana address";
    await client.query("SELECT 1 FROM wallets WHERE id = $1 FOR UPDATE", [row.wallet_id]);
    const existing = await client.query("SELECT 1 FROM signers WHERE wallet_id = $1", [row.wallet_id]);
    if ((existing.rowCount ?? 0) > 0) return "this wallet already has a signer";
    const taken = await client.query("SELECT 1 FROM wallet_addresses WHERE (family = 'evm' AND lower(address) = lower($1)) OR (family = 'solana' AND address = $2)", [
      input.evmAddress,
      input.solanaAddress,
    ]);
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
    await client.query("INSERT INTO wallet_addresses (wallet_id, family, address) VALUES ($1, 'evm', $2), ($1, 'solana', $3)", [row.wallet_id, input.evmAddress, input.solanaAddress]);
    await client.query("UPDATE wallets SET status = 'active' WHERE id = $1 AND status = 'pending'", [row.wallet_id]);
    await audit(client, { accountId: row.account_id, walletId: row.wallet_id, actor: "system", action: "signer.registered", detail: { signerId } });
    return { signerId, token: `wsig_${signerId}_${secret}` };
  });
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

export async function completeJob(pool: pg.Pool, signer: SignerContext, jobId: string, result: { decision: "signed" | "refused"; body: unknown }, now = Date.now()): Promise<boolean> {
  const done = await pool.query(
    "UPDATE signing_jobs SET status = $3, result = $4, completed_at = $5 WHERE id = $1 AND wallet_id = $2 AND status = 'leased' RETURNING id",
    [jobId, signer.walletId, result.decision, JSON.stringify(result.body), new Date(now)],
  );
  if ((done.rowCount ?? 0) === 0) return false;
  await audit(pool, { accountId: signer.accountId, walletId: signer.walletId, actor: "system", action: `signer.${result.decision}`, detail: { jobId } });
  return true;
}
