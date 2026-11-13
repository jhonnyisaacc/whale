import type { FastifyInstance } from "fastify";
import type pg from "pg";
import { gatewaySecrets, type GatewayConfig } from "./config.js";
import { googleKeys, type KeySource } from "./google.js";
import { executorClient, type ExecutorClient } from "./executor-client.js";
import { gatewayApp } from "./http.js";
import { registerMcpRoutes } from "./mcp-http.js";
import { registerAuthRoutes } from "./routes-auth.js";
import { registerEnclaveRoutes } from "./enclave.js";
import { registerOAuthRoutes } from "./routes-oauth.js";
import { delegationFromEnv, turnkeyParentFromEnv, type DelegationConfig, type TurnkeyParent } from "./turnkey.js";
import { registerPasskeyRoutes } from "./routes-passkeys.js";
import { registerPolicyRoutes } from "./routes-policy.js";
import { registerWalletRoutes } from "./routes-wallets.js";
import { registerStatic } from "./static.js";
import type { MetadataFetch } from "./oauth-clients.js";

export type GatewayDeps = {
  config: GatewayConfig;
  pool: pg.Pool;
  fetchImpl?: typeof fetch;
  keys?: KeySource;
  now?: () => number;
  logger?: boolean;
  executor?: ExecutorClient | null;
  fetchDocument?: MetadataFetch;
  turnkey?: TurnkeyParent | null;
  delegation?: DelegationConfig | null;
  webDir?: string;
};

export async function buildGateway(deps: GatewayDeps): Promise<FastifyInstance> {
  const fetchImpl = deps.fetchImpl ?? fetch;
  const now = deps.now ?? Date.now;
  const app = await gatewayApp(deps.config, { logger: deps.logger ?? true, secrets: gatewaySecrets(deps.config) });
  app.get("/health", async () => ({ ok: true }));
  registerAuthRoutes(app, { config: deps.config, pool: deps.pool, fetchImpl, keys: deps.keys ?? googleKeys(fetchImpl, now), now });
  registerWalletRoutes(app, deps.pool);
  registerPasskeyRoutes(app, { config: deps.config, pool: deps.pool, now });
  registerPolicyRoutes(app, { config: deps.config, pool: deps.pool, now });
  registerEnclaveRoutes(app, {
    config: deps.config,
    pool: deps.pool,
    turnkey: deps.turnkey !== undefined ? deps.turnkey : turnkeyParentFromEnv(process.env),
    delegation: deps.delegation !== undefined ? deps.delegation : delegationFromEnv(process.env),
  });
  registerOAuthRoutes(app, { config: deps.config, pool: deps.pool, now, ...(deps.fetchDocument ? { fetchDocument: deps.fetchDocument } : {}) });
  registerMcpRoutes(app, { config: deps.config, pool: deps.pool, executor: deps.executor ?? (deps.config.executor ? executorClient(deps.config.executor, fetchImpl) : null) });
  if (deps.webDir !== undefined) registerStatic(app, deps.webDir);
  return app;
}
