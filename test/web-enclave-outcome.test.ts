import assert from "node:assert/strict";
import test from "node:test";
import { enclaveOutcome, pollDelayMs } from "../web/src/enclave-outcome.js";

test("enclave setup reads each gateway answer from options and create", () => {
  assert.equal(enclaveOutcome(409, "enclave_exists"), "created");
  assert.equal(enclaveOutcome(409, "enclave_in_progress"), "in_progress");
  assert.equal(enclaveOutcome(409, "enclave_conflict"), "conflict");
  assert.equal(enclaveOutcome(502, "turnkey_refused"), "attempt_dropped");
  assert.equal(enclaveOutcome(503, "turnkey_unreachable"), "attempt_dropped");
  assert.equal(enclaveOutcome(428, "step_up_required"), "step_up");
  assert.equal(enclaveOutcome(429, "rate_limit"), "busy");
  assert.equal(enclaveOutcome(503, "enclave_unavailable"), "failed");
  assert.equal(enclaveOutcome(403, "step_up_failed"), "failed");
  assert.equal(enclaveOutcome(400, "passkey_rejected"), "failed");
});

test("polling options stays under the route's limit of ten calls a minute", () => {
  let elapsed = 0;
  let calls = 1;
  for (let attempt = 0; elapsed + pollDelayMs(attempt) < 60_000; attempt += 1) {
    elapsed += pollDelayMs(attempt);
    calls += 1;
  }
  assert.ok(calls <= 9, `${calls} options calls in the first minute`);
  assert.ok(pollDelayMs(0) >= 2_000 && pollDelayMs(50) <= 10_000, "first poll after 2 s, never more than 10 s apart");
});
