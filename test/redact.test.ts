import assert from "node:assert/strict";
import { inspect } from "node:util";
import test from "node:test";
import { createServer } from "node:http";
import { configSecrets, loadConfig } from "../src/config.js";
import { redactError, redactText, Secret } from "../src/redact.js";
import { evmReadClient, resetRpcClients } from "../src/rpc.js";

const key = "11".repeat(32);

test("secrets stringify, inspect, and error text stay redacted", () => {
  const secret = new Secret(key);
  assert.equal(String(secret), "[redacted]");
  assert.equal(JSON.stringify({ secret }), '{"secret":"[redacted]"}');
  assert.equal(inspect(secret), "[redacted]");
  assert.equal(redactText(`failed with ${key} and a note`, [key]).includes(key), false);
  assert.equal(redactError(new Error(`boom ${key}`), [secret.reveal()]).includes(key), false);
  assert.equal(redactText(`boom 0x${key}`).includes(key), false);
});

const rpcKey = "fake-rpc-key-0123456789";

for (const { name, configured, printed } of [
  { name: "a query key with no path", configured: `https://rpc.example?apikey=${rpcKey}`, printed: `https://rpc.example/?apikey=${rpcKey}` },
  { name: "a mixed-case host", configured: `https://RPC.Example/${rpcKey}`, printed: `https://rpc.example/${rpcKey}` },
  { name: "URL credentials", configured: `https://user:pass@rpc.example/${rpcKey}`, printed: `https://rpc.example/${rpcKey}` },
  { name: "a canonical URL", configured: `https://rpc.example/v2/${rpcKey}`, printed: `https://rpc.example/v2/${rpcKey}` },
]) {
  test(`an RPC URL with ${name} stays redacted in the form viem prints`, () => {
    const secrets = configSecrets(loadConfig({ RPC_URL_8453: configured }));
    assert.equal(redactText(`URL: ${printed}`, secrets).includes(rpcKey), false);
  });
}

test("a shorter configured URL does not expose the key of a longer one", () => {
  const secrets = configSecrets(loadConfig({ RPC_URL_8453: "https://rpc.example", RPC_URLS_8453: `https://rpc.example,https://rpc.example/?apikey=${rpcKey}` }));
  assert.equal(redactText(`URL: https://rpc.example/?apikey=${rpcKey}`, secrets).includes(rpcKey), false);
});

test("a viem error from a failing RPC does not print the key", async () => {
  resetRpcClients();
  const server = createServer((request, response) => {
    request.resume();
    request.on("end", () => {
      response.writeHead(500, { "content-type": "application/json" });
      response.end(JSON.stringify({ jsonrpc: "2.0", id: 1, error: { code: -32000, message: "down" } }));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as { port: number };
  const url = `http://LOCALHOST:${port}?apikey=${rpcKey}`;
  try {
    const failure = await evmReadClient([url]).getChainId().then(
      () => assert.fail("the RPC should fail"),
      (error: unknown) => error,
    );
    assert.equal(redactError(failure, configSecrets(loadConfig({ RPC_URL_8453: url }))).includes(rpcKey), false);
  } finally {
    server.closeAllConnections();
    server.close();
  }
});
