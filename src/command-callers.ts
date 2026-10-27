import { formatUnits } from "viem";
import { chainByKey } from "./chains.js";
import { quoteHop } from "./clients.js";
import type { CommandDeps, WalletCommand } from "./commands.js";
import { loadConfig } from "./config.js";
import type { ExecutionReport, Holding, RouteQuote, SwapIntent } from "./domain.js";
import { evmReadClient, solanaConnection } from "./rpc.js";

const QUOTE_KEY_NAMES = ["ZEROX_API_KEY", "JUPITER_API_KEY", "LIFI_API_KEY", "ONEINCH_API_KEY", "OKX_API_KEY"] as const;

export function quoteProviderConfigured(env: NodeJS.ProcessEnv): boolean {
  return QUOTE_KEY_NAMES.some((name) => {
    const value = env[name];
    return typeof value === "string" && value.trim().length > 0;
  });
}

async function quoteWithHop(env: NodeJS.ProcessEnv, command: Extract<WalletCommand, { kind: "quote" }>): Promise<RouteQuote | null> {
  const config = loadConfig(env);
  const hop = await quoteHop(
    config,
    {
      sellAddress: command.sell.address,
      buyAddress: command.buy.address,
      sellAmount: command.sellAmount,
      chain: command.sell.chain,
      ...(command.sell.decimals === null ? {} : { sellDecimals: command.sell.decimals }),
      taker: command.taker,
    },
    null,
  );
  if (hop.buyAmount === "" || hop.buyAmount === "0") return null;
  return {
    planId: hop.provider ?? "hop",
    kind: "aggregator",
    hops: [`${command.sell.symbol}->${command.buy.symbol}`],
    priceImpactPct: hop.priceImpactPct ?? 0,
    feeUsd: hop.feeUsd,
    buyAmount: hop.buyAmount,
    ...(hop.provider ? { provider: hop.provider } : {}),
    ...(hop.gasUsd !== undefined ? { gasUsd: hop.gasUsd } : {}),
    ...(hop.netOutputUsd !== undefined ? { netOutputUsd: hop.netOutputUsd } : {}),
    ...(hop.signable !== undefined ? { signable: hop.signable } : {}),
    ...(hop.note ? { note: hop.note } : {}),
    chain: command.sell.chain,
    chainKey: command.sell.chainKey,
  };
}

export async function readAddressBalance(
  env: NodeJS.ProcessEnv,
  chainKey: string,
  address: string,
): Promise<{ holdings: Holding[]; reason?: string }> {
  const spec = chainByKey(chainKey);
  if (!spec) return { holdings: [], reason: `unknown chain ${chainKey}` };
  const url = env[spec.rpcEnv];
  if (!url) return { holdings: [], reason: `${spec.rpcEnv} is unset` };
  if (spec.chain.kind === "evm") {
    const raw = await evmReadClient([url]).getBalance({ address: address as `0x${string}` });
    const decimals = 18;
    return {
      holdings: [
        {
          symbol: spec.nativeSymbol,
          address,
          amount: Number(formatUnits(raw, decimals)),
          usd: 0,
          native: true,
          decimals,
          chainKey,
        },
      ],
    };
  }
  if (spec.chain.kind === "solana") {
    const { PublicKey } = await import("@solana/web3.js");
    const lamports = await solanaConnection(url).getBalance(new PublicKey(address));
    return {
      holdings: [
        {
          symbol: spec.nativeSymbol,
          address,
          amount: lamports / 1_000_000_000,
          usd: 0,
          native: true,
          decimals: 9,
          chainKey,
        },
      ],
    };
  }
  return { holdings: [], reason: `${chainKey} has no address balance read` };
}

async function postIntent(env: NodeJS.ProcessEnv, intent: SwapIntent): Promise<ExecutionReport> {
  const base = (env.EXECUTOR_URL ?? "http://127.0.0.1:8788").replace(/\/$/, "");
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (env.EXECUTOR_AUTH_TOKEN) headers.authorization = `Bearer ${env.EXECUTOR_AUTH_TOKEN}`;
  const response = await fetch(`${base}/execute`, { method: "POST", headers, body: JSON.stringify(intent) });
  if (!response.ok) throw new Error(`executor rejected the swap (${response.status})`);
  return (await response.json()) as ExecutionReport;
}

export function commandDeps(env: NodeJS.ProcessEnv, command: WalletCommand): CommandDeps {
  if (command.kind === "quote" && quoteProviderConfigured(env)) return { quote: (item) => quoteWithHop(env, item) };
  if (command.kind === "balance") return { readBalance: (chainKey, address) => readAddressBalance(env, chainKey, address) };
  if (command.kind === "swap" && command.mode === "live" && env.WHALE_BROADCAST === "true") return { execute: (intent) => postIntent(env, intent) };
  return {};
}
