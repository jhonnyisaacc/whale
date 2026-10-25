import assert from "node:assert/strict";
import test from "node:test";
import { ProviderGuard } from "../src/provider-guard.js";

function guard(now: { value: number }): ProviderGuard {
  return new ProviderGuard({ budget: 30, windowMs: 60_000, failureThreshold: 3, openMs: 30_000, now: () => now.value });
}

test("a snapshot starts healthy and records a success", () => {
  const now = { value: 1_000 };
  const item = guard(now);
  item.before("zeroex");
  item.success("zeroex");
  const [row] = item.snapshot();
  assert.equal(row.state, "healthy");
  assert.equal(row.lastSuccessAt, 1_000);
  assert.equal(row.callsInWindow, 1);
});

test("failures degrade, then open the circuit with their class", () => {
  const now = { value: 2_000 };
  const item = guard(now);
  item.failure("lifi", "schema");
  assert.equal(item.snapshot()[0].state, "degraded");
  item.failure("lifi", "schema");
  item.failure("lifi", "http");
  const [row] = item.snapshot();
  assert.equal(row.state, "open");
  assert.equal(row.lastErrorClass, "http");
  assert.equal(row.openUntil, 32_000);
});

test("a success after the circuit clears the failure count", () => {
  const now = { value: 0 };
  const item = guard(now);
  item.failure("jupiter", "network");
  now.value = 40_000;
  item.success("jupiter");
  assert.equal(item.snapshot()[0].state, "healthy");
  assert.equal(item.snapshot()[0].consecutiveFailures, 0);
});
