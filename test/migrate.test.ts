import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { loadMigrations, MIGRATIONS_DIR, pendingMigrations } from "../src/db/migrate.js";

function dirWith(files: Record<string, string>): string {
  const dir = mkdtempSync(path.join(tmpdir(), "whale-migrations-"));
  for (const [name, sql] of Object.entries(files)) writeFileSync(path.join(dir, name), sql);
  return dir;
}

test("shipped migrations load in order with no gaps", () => {
  const migrations = loadMigrations(MIGRATIONS_DIR);
  assert.ok(migrations.length >= 1);
  assert.deepEqual(migrations.map((migration) => migration.version), migrations.map((_, index) => index + 1));
});

test("a bad file name or a version gap refuses to load", () => {
  assert.throws(() => loadMigrations(dirWith({ "1_init.sql": "SELECT 1" })), /named like 0001_name\.sql/);
  assert.throws(() => loadMigrations(dirWith({ "0001_a.sql": "SELECT 1", "0003_c.sql": "SELECT 1" })), /without gaps/);
});

test("an applied migration that changed or vanished refuses to run", () => {
  const local = loadMigrations(dirWith({ "0001_a.sql": "SELECT 1", "0002_b.sql": "SELECT 2" }));
  const first = local[0];
  assert.ok(first);
  assert.deepEqual(pendingMigrations(local, [{ version: 1, checksum: first.checksum }]).map((migration) => migration.name), ["b"]);
  assert.throws(() => pendingMigrations(local, [{ version: 1, checksum: "0".repeat(64) }]), /changed after it was applied/);
  assert.throws(() => pendingMigrations(local, [{ version: 3, checksum: first.checksum }]), /does not ship/);
});

test("the runtime image ships the migrations where the compiled runner looks for them", () => {
  const root = fileURLToPath(new URL("../../", import.meta.url));
  const runtime = readFileSync(path.join(root, "Dockerfile"), "utf8").split(/^FROM /m).at(-1) ?? "";
  const workdir = /^WORKDIR (\S+)$/m.exec(runtime)?.[1] ?? "/";
  const copies = [...runtime.matchAll(/^COPY (?:--from=\S+ )?(\S+) (\S+)$/gm)].map(([, from, to]) => ({ from, to: path.posix.resolve(workdir, to as string) }));
  assert.ok(copies.some(({ from, to }) => from?.endsWith("/dist") && to === path.posix.join(workdir, "dist")));
  const shipped = path.relative(root, MIGRATIONS_DIR).split(path.sep).join("/");
  assert.ok(copies.some(({ from, to }) => from === shipped && to === path.posix.join(workdir, shipped)), `the runtime stage must copy ${shipped} to ${path.posix.join(workdir, shipped)}`);
});
