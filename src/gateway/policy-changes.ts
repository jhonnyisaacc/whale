import type pg from "pg";
import { audit, inTransaction } from "./accounts.js";
import type { GatewayConfig } from "./config.js";
import { verifyStepUp, type AssertionPayload } from "./passkeys.js";
import { changeDirection, storedPolicySchema, type WalletPolicy } from "./policy.js";

export const WIDEN_DELAY_MS = 24 * 60 * 60 * 1000;

export type PolicyChangeResult =
  | { status: "unchanged"; version: number }
  | { status: "applied"; version: number }
  | { status: "scheduled"; changeId: string; effectiveAt: string }
  | { refused: "not_found" | "stale" | "conflict" | "wallet_frozen" | "step_up_required" | "step_up_failed"; detail?: string };

function fixedTime(now: number | undefined): Date | null {
  return now === undefined ? null : new Date(now);
}

function isOnePendingViolation(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "23505" && "constraint" in error && error.constraint === "policy_changes_one_pending";
}

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
  now?: number,
): Promise<PolicyChangeResult> {
  const current = await pool.query<{ version: number; document: unknown; status: string }>(
    "SELECT p.version, p.document, w.status FROM policies p JOIN wallets w ON w.id = p.wallet_id WHERE w.id = $1 AND w.account_id = $2 AND w.status <> 'archived'",
    [input.walletId, input.accountId],
  );
  const row = current.rows[0];
  if (!row) return { refused: "not_found" };
  if (row.version !== input.baseVersion) return { refused: "stale" };
  const direction = changeDirection(storedPolicySchema.parse(row.document), input.document);
  if (direction === "same") return { status: "unchanged", version: row.version };
  const scope = { accountId: input.accountId, walletId: input.walletId, actor: "user" as const };
  if (direction === "narrow") {
    return inTransaction(pool, async (client) => {
      const updated = await client.query<{ version: number }>(
        "UPDATE policies SET version = version + 1, document = $3, updated_at = COALESCE($4::timestamptz, now()) WHERE wallet_id = $1 AND version = $2 RETURNING version",
        [input.walletId, input.baseVersion, JSON.stringify(input.document), fixedTime(now)],
      );
      const version = updated.rows[0]?.version;
      if (version === undefined) return { refused: "stale" as const };
      await client.query("UPDATE policy_changes SET status = 'superseded', decided_at = COALESCE($2::timestamptz, now()) WHERE wallet_id = $1 AND status = 'pending'", [input.walletId, fixedTime(now)]);
      await audit(client, { ...scope, action: "policy.narrowed", detail: { version } });
      return { status: "applied" as const, version };
    });
  }
  if (row.status === "frozen") return { refused: "wallet_frozen" };
  if (!input.assertion) return { refused: "step_up_required" };
  const approved = await verifyStepUp(pool, config, input.accountId, widenAction(input.walletId, input.baseVersion, input.document), input.assertion, now);
  if (approved !== true) return { refused: "step_up_failed", detail: approved };
  return inTransaction(pool, async (client): Promise<PolicyChangeResult> => {
    const wallet = await client.query<{ status: string }>("SELECT status FROM wallets WHERE id = $1 FOR SHARE", [input.walletId]);
    if (wallet.rows[0]?.status === "frozen") return { refused: "wallet_frozen" };
    await client.query("UPDATE policy_changes SET status = 'superseded', decided_at = COALESCE($2::timestamptz, now()) WHERE wallet_id = $1 AND status = 'pending'", [input.walletId, fixedTime(now)]);
    const change = await client.query<{ id: string; effective_at: Date }>(
      `INSERT INTO policy_changes (wallet_id, base_version, document, direction, effective_at, requested_at)
       VALUES ($1, $2, $3, 'widen', COALESCE($4::timestamptz, now()) + $5 * interval '1 millisecond', COALESCE($4::timestamptz, now())) RETURNING id, effective_at`,
      [input.walletId, input.baseVersion, JSON.stringify(input.document), fixedTime(now), WIDEN_DELAY_MS],
    );
    const changeId = change.rows[0]?.id as string;
    const effectiveAt = (change.rows[0]?.effective_at as Date).toISOString();
    await audit(client, { ...scope, action: "policy.widen_requested", detail: { changeId, effectiveAt } });
    return { status: "scheduled" as const, changeId, effectiveAt };
  }).catch((error: unknown) => {
    if (isOnePendingViolation(error)) return { refused: "conflict" as const };
    throw error;
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
export async function applyDueChanges(pool: pg.Pool, now?: number): Promise<number> {
  const due = await pool.query<{ id: string }>(
    "SELECT id FROM policy_changes WHERE status = 'pending' AND effective_at <= COALESCE($1::timestamptz, now()) ORDER BY effective_at LIMIT 100",
    [fixedTime(now)],
  );
  let applied = 0;
  for (const { id } of due.rows) {
    const done = await inTransaction(pool, async (client) => {
      await client.query("SELECT 1 FROM policies WHERE wallet_id = (SELECT wallet_id FROM policy_changes WHERE id = $1) FOR UPDATE", [id]);
      const wallet = await client.query<{ status: string }>("SELECT status FROM wallets WHERE id = (SELECT wallet_id FROM policy_changes WHERE id = $1) FOR SHARE", [id]);
      const change = await client.query<{ wallet_id: string; base_version: number; document: unknown; account_id: string }>(
        `SELECT c.wallet_id, c.base_version, c.document, w.account_id FROM policy_changes c JOIN wallets w ON w.id = c.wallet_id
         WHERE c.id = $1 AND c.status = 'pending' FOR UPDATE OF c`,
        [id],
      );
      const row = change.rows[0];
      if (!row) return false;
      if (wallet.rows[0]?.status === "frozen") {
        await client.query("UPDATE policy_changes SET status = 'cancelled', decided_at = COALESCE($2::timestamptz, now()) WHERE id = $1", [id, fixedTime(now)]);
        await audit(client, { accountId: row.account_id, walletId: row.wallet_id, actor: "system", action: "policy.widen_cancelled", detail: { changeId: id, reason: "frozen" } });
        return false;
      }
      const updated = await client.query<{ version: number }>(
        "UPDATE policies SET version = version + 1, document = $3, updated_at = COALESCE($4::timestamptz, now()) WHERE wallet_id = $1 AND version = $2 RETURNING version",
        [row.wallet_id, row.base_version, JSON.stringify(row.document), fixedTime(now)],
      );
      const version = updated.rows[0]?.version;
      await client.query("UPDATE policy_changes SET status = $2, decided_at = COALESCE($3::timestamptz, now()) WHERE id = $1", [id, version === undefined ? "superseded" : "applied", fixedTime(now)]);
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
  return row ? { id: row.id, document: storedPolicySchema.parse(row.document), requestedAt: row.requested_at.toISOString(), effectiveAt: row.effective_at.toISOString() } : null;
}

export async function freezeWallets(pool: pg.Pool, accountId: string, walletId: string | null, now = Date.now()): Promise<number> {
  return inTransaction(pool, async (client) => {
    const frozen = await client.query<{ id: string }>(
      "UPDATE wallets SET status = 'frozen' WHERE account_id = $1 AND ($2::uuid IS NULL OR id = $2::uuid) AND status IN ('pending', 'active') RETURNING id",
      [accountId, walletId],
    );
    const walletIds = frozen.rows.map((row) => row.id);
    for (const id of walletIds) await audit(client, { accountId, walletId: id, actor: "user", action: "wallet.frozen", detail: { at: new Date(now).toISOString() } });
    await client.query("UPDATE signer_registrations SET expires_at = $2 WHERE wallet_id = ANY($1::uuid[]) AND used_at IS NULL AND expires_at > $2", [walletIds, new Date(now)]);
    const cancelled = await client.query<{ id: string; wallet_id: string }>(
      "UPDATE policy_changes SET status = 'cancelled', decided_at = $2 WHERE wallet_id = ANY($1::uuid[]) AND status = 'pending' RETURNING id, wallet_id",
      [walletIds, new Date(now)],
    );
    for (const row of cancelled.rows) await audit(client, { accountId, walletId: row.wallet_id, actor: "user", action: "policy.widen_cancelled", detail: { changeId: row.id, reason: "frozen" } });
    return walletIds.length;
  });
}

export async function unfreezeWallet(pool: pg.Pool, config: GatewayConfig, accountId: string, walletId: string, assertion: AssertionPayload, now = Date.now()): Promise<true | string> {
  const approved = await verifyStepUp(pool, config, accountId, unfreezeAction(walletId), assertion, now);
  if (approved !== true) return approved;
  const updated = await pool.query(
    `UPDATE wallets SET status = CASE
       WHEN level = 'enclave' AND turnkey_delegate_user_id IS NOT NULL THEN 'active'
       WHEN level = 'self_hosted' AND EXISTS (SELECT 1 FROM signers s WHERE s.wallet_id = wallets.id) THEN 'active'
       ELSE 'pending' END
     WHERE id = $1 AND account_id = $2 AND status = 'frozen' RETURNING id`,
    [walletId, accountId],
  );
  if ((updated.rowCount ?? 0) === 0) return "the wallet is not frozen";
  await audit(pool, { accountId, walletId, actor: "user", action: "wallet.unfrozen" });
  return true;
}
