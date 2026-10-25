import assert from "node:assert/strict";
import test from "node:test";
import { buildApp } from "../src/http.js";

test("the app builds with the logger enabled, as the servers boot it", async () => {
  const app = await buildApp({ authTokens: ["token-123456"], logger: true });
  const reply = await app.inject({ method: "GET", url: "/health" });
  assert.equal(reply.statusCode, 404);
  await app.close();
});
