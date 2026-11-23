import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { bridgeSpend } from "../src/bridge/spend.js";
import { closeSpendPools, spendJournal } from "../src/spend.js";

const freshDay = () => new Date(Date.UTC(2032 + Math.floor(Math.random() * 60), Math.floor(Math.random() * 12), 1 + Math.floor(Math.random() * 28), 12)).toISOString().slice(0, 10);

for (const [name, databaseUrl] of [["memory", null], ["Postgres", process.env.TEST_DATABASE_URL ?? null]] as const) {
  test(`the ${name} bridge reservation holds both the bridge cap and the shared daily cap, and a release frees it`, { skip: name === "Postgres" && !databaseUrl }, async () => {
    const run = randomUUID();
    const day = freshDay();
    const spend = bridgeSpend(spendJournal(databaseUrl, 100, () => day), 10);
    assert.equal(await spend.reserve(`bridge:${run}:a`, 6), "reserved");
    assert.equal(await spend.reserve(`bridge:${run}:a`, 6), "exists");
    assert.equal(await spend.reserve(`bridge:${run}:b`, 6), "cap");
    await spend.release(`bridge:${run}:a`);
    assert.equal(await spend.reserve(`bridge:${run}:b`, 6), "reserved");
    await spend.commit(`bridge:${run}:b`);
    assert.equal(await spend.reserve(`bridge:${run}:c`, 6), "cap");
  });

  test(`a bridge counts against the ${name} daily cap that swaps reserve on`, { skip: name === "Postgres" && !databaseUrl }, async () => {
    const day = freshDay();
    const journal = spendJournal(databaseUrl, 10, () => day);
    const run = randomUUID();
    assert.equal(await journal.reserve(`${run}:swap`, 8), "reserved");
    assert.equal(await bridgeSpend(journal, 10).reserve(`bridge:${run}`, 3), "cap");
    if (databaseUrl) await closeSpendPools();
  });
}
