import type pg from "pg";
import { isDeepStrictEqual } from "node:util";
import type { HostedCommand, HostedReport, HostedReportRequest } from "../hosted-commands.js";
import { poolFor } from "../spend.js";

export type HostedSendKey = { accountId: string; walletId: string; agentId: string; idempotencyKey: string };
export type HostedStart = { kind: "started" } | { kind: "in_progress" } | { kind: "executed"; value: unknown } | { kind: "refused" } | { kind: "conflict" };
export type HostedJournal = ReturnType<typeof hostedJournal>;

type Row = { state: "started" | "executed" | "refused"; command: unknown; result: unknown; barred: boolean };

const KEY = "agent_id = $1 AND idempotency_key = $2";

export function hostedJournal(databaseUrl: string) {
  const locked = async <T>(key: HostedSendKey, work: (client: pg.PoolClient) => Promise<T>): Promise<T> => {
    const client = await (await poolFor(databaseUrl)).connect();
    try {
      await client.query("BEGIN");
      await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [`hosted_sends:${key.agentId}:${key.idempotencyKey}`]);
      const result = await work(client);
      await client.query("COMMIT");
      return result;
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  };
  const settle = async (key: HostedSendKey, sql: string, params: unknown[] = []): Promise<void> => {
    await (await poolFor(databaseUrl)).query(`UPDATE hosted_sends SET ${sql}, updated_at = now() WHERE ${KEY} AND state = 'started'`, [key.agentId, key.idempotencyKey, ...params]);
  };
  return {
    start: (key: HostedSendKey, command: HostedCommand, issuedAt: string): Promise<HostedStart> =>
      locked(key, async (client) => {
        const found = await client.query<Row>(`SELECT state, command, result, ($3::timestamptz <= refused_before) IS TRUE AS barred FROM hosted_sends WHERE ${KEY}`, [key.agentId, key.idempotencyKey, issuedAt]);
        const row = found.rows[0];
        if (row?.state === "refused" && row.barred) return { kind: "refused" };
        if (row && row.state !== "refused") {
          if (!isDeepStrictEqual(row.command, command)) return { kind: "conflict" };
          return row.state === "executed" ? { kind: "executed", value: row.result } : { kind: "in_progress" };
        }
        await client.query(
          `INSERT INTO hosted_sends (agent_id, idempotency_key, account_id, wallet_id, state, command, issued_at) VALUES ($1, $2, $3, $4, 'started', $5::jsonb, $6)
           ON CONFLICT (agent_id, idempotency_key) DO UPDATE SET state = 'started', command = EXCLUDED.command, issued_at = EXCLUDED.issued_at, result = NULL, updated_at = now()`,
          [key.agentId, key.idempotencyKey, key.accountId, key.walletId, JSON.stringify(command), issuedAt],
        );
        return { kind: "started" };
      }),
    finish: (key: HostedSendKey, value: unknown) => settle(key, "state = 'executed', result = $3::jsonb", [JSON.stringify(value)]),
    abandon: (key: HostedSendKey) => settle(key, "state = 'refused', refused_before = GREATEST(refused_before, issued_at)"),
    report: (request: HostedReportRequest): Promise<HostedReport> =>
      locked(request, async (client) => {
        const found = await client.query<Row>(`SELECT state, result FROM hosted_sends WHERE ${KEY}`, [request.agentId, request.idempotencyKey]);
        const row = found.rows[0];
        if (row?.state === "executed") return { state: "executed", value: row.result };
        if (row?.state === "started") return { state: "in_progress" };
        await client.query(
          `INSERT INTO hosted_sends (agent_id, idempotency_key, account_id, wallet_id, state, refused_before) VALUES ($1, $2, $3, $4, 'refused', $5)
           ON CONFLICT (agent_id, idempotency_key) DO UPDATE SET refused_before = GREATEST(hosted_sends.refused_before, EXCLUDED.refused_before), updated_at = now()`,
          [request.agentId, request.idempotencyKey, request.accountId, request.walletId, request.issuedBefore],
        );
        return { state: "not_started" };
      }),
  };
}
