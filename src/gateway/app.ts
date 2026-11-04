import type { FastifyInstance } from "fastify";
import type pg from "pg";
import { gatewaySecrets, type GatewayConfig } from "./config.js";
import { googleKeys, type KeySource } from "./google.js";
import { gatewayApp } from "./http.js";
import { registerAuthRoutes } from "./routes-auth.js";

export type GatewayDeps = {
  config: GatewayConfig;
  pool: pg.Pool;
  fetchImpl?: typeof fetch;
  keys?: KeySource;
  now?: () => number;
  logger?: boolean;
};

export async function buildGateway(deps: GatewayDeps): Promise<FastifyInstance> {
  const fetchImpl = deps.fetchImpl ?? fetch;
  const now = deps.now ?? Date.now;
  const app = await gatewayApp(deps.config, { logger: deps.logger ?? true, secrets: gatewaySecrets(deps.config) });
  app.get("/health", async () => ({ ok: true }));
  registerAuthRoutes(app, { config: deps.config, pool: deps.pool, fetchImpl, keys: deps.keys ?? googleKeys(fetchImpl, now), now });
  return app;
}
