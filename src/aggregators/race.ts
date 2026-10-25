import { createHmac } from "node:crypto";
import { withTimeout } from "../timeout.js";
import type { AppConfig } from "../config.js";
import type { QuoteHop } from "../quote-hop.js";
import { validSellAmount } from "../quote-hop.js";
import type { HopQuote } from "../executor.js";
import { chainByEvmId, gasCeilingUsd } from "../chains.js";
import { impactPctFromUsd, readJupiter, readLifi, readZeroEx } from "../quotes.js";
import { KYBER_SLUG, callProvider, chainKeyOf, empty, guardFor, jupiterHeaders, jupiterQuote, jupiterQuoteUrl, kyberRouteQuote, kyberRoutesUrl, lifiHeaders, lifiQuote, lifiUrl, nowMs, oneInchSchema, okxSchema, providersFor, quoteKyber, signableProvider, veloraSchema, withNet, zeroExHeaders, zeroExQuote, zeroExUrl, type QuoteProviderId, type Reference } from "./shared.js";

async function quoteOne(config: AppConfig, id: QuoteProviderId, hop: QuoteHop, reference: Reference | null, fetchImpl: typeof fetch, signal: AbortSignal): Promise<HopQuote> {
  const key = chainKeyOf(hop.chain);
  if (id === "jupiter") {
    const body = await callProvider(config, id, jupiterQuoteUrl(config, hop, config.raceSlippageBps), { headers: jupiterHeaders(config) }, fetchImpl, signal);
    if (!body) return empty();
    return withNet(jupiterQuote(config, body), reference, key, null);
  }
  if (hop.chain.kind !== "evm") {
    if (id !== "okx") return empty();
    return quoteOkx(config, "501", hop, reference, fetchImpl, signal, key);
  }
  const chainId = hop.chain.chainId;
  if (id === "zeroex") return quoteZeroExRace(config, hop, chainId, reference, fetchImpl, signal, key);
  if (id === "lifi") return quoteLifiSame(config, hop, chainId, reference, fetchImpl, signal, key);
  if (id === "oneinch") return quoteOneInch(config, hop, chainId, reference, fetchImpl, signal, key);
  if (id === "kyberswap") return quoteKyber(config, hop, chainId, reference, fetchImpl, signal, key);
  if (id === "velora") return quoteVelora(config, hop, chainId, reference, fetchImpl, signal, key);
  return quoteOkx(config, String(chainId), hop, reference, fetchImpl, signal, key);
}

async function quoteZeroExRace(config: AppConfig, hop: QuoteHop, chainId: number, reference: Reference | null, fetchImpl: typeof fetch, signal: AbortSignal, key: string): Promise<HopQuote> {
  const taker = hop.taker ?? null;
  const body = await callProvider(config, "zeroex", zeroExUrl(config, hop, chainId, taker, config.raceSlippageBps), { headers: zeroExHeaders(config) }, fetchImpl, signal);
  if (!body) return empty();
  return withNet({ ...zeroExQuote(body, reference), taker }, reference, key, null);
}

async function quoteLifiSame(config: AppConfig, hop: QuoteHop, chainId: number, reference: Reference | null, fetchImpl: typeof fetch, signal: AbortSignal, key: string): Promise<HopQuote> {
  const taker = hop.taker ?? null;
  if (!taker) return empty();
  const body = await callProvider(config, "lifi", lifiUrl(config, hop, chainId, taker, config.raceSlippageBps), { headers: lifiHeaders(config) }, fetchImpl, signal);
  if (!body) return empty();
  return withNet({ ...lifiQuote(config, body, reference, chainId), taker }, reference, key, null);
}

async function quoteOneInch(config: AppConfig, hop: QuoteHop, chainId: number, reference: Reference | null, fetchImpl: typeof fetch, signal: AbortSignal, key: string): Promise<HopQuote> {
  const url = new URL(`${config.oneInchBase}/swap/v6.1/${chainId}/quote`);
  url.searchParams.set("src", hop.sellAddress);
  url.searchParams.set("dst", hop.buyAddress);
  url.searchParams.set("amount", hop.sellAmount);
  const body = await callProvider(config, "oneinch", url.toString(), { headers: { Authorization: `Bearer ${config.keys.oneInch}` } }, fetchImpl, signal);
  const parsed = oneInchSchema.safeParse(body);
  if (!parsed.success) return empty();
  const impact = reference ? impactPctFromUsd(reference.spentUsd, Number(parsed.data.dstAmount) / 10 ** reference.decimals, reference.priceUsd) : null;
  return withNet({ priceImpactPct: impact, feeUsd: 0, buyAmount: parsed.data.dstAmount, provider: "oneinch", signable: false, raw: body }, reference, key, null);
}

async function quoteVelora(config: AppConfig, hop: QuoteHop, chainId: number, reference: Reference | null, fetchImpl: typeof fetch, signal: AbortSignal, key: string): Promise<HopQuote> {
  if (hop.sellDecimals === undefined || !reference) return empty();
  const url = new URL(`${config.veloraBase}/prices`);
  url.searchParams.set("version", "6.2");
  url.searchParams.set("srcDecimals", String(hop.sellDecimals));
  url.searchParams.set("destDecimals", String(reference.decimals));
  url.searchParams.set("srcToken", hop.sellAddress);
  url.searchParams.set("destToken", hop.buyAddress);
  url.searchParams.set("amount", hop.sellAmount);
  url.searchParams.set("side", "SELL");
  url.searchParams.set("network", String(chainId));
  if (config.keys.veloraPartner) url.searchParams.set("partner", config.keys.veloraPartner);
  const body = await callProvider(config, "velora", url.toString(), {}, fetchImpl, signal);
  const parsed = veloraSchema.safeParse(body);
  if (!parsed.success) return empty();
  const gas = parsed.data.priceRoute.gasCostUSD ? Number(parsed.data.priceRoute.gasCostUSD) : null;
  const impact = reference ? impactPctFromUsd(reference.spentUsd, Number(parsed.data.priceRoute.destAmount) / 10 ** reference.decimals, reference.priceUsd) : null;
  return withNet(
    { priceImpactPct: impact, feeUsd: 0, buyAmount: parsed.data.priceRoute.destAmount, provider: "velora", signable: false, raw: body },
    reference,
    key,
    Number.isFinite(gas ?? NaN) ? gas : null,
  );
}

