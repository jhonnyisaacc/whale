import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { readFileSync } from "node:fs";
import { createServer } from "node:http";
import test from "node:test";
import { promisify } from "node:util";
import { encodeAbiParameters, toFunctionSelector, type Hex } from "viem";
import { LIFI_STEP_TARGETS as fromPolicy } from "../src/signing-policy.js";
import { LIFI_STEP_TARGETS as fromSteps } from "../src/signing-policy/lifi-steps.js";
import { LIFI_STEP_TARGETS, type LifiStepTable } from "../src/signing-policy/lifi-targets.js";

const runFile = promisify(execFile);

type Render = (tables: typeof LIFI_STEP_TARGETS) => string;
type Pair = { address: string; selectors: readonly string[] };
type Family = { family: string; role: string; variants: readonly (readonly string[])[] };
type Vector = { name: string; expect: string; reason?: string; job: { chainId?: number; tx?: { data: string } } };

const script = new URL("../../scripts/lifi-step-targets.mjs", import.meta.url);
const generated = (await import(script.href)) as {
  TS_FILE: URL;
  RUST_FILE: URL;
  CHAINS: readonly { chainId: number; diamond: string }[];
  FAMILIES: readonly Family[];
  classify: (chainId: number, pairs: readonly Pair[]) => { table: LifiStepTable };
  changes: (committed: Record<number, LifiStepTable>, fresh: Record<number, LifiStepTable>) => string[];
  renderTs: Render;
  renderRust: Render;
};

const toSelectors = (role: string) => {
  const variant = generated.FAMILIES.find((item) => item.role === role)!.variants[0]!;
  return variant.map((entry) => (entry.startsWith("0x") ? (entry as Hex) : toFunctionSelector(entry)));
};

test("the app, whale-signer, and vectors carry the same generated LI.FI step table and barrel exports", () => {
  assert.equal(fromSteps, LIFI_STEP_TARGETS);
  assert.equal(fromPolicy, LIFI_STEP_TARGETS);
  assert.equal(readFileSync(generated.TS_FILE, "utf8"), generated.renderTs(LIFI_STEP_TARGETS), "run node scripts/lifi-step-targets.mjs instead of editing the app table");
  assert.equal(readFileSync(generated.RUST_FILE, "utf8"), generated.renderRust(LIFI_STEP_TARGETS), "run node scripts/lifi-step-targets.mjs instead of editing the signer table");
  const stepsJson = JSON.parse(readFileSync(new URL("../../signer/vectors/lifi-steps.json", import.meta.url), "utf8")) as unknown;
  assert.deepEqual(stepsJson, LIFI_STEP_TARGETS, "run node signer/vectors/generate.mjs");
});

test("every LI.FI step table row has a signer vector on its chain, and spenders are refused as call targets", () => {
  const vectors = JSON.parse(readFileSync(new URL("../../signer/vectors/evm.json", import.meta.url), "utf8")) as { cases: Vector[] };
  for (const [chainId, table] of Object.entries(LIFI_STEP_TARGETS)) {
    const onChain = vectors.cases.filter((entry) => entry.job.chainId === Number(chainId));
    const signed = onChain.filter((entry) => entry.expect === "signed");
    const refused = onChain.filter((entry) => entry.expect === "refused");
    for (const address of [table.feeForwarder, ...table.targets, ...table.spenders]) {
      assert.ok(signed.some((entry) => entry.job.tx?.data.toLowerCase().includes(address.slice(2).toLowerCase())), `chain ${chainId} row ${address} has no signed vector; run node signer/vectors/generate.mjs`);
    }
    for (const spender of table.spenders) {
      const expected = `the LI.FI swap step calls 0x${spender.slice(2).toLowerCase()}, which is not a listed LI.FI step target`;
      assert.ok(refused.some((entry) => entry.reason === expected), `chain ${chainId} spender ${spender} has no refused callTo vector; run node signer/vectors/generate.mjs`);
    }
  }
});

