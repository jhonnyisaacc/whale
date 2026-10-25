import { QUOTE_ASSETS, chainByKey } from "./chains.js";
import { providersFor, raceProviderQuotes } from "./aggregators.js";
import { guardFor } from "./aggregators.js";
import type { AppConfig } from "./config.js";
import { loadConfig } from "./config.js";
import type { QuoteHop } from "./quote-hop.js";

export type CanaryCase = { chainKey: string; hop: QuoteHop; providers: string[] };
export type CanaryResult = { chainKey: string; status: "pass" | "fail"; provider: string | null; target: string | null; errorClass: "empty" | null };
export type CanaryReport = { live: false; results: CanaryResult[]; providers: ReturnType<typeof guardFor>["snapshot"] extends () => infer T ? T : never };

export function buildCanaryCases(config: AppConfig): CanaryCase[] {
  const cases: CanaryCase[] = [];
  for (const chainKey of config.enabledChainKeys) {
    const spec = chainByKey(chainKey);
    if (!spec || spec.chain.kind === "hypercore") continue;
    const assets = (config.quoteAssets ?? QUOTE_ASSETS)[chainKey] ?? QUOTE_ASSETS[chainKey] ?? [];
    if (assets.length === 0) continue;
    const sell = assets[0];
    const buy = assets[1] ?? assets[0];
    cases.push({
      chainKey,
      providers: providersFor(spec.chain, config),
      hop: { sellAddress: sell.address, buyAddress: buy.address, sellAmount: (5n * 10n ** BigInt(sell.decimals)).toString(), chain: spec.chain, sellDecimals: sell.decimals, taker: process.env.CANARY_TAKER ?? null },
    });
  }
  return cases;
}

export async function runCanary(config: AppConfig, fetchImpl: typeof fetch = fetch): Promise<CanaryReport> {
  if (config.live) throw new Error("canary refuses to run in live mode");
  const results: CanaryResult[] = [];
  for (const item of buildCanaryCases(config)) {
    const quote = await raceProviderQuotes(config, item.hop, null, fetchImpl);
    const pass = quote.signable === true && quote.buyAmount !== "0" && quote.priceImpactPct !== null;
    results.push({ chainKey: item.chainKey, status: pass ? "pass" : "fail", provider: quote.provider ?? null, target: quote.prepared?.to ?? null, errorClass: pass ? null : "empty" });
  }
  return { live: false, results, providers: guardFor(config).snapshot() };
}

const entry = process.argv[1] ?? "";
if (entry.endsWith("canary.js")) {
  const config = loadConfig();
  runCanary(config)
    .then((report) => {
      console.log(JSON.stringify(report));
      if (report.results.some((result) => result.status === "fail")) process.exit(1);
    })
    .catch((error: unknown) => {
      console.error(JSON.stringify({ canary: error instanceof Error ? error.message : "canary failed" }));
      process.exit(1);
    });
}
