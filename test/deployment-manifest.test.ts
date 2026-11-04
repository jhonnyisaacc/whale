import assert from "node:assert/strict";
import test from "node:test";
import { loadConfig } from "../src/config.js";
import { manifestPolicyDocument, manifestRouters, parseDeploymentManifest, verifyTurnkeyPolicies } from "../src/deployment-manifest.js";
import { defaultSupportTier, supportByChain } from "../src/support.js";

const ROUTER = "0x1111111111111111111111111111111111111111";
const manifest = {
  version: 1,
  turnkey: {
    userId: "11111111-1111-4111-8111-111111111111",
    wallets: { evm: "22222222-2222-4222-8222-222222222222", solana: "33333333-3333-4333-8333-333333333333", hyperliquid: null },
    evmAddress: ROUTER,
    solanaAddress: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
    hyperliquidAddress: null,
  },
  routers: { "8453": [ROUTER] },
  selectors: [],
  maxValueWei: "2000000000000000",
  solanaPrograms: ["EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v"],
};

test("a manifest parses and drives routers and the Turnkey document from one source", () => {
  const parsed = parseDeploymentManifest(manifest);
  assert.deepEqual(manifestRouters(parsed), { 8453: [ROUTER.toLowerCase()] });
  const document = manifestPolicyDocument(parsed) as { condition: string }[];
  assert.ok(document.some((row) => row.condition.includes("8453") && row.condition.includes(ROUTER.toLowerCase())));
  assert.ok(document.some((row) => row.condition.includes("EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v")));
});

test("a bad manifest fails with the field that is wrong", () => {
  assert.throws(() => parseDeploymentManifest({ ...manifest, maxValueWei: "1.5" }), /maxValueWei/);
});

test("policy verification passes on equality and names a missing policy", () => {
  const document = manifestPolicyDocument(parseDeploymentManifest(manifest));
  assert.deepEqual(verifyTurnkeyPolicies(document, document), { ok: true });
  const result = verifyTurnkeyPolicies(document, document.slice(1));
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.missing.length, 1);
});

test("config takes routers from the manifest and refuses a disagreeing legacy allowlist", () => {
  const base = { EXECUTOR_AUTH_TOKEN: "executor-token-123456", RESOLVER_AUTH_TOKEN: "resolver-token-123456", WALLET_DEPLOYMENT_MANIFEST_JSON: JSON.stringify(manifest) };
  const config = loadConfig(base);
  assert.deepEqual(config.routerAllowlist, { 8453: [ROUTER.toLowerCase()] });
  assert.equal(config.maxValueWei, 2000000000000000n);
  assert.throws(() => loadConfig({ ...base, ROUTER_ALLOWLIST_JSON: JSON.stringify({ "8453": ["0x2222222222222222222222222222222222222222"] }) }), /disagree/);
});

test("support tiers default monad off and zksync to dry-run, with explicit overrides", () => {
  assert.equal(defaultSupportTier("monad"), "disabled");
  assert.equal(defaultSupportTier("zksync"), "dry_run");
  assert.equal(defaultSupportTier("base"), "live");
  const support = supportByChain(["base", "monad"], "base:dry_run");
  assert.equal(support.base, "dry_run");
  assert.throws(() => supportByChain(["base"], "base:yolo"), /SUPPORT_TIERS/);
});

test("config exposes the support map", () => {
  const config = loadConfig({ EXECUTOR_AUTH_TOKEN: "executor-token-123456", RESOLVER_AUTH_TOKEN: "resolver-token-123456" });
  assert.equal(config.supportByChain.monad, "disabled");
  assert.equal(config.supportByChain.base, "live");
});
