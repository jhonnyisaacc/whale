import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import type pg from "pg";
import { audit, inTransaction } from "./accounts.js";
import { secretHash } from "./agents.js";
import type { AgentLimits } from "./policy.js";
import type { OAuthClient } from "./oauth-clients.js";

export const REQUEST_TTL_MS = 15 * 60 * 1000;
export const CODE_TTL_MS = 5 * 60 * 1000;
export const ACCESS_TTL_MS = 60 * 60 * 1000;
export const REFRESH_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const EXPIRED_RETENTION_MS = 24 * 60 * 60 * 1000;
const UNUSED_CLIENT_TTL_MS = 24 * 60 * 60 * 1000;
const REFRESH_TOKEN = /^wrt_([0-9a-f]{16})_([A-Za-z0-9_-]{43})$/;
const ACCESS_TOKEN = /^wat_([0-9a-f]{16})_([A-Za-z0-9_-]{43})$/;

export type TokenPair = { access_token: string; token_type: "Bearer"; expires_in: number; refresh_token: string; scope: string };
export type OAuthError = { error: "invalid_grant" | "invalid_request" | "invalid_client" };
export type PendingRequest = { id: string; clientId: string; clientName: string; redirectUri: string; codeChallenge: string; state: string | null; resource: string };

function random(bytes = 32): string {
  return randomBytes(bytes).toString("base64url");
}

export function withParams(redirectUri: string, params: Record<string, string | null>): string {
  const url = new URL(redirectUri);
  for (const [key, value] of Object.entries(params)) if (value !== null) url.searchParams.set(key, value);
  return url.toString();
}

async function deleteExpired(pool: pg.ClientBase, now: number): Promise<void> {
  const cutoff = new Date(now - EXPIRED_RETENTION_MS);
  await pool.query("DELETE FROM oauth_codes WHERE expires_at < $1", [cutoff]);
  await pool.query("DELETE FROM oauth_requests r WHERE expires_at < $1 AND NOT EXISTS (SELECT 1 FROM oauth_codes c WHERE c.request_id = r.id)", [cutoff]);
  await pool.query("DELETE FROM agent_credentials WHERE kind <> 'api_key' AND expires_at < $1", [cutoff]);
  await pool.query(
    `DELETE FROM oauth_clients c WHERE created_at < $1
     AND NOT EXISTS (SELECT 1 FROM oauth_requests r WHERE r.client_id = c.id)
     AND NOT EXISTS (SELECT 1 FROM oauth_codes o WHERE o.client_id = c.id)
     AND NOT EXISTS (SELECT 1 FROM agents a WHERE a.oauth_client_id = c.id)`,
    [new Date(now - UNUSED_CLIENT_TTL_MS)],
  ).catch((error: unknown) => {
    if ((error as { code?: string }).code !== "23503") throw error;
  });
}

export async function createRequest(pool: pg.Pool, input: Omit<PendingRequest, "id" | "clientName">, client: OAuthClient, now = Date.now()): Promise<string> {
  const id = random();
  return inTransaction(pool, async (transaction) => {
    await transaction.query("INSERT INTO oauth_clients (id, kind, name, redirect_uris) VALUES ($1, $2, $3, $4) ON CONFLICT (id) DO NOTHING", [client.id, client.kind, client.name, client.redirectUris]);
    await transaction.query(
      "INSERT INTO oauth_requests (id, client_id, redirect_uri, code_challenge, state, resource, expires_at) VALUES ($1, $2, $3, $4, $5, $6, $7)",
      [id, client.id, input.redirectUri, input.codeChallenge, input.state, input.resource, new Date(now + REQUEST_TTL_MS)],
    );
    await deleteExpired(transaction, now);
    return id;
  });
}

export async function pendingRequest(client: pg.Pool | pg.PoolClient, id: string, now = Date.now(), lock = false): Promise<PendingRequest | null> {
  const found = await client.query<{ id: string; client_id: string; name: string; redirect_uri: string; code_challenge: string; state: string | null; resource: string }>(
    `SELECT r.id, r.client_id, c.name, r.redirect_uri, r.code_challenge, r.state, r.resource
     FROM oauth_requests r JOIN oauth_clients c ON c.id = r.client_id
     WHERE r.id = $1 AND r.decided_at IS NULL AND r.expires_at > $2${lock ? " FOR UPDATE OF r" : ""}`,
    [id, new Date(now)],
  );
  const row = found.rows[0];
  return row ? { id: row.id, clientId: row.client_id, clientName: row.name, redirectUri: row.redirect_uri, codeChallenge: row.code_challenge, state: row.state, resource: row.resource } : null;
}

