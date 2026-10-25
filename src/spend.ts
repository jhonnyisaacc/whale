import type { TxOutcome, TxRecord } from "./domain.js";

export const SPEND_SCHEMA = `
CREATE TABLE IF NOT EXISTS spend_journal (
  idempotency_key text PRIMARY KEY,
  usd double precision NOT NULL,
  spent_on date NOT NULL,
  status text NOT NULL DEFAULT 'committed'
);
ALTER TABLE spend_journal ADD COLUMN IF NOT EXISTS status text NOT NULL DEFAULT 'committed';
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'spend_journal'::regclass AND conname = 'spend_journal_status_check') THEN
    ALTER TABLE spend_journal ADD CONSTRAINT spend_journal_status_check CHECK (status IN ('reserved', 'committed', 'released'));
  END IF;
END $$;
ALTER TABLE spend_journal ADD COLUMN IF NOT EXISTS reserved_at timestamptz;
ALTER TABLE spend_journal ADD COLUMN IF NOT EXISTS tx_hash text;
ALTER TABLE spend_journal ADD COLUMN IF NOT EXISTS chain_key text;
ALTER TABLE spend_journal ADD COLUMN IF NOT EXISTS outcome text;
ALTER TABLE spend_journal ADD COLUMN IF NOT EXISTS note text;
ALTER TABLE spend_journal ADD COLUMN IF NOT EXISTS strategy_id text;
CREATE TABLE IF NOT EXISTS signed_tx (
  tx_hash text PRIMARY KEY,
  idempotency_key text,
  chain_key text NOT NULL,
  from_address text NOT NULL,
  to_address text NOT NULL,
  value text NOT NULL,
  outcome text NOT NULL,
  note text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE signed_tx ADD COLUMN IF NOT EXISTS nonce bigint;
`;

export const STRATEGY_COLUMN_SQL =
  "SELECT is_nullable FROM information_schema.columns WHERE table_schema = current_schema() AND table_name = 'spend_journal' AND column_name = 'strategy_id'";
// Rows written before strategy_id existed: a key belongs to a strategy only when its prefix is a configured
// strategy id. Any other key, ':' or not, was a listing alert id.
export const STRATEGY_BACKFILL_SQL = `
UPDATE spend_journal
SET strategy_id = CASE WHEN position(':' in idempotency_key) > 0 AND split_part(idempotency_key, ':', 1) = ANY($1::text[]) THEN split_part(idempotency_key, ':', 1) ELSE 'listing' END
WHERE strategy_id IS NULL
`;
export const STRATEGY_NOT_NULL_SQL = "ALTER TABLE spend_journal ALTER COLUMN strategy_id SET DEFAULT 'listing', ALTER COLUMN strategy_id SET NOT NULL";
export const RESERVE_LOCK_SQL = "SELECT pg_advisory_xact_lock(hashtext($1))";
export const RESERVE_SUM_SQL =
  "SELECT COALESCE(SUM(usd), 0)::text AS total FROM spend_journal WHERE spent_on = $1::date AND status IN ('reserved', 'committed')";
export const RESERVE_SUM_SCOPED_SQL =
  "SELECT COALESCE(SUM(usd), 0)::text AS total FROM spend_journal WHERE spent_on = $1::date AND status IN ('reserved', 'committed') AND strategy_id = $2";
