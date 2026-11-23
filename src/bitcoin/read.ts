import type { BitcoinWalletView } from "../commands.js";
import type { AppConfig } from "../config.js";
import type { Holding } from "../domain.js";
import { coingeckoLoader, createPriceCache } from "../prices.js";
import type { BitcoinIndexer } from "./esplora.js";
import { BITCOIN_KEY, destinationScript, type BitcoinNetwork, type BitcoinWallet } from "./wallet.js";

const SATS_PER_BTC = 100_000_000;

export function btcHolding(address: string, sats = 0n): Holding {
  return { symbol: "BTC", address, amount: Number(sats) / SATS_PER_BTC, raw: String(sats), usd: 0, native: true, decimals: 8, chainKey: BITCOIN_KEY };
}

export function satsUsd(sats: bigint, unit: number): number {
  return (Number(sats) / SATS_PER_BTC) * unit;
}

export async function btcUsd(config: AppConfig, fetchImpl: typeof fetch = fetch): Promise<number | null> {
  const holding = btcHolding("");
  const prices = createPriceCache(coingeckoLoader(config, [holding], fetchImpl), config.priceMaxAgeMs);
  await prices.refresh().catch(() => undefined);
  return prices.priceOf(holding);
}

export async function bitcoinBalance(indexer: BitcoinIndexer, address: string, network: BitcoinNetwork): Promise<{ holdings: Holding[]; reason?: string }> {
  if (!destinationScript(address, network)) return { holdings: [], reason: `${address} is not a ${network} bitcoin address` };
  const balance = await indexer.balance(address).catch(() => null);
  if (!balance) return { holdings: [], reason: "the Esplora indexer did not return a balance" };
  const holdings = [btcHolding(address, balance.confirmedSats)];
  return balance.pendingSats === 0n ? { holdings } : { holdings, reason: `${balance.pendingSats} sats are unconfirmed` };
}

export async function bitcoinWalletView(config: AppConfig, wallet: BitcoinWallet, indexer: BitcoinIndexer): Promise<BitcoinWalletView> {
  const [balance, unit] = await Promise.all([indexer.balance(wallet.address), btcUsd(config)]);
  return {
    kind: "bitcoin_wallet",
    status: "read",
    network: wallet.network,
    address: wallet.address,
    confirmedSats: String(balance.confirmedSats),
    pendingSats: String(balance.pendingSats),
    usd: unit === null ? null : satsUsd(balance.confirmedSats, unit),
  };
}
