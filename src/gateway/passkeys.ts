import { createHash, randomBytes } from "node:crypto";
import type pg from "pg";
import { z } from "zod";
import { audit, inTransaction } from "./accounts.js";
import type { GatewayConfig } from "./config.js";
import { verifyAssertion, verifyRegistration, type Registration, type RelyingParty } from "./webauthn.js";

export const CHALLENGE_TTL_MS = 5 * 60 * 1000;
export const MAX_PASSKEYS = 10;
const b64url = z.string().regex(/^[A-Za-z0-9_-]+$/).max(8_192);

export const registrationPayload = z
  .object({ id: b64url, type: z.literal("public-key"), response: z.object({ clientDataJSON: b64url, attestationObject: b64url, transports: z.array(z.string().max(32)).max(8).optional() }).loose() })
  .loose();
export const assertionPayload = z
  .object({ id: b64url, type: z.literal("public-key"), response: z.object({ clientDataJSON: b64url, authenticatorData: b64url, signature: b64url }).loose() })
  .loose();
export type RegistrationPayload = z.infer<typeof registrationPayload>;
export type AssertionPayload = z.infer<typeof assertionPayload>;

export function relyingParty(config: GatewayConfig): RelyingParty {
  return { rpId: config.publicUrl.hostname, origin: config.publicUrl.origin };
}

function canonical(value: unknown): string {
  if (value === null || typeof value === "string" || typeof value === "boolean") return JSON.stringify(value);
  if (typeof value === "number" && Number.isFinite(value)) return JSON.stringify(value);
  if (Array.isArray(value)) return `[${Array.from(value, canonical).join(",")}]`;
  const proto: unknown = typeof value === "object" ? Object.getPrototypeOf(value) : undefined;
  if (proto === Object.prototype || proto === null) {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonical(record[key])}`)
      .join(",")}}`;
  }
  throw new TypeError("cannot bind a step-up to a value that is not plain JSON");
}

// A step-up signature approves one exact action. The challenge stores the hash of that action, so an assertion
// made for "add this destination" cannot be replayed to approve anything else.
export function bindingOf(action: unknown): string {
  return createHash("sha256").update(canonical(action)).digest("hex");
}

function challengeHash(challenge: string): Buffer {
  return createHash("sha256").update(challenge).digest();
}

export async function newChallenge(pool: pg.Pool, accountId: string, purpose: "register" | "step_up", binding: string, now = Date.now()): Promise<string> {
  const challenge = randomBytes(32).toString("base64url");
  await pool.query("DELETE FROM webauthn_challenges WHERE expires_at <= $1", [new Date(now)]);
  await pool.query("INSERT INTO webauthn_challenges (challenge_hash, account_id, purpose, binding, expires_at) VALUES ($1, $2, $3, $4, $5)", [
    challengeHash(challenge),
    accountId,
    purpose,
    binding,
    new Date(now + CHALLENGE_TTL_MS),
  ]);
  return challenge;
}

function challengeIn(clientDataJSON: string): string | null {
  try {
    const parsed: unknown = JSON.parse(Buffer.from(clientDataJSON, "base64url").toString("utf8"));
    return parsed && typeof parsed === "object" && typeof (parsed as { challenge?: unknown }).challenge === "string" ? (parsed as { challenge: string }).challenge : null;
  } catch {
    return null;
  }
}

async function consume(client: pg.ClientBase, accountId: string, purpose: string, binding: string, challenge: string, now: number): Promise<boolean> {
  const used = await client.query(
    "DELETE FROM webauthn_challenges WHERE challenge_hash = $1 AND account_id = $2 AND purpose = $3 AND binding = $4 AND expires_at > $5 RETURNING 1",
    [challengeHash(challenge), accountId, purpose, binding, new Date(now)],
  );
  return (used.rowCount ?? 0) === 1;
}

export async function registrationOptions(pool: pg.Pool, config: GatewayConfig, account: { accountId: string; email: string | null }, binding = "passkey", now = Date.now()) {
  const existing = await pool.query<{ credential_id: string }>("SELECT credential_id FROM passkeys WHERE account_id = $1 AND revoked_at IS NULL", [account.accountId]);
  const challenge = await newChallenge(pool, account.accountId, "register", binding, now);
  return {
    rp: { id: relyingParty(config).rpId, name: "Whale" },
    user: { id: Buffer.from(account.accountId.replace(/-/g, ""), "hex").toString("base64url"), name: account.email ?? account.accountId, displayName: account.email ?? "Whale account" },
    challenge,
    pubKeyCredParams: [{ type: "public-key", alg: -7 }],
    timeout: CHALLENGE_TTL_MS,
    attestation: "none",
    authenticatorSelection: { residentKey: "preferred", userVerification: "required" },
    excludeCredentials: existing.rows.map((row) => ({ type: "public-key", id: row.credential_id })),
  };
}