export const RESERVE_UPSERT_SQL = `
INSERT INTO spend_journal (idempotency_key, usd, spent_on, status, reserved_at, strategy_id)
VALUES ($1, $2, $3::date, 'reserved', now(), $4)
ON CONFLICT (idempotency_key) DO UPDATE
SET usd = EXCLUDED.usd, spent_on = EXCLUDED.spent_on, status = 'reserved', reserved_at = now(), strategy_id = EXCLUDED.strategy_id,
  tx_hash = NULL, chain_key = NULL, outcome = NULL, note = NULL
WHERE spend_journal.status = 'released'
`;
export const SIGNED_TX_SQL = `
INSERT INTO signed_tx (tx_hash, idempotency_key, chain_key, from_address, to_address, value, outcome, note, nonce)
VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
ON CONFLICT (tx_hash) DO UPDATE SET outcome = EXCLUDED.outcome, note = EXCLUDED.note, updated_at = now()
`;
export const SPEND_TX_SQL = `
UPDATE spend_journal SET tx_hash = $2, chain_key = $3, outcome = $4, note = $5
WHERE idempotency_key = $1 AND (tx_hash IS NULL OR tx_hash = $2 OR $4 IN ('pending', 'landed'))
`;
export const RESERVED_SQL = `
SELECT idempotency_key, tx_hash, chain_key, reserved_at IS NULL AS legacy FROM spend_journal
WHERE status = 'reserved' AND (reserved_at IS NULL OR reserved_at < now() - make_interval(mins => $1::int))
`;
export const SIGNED_FOR_KEY_SQL = "SELECT tx_hash, chain_key, from_address, nonce::text AS nonce FROM signed_tx WHERE idempotency_key = $1";
export const COMMIT_SQL = "UPDATE spend_journal SET status = 'committed' WHERE idempotency_key = $1 AND status = 'reserved'";
export const RELEASE_SQL = "UPDATE spend_journal SET status = 'released' WHERE idempotency_key = $1 AND status = 'reserved'";
export const CONTROL_SCHEMA = `
CREATE TABLE IF NOT EXISTS control_flags (
  name text PRIMARY KEY,
  enabled boolean NOT NULL
);
`;
export const KILL_SWITCH_SQL = "SELECT enabled FROM control_flags WHERE name = 'kill_switch'";

export type SpendStatus = "reserved" | "committed" | "released";

// Spend that did not come through a strategy token. Config rejects it as a strategy id.
export const LISTING_SCOPE = "listing";

export type SpendScope = { strategyId: string; capUsd: number };

// /listing keys are alert ids. Strategy keys are `${strategyId}:${key}`. A bare alert id has no ':' and keeps
// its historical key; one that has ':' moves under the reserved listing prefix so it cannot alias a strategy key.
export function listingKey(alertId: string): string {
  return alertId.includes(":") ? `${LISTING_SCOPE}:${alertId}` : alertId;
}

export function strategyKey(strategyId: string, key: string): string {
  return `${strategyId}:${key}`;
}

// The key an alert id with ':' had before it moved under the listing prefix; a replay of that alert must find it.
export function legacyListingKey(key: string): string | null {
  const prefix = `${LISTING_SCOPE}:`;
  return key.startsWith(prefix) ? key.slice(prefix.length) : null;
}

function heldStatus(statuses: readonly (SpendStatus | undefined)[]): SpendStatus | null {
  return statuses.find((status) => status === "reserved" || status === "committed") ?? statuses.find((status) => status !== undefined) ?? null;
}

export type ReservedRow = { idempotencyKey: string; txHash: string | null; chainKey: string | null; legacy: boolean };

// Every transaction signed for the row decides it: one landing commits, and only when all of them are
// provably dead (reverted, or expired because the chain moved past them) is the reservation released.
export function reconcileDecision(row: ReservedRow, outcomes: readonly (TxOutcome | null)[]): "commit" | "release" | "keep" {
  if (row.legacy) return "keep";
  if (outcomes.length === 0) return row.txHash ? "keep" : "release";
  if (outcomes.includes("landed")) return "commit";
  if (outcomes.every((outcome) => outcome === "reverted" || outcome === "expired")) return "release";
  return "keep";
}

export function reserveDecision(input: {
  existing: SpendStatus | null;
  spent: number;
  usd: number;
  cap: number;
  scoped?: { spent: number; cap: number };
}): "reserved" | "exists" | "cap" {
  if (input.existing === "reserved" || input.existing === "committed") return "exists";
  if (!(input.usd > 0) || input.spent + input.usd > input.cap) return "cap";
  if (input.scoped && input.scoped.spent + input.usd > input.scoped.cap) return "cap";
  return "reserved";
}

export function spendDay(now = new Date(), timeZone = "UTC"): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" }).format(now);
}

export function utcDay(now = new Date()): string {
  return spendDay(now, "UTC");
}

export function killSwitchOn(envOn: boolean, rowEnabled: boolean | null): boolean {
  return envOn || rowEnabled === true;
}

