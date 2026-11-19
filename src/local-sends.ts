import { z } from "zod";
import { addressKey, chainByKey, dexscreenerSlugMap } from "./chains.js";
import { swapIntent, type Asset, type WalletCommand } from "./commands.js";
import { configSecrets, loadConfig, type AppConfig } from "./config.js";
import type { Holding, TxRecord } from "./domain.js";
import { broadcastRoute, NATIVE_SELL, recoverToken, withdrawNative } from "./broadcast.js";
import { createBalanceCache } from "./balances.js";
import { chainReader } from "./executor-server/chain-reader.js";
import { createExecutor } from "./executor-server.js";
import { restoreSpent, spentToday } from "./executor.js";
import { withPolicy, type TransactionSigner } from "./managed-signer.js";
import { coingeckoLoader, createPriceCache, pricedHoldings, type PriceOf } from "./prices.js";
import { spendDay } from "./spend.js";
import { withTimeout } from "./timeout.js";
import { readVendorText, vendorResponse } from "./vendor-fetch.js";
import { WSOL_MINT } from "./signing-policy.js";
import type { SignerQueue } from "./signer-queue.js";
import { SignerRefusal, whaleSigner, type SignerJobRecord, type WhaleSignerSetup } from "./whale-signer.js";

export type LocalSend = Extract<WalletCommand, { kind: "swap"; mode: "live" } | { kind: "transfer" }>;

export type LocalSendResult = {
  kind: "swap" | "transfer";
  status: "signed" | "sent" | "skipped";
  reason: string;
  broadcast: boolean;
  jobs: SignerJobRecord[];
  txs: TxRecord[];
};

const HELD = "signed by whale-signer and not sent, because WHALE_BROADCAST is off";

export function isNativeAsset(asset: Pick<Asset, "chainKey" | "address">): boolean {
  return chainByKey(asset.chainKey)?.chain.kind === "solana" ? asset.address === WSOL_MINT : NATIVE_SELL.has(asset.address.toLowerCase());
}

function holdingOf(asset: Asset): Holding {
  const native = isNativeAsset(asset);
  return { symbol: asset.symbol, address: asset.address, amount: 0, usd: 0, native, chainKey: asset.chainKey, ...(asset.decimals === null ? {} : { decimals: asset.decimals }) };
}

const dexPairs = z.array(z.object({ baseToken: z.object({ address: z.string() }).loose(), priceUsd: z.string().optional(), liquidity: z.object({ usd: z.number().optional() }).loose().optional() }).loose());

async function dexscreenerPrice(config: AppConfig, asset: Asset): Promise<number | null> {
  const slug = [...dexscreenerSlugMap(config.dexscreenerSlugOverrides)].find(([, chainKey]) => chainKey === asset.chainKey)?.[0];
  if (!slug) return null;
  const pairs = await withTimeout(config.priceTimeoutMs, async (signal) => {
    const response = await vendorResponse(fetch, `${config.dexscreenerBase.replace(/\/$/, "")}/token-pairs/v1/${encodeURIComponent(slug)}/${encodeURIComponent(asset.address)}`, { signal });
    return response.ok ? dexPairs.parse(JSON.parse(await readVendorText(response))) : [];
  }).catch(() => []);
  const own = addressKey(asset.chainKey, asset.address);
  const deepest = pairs.filter((pair) => addressKey(asset.chainKey, pair.baseToken.address) === own).sort((a, b) => (b.liquidity?.usd ?? 0) - (a.liquidity?.usd ?? 0))[0];
  const usd = Number(deepest?.priceUsd);
  return Number.isFinite(usd) && usd > 0 ? usd : null;
}

async function usdPrices(config: AppConfig, assets: readonly Asset[]): Promise<PriceOf> {
  const prices = createPriceCache(coingeckoLoader(config, pricedHoldings(assets.map(holdingOf), config.enabledChainKeys)), config.priceMaxAgeMs);
  await prices.refresh().catch(() => undefined);
  const fallback = new Map<string, number | null>();
  for (const asset of assets) {
    if (prices.priceOf(holdingOf(asset)) === null && !isNativeAsset(asset)) fallback.set(addressKey(asset.chainKey, asset.address), await dexscreenerPrice(config, asset));
  }
  return (holding) => prices.priceOf(holding) ?? (holding.chainKey ? (fallback.get(addressKey(holding.chainKey, holding.address)) ?? null) : null);
}

function settled(kind: LocalSendResult["kind"], jobs: SignerJobRecord[], txs: TxRecord[], fallback: string): LocalSendResult {
  const refused = jobs.find((job) => job.decision === "refused");
  if (refused) throw new SignerRefusal(refused.id, refused.reasons ?? []);
  if (txs.length > 0 && txs.every((tx) => tx.outcome === "signed")) return { kind, status: "signed", reason: HELD, broadcast: false, jobs, txs };
  if (txs.some((tx) => tx.outcome !== "signed")) return { kind, status: "sent", reason: fallback, broadcast: true, jobs, txs };
  return { kind, status: "skipped", reason: fallback, broadcast: false, jobs, txs };
}

