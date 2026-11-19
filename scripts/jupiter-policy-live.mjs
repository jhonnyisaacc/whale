import { loadConfig } from "../dist/src/config.js";
import { prepareSolanaLeg } from "../dist/src/broadcast/solana.js";
import { withPolicy } from "../dist/src/managed-signer.js";

const OWNER = "111111111111111111111111WhaLeWa11et";
const MINTS = {
  SOL: { mint: "So11111111111111111111111111111111111111112", decimals: 9, ceilingUsd: 1_000 },
  USDC: { mint: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v", decimals: 6, ceilingUsd: 10 },
  USDT: { mint: "Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB", decimals: 6, ceilingUsd: 10 },
  JUP: { mint: "JUPyiwrYJFskUPiHa7hkeR8VUtAeFoSYbKedZNsDvCN", decimals: 6, ceilingUsd: 10 },
  BONK: { mint: "DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263", decimals: 5, ceilingUsd: 0.001 },
};
const ACCEPTED = "the signing policy accepted the transaction";
const QUOTE_MINT_ONLY = "solana: jupiter destination is not a hot wallet token account";
const LEGS = [
  ["USDC", "SOL", "1000000", ACCEPTED],
  ["SOL", "USDC", "10000000", ACCEPTED],
  ["USDC", "USDT", "1000000", ACCEPTED],
  ["JUP", "USDC", "1000000", ACCEPTED],
  ["BONK", "SOL", "100000000", ACCEPTED],
  ["SOL", "JUP", "10000000", QUOTE_MINT_ONLY],
  ["SOL", "BONK", "10000000", QUOTE_MINT_ONLY],
];
const config = loadConfig({ JUPITER_API_BASE: process.env.JUPITER_API_BASE ?? "https://lite-api.jup.ag/swap/v1" });
const inner = {
  backend: "keystore",
  evmAddress: () => null,
  solanaAddress: () => OWNER,
  signEvm: async () => {
    throw new Error("not used");
  },
  signSolana: async () => {
    throw new Error(ACCEPTED);
  },
  signHyperliquid: async () => {
    throw new Error("not used");
  },
};
const rpc = {
  simulate: async () => null,
  sendRaw: async () => {
    throw new Error("this check never sends");
  },
  latestBlockhash: async () => ({ blockhash: "11111111111111111111111111111111", lastValidBlockHeight: 0 }),
  blockHeight: async () => 0,
  status: async () => null,
  received: async () => null,
  lamports: async () => 0n,
  tokenAccount: async () => null,
};
const ctx = { config, signer: withPolicy(inner, config), rpc, owner: OWNER, fetchImpl: fetch, io: {}, onTx: async () => {}, secrets: [] };

let failed = 0;
for (const [sell, buy, sellAmount, expected] of LEGS) {
  await new Promise((resolve) => setTimeout(resolve, 2_000));
  const leg = { sellAddress: MINTS[sell].mint, buyAddress: MINTS[buy].mint, sellAmount, spentUsd: 0.0001, priceUsd: MINTS[buy].ceilingUsd, decimals: MINTS[buy].decimals };
  let outcome;
  try {
    const prepared = await prepareSolanaLeg(ctx, leg, 50, 300);
    await prepared.submit();
    outcome = "submitted, which this check never expects";
  } catch (error) {
    outcome = error instanceof Error ? error.message : String(error);
  }
  if (outcome !== expected) failed += 1;
  console.log(`${outcome === expected ? "as expected" : "UNEXPECTED"} ${sell} -> ${buy}: ${outcome}`);
}
process.exitCode = failed === 0 ? 0 : 1;
