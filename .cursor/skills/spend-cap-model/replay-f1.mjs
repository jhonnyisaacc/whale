#!/usr/bin/env node
// Replays finding F1 (SKILL.md) against the built src/spend.ts on a scratch Postgres database. It drops and
// recreates the spend tables, so never point it at a database that holds real data. Usage, after a build:
//   TEST_DATABASE_URL=postgres://... node .cursor/skills/spend-cap-model/replay-f1.mjs
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const { closeSpendPools, commitSpend, poolFor, reconcileReserved, recordSpend, recordTx } = await import(pathToFileURL(path.join(repo, "dist/src/spend.js")).href);
const db = process.env.TEST_DATABASE_URL;
if (!db) throw new Error("set TEST_DATABASE_URL to a scratch database");

const gate = () => {
  let open;
  const opened = new Promise((resolve) => (open = resolve));
  return { open, opened };
};
const step = (text) => console.log(`- ${text}`);
const tx = (txHash, outcome, nonce) => ({ chainKey: "base", txHash, from: "0xhot", to: "0xrouter", value: "0", outcome, nonce });
const statusOf = async (key) => (await (await poolFor(db)).query("SELECT status FROM spend_journal WHERE idempotency_key = $1", [key])).rows[0]?.status;

await (await poolFor(db)).query("DROP TABLE IF EXISTS spend_journal, signed_tx, hosted_sends, control_flags");
await closeSpendPools();
const day = "2026-11-25";
const cap = 2;

step(`a slow send left "slow" reserved with a pending transaction: ${await recordSpend(db, "slow", 1, day, cap)}`);
await recordTx(db, "slow", tx("0xslow", "pending", 0));
step(`call 1 for k1 reserves 1 USD: ${await recordSpend(db, "k1", 1, day, cap)}; the executor restarts before it signs`);

const bAtSlow = gate();
const retried = gate();
const passA = reconcileReserved(db, 0, async () => (await bAtSlow.opened, "pending"), (entry) => step(`pass A ${entry.action}s ${entry.idempotencyKey}`));
const passB = reconcileReserved(db, 0, async () => (bAtSlow.open(), await retried.opened, "pending"), (entry) => step(`pass B ${entry.action}s ${entry.idempotencyKey}`));
await passA;
step(`the strategy retries k1, and recordSpend re-reserves the released row: ${await recordSpend(db, "k1", 1, day, cap)}`);
retried.open();
await passB;
await recordTx(db, "k1", tx("0xk1", "pending", 1));
await recordTx(db, "k1", tx("0xk1", "landed", 1));
await commitSpend(db, "k1");
const k1 = await statusOf("k1");
step(`the retry's transaction lands and commitSpend runs; spend_journal k1 is ${k1}`);
step(`a new key under the ${cap} USD cap, with 1 USD pending and 1 USD landed: ${await recordSpend(db, "k2", 1, day, cap)}`);
await closeSpendPools();
console.log(k1 === "released" ? "F1 reproduces: a landed send no longer counts against the cap." : `F1 does not reproduce: k1 is ${k1}.`);
process.exit(k1 === "released" ? 1 : 0);