export function createMemoryJournal() {
  const rows = new Map<string, { usd: number; day: string; status: SpendStatus; strategyId: string }>();
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
    reserve(key: string, usd: number, day: string, cap: number, scope?: SpendScope) {
      return lock(() => {
        const existing = heldStatus([key, legacyListingKey(key)].map((item) => (item === null ? undefined : rows.get(item)?.status)));
        const strategyId = scope?.strategyId ?? LISTING_SCOPE;
        let spent = 0;
        let scopedSpent = 0;
        for (const row of rows.values()) {
          if (row.day !== day || (row.status !== "reserved" && row.status !== "committed")) continue;
          spent += row.usd;
          if (row.strategyId === strategyId) scopedSpent += row.usd;
        }
        const decision = reserveDecision({ existing, spent, usd, cap, scoped: scope ? { spent: scopedSpent, cap: scope.capUsd } : undefined });
        if (decision === "reserved") rows.set(key, { usd, day, status: "reserved", strategyId });
        return decision;
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
    pool = new pg.Pool({ connectionString: databaseUrl, max: 4 });
    pools.set(databaseUrl, pool);
  }
  if (!ready.has(databaseUrl)) {
    await pool.query(SPEND_SCHEMA);
    await pool.query(CONTROL_SCHEMA);
    ready.add(databaseUrl);
  }
  return pool;
}

export async function spentOnDay(databaseUrl: string, day: string): Promise<number> {
  const pool = await poolFor(databaseUrl);
  try {
    const result = await pool.query<{ total: string | null }>(RESERVE_SUM_SQL, [day]);
    const total = Number(result.rows[0]?.total ?? 0);
    return Number.isFinite(total) ? total : 0;
  } catch (error) {
    ready.delete(databaseUrl);
    throw error;
  }
}

export async function recordSpend(
  databaseUrl: string,
  idempotencyKey: string,
  usd: number,
  day = utcDay(),
  capUsd = Number.POSITIVE_INFINITY,
  scope?: SpendScope,
): Promise<"reserved" | "exists" | "cap"> {
  const pool = await poolFor(databaseUrl);
  const client = await pool.connect();
  const total = async (sql: string, params: unknown[]) => {
    const result = await client.query<{ total: string | null }>(sql, params);
    const value = Number(result.rows[0]?.total ?? 0);
    return Number.isFinite(value) ? value : 0;
  };
  try {
    await client.query("BEGIN");
    await client.query(RESERVE_LOCK_SQL, [day]);
    const keys = [idempotencyKey, legacyListingKey(idempotencyKey)].filter((item): item is string => item !== null);
    const existing = await client.query<{ status: SpendStatus }>("SELECT status FROM spend_journal WHERE idempotency_key = ANY($1)", [keys]);
    const status = heldStatus(existing.rows.map((row) => row.status));
    const spent = await total(RESERVE_SUM_SQL, [day]);
    const scoped = scope ? { spent: await total(RESERVE_SUM_SCOPED_SQL, [day, scope.strategyId]), cap: scope.capUsd } : undefined;
    const decision = reserveDecision({ existing: status, spent, usd, cap: capUsd, scoped });
    if (decision !== "reserved") {
      await client.query("ROLLBACK");
      return decision;
    }
    await client.query(RESERVE_UPSERT_SQL, [idempotencyKey, usd, day, scope?.strategyId ?? LISTING_SCOPE]);
    await client.query("COMMIT");
    return "reserved";
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

export async function backfillStrategyIds(databaseUrl: string, strategyIds: readonly string[]): Promise<void> {
  const pool = await poolFor(databaseUrl);
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const column = await client.query<{ is_nullable: string }>(STRATEGY_COLUMN_SQL);
    if (column.rows[0]?.is_nullable === "YES") {
      await client.query(STRATEGY_BACKFILL_SQL, [strategyIds]);
      await client.query(STRATEGY_NOT_NULL_SQL);
    }
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

export async function commitSpend(databaseUrl: string, idempotencyKey: string): Promise<void> {
  const pool = await poolFor(databaseUrl);
  await pool.query(COMMIT_SQL, [idempotencyKey]);
}

export async function releaseSpend(databaseUrl: string, idempotencyKey: string): Promise<void> {
  const pool = await poolFor(databaseUrl);
  await pool.query(RELEASE_SQL, [idempotencyKey]);
}

export async function readKillSwitch(databaseUrl: string): Promise<boolean> {
  const pool = await poolFor(databaseUrl);
  const result = await pool.query<{ enabled: boolean }>(KILL_SWITCH_SQL);
  return result.rows[0]?.enabled === true;
}

export async function recordTx(databaseUrl: string, idempotencyKey: string | null, tx: TxRecord): Promise<void> {
  const pool = await poolFor(databaseUrl);
  await pool.query(SIGNED_TX_SQL, [tx.txHash, idempotencyKey, tx.chainKey, tx.from, tx.to, tx.value, tx.outcome, tx.note ?? null, tx.nonce ?? null]);
  if (idempotencyKey) await pool.query(SPEND_TX_SQL, [idempotencyKey, tx.txHash, tx.chainKey, tx.outcome, tx.note ?? null]);
}

export async function reconcileReserved(
  databaseUrl: string,
  olderThanMinutes: number,
  lookup: (tx: AgedTx) => Promise<TxOutcome | null>,
  log: (entry: { idempotencyKey: string; txHash: string | null; action: "commit" | "release" | "keep"; outcomes: (TxOutcome | null)[] }) => void,
): Promise<number> {
  const pool = await poolFor(databaseUrl);
  const result = await pool.query<{ idempotency_key: string; tx_hash: string | null; chain_key: string | null; legacy: boolean }>(RESERVED_SQL, [olderThanMinutes]);
  for (const raw of result.rows) {
    const row: ReservedRow = { idempotencyKey: raw.idempotency_key, txHash: raw.tx_hash, chainKey: raw.chain_key, legacy: raw.legacy };
    const signed = await pool.query<{ tx_hash: string; chain_key: string; from_address: string; nonce: string | null }>(SIGNED_FOR_KEY_SQL, [row.idempotencyKey]);
    const txs = agedTxs(row, signed.rows.map((tx) => ({ txHash: tx.tx_hash, chainKey: tx.chain_key, from: tx.from_address, nonce: tx.nonce === null ? null : Number(tx.nonce) })));
    const outcomes = await Promise.all(txs.map((tx) => lookup(tx).catch(() => null)));
    const action = reconcileDecision(row, outcomes);
    if (action === "commit") await pool.query(COMMIT_SQL, [row.idempotencyKey]);
    if (action === "release") await pool.query(RELEASE_SQL, [row.idempotencyKey]);
    log({ idempotencyKey: row.idempotencyKey, txHash: row.txHash, action, outcomes });
  }
  return result.rows.length;
}

export type AgedTx = { chainKey: string; txHash: string; from: string | null; nonce: number | null };

function agedTxs(row: ReservedRow, signed: readonly AgedTx[]): AgedTx[] {
  if (!row.txHash || !row.chainKey || signed.some((tx) => tx.txHash === row.txHash)) return [...signed];
  return [...signed, { chainKey: row.chainKey, txHash: row.txHash, from: null, nonce: null }];
}

export async function closeSpendPools(): Promise<void> {
  const open = [...pools.values()];
  pools.clear();
  ready.clear();
  await Promise.all(open.map((pool) => pool.end()));
}

export const EXECUTOR_LOCK_SQL = "SELECT pg_try_advisory_lock($1) AS locked";
export const EXECUTOR_LOCK_KEY = 74_104;

export function lockAcquired(rows: readonly { locked?: unknown }[]): boolean {
  return rows[0]?.locked === true;
}

export async function acquireExecutorLock(databaseUrl: string, onLost: (error: Error) => void = (error) => console.error(JSON.stringify({ executorLockLost: String(error) }))): Promise<() => Promise<void>> {
  const { default: pg } = await import("pg");
  const client = new pg.Client({ connectionString: databaseUrl });
  client.on("error", onLost);
  await client.connect();
  const result = await client.query<{ locked: boolean }>(EXECUTOR_LOCK_SQL, [EXECUTOR_LOCK_KEY]);
  if (!lockAcquired(result.rows)) {
    await client.end();
    throw new Error("another executor already holds the boot lock; refusing to start a second replica");
  }
  let released = false;
  return async () => {
    if (released) return;
    released = true;
    await client.query("SELECT pg_advisory_unlock($1)", [EXECUTOR_LOCK_KEY]).catch(() => undefined);
    await client.end();
  };
}
