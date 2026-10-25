import assert from "node:assert/strict";
import test from "node:test";
import { createHandler, type McpDeps } from "../src/mcp-server.js";

function deps(): McpDeps {
  return {
    executorUrl: "http://executor",
    executorAuthToken: "executor-token",
    fetchImpl: async (url) => new Response(JSON.stringify({ url: String(url), live: false }), { status: 200 }),
  };
}

test("tools/list names the wallet commands", async () => {
  const handle = createHandler(deps());
  const reply = (await handle({ jsonrpc: "2.0", id: 1, method: "tools/list" })) as { result: { tools: { name: string }[] } };
  assert.deepEqual(reply.result.tools.map((tool) => tool.name), ["wallet_status", "quote", "swap", "bridge", "balance", "transfer"]);
});

test("initialize names the whale server", async () => {
  const handle = createHandler(deps());
  const reply = (await handle({ jsonrpc: "2.0", id: 1, method: "initialize" })) as { result: { serverInfo: { name: string } } };
  assert.equal(reply.result.serverInfo.name, "whale");
});

test("wallet_status reads the executor and a quote with no provider skips", async () => {
  const handle = createHandler(deps());
  const status = (await handle({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "wallet_status", arguments: {} } })) as { result: { content: { text: string }[] } };
  assert.match(status.result.content[0].text, /executor/);
  const quote = (await handle({
    jsonrpc: "2.0",
    id: 3,
    method: "tools/call",
    params: {
      name: "quote",
      arguments: {
        sell: { chain: { kind: "evm", chainId: 8453 }, chainKey: "base", address: "0x1", symbol: "USDC", decimals: 6 },
        buy: { chain: { kind: "evm", chainId: 8453 }, chainKey: "base", address: "0x2", symbol: "WETH", decimals: 18 },
        sellAmount: "1",
        taker: null,
        slippageBps: 50,
      },
    },
  })) as { result: { content: { text: string }[] } };
  const value = JSON.parse(quote.result.content[0].text) as { status: string };
  assert.equal(value.status, "skipped");
});
