import type { FastifyInstance } from "fastify";
import { guardFor } from "./aggregators.js";
import type { ExecutionReport, SwapIntent, TxRecord } from "./domain.js";
import { configSecrets, drainTimeoutMs, loadConfig, publicConfig, type AppConfig } from "./config.js";
import { createBalanceCache, holdingFitsChain, type BalanceCache, type BalanceReader } from "./balances.js";
import { resolveTokenDecimals } from "./token-decimals.js";
import { createExecutorState, execute, restoreSpent, type ExecutorDeps, type ExecutorState } from "./executor.js";
import { chainReader } from "./executor-server/chain-reader.js";
import { closeWithdrawPools } from "./withdraw-journal.js";
import { latencyLog } from "./latency.js";
import { anyTokenMatches, bearerOf, buildApp, mutatingLimit, shutdown } from "./http.js";
import { fetchHyperliquidMid, quoteHop } from "./clients.js";
import { redactError, zeroLoadedSecrets } from "./redact.js";
import { broadcastRoute, lookupAgedTx } from "./broadcast.js";
import { assertApprovedAgent, fetchSzDecimals } from "./hyperliquid.js";
import { createLogger } from "./log.js";
import { assertBoot, loadManagedSigner, type TransactionSigner } from "./managed-signer.js";
import { seedApprovals } from "./approvals.js";
import {
  acquireExecutorLock,
  backfillStrategyIds,
  closeSpendPools,
  commitSpend,
  readKillSwitch,
  reconcileReserved,
  recordSpend,
  recordTx,
  releaseSpend,
  spendDay,
  spentOnDay,
  type SpendScope,
} from "./spend.js";
import { planRebalance } from "./rebalance.js";
import { screenToken } from "./screening.js";
import { supportTierFor } from "./support.js";
import { evmReadClient, firstOk, solanaConnection } from "./rpc.js";
import { coingeckoLoader, createPriceCache, pricedHoldings, type PriceOf } from "./prices.js";
import { holdingsSchema, intentSchema, rebalanceSchema } from "./schemas.js";

async function notify(config: AppConfig, report: ExecutionReport, secrets: readonly string[]): Promise<void> {
  if (!config.notifierUrl) return;
  await fetch(config.notifierUrl, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      idempotencyKey: report.idempotencyKey,
      mode: report.mode,
      decision: report.decision,
      reason: report.reason,
      venue: report.venue,
      route: report.route,
      latency: latencyLog(report.latency),
    }),
  }).catch((error: unknown) => {
    console.log(JSON.stringify({ notifier: redactError(error, secrets) }));
  });
}

export function txJournal(config: AppConfig, log: (entry: { idempotencyKey: string | null; tx: TxRecord }) => void) {
  return async (idempotencyKey: string | null, tx: TxRecord): Promise<void> => {
    log({ idempotencyKey, tx });
    if (config.databaseUrl) await recordTx(config.databaseUrl, idempotencyKey, tx);
  };
}

