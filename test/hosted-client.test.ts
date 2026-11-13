import assert from "node:assert/strict";
import test from "node:test";
import { createBridge, createHostedClient, mcpEndpoint } from "../src/hosted-client.js";

const gatewayUrl = "https://whale.example";
const answering = (status: number, body: unknown, headers: Record<string, string> = {}) =>
  (async () => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } })) as typeof fetch;

test("http is allowed for the IPv6 loopback", () => {
  assert.equal(mcpEndpoint("http://[::1]:8080"), "http://[::1]:8080/mcp");
});

test("an unreachable gateway keeps the network cause", async () => {
  const refused = (async () => Promise.reject(new TypeError("fetch failed", { cause: new Error("connect ECONNREFUSED 127.0.0.1:8080") }))) as typeof fetch;
  const reply = (await createBridge({ gatewayUrl, apiKey: "whale_key", fetchImpl: refused })({ jsonrpc: "2.0", id: 4, method: "ping" })) as { id: number; error: { message: string } };
  assert.equal(reply.id, 4);
  assert.match(reply.error.message, /ECONNREFUSED 127\.0\.0\.1:8080/);
  await assert.rejects(createHostedClient({ gatewayUrl, apiKey: "whale_key", fetchImpl: refused }).walletStatus(), /ECONNREFUSED 127\.0\.0\.1:8080/);
});

test("the gateway's refusal reason reaches the caller", async () => {
  const unsupported = answering(400, { jsonrpc: "2.0", id: null, error: { code: -32600, message: "unsupported MCP-Protocol-Version 1999-01-01" } });
  assert.deepEqual(await createBridge({ gatewayUrl, apiKey: "whale_key", fetchImpl: unsupported })({ jsonrpc: "2.0", id: 5, method: "ping" }), {
    jsonrpc: "2.0",
    id: 5,
    error: { code: -32600, message: "unsupported MCP-Protocol-Version 1999-01-01" },
  });
  await assert.rejects(createHostedClient({ gatewayUrl, apiKey: "whale_key", fetchImpl: unsupported }).walletStatus(), /unsupported MCP-Protocol-Version 1999-01-01/);
  const revoked = answering(401, { error: "unauthorized" }, { "www-authenticate": 'Bearer resource_metadata="https://whale.example/.well-known/oauth-protected-resource/mcp", error="invalid_token"' });
  const reply = (await createBridge({ gatewayUrl, apiKey: "whale_key", fetchImpl: revoked })({ jsonrpc: "2.0", id: 6, method: "ping" })) as { error: { message: string } };
  assert.match(reply.error.message, /refused this API key: invalid_token/);
});

test("a key that cannot be a header value is refused before any request, without echoing it", async () => {
  let called = false;
  const fetchImpl = (async () => ((called = true), new Response("{}"))) as typeof fetch;
  for (const apiKey of ["whale_000000000000_SECRET\nx", "whale_000000000000_SECRET\rx", "whale_000000000000 SECRET", ""]) {
    for (const make of [() => createHostedClient({ gatewayUrl, apiKey, fetchImpl }), () => createBridge({ gatewayUrl, apiKey, fetchImpl })]) {
      assert.throws(make, (error: Error) => error.message === "the API key must be one line of printable characters with no spaces");
    }
  }
  assert.equal(called, false);
});

test("a gateway URL that does not parse is refused without echoing it", () => {
  const secret = "whale_aaaaaaaaaaaa_SECRETSECRET";
  for (const make of [() => mcpEndpoint(secret), () => createHostedClient({ gatewayUrl: secret, apiKey: "https://whale.example" }), () => createBridge({ gatewayUrl: secret, apiKey: "https://whale.example" })]) {
    assert.throws(make, (error: Error) => error instanceof TypeError && error.message === "the gateway URL is not a URL" && !JSON.stringify(Object.entries(error)).includes("SECRET") && !String(error.cause ?? "").includes("SECRET"));
  }
});
