import assert from "node:assert/strict";
import test from "node:test";
import { mcpEndpoint } from "../src/hosted-client.js";

test("http is allowed for the IPv6 loopback", () => {
  assert.equal(mcpEndpoint("http://[::1]:8080"), "http://[::1]:8080/mcp");
});
