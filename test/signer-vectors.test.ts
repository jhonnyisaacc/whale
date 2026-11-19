import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import type { Hex } from "viem";
import { signerChainTable } from "../src/chains.js";
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

test("the self-hosted signer names the same EVM chains and L1 fee budgets as the app's chain table", () => {
  const signer = JSON.parse(readFileSync(new URL("../../signer/vectors/chains.json", import.meta.url), "utf8")) as unknown;
  assert.deepEqual(signer, signerChainTable(), "run node signer/vectors/generate.mjs after a chain table change");
  const budgets = signerChainTable().filter((chain) => chain.l1DataFee !== undefined);
  assert.deepEqual(
    budgets.map((chain) => [chain.chainId, chain.l1DataFee === null]),
    [[10, false], [8453, false], [81457, true], [534352, false]],
  );
});
