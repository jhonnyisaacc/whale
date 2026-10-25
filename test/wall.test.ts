import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import test from "node:test";

test("listing modules are not part of the wallet", () => {
  for (const file of ["src/match.ts", "src/watchlist.ts", "src/refresh.ts", "src/resolver-server.ts", "src/parsers.ts"]) {
    assert.equal(existsSync(new URL(`../${file}`, import.meta.url)), false, file);
  }
});