async function quoteOkx(config: AppConfig, chainIndex: string, hop: QuoteHop, reference: Reference | null, fetchImpl: typeof fetch, signal: AbortSignal, key: string): Promise<HopQuote> {
  const path = `/api/v6/dex/aggregator/quote?${new URLSearchParams({
    chainIndex,
    amount: hop.sellAmount,
    fromTokenAddress: hop.sellAddress,
    toTokenAddress: hop.buyAddress,
    swapMode: "exactIn",
  }).toString()}`;
  const timestamp = new Date().toISOString();
  const sign = createHmac("sha256", config.keys.okxSecret ?? "")
    .update(`${timestamp}GET${path}`)
    .digest("base64");
  const body = await callProvider(
    config,
    "okx",
    `https://web3.okx.com${path}`,
    {
      headers: {
        "OK-ACCESS-KEY": config.keys.okxKey ?? "",
        "OK-ACCESS-SIGN": sign,
        "OK-ACCESS-TIMESTAMP": timestamp,
        "OK-ACCESS-PASSPHRASE": config.keys.okxPassphrase ?? "",
      },
    },
    fetchImpl,
    signal,
  );
  const parsed = okxSchema.safeParse(body);
  if (!parsed.success || parsed.data.code !== "0" || !parsed.data.data[0]) return empty();
  const row = parsed.data.data[0];
  const fee = row.tradeFee ? Number(row.tradeFee) : 0;
  const impact = reference ? impactPctFromUsd(reference.spentUsd, Number(row.toTokenAmount) / 10 ** reference.decimals, reference.priceUsd) : null;
  return withNet(
    { priceImpactPct: impact, feeUsd: Number.isFinite(fee) ? fee : 0, buyAmount: row.toTokenAmount, provider: "okx", signable: false, raw: body },
    reference,
    key,
    null,
  );
}

export function chooseQuote(quotes: readonly HopQuote[]): HopQuote {
  const usable = quotes.filter((quote) => quote.priceImpactPct !== null);
  if (usable.length === 0) return empty();
  const signable = usable.filter((quote) => quote.signable !== false);
  const pool = signable.length > 0 ? signable : usable;
  pool.sort((a, b) => {
    if (a.netOutputUsd !== undefined && b.netOutputUsd !== undefined && a.netOutputUsd !== b.netOutputUsd) return b.netOutputUsd - a.netOutputUsd;
    return (a.priceImpactPct ?? 0) - (b.priceImpactPct ?? 0) || a.feeUsd - b.feeUsd;
  });
  const winner = pool[0];
  if (!winner) return empty();
  const unsigned = usable
    .filter((quote) => quote.signable === false && quote.netOutputUsd !== undefined && (winner.netOutputUsd === undefined || quote.netOutputUsd > winner.netOutputUsd))
    .sort((a, b) => (b.netOutputUsd ?? 0) - (a.netOutputUsd ?? 0))[0];
  if (!unsigned?.provider) return winner;
  return { ...winner, note: `unsigned ${unsigned.provider} net ${unsigned.netOutputUsd}` };
}

export async function raceProviderQuotes(config: AppConfig, hop: QuoteHop, reference: Reference | null, fetchImpl: typeof fetch = fetch): Promise<HopQuote> {
  if (!validSellAmount(hop.sellAmount)) return empty();
  const ids = providersFor(hop.chain, config);
  if (ids.length === 0) return empty();
  const deadline = new AbortController();
  const deadlineTimer = setTimeout(() => deadline.abort(new Error("quote deadline")), config.quoteDeadlineMs);
  const slots: Array<HopQuote | undefined> = ids.map(() => undefined);
  await new Promise<void>((resolve) => {
    let pending = ids.length;
    let signablePending = ids.filter((id) => signableProvider(config, id)).length;
    let usableSignable = false;
    let done = false;
    let grace: ReturnType<typeof setTimeout> | undefined;
    const finish = () => {
      done = true;
      clearTimeout(grace);
      clearTimeout(timer);
      resolve();
    };
    const timer = setTimeout(finish, config.quoteDeadlineMs);
    const calls = ids.map((id, index) =>
      withTimeout(config.quoteTimeoutMs, (signal) => quoteOne(config, id, hop, reference, fetchImpl, signal), deadline.signal)
        .catch(() => empty())
        .then((quote) => {
          if (done) return;
          slots[index] = { ...quote, quotedAtMs: nowMs(config) };
          pending -= 1;
          if (signableProvider(config, id)) signablePending -= 1;
          if (quote.signable !== false && quote.priceImpactPct !== null) {
            usableSignable = true;
            grace ??= setTimeout(finish, config.raceGraceMs);
          }
          if (pending === 0 || (usableSignable && signablePending === 0)) finish();
        }),
    );
    void Promise.allSettled(calls).then(() => clearTimeout(deadlineTimer));
  });
  return chooseQuote(slots.filter((quote): quote is HopQuote => quote !== undefined));
}
