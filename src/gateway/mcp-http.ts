import type { FastifyError, FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type pg from "pg";
import { bearerOf } from "../bearer.js";
import { authenticateBearer, type AgentContext } from "./agents.js";
import type { GatewayConfig } from "./config.js";
import type { ExecutorClient } from "./executor-client.js";
import { callHostedTool, HOSTED_TOOLS } from "./mcp-tools.js";
import { listWallets } from "./wallets.js";

export const MCP_VERSIONS = ["2026-07-28", "2025-11-25", "2025-06-18", "2025-03-26"] as const;
const DEFAULT_VERSION = "2025-03-26";

type Rpc = { jsonrpc?: unknown; id?: unknown; method?: unknown; params?: unknown };
export type BearerAuth = (token: string) => Promise<AgentContext | null>;

function rpcError(id: unknown, code: number, message: string) {
  return { jsonrpc: "2.0", id: id ?? null, error: { code, message } };
}

function challenge(config: GatewayConfig, reply: FastifyReply, error?: string) {
  const metadata = new URL("/.well-known/oauth-protected-resource/mcp", config.publicUrl).toString();
  const value = `Bearer resource_metadata="${metadata}"${error ? `, error="${error}"` : ""}`;
  return reply.code(401).header("www-authenticate", value).send({ error: "unauthorized" });
}

export function registerMcpRoutes(app: FastifyInstance, deps: { config: GatewayConfig; pool: pg.Pool; executor: ExecutorClient | null; authenticate?: BearerAuth }): void {
  const { config, pool } = deps;
  const resource = new URL("/mcp", config.publicUrl).toString();
  const authenticate: BearerAuth = deps.authenticate ?? ((token) => authenticateBearer(pool, token, resource));
  const limited = { rateLimit: { max: 120, timeWindow: "1 minute" } };
  const agentIds = new WeakMap<FastifyRequest, string>();
  const perAgent = app.createRateLimit({ max: 120, timeWindow: "1 minute", keyGenerator: (request) => agentIds.get(request) ?? request.ip });

  app.get("/mcp", async (_request, reply) => reply.code(405).header("allow", "POST").send({ error: "method_not_allowed" }));
  app.delete("/mcp", async (_request, reply) => reply.code(405).header("allow", "POST").send({ error: "method_not_allowed" }));

  const parseErrors = new Set(["FST_ERR_CTP_INVALID_JSON_BODY", "FST_ERR_CTP_EMPTY_JSON_BODY"]);
  const errorHandler = (error: FastifyError, request: FastifyRequest, reply: FastifyReply) =>
    parseErrors.has(error.code) ? reply.code(400).send(rpcError(null, -32700, "parse error")) : app.errorHandler(error, request, reply);

  app.post("/mcp", { config: limited, errorHandler }, async (request, reply) => {
    // Streamable HTTP servers must refuse foreign browser origins, which is how DNS rebinding reaches them.
    const origin = request.headers.origin;
    if (origin !== undefined && origin !== config.publicUrl.origin) return reply.code(403).send({ error: "origin_not_allowed" });
    const version = request.headers["mcp-protocol-version"];
    if (typeof version === "string" && !(MCP_VERSIONS as readonly string[]).includes(version)) return reply.code(400).send(rpcError(null, -32600, `unsupported MCP-Protocol-Version ${version}`));
    const token = bearerOf(request);
    if (!token) return challenge(config, reply);
    const agent = await authenticate(token);
    if (!agent) return challenge(config, reply, "invalid_token");
    agentIds.set(request, agent.agentId);
    const limit = await perAgent(request);
    if (!limit.isAllowed && limit.isExceeded) return reply.code(429).header("retry-after", limit.ttlInSeconds).send({ error: "rate_limit" });

    const body = request.body as Rpc | Rpc[] | null;
    if (Array.isArray(body) || typeof body !== "object" || body === null || body.jsonrpc !== "2.0" || typeof body.method !== "string") {
      return reply.code(400).send(rpcError(null, -32600, "expected one JSON-RPC 2.0 request"));
    }
    if (body.id === undefined) return reply.code(202).send();
    const params = typeof body.params === "object" && body.params !== null ? (body.params as Record<string, unknown>) : {};

    if (body.method === "initialize") {
      const asked = typeof params.protocolVersion === "string" ? params.protocolVersion : DEFAULT_VERSION;
      const protocolVersion = (MCP_VERSIONS as readonly string[]).includes(asked) ? asked : MCP_VERSIONS[0];
      return {
        jsonrpc: "2.0",
        id: body.id,
        result: {
          protocolVersion,
          capabilities: { tools: {} },
          serverInfo: { name: "whale", version: "0.1.0" },
          instructions: "One wallet, scoped to this agent. Amounts are integers in the token's smallest unit. Hosted sends are dry-run. Call wallet_status first.",
        },
      };
    }
    if (body.method === "ping") return { jsonrpc: "2.0", id: body.id, result: {} };
    if (body.method === "tools/list") return { jsonrpc: "2.0", id: body.id, result: { tools: HOSTED_TOOLS } };
    if (body.method !== "tools/call") return rpcError(body.id, -32601, "method not found");

    const wallet = (await listWallets(pool, agent.accountId, agent.walletId))[0];
    if (!wallet) return challenge(config, reply, "invalid_token");
    const name = typeof params.name === "string" ? params.name : "";
    try {
      const outcome = await callHostedTool({ pool, agent, wallet, executor: deps.executor }, name, params.arguments ?? {});
      const text = outcome.ok ? JSON.stringify(outcome.value) : outcome.error;
      return { jsonrpc: "2.0", id: body.id, result: { content: [{ type: "text", text }], isError: !outcome.ok } };
    } catch (error) {
      request.log.warn({ err: error }, "hosted tool failed");
      return { jsonrpc: "2.0", id: body.id, result: { content: [{ type: "text", text: "the tool failed. Try again later" }], isError: true } };
    }
  });
}
