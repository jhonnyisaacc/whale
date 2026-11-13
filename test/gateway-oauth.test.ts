import assert from "node:assert/strict";
import test from "node:test";
import { createServer, request } from "node:http";
import type { AddressInfo } from "node:net";
import { fetchMetadataDocument, metadataUrlAllowed, publicAddress, redirectUriAllowed } from "../src/gateway/oauth-clients.js";
import { withParams } from "../src/gateway/oauth-store.js";

test("redirect URIs allow https, loopback http, and app schemes only", () => {
  for (const good of ["https://client.example/cb", "http://127.0.0.1:33418/callback", "http://localhost:8976/oauth", "http://[::1]:9000/cb", "cursor://anysphere.cursor-mcp/oauth/callback", "com.example.app:/cb"]) {
    assert.equal(redirectUriAllowed(good), true, good);
  }
  for (const bad of ["http://evil.example/cb", "javascript:alert(1)", "data:text/html,x", "file:///etc/passwd", "https://client.example/cb#frag", "https://user:pw@client.example/cb", "not a url", `https://x.example/${"a".repeat(600)}`]) {
    assert.equal(redirectUriAllowed(bad), false, bad);
  }
});

test("client metadata URLs must be https with a path on a named host, and resolve only to public addresses", () => {
  assert.equal(metadataUrlAllowed("https://client.example/oauth/metadata.json"), true);
  for (const bad of ["http://client.example/meta.json", "https://client.example", "https://client.example/", "https://127.0.0.1/meta.json", "https://[::1]/meta.json", "https://client.example:8443/meta.json"]) {
    assert.equal(metadataUrlAllowed(bad), false, bad);
  }
  for (const address of ["8.8.8.8", "1.1.1.1", "2606:4700:4700::1111"]) assert.equal(publicAddress(address), true, address);
  for (const address of ["127.0.0.1", "10.1.2.3", "172.20.0.1", "192.168.1.1", "169.254.169.254", "100.64.0.1", "0.0.0.0", "::1", "fd00::1", "fe80::1", "::ffff:127.0.0.1", "224.0.0.1", "not-an-ip"]) {
    assert.equal(publicAddress(address), false, address);
  }
});

test("redirect parameters keep the client's own query", () => {
  assert.equal(withParams("http://127.0.0.1:1/cb?x=1", { code: "c", state: null, iss: "https://whale.example" }), "http://127.0.0.1:1/cb?x=1&code=c&iss=https%3A%2F%2Fwhale.example");
});

test("a metadata host that drips bytes is cut off at the total deadline", async () => {
  const server = createServer((_request, response) => {
    response.writeHead(200, { "content-type": "application/json" });
    const drip = setInterval(() => response.write(" "), 20);
    response.on("close", () => clearInterval(drip));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  const started = Date.now();
  try {
    const outcome = await Promise.race([
      fetchMetadataDocument(`http://127.0.0.1:${port}/meta.json`, { deadlineMs: 300, send: request }).then(() => "resolved", (error: Error) => error.message),
      new Promise((resolve) => setTimeout(() => resolve("still open after 2 s"), 2_000)),
    ]);
    assert.equal(outcome, "client metadata timed out");
    assert.ok(Date.now() - started < 1_000, `took ${Date.now() - started} ms`);
  } finally {
    server.closeAllConnections();
    server.close();
  }
});

test("a metadata document over the size cap is refused", async () => {
  const server = createServer((_request, response) => {
    response.writeHead(200, { "content-type": "application/json" });
    response.end(`{"client_id":"x"}${" ".repeat(128 * 1024)}`);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  try {
    await assert.rejects(fetchMetadataDocument(`http://127.0.0.1:${port}/meta.json`, { send: request }), /client metadata response is too large/);
  } finally {
    server.closeAllConnections();
    server.close();
  }
});
