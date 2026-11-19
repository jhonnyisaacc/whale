import { writeFileSync } from "node:fs";

const BASE = "https://lite-api.jup.ag/swap/v1";
const OWNER = "111111111111111111111111WhaLeWa11et";
const USDC = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
const SOL = "So11111111111111111111111111111111111111112";
const BONK = "DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263";
const PYUSD = "2b1kV6DkPAnxd5ixfnxCpjxmKwqjjaYmCZfHsFu24GXo";

const ONLY = new Set(process.argv.slice(2));
const CASES = [
  { name: "usdc-sol-route", inputMint: USDC, outputMint: SOL, amount: "1000000", useSharedAccounts: false },
  { name: "usdc-sol-shared", inputMint: USDC, outputMint: SOL, amount: "1000000", useSharedAccounts: true, excludeDexes: "Manifest" },
  { name: "usdc-sol-manifest-shared", inputMint: USDC, outputMint: SOL, amount: "1000000", useSharedAccounts: true, dexes: "Manifest" },
  { name: "sol-bonk-shared", inputMint: SOL, outputMint: BONK, amount: "10000000", useSharedAccounts: true },
  { name: "usdc-pyusd-shared", inputMint: USDC, outputMint: PYUSD, amount: "1000000", useSharedAccounts: true },
];

async function json(url, init) {
  await new Promise((resolve) => setTimeout(resolve, 2_000));
  const response = await fetch(url, init);
  if (!response.ok) throw new Error(`${url} answered ${response.status}`);
  return response.json();
}

for (const { name, inputMint, outputMint, amount, useSharedAccounts, ...filter } of CASES) {
  if (ONLY.size > 0 && !ONLY.has(name)) continue;
  const quote = await json(`${BASE}/quote?${new URLSearchParams({ inputMint, outputMint, amount, slippageBps: "50", ...filter })}`);
  const request = {
    userPublicKey: OWNER,
    wrapAndUnwrapSol: true,
    dynamicComputeUnitLimit: true,
    prioritizationFeeLamports: { priorityLevelWithMaxLamports: { maxLamports: 1_000_000, priorityLevel: "veryHigh" } },
    useSharedAccounts,
  };
  const built = await json(`${BASE}/swap`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ quoteResponse: quote, ...request }) });
  const { inAmount, outAmount, otherAmountThreshold, swapMode, slippageBps, routePlan } = quote;
  const fixture = {
    captured: new Date().toISOString().slice(0, 10),
    source: `${BASE}/swap`,
    request,
    quote: { inputMint, outputMint, inAmount, outAmount, otherAmountThreshold, swapMode, slippageBps },
    steps: routePlan.map((step) => step.swapInfo.label),
    transaction: built.swapTransaction,
  };
  writeFileSync(new URL(`../test/fixtures/jupiter/${name}.json`, import.meta.url), `${JSON.stringify(fixture, null, 2)}\n`);
  console.log(`${name}: ${built.swapTransaction.length} base64 chars`);
}
