import assert from "node:assert/strict";
import test from "node:test";
import { providersFor } from "../src/aggregators.js";
import { chainByKey, feeRankOf } from "../src/chains.js";
import { loadConfig } from "../src/config.js";

test("Robinhood Chain and HyperEVM use the published chain ids and RPCs", () => {
  const robinhood = chainByKey("robinhood");
  assert.ok(robinhood);
  assert.deepEqual(robinhood?.chain, { kind: "evm", chainId: 4663 });
  assert.equal(robinhood?.defaultRpc, "https://rpc.mainnet.chain.robinhood.com");
  assert.equal(robinhood?.aggregator, "zeroex");
  const hyper = chainByKey("hyperevm");
  assert.equal(hyper?.chain.kind === "evm" ? hyper.chain.chainId : 0, 999);
  assert.equal(hyper?.defaultRpc, "https://rpc.hyperliquid.xyz/evm");
  assert.equal(chainByKey("zksync")?.liveSend, "disabled");
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

test("live mode is off unless the flag is the exact string true", () => {
  const dry = loadConfig({} as NodeJS.ProcessEnv);
  assert.equal(dry.live, false);
  assert.equal(dry.maxUsdPerTrade, 5);
  assert.equal(dry.maxLeverage, 1);
  assert.equal(loadConfig({ WHALE_BROADCAST: "false" } as NodeJS.ProcessEnv).live, false);
  const live = loadConfig({ WHALE_BROADCAST: "true" } as NodeJS.ProcessEnv);
  assert.equal(live.live, true);
  assert.throws(() => loadConfig({ MAX_SLIPPAGE_BPS: "400" } as NodeJS.ProcessEnv));
});
