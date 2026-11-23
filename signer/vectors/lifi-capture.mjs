import { writeFileSync } from "node:fs";
import { privateKeyToAccount } from "viem/accounts";

const LIFI = process.env.LIFI_API_BASE ?? "https://li.quest/v1";
const OWN = privateKeyToAccount(`0x${"11".repeat(32)}`).address;
const NATIVE = "0x0000000000000000000000000000000000000000";
const target = new URL("./lifi-quotes.json", import.meta.url).pathname;

const CASES = [
  { name: "zkSync USDC to ETH", chainId: 324, sell: "0x1d17CBcF0D6D143135aE902365D2E5e2A16538D4", buy: NATIVE, fromAmount: "5000000" },
  { name: "zkSync ETH to USDC", chainId: 324, sell: NATIVE, buy: "0x1d17CBcF0D6D143135aE902365D2E5e2A16538D4", fromAmount: "1000000000000000" },
  { name: "Base USDC to WETH", chainId: 8453, sell: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913", buy: "0x4200000000000000000000000000000000000006", fromAmount: "5000000" },
  { name: "Arbitrum USDC to WETH", chainId: 42161, sell: "0xaf88d065e77c8cC2239327C5EDb3A432268e5831", buy: "0x82aF49447D8a07e3bd95BD0d56f35241523fBab1", fromAmount: "100000000" },
];

const quotes = [];
for (const item of CASES) {
  const url = new URL(`${LIFI}/quote`);
  for (const [key, value] of Object.entries({ fromChain: item.chainId, toChain: item.chainId, fromToken: item.sell, toToken: item.buy, fromAmount: item.fromAmount, fromAddress: OWN, slippage: 0.005 })) {
    url.searchParams.set(key, String(value));
  }
  const body = await (await fetch(url)).json();
  const request = body.transactionRequest;
  if (!request) throw new Error(`${item.name}: LI.FI gave no transaction: ${body.message ?? "no message"}`);
  quotes.push({ name: item.name, tool: body.tool, chainId: item.chainId, to: request.to, value: BigInt(request.value).toString(), data: request.data });
  console.log(`${item.name}: ${body.tool}, ${request.data.length / 2 - 1} bytes`);
}
writeFileSync(target, `${JSON.stringify({ capturedAt: new Date().toISOString(), own: OWN, quotes }, null, 2)}\n`);