test("classify separates targets and approve-only spenders, excludes unknown selectors, and requires one FeeForwarder", () => {
  const feeForwarder = "0xDe2b920506EE931a6A2ABDF566526220214FBbAE";
  const router = "0x20F6ee51340aDEed01A59B0e65cB3703f3dc860c";
  const spender = "0x40aA958dd87FC8305b97f2BA922CDdCa374bcD7f";
  const excluded = "0x0000000000001fF3684f28c67538d4D072C22734";
  const flySelectors = generated.FAMILIES.find((item) => item.family === "Fly DexAggregator")!.variants[0]!.map(toFunctionSelector);
  const { table } = generated.classify(1, [
    { address: feeForwarder, selectors: toSelectors("feeForwarder") },
    { address: router, selectors: flySelectors },
    { address: spender, selectors: toSelectors("spender") },
    { address: excluded, selectors: ["0x2213bc0b"] },
  ]);
  assert.deepEqual(table, { feeForwarder, targets: [router], spenders: [spender] });
  assert.throws(() => generated.classify(1, [{ address: router, selectors: flySelectors }]), /expected one LI\.FI FeeForwarder/);
});

test("lifi-step-targets --check passes against matching diamond allowlists and fails on drift or wrong chain id", async () => {
  const familyOrder = generated.FAMILIES.filter((item) => item.role === "target");
  const pairsByChain = new Map<number, { address: Hex; selectors: Hex[] }[]>();
  for (const { chainId } of generated.CHAINS) {
    const table = LIFI_STEP_TARGETS[chainId]!;
    let familyIndex = 0;
    const targetPairs = table.targets.map((address, index) => {
      if (index > 0 && address.toLowerCase() < table.targets[index - 1]!.toLowerCase()) familyIndex += 1;
      const selectors = familyOrder[familyIndex]!.variants[0]!.map((entry) => (entry.startsWith("0x") ? (entry as Hex) : toFunctionSelector(entry)));
      return { address: address as Hex, selectors };
    });
    const pairs: { address: Hex; selectors: Hex[] }[] = [
      { address: table.feeForwarder as Hex, selectors: toSelectors("feeForwarder") },
      ...targetPairs,
      ...table.spenders.map((address) => ({ address: address as Hex, selectors: toSelectors("spender") })),
    ];
    pairsByChain.set(chainId, pairs);
  }

  let extraTargetOnOne = false;
  let wrongChainId = false;
  let failFirstAttempt = true;
  const server = createServer((request, response) => {
    const chainId = Number(new URL(request.url ?? "/", "http://127.0.0.1").pathname.slice(1));
    let raw = "";
    request.on("data", (chunk) => (raw += chunk));
    request.on("end", () => {
      if (failFirstAttempt && chainId === 1) {
        failFirstAttempt = false;
        response.writeHead(503);
        response.end("busy");
        return;
      }
      const { id, method } = JSON.parse(raw) as { id: number; method: string };
      const pairs = [...(pairsByChain.get(chainId) ?? [])];
      if (extraTargetOnOne && chainId === 1) {
        const fly = generated.FAMILIES.find((item) => item.family === "Fly DexAggregator")!.variants[0]!.map(toFunctionSelector);
        pairs.push({ address: "0x000000000000000000000000000000000000beef", selectors: fly });
      }
      const result =
        method === "eth_chainId"
          ? `0x${(wrongChainId && chainId === 1 ? 10 : chainId).toString(16)}`
          : method === "eth_blockNumber"
            ? "0x100"
            : encodeAbiParameters(
                [{ type: "address[]" }, { type: "bytes4[][]" }],
                [pairs.map((pair) => pair.address), pairs.map((pair) => pair.selectors)],
              );
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ jsonrpc: "2.0", id, result }));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as { port: number };
  const env: NodeJS.ProcessEnv = { ...process.env };
  for (const { chainId } of generated.CHAINS) env[`RPC_URL_${chainId}`] = `http://127.0.0.1:${port}/${chainId}`;
  try {
    const ok = await runFile(process.execPath, [script.pathname, "--check"], { env });
    assert.match(ok.stdout, /matches the on-chain allowlists/);

    extraTargetOnOne = true;
    await assert.rejects(
      runFile(process.execPath, [script.pathname, "--check"], { env }),
      (error: { stderr?: string }) => (error.stderr ?? "").includes("chain 1: add target 0x000000000000000000000000000000000000bEEF"),
    );

    extraTargetOnOne = false;
    wrongChainId = true;
    await assert.rejects(
      runFile(process.execPath, [script.pathname, "--check"], { env }),
      (error: { stderr?: string }) => (error.stderr ?? "").includes("chain 1: RPC answered eth_chainId with 10"),
    );
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
