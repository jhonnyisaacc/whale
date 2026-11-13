import assert from "node:assert/strict";
import test from "node:test";
import type pg from "pg";
import type { AgentContext } from "../src/gateway/agents.js";
import { gatewayApp } from "../src/gateway/http.js";
import { registerMcpRoutes } from "../src/gateway/mcp-http.js";
import { gatewayConfig } from "./gateway-fixtures.js";

test("/mcp keeps a tenant's seen key when another tenant cycles through many valid keys and floods its IP", async () => {
  const config = gatewayConfig();
  const app = await gatewayApp(config, { logger: false, secrets: [] });
  const authenticate = async (token: string) => {
    const [kind, index] = token.split(":");
    if (kind === "victim") return { agentId: "victim-agent", accountId: "victim-account" } as AgentContext;
    if (kind === "attacker") return { agentId: `attacker-agent-${index}`, accountId: "attacker-account" } as AgentContext;
    return null;
  };
  registerMcpRoutes(app, { config, pool: {} as pg.Pool, executor: null, authenticate });
  const ping = { jsonrpc: "2.0", id: 1, method: "ping" };
  const send = (token: string, remoteAddress: string) => app.inject({ method: "POST", url: "/mcp", remoteAddress, headers: { authorization: `Bearer ${token}` }, payload: ping });
  try {
    assert.equal((await send("victim:0", "34.1.2.3")).statusCode, 200);
    for (let index = 0; index <= 10_000; index += 1) await send(`attacker:${index}`, "203.0.113.50");
    for (let index = 0; index < 120; index += 1) assert.equal((await send(`bad:${index}`, "34.1.2.3")).statusCode, 401);
    assert.equal((await send("bad:fresh", "34.1.2.3")).statusCode, 429);
    assert.equal((await send("victim:0", "34.1.2.3")).statusCode, 200);
  } finally {
    await app.close();
  }
});
