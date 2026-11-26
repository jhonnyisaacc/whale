import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import test from "node:test";
import pg from "pg";
import { closeSpendPools, poolFor } from "../src/spend.js";
import { closeWithdrawPools, commitWithdraw } from "../src/withdraw-journal.js";

const url = process.env.TEST_DATABASE_URL;
const BOOTS = 12;

async function freshSchema(): Promise<{ urlFor: (process: number) => string; tables: () => Promise<string[]>; drop: () => Promise<void> }> {
  const schema = `boot_${randomBytes(6).toString("hex")}`;
  const admin = new pg.Client({ connectionString: url });
  await admin.connect();
  await admin.query(`CREATE SCHEMA ${schema}`);
  return {
    urlFor: (process) => {
      const target = new URL(url as string);
      target.searchParams.set("options", `-c search_path=${schema}`);
      target.searchParams.set("application_name", `boot_${process}`);
      return target.toString();
    },
    tables: async () =>
      (await admin.query<{ table_name: string }>("SELECT table_name FROM information_schema.tables WHERE table_schema = $1 ORDER BY table_name", [schema])).rows.map(
        (row) => row.table_name,
      ),
    drop: async () => {
      await admin.query(`DROP SCHEMA ${schema} CASCADE`);
      await admin.end();
    },
  };
}

test("concurrent first boots on an empty database all create the spend schema", { skip: !url }, async () => {
  const db = await freshSchema();
  try {
    const shared = db.urlFor(0);
    const boots = Array.from({ length: BOOTS }, (_, index) => poolFor(index % 2 === 0 ? shared : db.urlFor(index)));
    const settled = await Promise.allSettled(boots);
    assert.deepEqual(
      settled.filter((boot) => boot.status === "rejected").map((boot) => String(boot.reason)),
      [],
    );
    assert.deepEqual(await db.tables(), ["control_flags", "hosted_sends", "signed_tx", "spend_journal"]);
  } finally {
    await closeSpendPools();
    await db.drop();
  }
});

test("concurrent first boots on an empty database all create the withdraw schema", { skip: !url }, async () => {
  const db = await freshSchema();
  try {
    const shared = db.urlFor(0);
    const boots = Array.from({ length: BOOTS }, (_, index) => commitWithdraw(index % 2 === 0 ? shared : db.urlFor(index), "absent"));
    const settled = await Promise.allSettled(boots);
    assert.deepEqual(
      settled.filter((boot) => boot.status === "rejected").map((boot) => String(boot.reason)),
      [],
    );
    assert.deepEqual(await db.tables(), ["withdraw_journal"]);
  } finally {
    await closeWithdrawPools();
    await db.drop();
  }
});
