import assert from "node:assert/strict";
import test from "node:test";
import { createBridge, createHostedClient, mcpEndpoint } from "../src/hosted-client.js";

const gatewayUrl = "https://whale.example";

test("http is allowed for the IPv6 loopback", () => {
  assert.equal(mcpEndpoint("http://[::1]:8080"), "http://[::1]:8080/mcp");
});

test("an unreachable gateway keeps the network cause", async () => {
  const refused = (async () => Promise.reject(new TypeError("fetch failed", { cause: new Error("connect ECONNREFUSED 127.0.0.1:8080") }))) as typeof fetch;
  const reply = (await createBridge({ gatewayUrl, apiKey: "whale_key", fetchImpl: refused })({ jsonrpc: "2.0", id: 4, method: "ping" } as { id: number })) as { id: number; error: { message: string } };
  assert.equal(reply.id, 4);
  assert.match(reply.error.message, /ECONNREFUSED 127\.0\.0\.1:8080/);
  await assert.rejects(createHostedClient({ gatewayUrl, apiKey: "whale_key", fetchImpl: refused }).walletStatus(), /ECONNREFUSED 127\.0\.0\.1:8080/);
});
