import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import type { Hex } from "viem";
import { JUPITER_PROGRAM_ID } from "../src/signing-policy.js";
import { swapTerms } from "../src/signing-policy/swap-terms.js";

type Vector = { name: string; job: { tx: { data: Hex } }; recipient?: string };

test("the app's swap decoder reads the same recipient as the self-hosted signer's vectors", () => {
  const vectors = JSON.parse(readFileSync(new URL("../../signer/vectors/evm.json", import.meta.url), "utf8")) as { cases: Vector[] };
  const swaps = vectors.cases.filter((entry) => entry.recipient);
  assert.ok(swaps.length >= 5);
  for (const entry of swaps) {
    const terms = swapTerms(entry.job.tx.data);
    assert.equal(terms?.recipient.toLowerCase(), entry.recipient?.toLowerCase(), entry.name);
  }
});

test("the example signer policy lists the Jupiter program the app signs for", () => {
  const policy = JSON.parse(readFileSync(new URL("../../signer/vectors/policy.json", import.meta.url), "utf8")) as { solana: { programs: string[] } };
  assert.deepEqual(policy.solana.programs, [JUPITER_PROGRAM_ID]);
});
