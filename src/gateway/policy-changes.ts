import type pg from "pg";
import { audit, inTransaction } from "./accounts.js";
import type { GatewayConfig } from "./config.js";
import { verifyStepUp, type AssertionPayload } from "./passkeys.js";
import { changeDirection, walletPolicySchema, type WalletPolicy } from "./policy.js";

export const WIDEN_DELAY_MS = 24 * 60 * 60 * 1000;

export type PolicyChangeResult =
  | { status: "unchanged"; version: number }
  | { status: "applied"; version: number }
  | { status: "scheduled"; changeId: string; effectiveAt: string }
  | { refused: "not_found" | "stale" | "step_up_required" | "step_up_failed"; detail?: string };

export function widenAction(walletId: string, baseVersion: number, document: WalletPolicy) {
  return { kind: "policy.widen", walletId, baseVersion, document };
}

export function unfreezeAction(walletId: string) {
  return { kind: "wallet.unfreeze", walletId };
}

// Narrowing protects the user, so it applies at once and cancels any widening still waiting. Widening needs a passkey
// approval of this exact document and then waits, so a stolen session cannot loosen the wallet and spend in one go.
export async function changePolicy(
  pool: pg.Pool,
  config: GatewayConfig,
  input: { accountId: string; walletId: string; baseVersion: number; document: WalletPolicy; assertion: AssertionPayload | null },
  now = Date.now(),
): Promise<PolicyChangeResult> {
  const current = await pool.query<{ version: number; document: unknown }>(
    "SELECT p.version, p.document FROM policies p JOIN wallets w ON w.id = p.wallet_id WHERE w.id = $1 AND w.account_id = $2 AND w.status <> 'archived'",
    [input.walletId, input.accountId],
  );
  const row = current.rows[0];
  if (!row) return { refused: "not_found" };
  if (row.version !== input.baseVersion) return { refused: "stale" };
  const direction = changeDirection(walletPolicySchema.parse(row.document), input.document);
  if (direction === "same") return { status: "unchanged", version: row.version };
  const scope = { accountId: input.accountId, walletId: input.walletId, actor: "user" as const };
  if (direction === "narrow") {
    return inTransaction(pool, async (client) => {
      const updated = await client.query<{ version: number }>(
        "UPDATE policies SET version = version + 1, document = $3, updated_at = $4 WHERE wallet_id = $1 AND version = $2 RETURNING version",
        [input.walletId, input.baseVersion, JSON.stringify(input.document), new Date(now)],
      );
      const version = updated.rows[0]?.version;
      if (version === undefined) return { refused: "stale" as const };
      await client.query("UPDATE policy_changes SET status = 'superseded', decided_at = $2 WHERE wallet_id = $1 AND status = 'pending'", [input.walletId, new Date(now)]);
      await audit(client, { ...scope, action: "policy.narrowed", detail: { version } });
      return { status: "applied" as const, version };
    });
  }
  if (!input.assertion) return { refused: "step_up_required" };
  const approved = await verifyStepUp(pool, config, input.accountId, widenAction(input.walletId, input.baseVersion, input.document), input.assertion, now);
  if (approved !== true) return { refused: "step_up_failed", detail: approved };
  return inTransaction(pool, async (client) => {
    await client.query("UPDATE policy_changes SET status = 'superseded', decided_at = $2 WHERE wallet_id = $1 AND status = 'pending'", [input.walletId, new Date(now)]);
    const effectiveAt = new Date(now + WIDEN_DELAY_MS);
    const change = await client.query<{ id: string }>(
      "INSERT INTO policy_changes (wallet_id, base_version, document, direction, effective_at, requested_at) VALUES ($1, $2, $3, 'widen', $4, $5) RETURNING id",
      [input.walletId, input.baseVersion, JSON.stringify(input.document), effectiveAt, new Date(now)],
    );
    const changeId = change.rows[0]?.id as string;
    await audit(client, { ...scope, action: "policy.widen_requested", detail: { changeId, effectiveAt: effectiveAt.toISOString() } });
    return { status: "scheduled" as const, changeId, effectiveAt: effectiveAt.toISOString() };
  });
}

