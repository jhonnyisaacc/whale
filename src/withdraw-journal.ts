import type { TxOutcome } from "./domain.js";
import { reserveDecision, type SpendStatus } from "./spend.js";

export type WithdrawJournalAction = "commit" | "release" | "keep";

export function withdrawJournalAction(outcome: TxOutcome): WithdrawJournalAction {
  switch (outcome) {
    case "landed":
      return "commit";
    case "pending":
      return "keep";
    case "reverted":
    case "expired":
      return "release";
    default: {
      const exhaustive: never = outcome;
      return exhaustive;
    }
  }
}

export const WITHDRAW_SCHEMA = `
CREATE TABLE IF NOT EXISTS withdraw_journal (
  idempotency_key text PRIMARY KEY,
  scope text NOT NULL,
  amount double precision NOT NULL,
  spent_on date NOT NULL,
  status text NOT NULL DEFAULT 'reserved',
  CONSTRAINT withdraw_journal_status_check CHECK (status IN ('reserved', 'committed', 'released'))
);
`;
export const WITHDRAW_SUM_SQL =
  "SELECT COALESCE(SUM(amount), 0)::text AS total FROM withdraw_journal WHERE scope = $1 AND spent_on = $2::date AND status IN ('reserved', 'committed')";
export const WITHDRAW_UPSERT_SQL = `
INSERT INTO withdraw_journal (idempotency_key, scope, amount, spent_on, status)
VALUES ($1, $2, $3, $4::date, 'reserved')
ON CONFLICT (idempotency_key) DO UPDATE SET scope = EXCLUDED.scope, amount = EXCLUDED.amount, spent_on = EXCLUDED.spent_on, status = 'reserved'
WHERE withdraw_journal.status = 'released'
`;
export const WITHDRAW_COMMIT_SQL = "UPDATE withdraw_journal SET status = 'committed' WHERE idempotency_key = $1 AND status = 'reserved'";
export const WITHDRAW_RELEASE_SQL = "UPDATE withdraw_journal SET status = 'released' WHERE idempotency_key = $1 AND status = 'reserved'";
const RESERVE_LOCK_SQL = "SELECT pg_advisory_xact_lock(hashtext($1))";

export function createMemoryWithdrawJournal() {
  const rows = new Map<string, { scope: string; amount: number; day: string; status: SpendStatus }>();
  let tail = Promise.resolve();
  const lock = <T>(fn: () => T): Promise<T> => {
    const run = tail.then(fn, fn);
    tail = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  };
  return {
    reserve(key: string, scope: string, amount: number, day: string, cap: number) {
      return lock(() => {
        const existing = rows.get(key)?.status ?? null;
        let spent = 0;
        for (const row of rows.values()) {
          if (row.scope === scope && row.day === day && (row.status === "reserved" || row.status === "committed")) spent += row.amount;
        }
        const decision = reserveDecision({ existing, spent, usd: amount, cap });
        if (decision === "reserved") rows.set(key, { scope, amount, day, status: "reserved" });
        return decision;
      });
    },
    async commit(key: string) {
      await lock(() => {
        const row = rows.get(key);
        if (row?.status === "reserved") row.status = "committed";
      });
    },
    async release(key: string) {
      await lock(() => {
        const row = rows.get(key);
        if (row?.status === "reserved") row.status = "released";
      });
    },
  };
}

const pools = new Map<string, import("pg").Pool>();
const ready = new Set<string>();

async function poolFor(databaseUrl: string) {
  const { default: pg } = await import("pg");
  let pool = pools.get(databaseUrl);
  if (!pool) {
    pool = new pg.Pool({ connectionString: databaseUrl, max: 2 });
    pools.set(databaseUrl, pool);
  }
  if (!ready.has(databaseUrl)) {
    await pool.query(WITHDRAW_SCHEMA);
    ready.add(databaseUrl);
  }
  return pool;
}

export async function reserveWithdraw(
  databaseUrl: string,
  idempotencyKey: string,
  scope: string,
  amount: number,
  day: string,
  cap: number,
): Promise<"reserved" | "exists" | "cap"> {
  const pool = await poolFor(databaseUrl);
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query(RESERVE_LOCK_SQL, [`withdraw:${day}`]);
    const existing = await client.query<{ status: SpendStatus }>("SELECT status FROM withdraw_journal WHERE idempotency_key = $1", [idempotencyKey]);
    const total = await client.query<{ total: string | null }>(WITHDRAW_SUM_SQL, [scope, day]);
    const spent = Number(total.rows[0]?.total ?? 0);
    const decision = reserveDecision({ existing: existing.rows[0]?.status ?? null, spent: Number.isFinite(spent) ? spent : 0, usd: amount, cap });
    if (decision !== "reserved") {
      await client.query("ROLLBACK");
      return decision;
    }
    await client.query(WITHDRAW_UPSERT_SQL, [idempotencyKey, scope, amount, day]);
    await client.query("COMMIT");
    return "reserved";
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

export async function commitWithdraw(databaseUrl: string, idempotencyKey: string): Promise<void> {
  const pool = await poolFor(databaseUrl);
  await pool.query(WITHDRAW_COMMIT_SQL, [idempotencyKey]);
}

export async function releaseWithdraw(databaseUrl: string, idempotencyKey: string): Promise<void> {
  const pool = await poolFor(databaseUrl);
  await pool.query(WITHDRAW_RELEASE_SQL, [idempotencyKey]);
}

export async function closeWithdrawPools(): Promise<void> {
  const open = [...pools.values()];
  pools.clear();
  ready.clear();
  await Promise.all(open.map((pool) => pool.end()));
}
