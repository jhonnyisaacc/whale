import { writeFileSync } from "node:fs";
import { lifiStartCall } from "./lifi-start.mjs";

const OWN = "0x19E7E376E7C213B7E7e7e46cc70A5dD086DAff2A";
const DESTINATION = "0x1111111111111111111111111111111111111111";
const BASE_USDC = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";
const ARBITRUM_USDC = "0xaf88d065e77c8cC2239327C5EDb3A432268e5831";
const AMOUNT = "2000000";
const out = new URL("../test/fixtures/bridge/", import.meta.url).pathname;
const captured = new Date().toISOString().slice(0, 10);
const route = (recipient) => ({ fromChainId: 8453, toChainId: 42161, sell: BASE_USDC, buy: ARBITRUM_USDC, amount: AMOUNT, from: OWN, recipient });

async function json(url, init) {
  const response = await fetch(url, init);
  if (!response.ok) throw new Error(`${url} answered ${response.status}`);
  return response.json();
}

async function lifiQuote(toAddress) {
  const query = { fromChain: "8453", toChain: "42161", fromToken: BASE_USDC, toToken: ARBITRUM_USDC, fromAmount: AMOUNT, fromAddress: OWN, toAddress, allowBridges: "across" };
  return json(`https://li.quest/v1/quote?${new URLSearchParams(query)}`);
}

async function lifi(name, toAddress) {
  const quote = await lifiQuote(toAddress);
  const { to, data, value, gasLimit } = quote.transactionRequest;
  const { toAmount, toAmountMin, approvalAddress } = quote.estimate;
  const fixture = { captured, source: "https://li.quest/v1/quote?allowBridges=across", route: route(toAddress), tool: quote.tool, steps: quote.includedSteps.map((step) => step.type), estimate: { toAmount, toAmountMin, approvalAddress }, tx: { to, data, value, gasLimit } };
  writeFileSync(`${out}${name}.json`, `${JSON.stringify(fixture, null, 2)}\n`);
}

async function lifiStart(name, toAddress) {
  const { to, data } = (await lifiQuote(toAddress)).transactionRequest;
  const derivedFrom = "the LI.FI swapAndStartBridgeTokensViaAcrossV4 quote with its fee-collection swap removed: minAmount is the whole charge and outputAmount is the charge times the quoted multiplier";
  const fixture = { captured, source: "https://li.quest/v1/quote?allowBridges=across", derivedFrom, route: route(toAddress), tx: { to, data: lifiStartCall(data, BigInt(AMOUNT)), value: "0x0" } };
  writeFileSync(`${out}${name}.json`, `${JSON.stringify(fixture, null, 2)}\n`);
}

async function across(name, recipient) {
  const query = { tradeType: "exactInput", amount: AMOUNT, inputToken: BASE_USDC, outputToken: ARBITRUM_USDC, originChainId: "8453", destinationChainId: "42161", depositor: OWN, recipient };
  const quote = await json(`https://app.across.to/api/swap/approval?${new URLSearchParams(query)}`);
  const { to, data, value, gas } = quote.swapTx;
  const { crossSwapType, inputAmount, expectedOutputAmount, minOutputAmount } = quote;
  const fixture = { captured, source: "https://app.across.to/api/swap/approval", route: route(recipient), crossSwapType, inputAmount, expectedOutputAmount, minOutputAmount, tx: { to, data, value: value ?? "0", gas: gas ?? null } };
  writeFileSync(`${out}${name}.json`, `${JSON.stringify(fixture, null, 2)}\n`);
}

async function relay(name) {
  const body = { user: OWN, recipient: OWN, originChainId: 8453, destinationChainId: 42161, originCurrency: BASE_USDC, destinationCurrency: ARBITRUM_USDC, amount: AMOUNT, tradeType: "EXACT_INPUT" };
  const quote = await json("https://api.relay.link/quote/v2", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  const steps = quote.steps.map((step) => ({ id: step.id, requestId: step.requestId, txs: step.items.map((item) => ({ to: item.data.to, data: item.data.data, value: item.data.value })) }));
  writeFileSync(`${out}${name}.json`, `${JSON.stringify({ captured, source: "https://api.relay.link/quote/v2", route: route(OWN), steps }, null, 2)}\n`);
}

await lifi("lifi-swap-and-start-base-arbitrum", OWN);
await lifiStart("lifi-start-base-arbitrum", OWN);
await lifiStart("lifi-start-base-arbitrum-destination", DESTINATION);
await across("across-base-arbitrum", OWN);
await across("across-base-arbitrum-destination", DESTINATION);
await relay("relay-base-arbitrum");