function deps(
  config: AppConfig,
  signer: TransactionSigner | null,
  secrets: readonly string[],
  journal: ReturnType<typeof txJournal>,
  priceOf: PriceOf,
  balances: BalanceCache | null,
  opts: { state?: ExecutorState; spendScope?: SpendScope; databaseUrl?: string | null } = {},
): ExecutorDeps {
  const databaseUrl = opts.databaseUrl !== undefined ? opts.databaseUrl : config.databaseUrl;
  const spent = (tx: TxRecord) => balances?.invalidate(tx.chainKey);
  return {
    config,
    priceOf,
    mode: config.live ? "live" : "dry_run",
    spentTodayUsd: 0,
    quoteHop: (hop, context) => {
      const reference =
        context.priceUsd !== null && context.decimals !== null
          ? { spentUsd: context.spentUsd, priceUsd: context.priceUsd, decimals: context.decimals }
          : null;
      const taker = hop.chain.kind === "evm" ? signer?.evmAddress() : hop.chain.kind === "solana" ? signer?.solanaAddress() : null;
      return quoteHop(config, { ...hop, taker: taker ?? null }, reference);
    },
    markPrice: (coin) => fetchHyperliquidMid(config.hyperliquidUrl, coin),
    send: (request, onTx) => broadcastRoute(config, signer, request, config.maxSlippageBps / 100, fetch, secrets, { onTx }),
    recordTx: async (key, tx) => {
      spent(tx);
      await journal(key, tx);
    },
    szDecimals: (market) => fetchSzDecimals(config.hyperliquidUrl, market),
    state: opts.state ?? createExecutorState(),
    spendScope: opts.spendScope,
    recordSpend:
      config.live && databaseUrl
        ? (key, usd, scope) => recordSpend(databaseUrl, key, usd, spendDay(new Date(), config.spendTimezone), config.dailyUsdCap, scope)
        : undefined,
    killSwitchEnabled: async () => {
      if (config.killSwitch) return true;
      if (!databaseUrl) return false;
      return readKillSwitch(databaseUrl);
    },
    commitSpend: config.live && databaseUrl ? (key) => commitSpend(databaseUrl, key) : undefined,
    releaseSpend: config.live && databaseUrl ? (key) => releaseSpend(databaseUrl, key) : undefined,
    screenToken: config.screening ? (token) => screenToken(config, token) : undefined,
    supportTierFor: (chainKey) => supportTierFor(config.supportByChain, chainKey),
    readTokenDecimals: (token) => resolveTokenDecimals(token.chainKey, token.address, token.chain, config.rpcByChainKey[token.chainKey]),
    readBalance: balances?.read ?? null,
  };
}

export type ExecutorInstance = {
  config: AppConfig;
  state: ExecutorState;
  deps: ExecutorDeps;
  execute: (intent: SwapIntent, overrides?: Partial<ExecutorDeps>) => Promise<ExecutionReport>;
};

export function createExecutor(
  config: AppConfig,
  signer: TransactionSigner | null,
  db: string | null,
  opts: { priceOf?: PriceOf; balances?: BalanceCache | null; secrets?: readonly string[] } = {},
): ExecutorInstance {
  const state = createExecutorState();
  const secrets = opts.secrets ?? configSecrets(config).filter((item) => item.length >= 8);
  const runtime = deps(config, signer, secrets, txJournal({ ...config, databaseUrl: db }, () => undefined), opts.priceOf ?? (() => null), opts.balances ?? null, { state, databaseUrl: db });
  return {
    config,
    state,
    deps: runtime,
    execute: (intent, overrides = {}) => execute(intent, { ...runtime, ...overrides, state }),
  };
}

export async function createExecutorApp(
  config: AppConfig,
  runtime: ExecutorDeps,
  signer: TransactionSigner | null,
  secrets: readonly string[],
  holdings: SwapIntent["holdings"],
  logger = false,
  fetchImpl: typeof fetch = fetch,
): Promise<FastifyInstance> {
  const app = await buildApp({ authTokens: config.executorAuthTokens, secrets, logger });
  const guard = { preHandler: app.auth([app.verifyBearer]), config: mutatingLimit };
  app.get("/health", async () => ({ ok: true }));
  app.get("/status", { preHandler: app.auth([app.verifyBearer]) }, async () => ({ ok: true, service: "executor", ...publicConfig(config) }));
  app.get("/provider-health", { preHandler: app.auth([app.verifyBearer]) }, async () => ({ providers: guardFor(config).snapshot() }));
  app.post("/execute", { config: mutatingLimit }, async (request, reply) => {
    const presented = bearerOf(request);
    if (!anyTokenMatches(presented, config.executorAuthTokens)) return reply.code(401).send({ error: "unauthorized" });
    const parsed = intentSchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: "invalid request" });
    const report = await app.drain.track(() => execute(parsed.data, config.live ? runtime : { ...runtime, mode: "dry_run" }));
    console.log(JSON.stringify({ report: { ...report, latency: latencyLog(report.latency) } }));
    await notify(config, report, secrets);
    return report;
  });
  void holdings;
  void fetchImpl;
  app.post("/rebalance", guard, async (request, reply) => {
    const parsed = rebalanceSchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: "invalid request" });
    return planRebalance({
      quotes: parsed.data.quotes,
      maxBridgeUsd: config.maxBridgeUsd,
      maxFeeBps: config.maxBridgeFeeBps,
      spentBridgeUsd: parsed.data.spentBridgeUsd,
      dailyBridgeCap: config.dailyBridgeUsdCap,
      ownAddresses: parsed.data.ownAddresses,
      allowlist: config.withdrawAllowlist,
    });
  });
  return app;
}

