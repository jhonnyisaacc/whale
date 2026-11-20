import assert from "node:assert/strict";
import test from "node:test";
import { resetProviderGuards } from "../src/aggregators.js";
import { commandDeps } from "../src/command-callers.js";
import { run, type WalletCommand } from "../src/commands.js";
import { loadConfig } from "../src/config.js";
import { manifestPolicyDocument, manifestRouters, parseDeploymentManifest } from "../src/deployment-manifest.js";
import { delegationFromEnv } from "../src/gateway/turnkey.js";
import { assertEvmSigning, DEFAULT_MAX_VALUE_WEI } from "../src/signing-policy.js";

const MONAD = { kind: "evm" as const, chainId: 143 };
const ALLOWANCE_HOLDER = "0x0000000000001fF3684f28c67538d4D072C22734".toLowerCase();
const KYBER_ROUTER = "0x6131B5fae19EA4f9D964eAc0408E4408b66337b5".toLowerCase();
const USDC = "0x754704Bc059F8C67012fEd69BC8A327a5aafb603";
const NATIVE = "0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE";
const OWNER = `0x${"11".repeat(20)}`;
const OTHER = `0x${"22".repeat(20)}`;
const ZEROEX_HOST = "api.0x.org";
const KYBER_HOST = "aggregator-api.kyberswap.com";

const swapOn143 = (to: string, routers: readonly string[]) => () =>
  assertEvmSigning({
    chainId: 143,
    to,
    data: "0x",
    value: 0n,
    purpose: "swap",
    routers,
    settlers: [],
    withdrawAllowlist: [],
    maxValueWei: DEFAULT_MAX_VALUE_WEI,
    allowHotApproval: false,
    owner: OWNER,
    allowOpaqueSwap: true,
  });

test("with no router config, Monad allows the 0x AllowanceHolder and the KyberSwap router and refuses any other destination", () => {
  const config = loadConfig({});
  assert.deepEqual(config.routerAllowlist[143], [ALLOWANCE_HOLDER, KYBER_ROUTER]);
  assert.equal(config.routerAllowlist[8453], undefined);
  assert.doesNotThrow(swapOn143(KYBER_ROUTER, config.routerAllowlist[143] ?? []));
  assert.doesNotThrow(swapOn143(ALLOWANCE_HOLDER, config.routerAllowlist[143] ?? []));
  assert.throws(swapOn143(OTHER, config.routerAllowlist[143] ?? []), /monad \(chain id 143\): transaction destination is not an allowlisted router/);
});

test("an operator list for chain 143 replaces the Monad default, an empty list still denies, and other chains keep the default", () => {
  assert.deepEqual(loadConfig({ ROUTER_ALLOWLIST_JSON: JSON.stringify({ "143": [OTHER] }) }).routerAllowlist[143], [OTHER]);
  const denied = loadConfig({ ROUTER_ALLOWLIST_JSON: JSON.stringify({ "143": [] }) });
  assert.throws(swapOn143(KYBER_ROUTER, denied.routerAllowlist[143] ?? []), /router allowlist is empty/);
  const base = loadConfig({ ROUTER_ALLOWLIST_JSON: JSON.stringify({ "8453": [OTHER] }) });
  assert.deepEqual(base.routerAllowlist, { 143: [ALLOWANCE_HOLDER, KYBER_ROUTER], 8453: [OTHER] });
});

const manifestWith = (routers: Record<string, string[]>) =>
  parseDeploymentManifest({
    version: 1,
    turnkey: {
      userId: "11111111-1111-4111-8111-111111111111",
      wallets: { evm: "22222222-2222-4222-8222-222222222222", solana: "33333333-3333-4333-8333-333333333333", hyperliquid: null },
      evmAddress: OWNER,
      solanaAddress: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
      hyperliquidAddress: null,
    },
    routers,
    maxValueWei: "2000000000000000",
  });
const monadClause = (document: unknown[]) => (document as { condition: string }[]).find((row) => row.condition.includes("eth.tx.chain_id == 143"));
const withManifest = (manifest: object, routers?: object) => ({
  EXECUTOR_AUTH_TOKEN: "executor-token-123456",
  WALLET_DEPLOYMENT_MANIFEST_JSON: JSON.stringify(manifest),
  ...(routers ? { ROUTER_ALLOWLIST_JSON: JSON.stringify(routers) } : {}),
});

