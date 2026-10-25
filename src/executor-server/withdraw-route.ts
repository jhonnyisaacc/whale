import type { FastifyInstance, RouteShorthandOptions } from "fastify";
import "../http.js";
import { recoverToken, withdrawNative } from "../broadcast.js";
import type { AppConfig } from "../config.js";
import type { TxRecord } from "../domain.js";
import { BroadcastError, decideWithdraw, type ExecutorDeps } from "../executor.js";
import { tokenMatches, type TransactionSigner } from "../managed-signer.js";
import { withdrawSchema } from "../schemas.js";
import { spendDay } from "../spend.js";
import { commitWithdraw, createMemoryWithdrawJournal, releaseWithdraw, reserveWithdraw, withdrawJournalAction } from "../withdraw-journal.js";

export function registerWithdraw(app: FastifyInstance, guard: RouteShorthandOptions, input: { config: AppConfig; runtime: ExecutorDeps; signer: TransactionSigner | null; secrets: readonly string[] }): void {
  const { config, runtime, signer, secrets } = input;
  const memoryWithdraw = createMemoryWithdrawJournal();
  app.post("/withdraw", guard, async (request, reply) => {
    const header = request.headers["x-admin-token"];
    const presented = typeof header === "string" ? header : "";
    const parsed = withdrawSchema.safeParse(request.body);
    if (!parsed.success) {
      const adminOk = Boolean(config.adminToken) && tokenMatches(presented, config.adminToken ?? "");
      if (!adminOk) return reply.code(401).send({ error: "unauthorized" });
      return reply.code(400).send({ error: "invalid request" });
    }
    const decision = decideWithdraw({
      adminOk: Boolean(config.adminToken) && tokenMatches(presented, config.adminToken ?? ""),
      enabled: config.withdrawEnabled,
      amount: parsed.data.amount,
      cap: config.maxWithdrawAmount,
      destinationAllowed: config.withdrawAllowlist.some((item) => item.toLowerCase() === parsed.data.to.toLowerCase()),
      mint: parsed.data.mint,
      recoveryAllowlist: config.tokenRecoveryAllowlist,
      live: config.live,
      killSwitch: config.killSwitch,
      signerReady: signer !== null,
      chainKey: parsed.data.chainKey,
      decimals: parsed.data.decimals,
    });
    if (decision.error) return reply.code(decision.http).send({ error: decision.error });
    if (decision.decision === "would_send") return { decision: "would_send", to: parsed.data.to, mode: config.live ? "live" : "dry_run" };
    if (!parsed.data.idempotencyKey) return reply.code(409).send({ error: "live withdraw needs an idempotencyKey" });
    if (!signer || !parsed.data.chainKey || parsed.data.amount === undefined) return reply.code(409).send({ error: "live withdraw needs a signer, chainKey, and amount" });
    const withdrawKey = `withdraw:${parsed.data.idempotencyKey}`;
    const mintScope = parsed.data.mint ? (parsed.data.mint.startsWith("0x") ? parsed.data.mint.toLowerCase() : parsed.data.mint) : "native";
    const withdrawScope = `${parsed.data.chainKey}:${mintScope}`;
    const withdrawDay = spendDay(new Date(), config.spendTimezone);
    const reserved = config.databaseUrl
      ? await reserveWithdraw(config.databaseUrl, withdrawKey, withdrawScope, parsed.data.amount, withdrawDay, config.maxWithdrawDailyAmount)
      : await memoryWithdraw.reserve(withdrawKey, withdrawScope, parsed.data.amount, withdrawDay, config.maxWithdrawDailyAmount);
    if (reserved === "exists") return reply.code(409).send({ error: "duplicate withdraw" });
    if (reserved === "cap") return reply.code(403).send({ error: "withdraw exceeds the daily cap" });
    const commitKey = async () => {
      if (config.databaseUrl) await commitWithdraw(config.databaseUrl, withdrawKey);
      else await memoryWithdraw.commit(withdrawKey);
    };
    const releaseKey = async () => {
      if (config.databaseUrl) await releaseWithdraw(config.databaseUrl, withdrawKey).catch(() => undefined);
      else await memoryWithdraw.release(withdrawKey);
    };
    const onTx = async (tx: TxRecord) => runtime.recordTx?.(null, tx);
    let tx: TxRecord;
    try {
      if (!parsed.data.mint) {
        tx = await app.drain.track(() => withdrawNative({ config, signer, chainKey: parsed.data.chainKey as string, to: parsed.data.to, amount: parsed.data.amount as number, secrets, onTx }));
      } else {
        if (parsed.data.decimals === undefined) {
          await releaseKey();
          return reply.code(409).send({ error: "token withdraw needs decimals" });
        }
        const recovery = { chainKey: parsed.data.chainKey, amount: parsed.data.amount, mint: parsed.data.mint, decimals: parsed.data.decimals };
        tx = await app.drain.track(() =>
          recoverToken({
            config,
            signer,
            chainKey: recovery.chainKey,
            to: parsed.data.to,
            amount: recovery.amount,
            mint: recovery.mint,
            decimals: recovery.decimals,
            secrets,
            onTx,
          }),
        );
      }
    } catch (error) {
      const ambiguous = error instanceof BroadcastError && error.broadcast;
      if (!ambiguous) await releaseKey();
      throw error;
    }
    const action = withdrawJournalAction(tx.outcome);
    if (action === "commit") await commitKey();
    if (action === "release") {
      await releaseKey();
      return reply.code(409).send({ error: `withdraw ${tx.outcome}`, tx });
    }
    return { decision: "sent", to: parsed.data.to, chainKey: parsed.data.chainKey, mint: parsed.data.mint, tx };
  });
}