export function localSender(env: NodeJS.ProcessEnv, queue: SignerQueue, setup: WhaleSignerSetup) {
  const config = loadConfig(env);
  const secrets = configSecrets(config).filter((item) => item.length >= 8);
  const addresses = { evm: setup.evmAddress, solana: setup.solanaAddress };
  const signerFor = (jobs: SignerJobRecord[]): TransactionSigner => withPolicy(whaleSigner(queue, addresses, jobs), config);
  const reader = signerFor([]);
  const executor = createExecutor(config, reader, config.live ? config.databaseUrl : null, {
    priceOf: () => null,
    balances: createBalanceCache(chainReader(config, reader), config.balanceCacheMs),
    secrets,
  });
  const hold = !config.live;
  const day = () => spendDay(new Date(), config.spendTimezone);

  async function swap(command: Extract<LocalSend, { kind: "swap" }>): Promise<LocalSendResult> {
    const priceOf = await usdPrices(config, [command.sell, command.buy]);
    if (priceOf(holdingOf(command.sell)) === null) return { kind: "swap", status: "skipped", reason: `no USD price for ${command.sell.symbol}, so the caps cannot be checked`, broadcast: false, jobs: [], txs: [] };
    const buyPriceUsd = priceOf(holdingOf(command.buy));
    if (buyPriceUsd === null) return { kind: "swap", status: "skipped", reason: `no USD price for ${command.buy.symbol}, so the minimum output cannot be checked`, broadcast: false, jobs: [], txs: [] };
    const jobs: SignerJobRecord[] = [];
    const signer = signerFor(jobs);
    const base = swapIntent(command, Date.now());
    const top = { poolAddress: "", dex: "whale-price", chainKey: command.buy.chainKey, baseSymbol: command.buy.symbol, baseAddress: command.buy.address, quoteSymbol: "USD", quoteAddress: "", liquidityUsd: 0, priceUsd: buyPriceUsd, baseDecimals: command.buy.decimals };
    const intent = { ...base, token: { ...base.token, pairMap: { pools: [], top } }, holdings: base.holdings.map((holding) => ({ ...holding, native: isNativeAsset(command.sell) })) };
    const report = await executor.execute(intent, {
      mode: "live",
      priceOf,
      send: (request, onTx) => broadcastRoute(config, signer, request, config.maxSlippageBps / 100, fetch, secrets, { onTx, hold }),
    });
    return settled("swap", jobs, report.txs ?? [], report.reason);
  }

  async function transfer(command: Extract<LocalSend, { kind: "transfer" }>): Promise<LocalSendResult> {
    const skip = (reason: string): LocalSendResult => ({ kind: "transfer", status: "skipped", reason, broadcast: false, jobs: [], txs: [] });
    if (!/^[1-9]\d{0,77}$/.test(command.amount)) return skip("amount is a positive integer in the asset's smallest unit");
    const { asset } = command;
    const spec = chainByKey(asset.chainKey);
    if (!spec || !config.enabledChainKeys.has(spec.key)) return skip(`chain ${asset.chainKey} is disabled`);
    const native = isNativeAsset(asset);
    const decimals = native ? (spec.chain.kind === "solana" ? 9 : 18) : asset.decimals;
    if (decimals === null) return skip("a token transfer needs the token's decimals");
    if (!config.withdrawAllowlist.some((item) => item.toLowerCase() === command.to.toLowerCase())) return skip("destination is not in OWNER_WITHDRAW_ADDRESSES");
    const unit = (await usdPrices(config, [asset]))(holdingOf(asset));
    if (unit === null) return skip(`no USD price for ${asset.symbol}, so the caps cannot be checked`);
    const usd = (Number(command.amount) / 10 ** decimals) * unit;
    if (!(usd <= config.maxUsdPerTrade)) return skip(`notional exceeds ${config.maxUsdPerTrade} USD`);
    if (spentToday(executor.state, day()) + usd > config.dailyUsdCap) return skip(`daily cap ${config.dailyUsdCap} USD`);
    const jobs: SignerJobRecord[] = [];
    const txs: TxRecord[] = [];
    const input = { config, signer: signerFor(jobs), chainKey: spec.key, to: command.to, amount: BigInt(command.amount), secrets, hold, onTx: async (tx: TxRecord) => void txs.push(tx) };
    const done = await (native ? withdrawNative(input) : recoverToken({ ...input, mint: asset.address, decimals })).catch((error: unknown) => {
      if (jobs.some((job) => job.decision === "refused")) return null;
      throw error;
    });
    if (done && done.outcome !== "signed") restoreSpent(executor.state, spentToday(executor.state, day()) + usd, day());
    return settled("transfer", jobs, done ? [done] : txs, done ? `transfer ${done.outcome}` : "transfer refused");
  }

  const seen = new Map<string, { fingerprint: string; result: Promise<LocalSendResult> }>();
  return (command: LocalSend): Promise<LocalSendResult> => {
    const fingerprint = JSON.stringify(command);
    const known = seen.get(command.idempotencyKey);
    if (known) return known.fingerprint === fingerprint ? known.result : Promise.reject(new Error("this idempotencyKey was used for a different command"));
    const result = command.kind === "swap" ? swap(command) : transfer(command);
    seen.set(command.idempotencyKey, { fingerprint, result });
    result.catch(() => seen.delete(command.idempotencyKey));
    return result;
  };
}
