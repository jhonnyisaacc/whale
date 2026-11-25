import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { LIFI_STEP_TARGETS } from "../src/signing-policy/lifi-targets.js";

type Render = (tables: typeof LIFI_STEP_TARGETS) => string;
type Vector = { name: string; expect: string; job: { chainId?: number; tx?: { data: string } } };

const script = new URL("../../scripts/lifi-step-targets.mjs", import.meta.url);
const generated = (await import(script.href)) as { renderTs: Render; renderRust: Render; TS_FILE: URL; RUST_FILE: URL };

test("the app and whale-signer carry the same generated LI.FI step table", () => {
  assert.equal(readFileSync(generated.TS_FILE, "utf8"), generated.renderTs(LIFI_STEP_TARGETS), "run node scripts/lifi-step-targets.mjs instead of editing the app table");
  assert.equal(readFileSync(generated.RUST_FILE, "utf8"), generated.renderRust(LIFI_STEP_TARGETS), "run node scripts/lifi-step-targets.mjs instead of editing the signer table");
});

test("every LI.FI step table row has a signer vector on its chain", () => {
  const vectors = JSON.parse(readFileSync(new URL("../../signer/vectors/evm.json", import.meta.url), "utf8")) as { cases: Vector[] };
  for (const [chainId, table] of Object.entries(LIFI_STEP_TARGETS)) {
    const onChain = vectors.cases.filter((entry) => entry.job.chainId === Number(chainId) && entry.expect === "signed");
    for (const address of [table.feeForwarder, ...table.targets, ...table.spenders]) {
      assert.ok(onChain.some((entry) => entry.job.tx?.data.toLowerCase().includes(address.slice(2).toLowerCase())), `chain ${chainId} row ${address} has no signed vector; run node signer/vectors/generate.mjs`);
    }
  }
});
