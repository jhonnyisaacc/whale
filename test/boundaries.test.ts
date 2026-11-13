import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const SCRIPT = fileURLToPath(new URL("../../scripts/check-boundaries.mjs", import.meta.url));

function boundaries(file: string, source: string): number | null {
  const root = mkdtempSync(path.join(tmpdir(), "whale-boundaries-"));
  try {
    mkdirSync(path.join(root, "src", path.dirname(file)), { recursive: true });
    writeFileSync(path.join(root, "src", file), source);
    return spawnSync(process.execPath, [SCRIPT], { cwd: root, encoding: "utf8" }).status;
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

test("the gateway may import the Turnkey policy renderer and nothing else from signing-policy", () => {
  assert.equal(boundaries("gateway/probe.ts", 'import { turnkeyPolicyDocument } from "../signing-policy/turnkey.js";\n'), 0);
  assert.equal(boundaries("gateway/probe.ts", 'import { assertEvmSigning } from "../signing-policy.js";\n'), 1);
  assert.equal(boundaries("gateway/probe.ts", 'import { swapTerms } from "../signing-policy/swap-terms.js";\n'), 1);
  assert.equal(boundaries("gateway-server.ts", 'import { turnkeyPolicyDocument } from "./signing-policy/turnkey.js";\n'), 0);
  assert.equal(boundaries("gateway-server.ts", 'import { assertEvmSigning } from "./signing-policy.js";\n'), 1);
});
