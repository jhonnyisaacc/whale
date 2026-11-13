import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import type pg from "pg";
import { audit, inTransaction } from "./accounts.js";
import { storedLimitsSchema, storedPolicySchema, type AgentLimits, type WalletPolicy } from "./policy.js";

const API_KEY = /^whale_([0-9a-f]{12})_([A-Za-z0-9_-]{43})$/;
const TOUCH_AFTER_MS = 60_000;
const KEY_ID_ATTEMPTS = 3;

export type AgentContext = {
  agentId: string;
  accountId: string;
  walletId: string;
  walletStatus: string;
  live: boolean;
  limits: AgentLimits;
  policy: WalletPolicy;
};

export function secretHash(secret: string): Buffer {
  return createHash("sha256").update(secret).digest();
}

export function newApiKey(): { id: string; secret: string; key: string } {
  const id = randomBytes(6).toString("hex");
  const secret = randomBytes(32).toString("base64url");
  return { id, secret, key: `whale_${id}_${secret}` };
}

export async function issueApiKey(client: pg.ClientBase, agentId: string): Promise<string> {
  for (let attempt = 0; attempt < KEY_ID_ATTEMPTS; attempt += 1) {
    const { id, secret, key } = newApiKey();
    const inserted = await client.query("INSERT INTO agent_credentials (id, agent_id, kind, secret_hash) VALUES ($1, $2, 'api_key', $3) ON CONFLICT (id) DO NOTHING", [id, agentId, secretHash(secret)]);
    if (inserted.rowCount === 1) return key;
  }
  throw new Error("no free API key id");
}

export async function createAgent(
  pool: pg.Pool,
  input: { accountId: string; walletId: string; name: string; limits: AgentLimits },
): Promise<{ agentId: string; apiKey: string } | { refused: "wallet_frozen" }> {
  return inTransaction(pool, async (client) => {
    const wallet = await client.query<{ status: string }>("SELECT status FROM wallets WHERE id = $1 AND account_id = $2 FOR UPDATE", [input.walletId, input.accountId]);
    if (wallet.rows[0]?.status === "frozen") return { refused: "wallet_frozen" };
    const agent = await client.query<{ id: string }>("INSERT INTO agents (account_id, wallet_id, name, limits) VALUES ($1, $2, $3, $4) RETURNING id", [
      input.accountId,
      input.walletId,
      input.name,
      JSON.stringify(input.limits),
    ]);
    const agentId = agent.rows[0]?.id as string;
    const apiKey = await issueApiKey(client, agentId);
    await audit(client, { accountId: input.accountId, walletId: input.walletId, agentId, actor: "user", action: "agent.created", detail: { name: input.name, limits: input.limits } });
    return { agentId, apiKey };
  });
}

export async function rotateApiKey(pool: pg.Pool, accountId: string, agentId: string): Promise<string | null> {
  return inTransaction(pool, async (client) => {
    const agent = await client.query<{ wallet_id: string }>("SELECT wallet_id FROM agents WHERE id = $1 AND account_id = $2 AND revoked_at IS NULL FOR UPDATE", [agentId, accountId]);
    const walletId = agent.rows[0]?.wallet_id;
    if (!walletId) return null;
    await client.query("UPDATE agent_credentials SET revoked_at = now() WHERE agent_id = $1 AND kind = 'api_key' AND revoked_at IS NULL", [agentId]);
    const apiKey = await issueApiKey(client, agentId);
    await audit(client, { accountId, walletId, agentId, actor: "user", action: "agent.key_rotated" });
    return apiKey;
  });
}

export async function revokeAgent(pool: pg.Pool, accountId: string, agentId: string): Promise<boolean> {
  return inTransaction(pool, async (client) => {
    const agent = await client.query<{ wallet_id: string }>("UPDATE agents SET revoked_at = now() WHERE id = $1 AND account_id = $2 AND revoked_at IS NULL RETURNING wallet_id", [agentId, accountId]);
    const walletId = agent.rows[0]?.wallet_id;
    if (!walletId) return false;
    await client.query("UPDATE agent_credentials SET revoked_at = now() WHERE agent_id = $1 AND revoked_at IS NULL", [agentId]);
    await audit(client, { accountId, walletId, agentId, actor: "user", action: "agent.revoked" });
    return true;
  });
}

