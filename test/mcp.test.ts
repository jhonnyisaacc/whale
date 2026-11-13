import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
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

const SERVER = fileURLToPath(new URL("../src/mcp-server.js", import.meta.url));

function runServer(input: string, extra: Record<string, string> = {}) {
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => key !== "WHALE_GATEWAY_URL" && key !== "WHALE_API_KEY"));
  return spawnSync(process.execPath, [SERVER], { input, env: { ...env, ...extra }, encoding: "utf8", timeout: 10_000 });
}

test("the stdio server refuses a gateway URL without an API key, and a key without a URL", () => {
  for (const extra of <Record<string, string>[]>[{ WHALE_GATEWAY_URL: "https://whale.example", WHALE_API_KEY: "" }, { WHALE_API_KEY: "whale_key" }]) {
    const result = runServer("", extra);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /set both WHALE_GATEWAY_URL and WHALE_API_KEY/);
  }
});

test("swapped gateway settings exit with a fixed message that never prints the key", () => {
  const secret = "whale_000000000000_SECRETSECRETSECRETSECRETSECRETSECRETSECRETSEC";
  for (const extra of <Record<string, string>[]>[{ WHALE_GATEWAY_URL: secret, WHALE_API_KEY: "https://whale.example" }, { WHALE_GATEWAY_URL: "http://whale.example", WHALE_API_KEY: secret }]) {
    const result = runServer("", extra);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /^whale: WHALE_GATEWAY_URL /);
    assert.equal(result.stderr.includes("SECRET"), false, result.stderr);
    assert.equal(result.stderr.split("\n").filter(Boolean).length, 1, result.stderr);
  }
});

test("an API key that is not a valid header value exits with a fixed message that never prints it", () => {
  for (const key of ["whale_000000000000_SECRET\nx", "whale_000000000000_SECRET\rx", "whale_000000000000 SECRET"]) {
    const result = runServer("", { WHALE_GATEWAY_URL: "https://whale.example", WHALE_API_KEY: key });
    assert.equal(result.status, 1);
    assert.equal(result.stderr, "whale: WHALE_API_KEY must be one line of printable characters with no spaces\n");
    assert.equal(result.stdout, "");
  }
});

test("a malformed stdin line gets a JSON-RPC error and the server keeps serving", () => {
  const result = runServer(`not json\nnull\n${JSON.stringify({ jsonrpc: "2.0", id: 2, method: "ping" })}\n`);
  assert.equal(result.status, 0);
  assert.deepEqual(result.stdout.trim().split("\n").map((line) => JSON.parse(line) as unknown), [
    { jsonrpc: "2.0", id: null, error: { code: -32700, message: "parse error" } },
    { jsonrpc: "2.0", id: null, error: { code: -32600, message: "invalid request" } },
    { jsonrpc: "2.0", id: 2, result: {} },
  ]);
});