export async function denyRequest(pool: pg.Pool, id: string, issuer: string, now = Date.now()): Promise<string | null> {
  const denied = await pool.query<{ redirect_uri: string; state: string | null }>(
    "UPDATE oauth_requests SET decided_at = $2 WHERE id = $1 AND decided_at IS NULL AND expires_at > $2 RETURNING redirect_uri, state",
    [id, new Date(now)],
  );
  const request = denied.rows[0];
  return request ? withParams(request.redirect_uri, { error: "access_denied", state: request.state, iss: issuer }) : null;
}

// Approval creates the agent this client acts as, and a single-use code bound to the request's client, redirect,
// PKCE challenge, and resource.
export async function approveRequest(
  pool: pg.Pool,
  input: { requestId: string; accountId: string; walletId: string; name: string; limits: AgentLimits; issuer: string },
  now = Date.now(),
): Promise<string | null> {
  return inTransaction(pool, async (client) => {
    const request = await pendingRequest(client, input.requestId, now, true);
    if (!request) return null;
    const agent = await client.query<{ id: string }>(
      "INSERT INTO agents (account_id, wallet_id, name, limits, oauth_client_id) VALUES ($1, $2, $3, $4, $5) RETURNING id",
      [input.accountId, input.walletId, input.name, JSON.stringify(input.limits), request.clientId],
    );
    const agentId = agent.rows[0]?.id as string;
    const code = random();
    await client.query(
      "INSERT INTO oauth_codes (code_hash, request_id, client_id, agent_id, redirect_uri, code_challenge, resource, expires_at) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)",
      [secretHash(code), request.id, request.clientId, agentId, request.redirectUri, request.codeChallenge, request.resource, new Date(now + CODE_TTL_MS)],
    );
    await client.query("UPDATE oauth_requests SET decided_at = $2 WHERE id = $1", [request.id, new Date(now)]);
    await audit(client, { accountId: input.accountId, walletId: input.walletId, agentId, actor: "user", action: "agent.connected", detail: { client: request.clientName, limits: input.limits } });
    return withParams(request.redirectUri, { code, state: request.state, iss: input.issuer });
  });
}

async function issuePair(client: pg.PoolClient, agentId: string, audience: string, now: number): Promise<TokenPair> {
  const accessId = randomBytes(8).toString("hex");
  const refreshId = randomBytes(8).toString("hex");
  const accessSecret = random();
  const refreshSecret = random();
  await client.query(
    `INSERT INTO agent_credentials (id, agent_id, kind, secret_hash, expires_at, audience) VALUES
     ($1, $3, 'oauth_access', $4, $5, $8), ($2, $3, 'oauth_refresh', $6, $7, $8)`,
    [accessId, refreshId, agentId, secretHash(accessSecret), new Date(now + ACCESS_TTL_MS), secretHash(refreshSecret), new Date(now + REFRESH_TTL_MS), audience],
  );
  return { access_token: `wat_${accessId}_${accessSecret}`, token_type: "Bearer", expires_in: ACCESS_TTL_MS / 1000, refresh_token: `wrt_${refreshId}_${refreshSecret}`, scope: "wallet" };
}

async function revokeOAuthCredentials(client: pg.Pool | pg.PoolClient, agentId: string): Promise<void> {
  await client.query("UPDATE agent_credentials SET revoked_at = now() WHERE agent_id = $1 AND kind <> 'api_key' AND revoked_at IS NULL", [agentId]);
}

function pkceMatches(verifier: string, challenge: string): boolean {
  if (!/^[A-Za-z0-9._~-]{43,128}$/.test(verifier)) return false;
  const computed = Buffer.from(createHash("sha256").update(verifier).digest("base64url"));
  const expected = Buffer.from(challenge);
  return computed.byteLength === expected.byteLength && timingSafeEqual(computed, expected);
}

