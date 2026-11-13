import assert from "node:assert/strict";
import test from "node:test";
import type { FastifyInstance } from "fastify";
import { createAgent } from "../src/gateway/agents.js";
import { buildGateway } from "../src/gateway/app.js";
import type { ExecutorClient } from "../src/gateway/executor-client.js";
import { createWallet } from "../src/gateway/wallets.js";
import { createBridge, createHostedClient, mcpEndpoint, WhaleToolError } from "../src/hosted-client.js";
import { gatewayConfig, signedInAccount } from "./gateway-fixtures.js";
import { migratedSchema, TEST_DATABASE_URL } from "./pg-schema.js";

const USDC = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";
const WETH = "0x4200000000000000000000000000000000000006";

function viaInject(app: FastifyInstance): typeof fetch {
  return (async (url: string | URL | Request, init?: RequestInit) => {
    const reply = await app.inject({ method: "POST", url: new URL(String(url)).pathname, headers: init?.headers as Record<string, string>, payload: String(init?.body ?? "") });
    return new Response(reply.statusCode === 202 || reply.statusCode === 204 ? null : reply.body, { status: reply.statusCode, headers: Object.entries(reply.headers).map(([name, value]): [string, string] => [name, String(value)]) });
  }) as typeof fetch;
}

test("the gateway URL must be https outside localhost", () => {
  assert.equal(mcpEndpoint("https://whale.example/"), "https://whale.example/mcp");
  assert.equal(mcpEndpoint("http://localhost:8080"), "http://localhost:8080/mcp");
  assert.throws(() => mcpEndpoint("http://whale.example"), /https/);
});

test("the hosted client and the stdio bridge reach the same tools under the same limits", { skip: !TEST_DATABASE_URL }, async () => {
  const { pool, drop } = await migratedSchema();
  const executor: ExecutorClient = { run: async () => ({ kind: "quote", status: "quoted" }) };
  const app = await buildGateway({ config: gatewayConfig(), pool, logger: false, keys: { key: async () => null }, executor, turnkey: null, delegation: null });
  try {
    const { accountId } = await signedInAccount(pool);
    const created = await createWallet(pool, accountId, { label: "bot", level: "enclave" });
    const walletId = "walletId" in created ? created.walletId : "";
    const agent = await createAgent(pool, { accountId, walletId, name: "bot", limits: { chains: ["base"], actions: ["swap"], maxTxUsd: 10, dailyUsd: 20 } });
    if ("refused" in agent) throw new Error(agent.refused);
    const { apiKey } = agent;
    const client = createHostedClient({ gatewayUrl: "https://whale.example", apiKey, fetchImpl: viaInject(app) });

    assert.ok((await client.tools()).some((tool) => tool.name === "quote"));
    assert.equal((await client.walletStatus()).mode, "dry_run");
    assert.deepEqual(await client.quote({ chain: "base", sellToken: USDC, buyToken: WETH, sellAmount: "1000000" }), { kind: "quote", status: "quoted" });
    await assert.rejects(client.quote({ chain: "arbitrum", sellToken: USDC, buyToken: WETH, sellAmount: "1" }), (error: unknown) => error instanceof WhaleToolError && /outside this agent's chains/.test(error.message));
    await assert.rejects(createHostedClient({ gatewayUrl: "https://whale.example", apiKey: "whale_000000000000_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA", fetchImpl: viaInject(app) }).walletStatus(), /refused this API key: invalid_token/);

    const bridge = createBridge({ gatewayUrl: "https://whale.example", apiKey, fetchImpl: viaInject(app) });
    const listed = (await bridge({ jsonrpc: "2.0", id: 1, method: "tools/list" } as { id: number })) as { result: { tools: unknown[] } };
    assert.deepEqual(listed.result.tools, await client.tools());
    assert.equal(await bridge({ jsonrpc: "2.0", method: "notifications/initialized" } as { id?: undefined }), null);
    const down = createBridge({ gatewayUrl: "https://whale.example", apiKey, fetchImpl: (async () => Promise.reject(new Error("connect ECONNREFUSED"))) as typeof fetch });
    assert.deepEqual(await down({ jsonrpc: "2.0", id: 7, method: "ping" } as { id: number }), { jsonrpc: "2.0", id: 7, error: { code: -32000, message: "the Whale gateway is unreachable: connect ECONNREFUSED" } });
  } finally {
    await app.close();
    await drop();
  }
});
