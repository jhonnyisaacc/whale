import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { BRIDGE_CONTRACTS, BRIDGE_TOKENS, DEFAULT_MAX_VALUE_WEI, assertEvmSigning, bridgeTerms } from "../dist/src/signing-policy.js";

const AMOUNT = 5_000_000n;
const FEE_CAP_BPS = 100;
const UNREADABLE = "is not one the signer can read";
const ROUTES = [
  { from: 8453, to: 42161, expect: "signed" },
  { from: 42161, to: 8453, expect: "signed" },
  { from: 10, to: 8453, expect: "decoded" },
];
const chains = [...new Set(ROUTES.flatMap((route) => [route.from, route.to]))];
const usdc = (chainId) => BRIDGE_TOKENS.USDC[chainId].address;
const root = new URL("..", import.meta.url).pathname;
const signerBin = path.join(root, "signer/target/release/whale-signer");
const env = { ...process.env, WHALE_SIGNER_PASSPHRASE: "decode-check-only" };

async function quote(route, owner) {
  const query = { fromChain: String(route.from), toChain: String(route.to), fromToken: usdc(route.from), toToken: usdc(route.to), fromAmount: String(AMOUNT), fromAddress: owner, toAddress: owner, allowBridges: "across" };
  const response = await fetch(`https://li.quest/v1/quote?${new URLSearchParams(query)}`);
  if (!response.ok) throw new Error(`li.quest answered ${response.status} for ${route.from} to ${route.to}`);
  return (await response.json()).transactionRequest;
}

function appDecision(route, owner, tx) {
  try {
    assertEvmSigning({ chainId: route.from, to: tx.to, data: tx.data, value: BigInt(tx.value ?? 0), purpose: "bridge", routers: [], settlers: [], withdrawAllowlist: [], maxValueWei: 0n, allowHotApproval: true, owner, allowOpaqueSwap: false, charge: { token: usdc(route.from), amount: AMOUNT }, bridgeChainIds: chains, maxBridgeFeeBps: FEE_CAP_BPS });
    return { decision: "signed", reasons: [] };
  } catch (error) {
    return { decision: "refused", reasons: [error.message] };
  }
}

function signerDecision(route, tx, files) {
  const job = { id: `decode-${route.from}-${route.to}`, kind: "evm", chainId: route.from, tx: { nonce: "0", to: tx.to, value: String(BigInt(tx.value ?? 0)), data: tx.data, gas: "600000", maxFeePerGas: "100000000", maxPriorityFeePerGas: "1000000" } };
  let output;
  try {
    output = execFileSync(signerBin, ["sign", "--keystore", files.keystore, "--policy", files.policy, "--ledger", files.ledger], { env, input: JSON.stringify(job) });
  } catch (error) {
    output = error.stdout;
  }
  const answer = JSON.parse(output.toString());
  return { decision: answer.decision, reasons: answer.reasons ?? [] };
}

const work = mkdtempSync(path.join(tmpdir(), "bridge-decode-"));
try {
  execFileSync("cargo", ["build", "--release", "--locked", "--quiet"], { cwd: path.join(root, "signer"), stdio: "inherit" });
  const files = { keystore: path.join(work, "keystore.json"), policy: path.join(work, "policy.json"), ledger: path.join(work, "ledger.json") };
  const owner = JSON.parse(execFileSync(signerBin, ["init", "--keystore", files.keystore], { env }).toString()).evmAddress;
  const dailyLimits = Object.fromEntries(chains.flatMap((id) => [[`${id}:native`, "100000000000000000"], [`${id}:${usdc(id)}`, "100000000"]]));
  const bridges = Object.fromEntries(ROUTES.map((route) => [route.from, BRIDGE_CONTRACTS[route.from]]));
  writeFileSync(files.policy, JSON.stringify({ version: 1, evm: { chains, bridges, maxBridgeFeeBps: FEE_CAP_BPS, maxValueWei: DEFAULT_MAX_VALUE_WEI.toString(), maxFeeWei: "10000000000000000", dailyLimits } }));
  let failed = 0;
  for (const route of ROUTES) {
    const tx = await quote(route, owner);
    const app = appDecision(route, owner, tx);
    const signer = signerDecision(route, tx, files);
    const decoded = bridgeTerms(tx.data) !== null && !signer.reasons.some((reason) => reason.includes(UNREADABLE));
    const pass = decoded && app.decision === signer.decision && (route.expect === "decoded" || app.decision === "signed");
    failed += pass ? 0 : 1;
    console.log(JSON.stringify({ route: `${route.from} to ${route.to}`, selector: tx.data.slice(0, 10), to: tx.to, expect: route.expect, decoded, app, signer, broadcast: false, pass }));
  }
  if (failed > 0) process.exit(1);
} finally {
  rmSync(work, { recursive: true, force: true });
}
