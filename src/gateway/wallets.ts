import type pg from "pg";
import { audit, inTransaction } from "./accounts.js";
import { DEFAULT_POLICY, storedPolicySchema, type WalletPolicy } from "./policy.js";

export const LEVELS = ["enclave", "self_hosted", "smart_account"] as const;
export type Level = (typeof LEVELS)[number];
// A level is offered only once its signer exists. ADR 0003 keeps smart accounts out until the module record lands.
export const AVAILABLE_LEVELS: readonly Level[] = ["enclave"];
export const MAX_WALLETS_PER_ACCOUNT = 10;

export type WalletView = {
  id: string;
  label: string;
  level: Level;
  status: string;
  live: boolean;
  addresses: { family: string; address: string }[];
  policy: WalletPolicy;
  policyVersion: number;
  createdAt: string;
};

export async function createWallet(pool: pg.Pool, accountId: string, input: { label: string; level: Level }): Promise<{ walletId: string } | { refused: string }> {
  if (!AVAILABLE_LEVELS.includes(input.level)) return { refused: "level_unavailable" };
  return inTransaction(pool, async (client) => {
    await client.query("SELECT id FROM accounts WHERE id = $1 FOR UPDATE", [accountId]);
    const count = await client.query<{ n: number }>("SELECT count(*)::int AS n FROM wallets WHERE account_id = $1 AND status <> 'archived'", [accountId]);
    if ((count.rows[0]?.n ?? 0) >= MAX_WALLETS_PER_ACCOUNT) return { refused: "wallet_limit" };
    const wallet = await client.query<{ id: string }>("INSERT INTO wallets (account_id, label, level) VALUES ($1, $2, $3) RETURNING id", [accountId, input.label, input.level]);
    const walletId = wallet.rows[0]?.id as string;
    await client.query("INSERT INTO policies (wallet_id, version, document) VALUES ($1, 1, $2)", [walletId, JSON.stringify(DEFAULT_POLICY)]);
    await audit(client, { accountId, walletId, actor: "user", action: "wallet.created", detail: { level: input.level } });
    return { walletId };
  });
}

export async function listWallets(pool: pg.Pool, accountId: string, walletId?: string): Promise<WalletView[]> {
  const rows = await pool.query<{
    id: string;
    label: string;
    level: Level;
    status: string;
    live: boolean;
    created_at: Date;
    document: unknown;
    version: number;
    addresses: { family: string; address: string }[];
  }>(
    `SELECT w.id, w.label, w.level, w.status, w.live, w.created_at, p.document, p.version,
       COALESCE((SELECT json_agg(json_build_object('family', a.family, 'address', a.address) ORDER BY a.family) FROM wallet_addresses a WHERE a.wallet_id = w.id), '[]') AS addresses
     FROM wallets w JOIN policies p ON p.wallet_id = w.id
     WHERE w.account_id = $1 AND w.status <> 'archived' AND ($2::uuid IS NULL OR w.id = $2::uuid)
     ORDER BY w.created_at`,
    [accountId, walletId ?? null],
  );
  return rows.rows.map((row) => ({
    id: row.id,
    label: row.label,
    level: row.level,
    status: row.status,
    live: row.live,
    addresses: row.addresses,
    policy: storedPolicySchema.parse(row.document),
    policyVersion: row.version,
    createdAt: row.created_at.toISOString(),
  }));
}
