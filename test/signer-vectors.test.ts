import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import type { Hex } from "viem";
import { signerChainTable } from "../src/chains.js";
import { assertEvmSigning, DEFAULT_MAX_VALUE_WEI, JUPITER_PROGRAM_ID } from "../src/signing-policy.js";
import { swapTerms } from "../src/signing-policy/swap-terms.js";

type Vector = { name: string; job: { tx: { data: Hex } }; recipient?: string };
type LifiVector = { name: string; expect: "signed" | "refused"; reason?: string; job: { chainId: number; tx: { to: string; data: Hex; value: string } } };

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

test("the app's signing policy decides every LI.FI vector the way the self-hosted signer does", () => {
  const vectors = JSON.parse(readFileSync(new URL("../../signer/vectors/evm.json", import.meta.url), "utf8")) as { own: string; cases: LifiVector[] };
  const policy = JSON.parse(readFileSync(new URL("../../signer/vectors/policy.json", import.meta.url), "utf8")) as { evm: { routers: Record<string, string[]> } };
  const lifi = vectors.cases.filter((entry) => swapTerms(entry.job.tx.data)?.provider === "lifi" && (entry.expect === "signed" || entry.reason?.includes("LI.FI")));
  assert.ok(lifi.filter((entry) => entry.expect === "refused").length >= 6);
  for (const entry of lifi) {
    const { tx } = entry.job;
    const sign = () =>
      assertEvmSigning({ chainId: entry.job.chainId, to: tx.to, data: tx.data, value: BigInt(tx.value), purpose: "swap", routers: policy.evm.routers[String(entry.job.chainId)] ?? [], settlers: [], withdrawAllowlist: [], maxValueWei: DEFAULT_MAX_VALUE_WEI, allowHotApproval: false, owner: vectors.own, allowOpaqueSwap: false, nativeSell: BigInt(tx.value) > 0n });
    if (entry.expect === "signed") assert.doesNotThrow(sign, entry.name);
    else assert.throws(sign, (error: Error) => error.message.includes(entry.reason ?? ""), entry.name);
  }
});