// The caller decides what the new passkey is for. A plain passkey stores it here; an enclave wallet also hands the
// same attestation to Turnkey, inside the same transaction, so both sides agree on the root credential.
export async function registerPasskey(
  pool: pg.Pool,
  config: GatewayConfig,
  input: { accountId: string; payload: RegistrationPayload; label: string; binding?: string },
  after?: (client: pg.PoolClient, registration: Registration & { challenge: string }) => Promise<void>,
  now = Date.now(),
): Promise<Registration | string> {
  const challenge = challengeIn(input.payload.response.clientDataJSON);
  if (!challenge) return "the passkey response has no challenge";
  return inTransaction(pool, async (client) => {
    if (!(await consume(client, input.accountId, "register", input.binding ?? "passkey", challenge, now))) return "the challenge expired or was already used";
    const count = await client.query<{ n: number }>("SELECT count(*)::int AS n FROM passkeys WHERE account_id = $1 AND revoked_at IS NULL", [input.accountId]);
    if ((count.rows[0]?.n ?? 0) >= MAX_PASSKEYS) return "this account already has ten passkeys";
    let registration: Registration;
    try {
      registration = verifyRegistration(
        { credentialId: input.payload.id, clientDataJSON: Buffer.from(input.payload.response.clientDataJSON, "base64url"), attestationObject: Buffer.from(input.payload.response.attestationObject, "base64url"), challenge },
        relyingParty(config),
      );
    } catch (error) {
      return error instanceof Error ? error.message : "the passkey did not verify";
    }
    const inserted = await client.query("INSERT INTO passkeys (credential_id, account_id, public_key, sign_count, label) VALUES ($1, $2, $3, $4, $5) ON CONFLICT (credential_id) DO NOTHING", [
      registration.credentialId,
      input.accountId,
      registration.publicKey,
      registration.signCount,
      input.label,
    ]);
    if ((inserted.rowCount ?? 0) === 0) return "this passkey is already registered";
    await audit(client, { accountId: input.accountId, actor: "user", action: "passkey.added", detail: { label: input.label } });
    if (after) await after(client, { ...registration, challenge });
    return registration;
  });
}

export type PasskeyRefusal = { refused: "step_up_required" | "step_up_failed" | "passkey_rejected"; detail?: string };

export async function addPasskey(
  pool: pg.Pool,
  config: GatewayConfig,
  input: { accountId: string; payload: RegistrationPayload; label: string; assertion: AssertionPayload | null },
  now = Date.now(),
): Promise<Registration | PasskeyRefusal> {
  const existing = await pool.query("SELECT 1 FROM passkeys WHERE account_id = $1 AND revoked_at IS NULL LIMIT 1", [input.accountId]);
  if ((existing.rowCount ?? 0) > 0) {
    if (!input.assertion) return { refused: "step_up_required" };
    const approved = await verifyStepUp(pool, config, input.accountId, { kind: "passkey.add", credentialId: input.payload.id }, input.assertion, now);
    if (approved !== true) return { refused: "step_up_failed", detail: approved };
  }
  const added = await registerPasskey(pool, config, { accountId: input.accountId, payload: input.payload, label: input.label }, undefined, now);
  return typeof added === "string" ? { refused: "passkey_rejected", detail: added } : added;
}

export async function stepUpOptions(pool: pg.Pool, config: GatewayConfig, accountId: string, action: unknown, now = Date.now()) {
  const keys = await pool.query<{ credential_id: string }>("SELECT credential_id FROM passkeys WHERE account_id = $1 AND revoked_at IS NULL", [accountId]);
  if (keys.rows.length === 0) return null;
  const challenge = await newChallenge(pool, accountId, "step_up", bindingOf(action), now);
  return { challenge, rpId: relyingParty(config).rpId, timeout: CHALLENGE_TTL_MS, userVerification: "required", allowCredentials: keys.rows.map((row) => ({ type: "public-key", id: row.credential_id })) };
}

// Approves exactly `action` once: the challenge must be unused, for this account, and bound to this action.
export async function verifyStepUp(pool: pg.Pool, config: GatewayConfig, accountId: string, action: unknown, payload: AssertionPayload, now = Date.now()): Promise<true | string> {
  const challenge = challengeIn(payload.response.clientDataJSON);
  if (!challenge) return "the passkey response has no challenge";
  return inTransaction(pool, async (client) => {
    if (!(await consume(client, accountId, "step_up", bindingOf(action), challenge, now))) return "the approval expired, was used, or was for a different action";
    const found = await client.query<{ public_key: Buffer; sign_count: string }>(
      "SELECT public_key, sign_count FROM passkeys WHERE credential_id = $1 AND account_id = $2 AND revoked_at IS NULL FOR UPDATE",
      [payload.id, accountId],
    );
    const row = found.rows[0];
    if (!row) return "that passkey is not on this account";
    let signCount: number;
    try {
      signCount = verifyAssertion(
        {
          clientDataJSON: Buffer.from(payload.response.clientDataJSON, "base64url"),
          authenticatorData: Buffer.from(payload.response.authenticatorData, "base64url"),
          signature: Buffer.from(payload.response.signature, "base64url"),
          challenge,
          publicKey: row.public_key,
          storedSignCount: Number(row.sign_count),
        },
        relyingParty(config),
      ).signCount;
    } catch (error) {
      return error instanceof Error ? error.message : "the passkey did not verify";
    }
    await client.query("UPDATE passkeys SET sign_count = $3, last_used_at = $4 WHERE credential_id = $1 AND account_id = $2", [payload.id, accountId, signCount, new Date(now)]);
    return true;
  });
}

export async function listPasskeys(pool: pg.Pool, accountId: string) {
  const rows = await pool.query<{ credential_id: string; label: string; created_at: Date; last_used_at: Date | null }>(
    "SELECT credential_id, label, created_at, last_used_at FROM passkeys WHERE account_id = $1 AND revoked_at IS NULL ORDER BY created_at",
    [accountId],
  );
  return rows.rows.map((row) => ({ credentialId: row.credential_id, label: row.label, createdAt: row.created_at.toISOString(), lastUsedAt: row.last_used_at?.toISOString() ?? null }));
}
