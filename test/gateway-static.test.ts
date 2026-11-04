import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import Fastify from "fastify";
import { PAGE_CSP, registerStatic } from "../src/gateway/static.js";

function site(): string {
  const dir = mkdtempSync(path.join(tmpdir(), "whale-web-"));
  mkdirSync(path.join(dir, "assets"));
  writeFileSync(path.join(dir, "index.html"), "<!doctype html><div id=root></div>");
  writeFileSync(path.join(dir, "assets", "index-abc.js"), "console.log(1)");
  writeFileSync(path.join(dir, "secret.txt"), "nope");
  return dir;
}

test("the dashboard serves its page under a strict CSP and only hashed assets beside it", async () => {
  const app = Fastify();
  assert.equal(registerStatic(app, site()), true);
  app.get("/api/real", async () => ({ ok: true }));
  try {
    const page = await app.inject({ method: "GET", url: "/wallets/123?x=1" });
    assert.equal(page.statusCode, 200);
    assert.equal(page.headers["content-security-policy"], PAGE_CSP);
    assert.match(PAGE_CSP, /script-src 'self'/);
    assert.doesNotMatch(PAGE_CSP, /unsafe/);
    assert.equal(page.headers["cache-control"], "no-cache");
    const asset = await app.inject({ method: "GET", url: "/assets/index-abc.js" });
    assert.equal(asset.headers["content-type"], "text/javascript; charset=utf-8");
    assert.match(String(asset.headers["cache-control"]), /immutable/);
    for (const url of ["/assets/..%2Fsecret.txt", "/assets/missing.js", "/secret.txt", "/api/unknown", "/oauth/nothing", "/mcp/x"]) {
      const reply = await app.inject({ method: "GET", url });
      assert.equal(reply.statusCode, 404, url);
      assert.notEqual(reply.headers["content-type"], "text/html; charset=utf-8", url);
    }
    assert.equal((await app.inject({ method: "POST", url: "/wallets", payload: {} })).statusCode, 404);
    assert.equal(registerStatic(Fastify(), path.join(tmpdir(), "no-such-web-dir")), false);
  } finally {
    await app.close();
  }
});
