import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { bridgeSpend } from "../src/bridge/spend.js";
import { closeSpendPools, recordSpend } from "../src/spend.js";

const caps = { dailyUsdCap: 100, dailyBridgeUsdCap: 10, spendTimezone: "UTC" };
const freshDay = () => new Date(Date.UTC(2032 + Math.floor(Math.random() * 60), Math.floor(Math.random() * 12), 1 + Math.floor(Math.random() * 28), 12));

for (const [name, databaseUrl] of [["memory", null], ["Postgres", process.env.TEST_DATABASE_URL ?? null]] as const) {
  test(`the ${name} bridge reservation holds both the bridge cap and the shared daily cap, and a release frees it`, { skip: name === "Postgres" && !databaseUrl }, async () => {
    const run = randomUUID();
    const day = freshDay();
    const spend = bridgeSpend({ ...caps, databaseUrl }, () => day);
    assert.equal(await spend.reserve(`bridge:${run}:a`, 6), "reserved");
    assert.equal(await spend.reserve(`bridge:${run}:a`, 6), "exists");
    assert.equal(await spend.reserve(`bridge:${run}:b`, 6), "cap");
    await spend.release(`bridge:${run}:a`);
    assert.equal(await spend.reserve(`bridge:${run}:b`, 6), "reserved");
    await spend.commit(`bridge:${run}:b`);
    assert.equal(await spend.reserve(`bridge:${run}:c`, 6), "cap");
  });
}

test("a bridge counts against the shared daily cap that swaps reserve on", { skip: !process.env.TEST_DATABASE_URL }, async () => {
  const databaseUrl = process.env.TEST_DATABASE_URL as string;
  const at = freshDay();
  const day = at.toISOString().slice(0, 10);
  const spend = bridgeSpend({ dailyUsdCap: 10, dailyBridgeUsdCap: 10, spendTimezone: "UTC", databaseUrl }, () => at);
  const run = randomUUID();
  assert.equal(await recordSpend(databaseUrl, `${run}:swap`, 8, day, 10), "reserved");
  assert.equal(await spend.reserve(`bridge:${run}`, 3), "cap");
  await closeSpendPools();
});