export async function listAgents(pool: pg.Pool, accountId: string, walletId: string) {
  const rows = await pool.query<{ id: string; name: string; limits: unknown; created_at: Date; last_used_at: Date | null; revoked_at: Date | null; key_ids: string[] }>(
    `SELECT a.id, a.name, a.limits, a.created_at, a.last_used_at, a.revoked_at,
       COALESCE(array_agg(c.id) FILTER (WHERE c.id IS NOT NULL), '{}') AS key_ids
     FROM agents a LEFT JOIN agent_credentials c ON c.agent_id = a.id AND c.kind = 'api_key' AND c.revoked_at IS NULL
     WHERE a.account_id = $1 AND a.wallet_id = $2
     GROUP BY a.id ORDER BY a.created_at`,
    [accountId, walletId],
  );
  return rows.rows.map((row) => ({
    id: row.id,
    name: row.name,
    limits: row.limits,
    createdAt: row.created_at.toISOString(),
    lastUsedAt: row.last_used_at?.toISOString() ?? null,
    revoked: row.revoked_at !== null,
    keyPrefixes: row.key_ids.map((id) => `whale_${id}_`),
  }));
}

const ACCESS_TOKEN = /^wat_([0-9a-f]{16})_([A-Za-z0-9_-]{43})$/;

type CredentialRow = {
  secret_hash: Buffer;
  agent_id: string;
  account_id: string;
  wallet_id: string;
  wallet_status: string;
  live: boolean;
  limits: unknown;
  document: unknown;
  last_used_at: Date | null;
};

// A credential works only while its agent, wallet, and account are all usable. Revoking any one of them stops it.
async function contextFor(pool: pg.Pool, id: string, secret: string, kind: "api_key" | "oauth_access", audience: string | null, now: number): Promise<AgentContext | null> {
  const found = await pool.query<CredentialRow>(
    `SELECT c.secret_hash, a.id AS agent_id, a.account_id, a.wallet_id, w.status AS wallet_status, w.live, a.limits, p.document, c.last_used_at
     FROM agent_credentials c
     JOIN agents a ON a.id = c.agent_id AND a.revoked_at IS NULL
     JOIN wallets w ON w.id = a.wallet_id AND w.status IN ('pending', 'active')
     JOIN accounts acc ON acc.id = a.account_id AND acc.status = 'active'
     JOIN policies p ON p.wallet_id = w.id
     WHERE c.id = $1 AND c.kind = $2 AND c.revoked_at IS NULL AND (c.expires_at IS NULL OR c.expires_at > $3)
       AND ($4::text IS NULL OR c.audience = $4)`,
    [id, kind, new Date(now), audience],
  );
  const row = found.rows[0];
  if (!row || !timingSafeEqual(row.secret_hash, secretHash(secret))) return null;
  const limits = storedLimitsSchema.safeParse(row.limits);
  const policy = storedPolicySchema.safeParse(row.document);
  if (!limits.success || !policy.success) return null;
  if (!row.last_used_at || now - row.last_used_at.getTime() >= TOUCH_AFTER_MS) {
    await pool.query("UPDATE agent_credentials SET last_used_at = $2 WHERE id = $1", [id, new Date(now)]);
    await pool.query("UPDATE agents SET last_used_at = $2 WHERE id = $1", [row.agent_id, new Date(now)]);
  }
  return {
    agentId: row.agent_id,
    accountId: row.account_id,
    walletId: row.wallet_id,
    walletStatus: row.wallet_status,
    live: row.live,
    limits: limits.data,
    policy: policy.data,
  };
}

export async function authenticateApiKey(pool: pg.Pool, presented: string, now = Date.now()): Promise<AgentContext | null> {
  const match = API_KEY.exec(presented);
  return match ? contextFor(pool, match[1] as string, match[2] as string, "api_key", null, now) : null;
}

// An access token is bound to the resource it was issued for, so a token minted for another audience never works here.
export async function authenticateBearer(pool: pg.Pool, presented: string, audience: string, now = Date.now()): Promise<AgentContext | null> {
  const access = ACCESS_TOKEN.exec(presented);
  if (access) return contextFor(pool, access[1] as string, access[2] as string, "oauth_access", audience, now);
  return authenticateApiKey(pool, presented, now);
}

