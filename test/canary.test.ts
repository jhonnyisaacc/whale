import assert from "node:assert/strict";
import test from "node:test";
import { loadConfig } from "../src/config.js";
import { buildCanaryCases, runCanary } from "../src/canary.js";
import { resetProviderGuards } from "../src/aggregators.js";

test("canary cases cover enabled chains with quote assets and never hypercore", () => {
  resetProviderGuards();
  const config = loadConfig({ EXECUTOR_AUTH_TOKEN: "executor-token-123456", RESOLVER_AUTH_TOKEN: "resolver-token-123456" });
  const cases = buildCanaryCases(config);
  assert.ok(cases.some((item) => item.chainKey === "base"));
  assert.ok(cases.some((item) => item.chainKey === "solana"));
  assert.equal(cases.some((item) => item.chainKey === "hypercore"), false);
});

test("a dead provider set fails the case instead of passing silently", async () => {
  resetProviderGuards();
  const config = loadConfig({ EXECUTOR_AUTH_TOKEN: "executor-token-123456", RESOLVER_AUTH_TOKEN: "resolver-token-123456", ENABLED_CHAINS: "base" });
  const report = await runCanary(config, async () => { throw new Error("offline"); });
  assert.equal(report.live, false);
  assert.ok(report.results.length >= 1);
  assert.ok(report.results.every((result) => result.status === "fail"));
});

test("the canary refuses live mode", async () => {
  resetProviderGuards();
  const config = loadConfig({ EXECUTOR_AUTH_TOKEN: "executor-token-123456", RESOLVER_AUTH_TOKEN: "resolver-token-123456", WHALE_BROADCAST: "true", DATABASE_URL: "postgres://localhost/db", TURNKEY_ORGANIZATION_ID: "org", TURNKEY_API_PUBLIC_KEY: "pub", TURNKEY_API_PRIVATE_KEY: "priv" });
  await assert.rejects(() => runCanary(config, async () => { throw new Error("offline"); }), /live mode/);
});