async function main(): Promise<void> {
  const config = loadConfig();
  assertBoot(config, "executor");
  seedApprovals(config.approvalSeed);
  const { signer, secrets: signerSecrets } = loadManagedSigner(process.env, config);
  if (config.live && !signer) throw new Error("live mode requires Turnkey");
  if (config.live && !config.databaseUrl) throw new Error("live mode requires DATABASE_URL so the daily cap survives restart");
  if (config.live) {
    const agent = process.env.TURNKEY_HYPERLIQUID_ADDRESS;
    if (agent) {
      if (!config.hyperliquidAccount) throw new Error("live mode requires HYPERLIQUID_ACCOUNT_ADDRESS to verify the agent");
      await assertApprovedAgent(config.hyperliquidUrl, config.hyperliquidAccount, agent, fetch);
    }
  }
  const holdingsParsed = holdingsSchema.safeParse(JSON.parse(process.env.WALLET_HOLDINGS_JSON ?? "[]"));
  if (!holdingsParsed.success) throw new Error("WALLET_HOLDINGS_JSON is invalid");
  const secrets = [...signerSecrets, ...configSecrets(config)].filter((item) => item.length >= 8);
  const logger = createLogger(secrets);
  const releaseLock = config.databaseUrl ? await acquireExecutorLock(config.databaseUrl, () => process.exit(1)) : null;
  const state = createExecutorState();
  const reconcile = async () => {
    if (!config.databaseUrl) return;
    await reconcileReserved(config.databaseUrl, config.reconcileAfterMinutes, (tx) => lookupAgedTx(config, tx), (entry) =>
      logger.info({ reconcile: entry }, "reconciled reserved spend"),
    );
  };
  if (config.databaseUrl) {
    await backfillStrategyIds(config.databaseUrl, Object.keys(config.strategies));
    await reconcile();
    const day = spendDay(new Date(), config.spendTimezone);
    restoreSpent(state, await spentOnDay(config.databaseUrl, day), day);
  }
  const prices = createPriceCache(coingeckoLoader(config, pricedHoldings(holdingsParsed.data, config.enabledChainKeys)), config.priceMaxAgeMs);
  const refreshPrices = () => prices.refresh().catch((error: unknown) => logger.warn({ err: error }, "price refresh failed"));
  await refreshPrices();
  const priceTimer = setInterval(refreshPrices, config.priceRefreshMs);
  priceTimer.unref();
  const reconcileTimer = config.databaseUrl ? setInterval(() => void reconcile().catch((error: unknown) => logger.warn({ err: error }, "reconcile failed")), config.reconcileIntervalMs) : null;
  reconcileTimer?.unref();
  const balances = config.live ? createBalanceCache(chainReader(config, signer), config.balanceCacheMs) : null;
  const runtime = deps(config, signer, secrets, txJournal(config, (entry) => logger.info(entry, "signed tx")), (holding) => prices.priceOf(holding), balances, { state });
  const app = await createExecutorApp(config, runtime, signer, secrets, holdingsParsed.data, true);
  let stopping = false;
  const stop = () => {
    if (stopping) return;
    stopping = true;
    void shutdown(app, Math.min(drainTimeoutMs(config), 20_000), async () => {
      clearInterval(priceTimer);
      if (reconcileTimer) clearInterval(reconcileTimer);
      zeroLoadedSecrets();
      await closeSpendPools();
      await closeWithdrawPools();
      await releaseLock?.();
    }).then((idle) => process.exit(idle ? 0 : 1));
  };
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
  await app.listen({ port: config.port, host: "0.0.0.0" });
  console.log(JSON.stringify({ service: "executor", port: config.port, ...publicConfig(config) }));
}

const entry = process.argv[1] ?? "";
if (entry.endsWith("executor-server.js")) {
  main().catch((error: unknown) => {
    console.error(JSON.stringify({ error: redactError(error) }));
    process.exit(1);
  });
}
