import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import type pg from "pg";
import { audit, inTransaction } from "./accounts.js";
import { agentLimitsSchema, walletPolicySchema, type AgentLimits, type WalletPolicy } from "./policy.js";

const API_KEY = /^whale_([0-9a-f]{12})_([A-Za-z0-9_-]{43})$/;
const TOUCH_AFTER_MS = 60_000;

export type AgentContext = {
  agentId: string;
  accountId: string;
  walletId: string;
  walletStatus: string;
  live: boolean;
  limits: AgentLimits;
  policy: WalletPolicy;
};

function secretHash(secret: string): Buffer {
  return createHash("sha256").update(secret).digest();
}

export function newApiKey(): { id: string; secret: string; key: string } {
  const id = randomBytes(6).toString("hex");
  const secret = randomBytes(32).toString("base64url");
  return { id, secret, key: `whale_${id}_${secret}` };
}

export async function issueApiKey(client: pg.ClientBase, agentId: string): Promise<string> {
  const { id, secret, key } = newApiKey();
  await client.query("INSERT INTO agent_credentials (id, agent_id, kind, secret_hash) VALUES ($1, $2, 'api_key', $3)", [id, agentId, secretHash(secret)]);
  return key;
}

export async function createAgent(
  pool: pg.Pool,
  input: { accountId: string; walletId: string; name: string; limits: AgentLimits },
): Promise<{ agentId: string; apiKey: string }> {
  return inTransaction(pool, async (client) => {
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

// A credential works only while its agent, wallet, and account are all usable. Revoking any one of them stops it.
export async function authenticateApiKey(pool: pg.Pool, presented: string, now = Date.now()): Promise<AgentContext | null> {
  const match = API_KEY.exec(presented);
  if (!match) return null;
  const [, id, secret] = match as unknown as [string, string, string];
  const found = await pool.query<{
    secret_hash: Buffer;
    agent_id: string;
    account_id: string;
    wallet_id: string;
    wallet_status: string;
    live: boolean;
    limits: unknown;
    document: unknown;
    last_used_at: Date | null;
  }>(
    `SELECT c.secret_hash, a.id AS agent_id, a.account_id, a.wallet_id, w.status AS wallet_status, w.live, a.limits, p.document, c.last_used_at
     FROM agent_credentials c
     JOIN agents a ON a.id = c.agent_id AND a.revoked_at IS NULL
     JOIN wallets w ON w.id = a.wallet_id AND w.status IN ('pending', 'active')
     JOIN accounts acc ON acc.id = a.account_id AND acc.status = 'active'
     JOIN policies p ON p.wallet_id = w.id
     WHERE c.id = $1 AND c.kind = 'api_key' AND c.revoked_at IS NULL`,
    [id],
  );
  const row = found.rows[0];
  if (!row || !timingSafeEqual(row.secret_hash, secretHash(secret))) return null;
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
    limits: agentLimitsSchema.parse(row.limits),
    policy: walletPolicySchema.parse(row.document),
  };
}
