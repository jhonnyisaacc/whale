import assert from "node:assert/strict";
import test from "node:test";
import { Keypair } from "@solana/web3.js";
import { providersFor } from "../src/aggregators.js";
import { CHAINS, DEFAULT_EVM_FEE_LIMITS, L1_DATA_FEE_CHAIN_IDS, TURNKEY_EXCLUDED_CHAIN_IDS, chainByKey, feeRankOf } from "../src/chains.js";
import { loadConfig } from "../src/config.js";
import { routerAllowlist } from "../src/config/guard.js";
import { turnkeyPolicyDocument } from "../src/signing-policy/turnkey.js";

test("Robinhood Chain and HyperEVM use the published chain ids and RPCs", () => {
  const robinhood = chainByKey("robinhood");
  assert.ok(robinhood);
  assert.deepEqual(robinhood?.chain, { kind: "evm", chainId: 4663 });
  assert.equal(robinhood?.defaultRpc, "https://rpc.mainnet.chain.robinhood.com");
  assert.equal(robinhood?.aggregator, "zeroex");
  const hyper = chainByKey("hyperevm");
  assert.equal(hyper?.chain.kind === "evm" ? hyper.chain.chainId : 0, 999);
  assert.equal(hyper?.defaultRpc, "https://rpc.hyperliquid.xyz/evm");
  assert.equal(chainByKey("zksync")?.liveSend, "eip1559");
  assert.equal(chainByKey("blast")?.aggregator, "lifi");
  assert.equal(chainByKey("hypercore")?.defaultRpc, "https://api.hyperliquid.xyz");
  const monad = chainByKey("monad");
  assert.equal(monad?.chain.kind === "evm" ? monad.chain.chainId : 0, 143);
  assert.equal(monad?.nativeSymbol, "MON");
  assert.equal(monad?.defaultRpc, "https://rpc.monad.xyz");
  assert.equal(monad?.enabledByDefault, false);
  assert.equal(monad?.dexscreenerSlug, null);
  assert.equal(monad?.aggregator, "zeroex");
  assert.equal(feeRankOf("monad"), 1000);
  const off = loadConfig({} as NodeJS.ProcessEnv);
  assert.equal(off.enabledChainKeys.has("monad"), false);
  const on = loadConfig({ ENABLED_CHAINS: "monad", ZEROX_API_KEY: "zeroex-key" } as NodeJS.ProcessEnv);
  assert.equal(on.enabledChainKeys.has("monad"), true);
  const providers = providersFor({ kind: "evm", chainId: 143 }, on);
  assert.equal(providers.includes("zeroex"), true);
  assert.equal(providers.includes("kyberswap"), true);
  assert.equal(providers.includes("lifi"), true);
});

test("Ethereum is off until ENABLED_CHAINS names it, and DISABLED_CHAINS still wins", () => {
  assert.equal(loadConfig({} as NodeJS.ProcessEnv).enabledChainKeys.has("ethereum"), false);
  assert.equal(loadConfig({ ENABLED_CHAINS: "ethereum" } as NodeJS.ProcessEnv).enabledChainKeys.has("ethereum"), true);
  assert.equal(loadConfig({ ENABLED_CHAINS: "ethereum", DISABLED_CHAINS: "ethereum" } as NodeJS.ProcessEnv).enabledChainKeys.has("ethereum"), false);
  assert.equal(loadConfig({} as NodeJS.ProcessEnv).enabledChainKeys.has("arbitrum"), true);
});

test("live mode is off unless the flag is the exact string true", () => {
  const dry = loadConfig({} as NodeJS.ProcessEnv);
  assert.equal(dry.live, false);
  assert.equal(dry.maxUsdPerTrade, 5);
  assert.equal(dry.maxLeverage, 3);
  assert.equal(loadConfig({ WHALE_BROADCAST: "false" } as NodeJS.ProcessEnv).live, false);
  const live = loadConfig({ WHALE_BROADCAST: "true" } as NodeJS.ProcessEnv);
  assert.equal(live.live, true);
  assert.throws(() => loadConfig({ MAX_SLIPPAGE_BPS: "400" } as NodeJS.ProcessEnv));
});

test("every EVM chain id matches its RPC variable, router allowlist, fee limit, and Turnkey policy clause", () => {
  const sorted = (list: Iterable<number | string>) => [...list].map(Number).sort((left, right) => left - right);
  const evm = CHAINS.flatMap((chain) => (chain.chain.kind === "evm" ? [{ ...chain, id: chain.chain.chainId }] : []));
  const ids = sorted(evm.map((chain) => chain.id));
  for (const chain of evm) assert.equal(chain.rpcEnv, `RPC_URL_${chain.id}`, chain.key);
  const allowlist = routerAllowlist({ ROUTER_ALLOWLIST: `0x${"3".repeat(40)}` } as NodeJS.ProcessEnv);
  assert.deepEqual(sorted(Object.keys(allowlist)), ids);
  const signable = sorted(evm.filter((chain) => chain.liveSend === "eip1559" && chain.key !== "blast").map((chain) => chain.id));
  assert.deepEqual(sorted(Object.keys(DEFAULT_EVM_FEE_LIMITS)), signable, "every eip1559 chain but Blast, which is winding down, has a fee limit");
  for (const id of L1_DATA_FEE_CHAIN_IDS) assert.ok(ids.includes(id), `L1 data fee chain ${id} is in the chain table`);
  for (const [id, limit] of Object.entries(DEFAULT_EVM_FEE_LIMITS)) {
    assert.equal(limit.l1 !== undefined, L1_DATA_FEE_CHAIN_IDS.has(Number(id)), `chain ${id} has an L1 fee budget exactly when it charges an L1 data fee`);
  }
  const uuid = (digit: string) => `${digit.repeat(8)}-${digit.repeat(4)}-${digit.repeat(4)}-${digit.repeat(4)}-${digit.repeat(12)}`;
  const policy = turnkeyPolicyDocument({
    userId: uuid("1"),
    wallets: { evm: uuid("2"), solana: uuid("3"), hyperliquid: null },
    solanaAddress: Keypair.generate().publicKey.toBase58(),
    routers: allowlist,
    maxValueWei: 1n,
  });
  const clauses = [...JSON.stringify(policy).matchAll(/eth\.tx\.chain_id == (\d+) &&/g)].map((match) => match[1] ?? "");
  assert.deepEqual(sorted(clauses), signable.filter((id) => !TURNKEY_EXCLUDED_CHAIN_IDS.has(id)), "the Turnkey policy renders every signable chain but zkSync, and an L1 data fee chain only with its budget");
});
