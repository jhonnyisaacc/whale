import { writeFileSync } from "node:fs";
import { Keypair, VersionedTransaction } from "@solana/web3.js";

const JUPITER = process.env.JUPITER_BASE ?? "https://lite-api.jup.ag/swap/v1";
const SEED_TEXT = "whale-signer jupiter v0 fixtures";
const OWN = Keypair.fromSeed(Buffer.from(SEED_TEXT)).publicKey.toBase58();
const FUNDED = "9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM";
const target = new URL("./jupiter.json", import.meta.url).pathname;

const SOL = "So11111111111111111111111111111111111111112";
const USDC = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
const BONK = "DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263";
const WIF = "EKpQGSJtjMFqKZ9KQanSqYXRcF8fBopzLHYxdM65zcjm";
const JITOSOL = "J1toso1uCk3RLmjorhTtrVwY9HJ7X8V9yYac6Y7kGCPn";
const PYUSD = "2b1kV6DkPAnxd5ixfnxCpjxmKwqjjaYmCZfHsFu24GXo";

const CASES = [
  { name: "SOL to USDC", owner: OWN, inputMint: SOL, outputMint: USDC, amount: "10000000", shared: true },
  { name: "USDC to SOL", owner: OWN, inputMint: USDC, outputMint: SOL, amount: "1000000", shared: true },
  { name: "USDC to BONK", owner: OWN, inputMint: USDC, outputMint: BONK, amount: "1000000", shared: true },
  { name: "BONK to WIF", owner: OWN, inputMint: BONK, outputMint: WIF, amount: "100000000000", shared: true },
  { name: "SOL to BONK with a Jito tip", owner: OWN, inputMint: SOL, outputMint: BONK, amount: "10000000", shared: true, jito: 10000 },
  { name: "SOL to JitoSOL with a Jito tip", owner: OWN, inputMint: SOL, outputMint: JITOSOL, amount: "10000000", shared: true, jito: 10000 },
  { name: "USDC to PYUSD, a Token-2022 mint", owner: OWN, inputMint: USDC, outputMint: PYUSD, amount: "1000000", shared: true },
  { name: "SOL to USDC as route", owner: OWN, inputMint: SOL, outputMint: USDC, amount: "10000000", shared: false },
  { name: "USDC to BONK as route", owner: OWN, inputMint: USDC, outputMint: BONK, amount: "1000000", shared: false },
  { name: "funded SOL to USDC", owner: FUNDED, inputMint: SOL, outputMint: USDC, amount: "10000000", shared: true, slippageBps: 300 },
  { name: "funded USDC to BONK", owner: FUNDED, inputMint: USDC, outputMint: BONK, amount: "1000000", shared: true, slippageBps: 300 },
];

const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function json(url, init, attempt = 0) {
  await pause(1500);
  const response = await fetch(url, init);
  if (response.status === 429 && attempt < 5) return json(url, init, attempt + 1);
  const body = await response.json();
  if (!response.ok || body.error) throw new Error(`${url}: ${JSON.stringify(body)}`);
  return body;
}

async function capture(spec) {
  const slippageBps = spec.slippageBps ?? 50;
  const quote = await json(`${JUPITER}/quote?inputMint=${spec.inputMint}&outputMint=${spec.outputMint}&amount=${spec.amount}&slippageBps=${slippageBps}`);
  const swap = await json(`${JUPITER}/swap`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      quoteResponse: quote,
      userPublicKey: spec.owner,
      wrapAndUnwrapSol: true,
      dynamicComputeUnitLimit: true,
      useSharedAccounts: spec.shared,
      prioritizationFeeLamports: spec.jito ? { jitoTipLamports: spec.jito } : { priorityLevelWithMaxLamports: { maxLamports: 100000, priorityLevel: "veryHigh" } },
    }),
  });
  const message = VersionedTransaction.deserialize(Buffer.from(swap.swapTransaction, "base64")).message;
  return {
    name: spec.name,
    owner: spec.owner,
    inputMint: spec.inputMint,
    outputMint: spec.outputMint,
    inAmount: quote.inAmount,
    amms: quote.routePlan.map((step) => step.swapInfo.label),
    lookupTables: message.addressTableLookups.length,
    messageHex: Buffer.from(message.serialize()).toString("hex"),
  };
}

const cases = [];
for (const spec of CASES) cases.push(await capture(spec));
writeFileSync(target, `${JSON.stringify({ capturedAt: new Date().toISOString(), seedText: SEED_TEXT, own: OWN, funded: FUNDED, cases }, null, 2)}\n`);
console.log(cases.map((entry) => `${entry.name}: ${entry.amms.join(" > ")}, ${entry.lookupTables} tables, ${entry.messageHex.length / 2} bytes`).join("\n"));