// A replayed code means someone else holds it, so every token minted from it stops working.
export async function exchangeCode(
  pool: pg.Pool,
  input: { code: string; clientId: string; redirectUri: string; verifier: string; resource: string },
  now = Date.now(),
): Promise<TokenPair | OAuthError> {
  return inTransaction(pool, async (client) => {
    await client.query("SELECT 1 FROM agents WHERE id = (SELECT agent_id FROM oauth_codes WHERE code_hash = $1) FOR NO KEY UPDATE", [secretHash(input.code)]);
    const found = await client.query<{ client_id: string; agent_id: string; redirect_uri: string; code_challenge: string; resource: string; expires_at: Date; used_at: Date | null }>(
      "SELECT client_id, agent_id, redirect_uri, code_challenge, resource, expires_at, used_at FROM oauth_codes WHERE code_hash = $1 FOR UPDATE",
      [secretHash(input.code)],
    );
    const row = found.rows[0];
    if (!row) return { error: "invalid_grant" as const };
    if (row.used_at) {
      await revokeOAuthCredentials(client, row.agent_id);
      return { error: "invalid_grant" as const };
    }
    await client.query("UPDATE oauth_codes SET used_at = $2 WHERE code_hash = $1", [secretHash(input.code), new Date(now)]);
    const valid =
      row.expires_at.getTime() > now &&
      row.client_id === input.clientId &&
      row.redirect_uri === input.redirectUri &&
      row.resource === input.resource &&
      pkceMatches(input.verifier, row.code_challenge);
    if (!valid) return { error: "invalid_grant" as const };
    return issuePair(client, row.agent_id, row.resource, now);
  });
}

export async function refreshTokens(pool: pg.Pool, input: { refreshToken: string; clientId: string }, now = Date.now()): Promise<TokenPair | OAuthError> {
  const match = REFRESH_TOKEN.exec(input.refreshToken);
  if (!match) return { error: "invalid_grant" };
  const [, id, secret] = match as unknown as [string, string, string];
  return inTransaction(pool, async (client) => {
    await client.query("SELECT 1 FROM agents WHERE id = (SELECT agent_id FROM agent_credentials WHERE id = $1) FOR NO KEY UPDATE", [id]);
    const found = await client.query<{ secret_hash: Buffer; agent_id: string; audience: string; expires_at: Date; revoked_at: Date | null; oauth_client_id: string | null; agent_revoked: Date | null }>(
      `SELECT c.secret_hash, c.agent_id, c.audience, c.expires_at, c.revoked_at, a.oauth_client_id, a.revoked_at AS agent_revoked
       FROM agent_credentials c JOIN agents a ON a.id = c.agent_id WHERE c.id = $1 AND c.kind = 'oauth_refresh' FOR UPDATE OF c`,
      [id],
    );
    const row = found.rows[0];
    if (!row || !timingSafeEqual(row.secret_hash, secretHash(secret)) || row.oauth_client_id !== input.clientId) return { error: "invalid_grant" as const };
    if (row.revoked_at) {
      await revokeOAuthCredentials(client, row.agent_id);
      return { error: "invalid_grant" as const };
    }
    if (row.expires_at.getTime() <= now || row.agent_revoked) return { error: "invalid_grant" as const };
    await client.query("UPDATE agent_credentials SET revoked_at = $2 WHERE id = $1", [id, new Date(now)]);
    return issuePair(client, row.agent_id, row.audience, now);
  });
}

export async function revokeToken(pool: pg.Pool, token: string): Promise<void> {
  const match = REFRESH_TOKEN.exec(token) ?? ACCESS_TOKEN.exec(token);
  if (!match) return;
  const [, id, secret] = match as unknown as [string, string, string];
  await inTransaction(pool, async (client) => {
    await client.query("SELECT 1 FROM agents WHERE id = (SELECT agent_id FROM agent_credentials WHERE id = $1) FOR NO KEY UPDATE", [id]);
    const found = await client.query<{ secret_hash: Buffer; kind: string; agent_id: string }>("SELECT secret_hash, kind, agent_id FROM agent_credentials WHERE id = $1 AND kind <> 'api_key'", [id]);
    const row = found.rows[0];
    if (!row || !timingSafeEqual(row.secret_hash, secretHash(secret))) return;
    if (row.kind === "oauth_refresh") await revokeOAuthCredentials(client, row.agent_id);
    else await client.query("UPDATE agent_credentials SET revoked_at = now() WHERE id = $1 AND revoked_at IS NULL", [id]);
  });
}