export async function cancelPendingChange(pool: pg.Pool, accountId: string, walletId: string, now = Date.now()): Promise<boolean> {
  return inTransaction(pool, async (client) => {
    const cancelled = await client.query<{ id: string }>(
      `UPDATE policy_changes c SET status = 'cancelled', decided_at = $3 FROM wallets w
       WHERE c.wallet_id = w.id AND w.id = $1 AND w.account_id = $2 AND c.status = 'pending' RETURNING c.id`,
      [walletId, accountId, new Date(now)],
    );
    const changeId = cancelled.rows[0]?.id;
    if (!changeId) return false;
    await audit(client, { accountId, walletId, actor: "user", action: "policy.widen_cancelled", detail: { changeId } });
    return true;
  });
}

// A widening applies only on top of the version it was approved against. Anything that moved the policy since makes
// it superseded, so an old approval never lands on a newer policy.
export async function applyDueChanges(pool: pg.Pool, now = Date.now()): Promise<number> {
  const due = await pool.query<{ id: string }>("SELECT id FROM policy_changes WHERE status = 'pending' AND effective_at <= $1 ORDER BY effective_at LIMIT 100", [new Date(now)]);
  let applied = 0;
  for (const { id } of due.rows) {
    const done = await inTransaction(pool, async (client) => {
      const change = await client.query<{ wallet_id: string; base_version: number; document: unknown; account_id: string }>(
        `SELECT c.wallet_id, c.base_version, c.document, w.account_id FROM policy_changes c JOIN wallets w ON w.id = c.wallet_id
         WHERE c.id = $1 AND c.status = 'pending' FOR UPDATE OF c`,
        [id],
      );
      const row = change.rows[0];
      if (!row) return false;
      const updated = await client.query<{ version: number }>(
        "UPDATE policies SET version = version + 1, document = $3, updated_at = $4 WHERE wallet_id = $1 AND version = $2 RETURNING version",
        [row.wallet_id, row.base_version, JSON.stringify(row.document), new Date(now)],
      );
      const version = updated.rows[0]?.version;
      await client.query("UPDATE policy_changes SET status = $2, decided_at = $3 WHERE id = $1", [id, version === undefined ? "superseded" : "applied", new Date(now)]);
      if (version !== undefined) await audit(client, { accountId: row.account_id, walletId: row.wallet_id, actor: "system", action: "policy.widened", detail: { changeId: id, version } });
      return version !== undefined;
    });
    if (done) applied += 1;
  }
  return applied;
}

export async function pendingChange(pool: pg.Pool, accountId: string, walletId: string) {
  const found = await pool.query<{ id: string; document: unknown; requested_at: Date; effective_at: Date }>(
    `SELECT c.id, c.document, c.requested_at, c.effective_at FROM policy_changes c JOIN wallets w ON w.id = c.wallet_id
     WHERE w.id = $1 AND w.account_id = $2 AND c.status = 'pending'`,
    [walletId, accountId],
  );
  const row = found.rows[0];
  return row ? { id: row.id, document: walletPolicySchema.parse(row.document), requestedAt: row.requested_at.toISOString(), effectiveAt: row.effective_at.toISOString() } : null;
}

export async function freezeWallets(pool: pg.Pool, accountId: string, walletId: string | null, now = Date.now()): Promise<number> {
  const frozen = await pool.query<{ id: string }>(
    "UPDATE wallets SET status = 'frozen' WHERE account_id = $1 AND ($2::uuid IS NULL OR id = $2::uuid) AND status IN ('pending', 'active') RETURNING id",
    [accountId, walletId],
  );
  for (const row of frozen.rows) await audit(pool, { accountId, walletId: row.id, actor: "user", action: "wallet.frozen", detail: { at: new Date(now).toISOString() } });
  return frozen.rows.length;
}

// Unfreezing loosens the wallet, so it takes a passkey. The wallet returns to active only if its enclave was complete.
export async function unfreezeWallet(pool: pg.Pool, config: GatewayConfig, accountId: string, walletId: string, assertion: AssertionPayload, now = Date.now()): Promise<true | string> {
  const approved = await verifyStepUp(pool, config, accountId, unfreezeAction(walletId), assertion, now);
  if (approved !== true) return approved;
  const updated = await pool.query(
    `UPDATE wallets SET status = CASE WHEN level = 'enclave' AND turnkey_delegate_user_id IS NOT NULL THEN 'active' ELSE 'pending' END
     WHERE id = $1 AND account_id = $2 AND status = 'frozen' RETURNING id`,
    [walletId, accountId],
  );
  if ((updated.rowCount ?? 0) === 0) return "the wallet is not frozen";
  await audit(pool, { accountId, walletId, actor: "user", action: "wallet.unfrozen" });
  return true;
}
