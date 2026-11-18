import assert from "node:assert/strict";
import test from "node:test";
import { oneAtATime } from "../src/gateway/send-ledger.js";

test("a sweep tick that fires while the last sweep still runs starts nothing, and the next tick after it ends starts one", async () => {
  let started = 0;
  let finish: () => void = () => undefined;
  const tick = oneAtATime(() => {
    started += 1;
    return new Promise<void>((resolve, reject) => (finish = started === 1 ? () => reject(new Error("executor timed out")) : resolve));
  });
  tick();
  tick();
  tick();
  assert.equal(started, 1, "overlapping ticks do not start a second sweep");
  finish();
  await new Promise((resolve) => setImmediate(resolve));
  tick();
  assert.equal(started, 2, "a sweep that failed does not block the next one");
});
