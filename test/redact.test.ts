import assert from "node:assert/strict";
import { inspect } from "node:util";
import test from "node:test";
import { redactError, redactText, Secret } from "../src/redact.js";

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