test("a manifest that does not name 143 renders no Monad routers and no Monad Turnkey clause", () => {
  const manifest = manifestWith({ "42161": [OTHER] });
  assert.deepEqual(manifestRouters(manifest), { 42161: [OTHER] });
  assert.equal(monadClause(manifestPolicyDocument(manifest)), undefined);
  assert.deepEqual(loadConfig(withManifest(manifest)).routerAllowlist, { 42161: [OTHER] });
});

test("a manifest that names 143 carries those routers into the config and the Turnkey document", () => {
  const manifest = manifestWith({ "143": [ALLOWANCE_HOLDER, KYBER_ROUTER] });
  assert.deepEqual(loadConfig(withManifest(manifest)).routerAllowlist, { 143: [ALLOWANCE_HOLDER, KYBER_ROUTER] });
  const clause = monadClause(manifestPolicyDocument(manifest));
  assert.ok(clause?.condition.includes(ALLOWANCE_HOLDER) && clause.condition.includes(KYBER_ROUTER), "the Turnkey EVM clause names both Monad routers");
});

test("a manifest boots beside a ROUTER_ALLOWLIST_JSON that states the same routers, with or without a 143 opt-out", () => {
  const manifest = manifestWith({ "42161": [OTHER] });
  assert.deepEqual(loadConfig(withManifest(manifest, { "42161": [OTHER] })).routerAllowlist, { 42161: [OTHER] });
  assert.deepEqual(loadConfig(withManifest(manifest, { "42161": [OTHER], "143": [] })).routerAllowlist, { 42161: [OTHER] });
  assert.throws(() => loadConfig(withManifest(manifest, { "42161": [OTHER], "143": [KYBER_ROUTER] })), /disagree on routers/);
  assert.throws(() => loadConfig(withManifest(manifestWith({ "143": [KYBER_ROUTER] }), { "143": [] })), /disagree on routers/);
});

test("the gateway delegation fills the Monad default when ROUTER_ALLOWLIST_JSON does not name 143", () => {
  const delegation = delegationFromEnv({ TURNKEY_DELEGATE_API_PUBLIC_KEY: `02${"a".repeat(64)}`, ROUTER_ALLOWLIST_JSON: JSON.stringify({ "42161": [OTHER] }) });
  assert.deepEqual(delegation?.routers[143], [ALLOWANCE_HOLDER, KYBER_ROUTER]);
});

test("a MON to USDC quote on Monad asks 0x on chain 143 and Kyber on its monad route, and the Kyber router it returns is allowlisted", async () => {
  resetProviderGuards();
  const asked: { host: string; path: string; chainId: string | null }[] = [];
  const original = globalThis.fetch;
  globalThis.fetch = async (input) => {
    const url = new URL(String(input));
    asked.push({ host: url.hostname, path: url.pathname, chainId: url.searchParams.get("chainId") });
    if (url.hostname === ZEROEX_HOST) return new Response(JSON.stringify({ buyAmount: "13900", liquidityAvailable: true }), { status: 200 });
    if (url.hostname === KYBER_HOST) return new Response(JSON.stringify({ data: { routeSummary: { amountOut: "13954", routerAddress: KYBER_ROUTER } } }), { status: 200 });
    return new Response("{}", { status: 404 });
  };
  const env = { ZEROX_API_KEY: "zeroex-key", ENABLED_CHAINS: "monad", QUOTE_TIMEOUT_MS: "200", QUOTE_DEADLINE_MS: "400" };
  const command: Extract<WalletCommand, { kind: "quote" }> = {
    kind: "quote",
    sell: { chain: MONAD, chainKey: "monad", address: NATIVE, symbol: "MON", decimals: 18 },
    buy: { chain: MONAD, chainKey: "monad", address: USDC, symbol: "USDC", decimals: 6 },
    sellAmount: "1000000000000000000",
    taker: null,
    slippageBps: 50,
    purpose: "price",
  };
  try {
    const result = await run(command, commandDeps(env, command));
    assert.ok(result.kind === "quote" && result.status === "quoted", `expected a quote, got ${JSON.stringify(result)}`);
    assert.equal(result.quote.provider, "kyberswap");
    assert.equal(result.quote.buyAmount, "13954");
    assert.equal(result.quote.chainKey, "monad");
    assert.equal(asked.find((item) => item.host === ZEROEX_HOST)?.chainId, "143");
    assert.equal(asked.find((item) => item.host === KYBER_HOST)?.path, "/monad/api/v1/routes");
    assert.ok(loadConfig(env).routerAllowlist[143]?.includes(KYBER_ROUTER));
  } finally {
    globalThis.fetch = original;
  }
});
