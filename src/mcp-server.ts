import { createInterface } from "node:readline";
import { z } from "zod";
import { run, type WalletCommand } from "./commands.js";
import type { LocalSend, LocalSendOutcome } from "./local-sends.js";
import { perpOrderSchema } from "./local-perps.js";
import { bridgeRequestSchema } from "./schemas.js";

export type McpDeps = {
  executorUrl: string;
  executorAuthToken: string | null;
  fetchImpl?: typeof fetch;
  runCommand?: typeof run;
  localSend?: (command: LocalSend) => Promise<LocalSendOutcome>;
};

const assetSchema = {
  type: "object",
  properties: {
    chain: { type: "object" },
    chainKey: { type: "string" },
    address: { type: "string" },
    symbol: { type: "string" },
    decimals: { type: ["number", "null"] },
  },
  required: ["chain", "chainKey", "address", "symbol", "decimals"],
};

export const TOOLS = [
  { name: "wallet_status", description: "Read executor status. It shows the mode, the enabled chains, and the caps. It moves no money.", inputSchema: { type: "object", properties: {} } },
  { name: "quote", description: "Quote a swap. With no provider this skips and does not hit the network.", inputSchema: { type: "object", properties: { sell: assetSchema, buy: assetSchema, sellAmount: { type: "string" }, taker: { type: ["string", "null"] }, slippageBps: { type: "number" } }, required: ["sell", "buy", "sellAmount", "slippageBps"] } },
  { name: "swap", description: "Swap on one chain. The default dry_run quotes the best signable route and returns would_swap, or skipped with the reason, and signs nothing. mode live needs whale-signer: Whale sizes the trade from notionalUsd, checks its caps, builds and simulates the transaction, and asks whale-signer, whose refusal is final. With WHALE_BROADCAST off the signed job is reported and not sent.", inputSchema: { type: "object", properties: { idempotencyKey: { type: "string" }, sell: assetSchema, buy: assetSchema, sellAmount: { type: "string" }, slippageBps: { type: "number" }, mode: { type: "string", enum: ["dry_run", "live"] }, notionalUsd: { type: "number" } }, required: ["idempotencyKey", "sell", "buy", "sellAmount", "slippageBps"] } },
  { name: "bridge", description: "Fetch bridge routes from LI.FI, Across, and Relay and rank them by fee. amount is in the asset's smallest unit. The destination must be an owner address on an enabled chain. The plan never broadcasts.", inputSchema: z.toJSONSchema(bridgeRequestSchema) },
  { name: "balance", description: "Read holdings for one chain and address. On Solana this includes SPL tokens. With no reader this fails.", inputSchema: { type: "object", properties: { chainKey: { type: "string" }, address: { type: "string" } }, required: ["chainKey", "address"] } },
  { name: "perp", description: "Trade a Hyperliquid perp with an immediate-or-cancel limit order sized from notionalUsd (in USD, not smallest units) at the mark price. coin is the perp's name in Hyperliquid's meta, such as ETH. side buy opens or grows a long or reduces a short; side sell reduces a long or opens or grows a short. The order trades on the account that whale-signer's key signs for. Whale reads the position in coin of HYPERLIQUID_ACCOUNT_ADDRESS, or of whale-signer's EVM address. When that address is another account, it first checks the key is an approved agent of it and refuses with hyperliquid agent is not approved otherwise. With no position it sets 1x isolated leverage before the order. With a position open, the order runs at that position's margin mode and leverage, cross included. When the position cannot be read, the order is skipped. It needs whale-signer (WHALE_SIGNER_KEYSTORE) in both modes. The default dry_run signs nothing and does not check HYPERCORE_SELL_LIMITS. In mode live Whale checks its caps and signing policy, and whale-signer's refusal is final. A live sell is refused unless HYPERCORE_SELL_LIMITS sets hypercore:perp:<asset>:sold. With WHALE_BROADCAST off the signed actions are reported and not sent.", inputSchema: z.toJSONSchema(perpOrderSchema, { io: "input" }) },
  { name: "perp_positions", description: "Read the Hyperliquid perp account from HYPERLIQUID_ACCOUNT_ADDRESS, or whale-signer's EVM address: account value, margin used, withdrawable, each position with side, size, entry, mark, liquidation price, unrealized PnL, leverage and funding, and the open orders. Each order has kind limit or trigger. A trigger order (stop, take profit, or trailing stop) carries orderType, triggerPx, triggerCondition and isMarket. triggerPx is null while a trailing stop waits for activation. A stop that has fired and still rests is a limit order. An order of unknown shape is listed in unreadableOrders with its oid, coin, orderType and the reason, so openOrders is complete only when unreadableOrders is empty. A trigger with isPositionTpsl true closes the whole position, so its size is \"entire position\". Take-profit and stop orders attached to a pending order are listed under that order in attached. Numbers are Hyperliquid's decimal strings in USD or coin units. Funding paid is positive. It moves no money.", inputSchema: { type: "object", properties: {} } },
  { name: "transfer", description: "Transfer to an owner address. amount is in the asset's smallest unit. The default dry_run sends nothing. mode live needs whale-signer: the destination must be in OWNER_WITHDRAW_ADDRESSES and inside Whale's USD caps, and whale-signer's refusal is final. With WHALE_BROADCAST off the signed job is reported and not sent.", inputSchema: { type: "object", properties: { idempotencyKey: { type: "string" }, asset: assetSchema, to: { type: "string" }, amount: { type: "string" }, mode: { type: "string", enum: ["dry_run", "live"] } }, required: ["idempotencyKey", "asset", "to", "amount"] } },
  { name: "bitcoin_wallet", description: "Read the native Bitcoin wallet: its P2WPKH address for BITCOIN_NETWORK, the confirmed and pending sats, and the USD value. Send BTC to this address to receive. It moves no money.", inputSchema: { type: "object", properties: {} } },
  { name: "send_bitcoin", description: "Send native BTC to an address in BITCOIN_WITHDRAW_ADDRESSES. sats is an integer number of satoshis. The default dry_run plans the coins and fee and signs nothing. mode live needs whale-signer: Whale refuses a fee rate above BITCOIN_MAX_FEE_RATE, checks its USD caps, and asks whale-signer, whose refusal is final. With WHALE_BROADCAST on, the signed transaction must pass testmempoolaccept through the indexer before it is broadcast. With WHALE_BROADCAST off the signed transaction is returned and not sent.", inputSchema: { type: "object", properties: { idempotencyKey: { type: "string" }, to: { type: "string" }, sats: { type: "string" }, mode: { type: "string", enum: ["dry_run", "live"] } }, required: ["idempotencyKey", "to", "sats"] } },
] as const;

const sendBitcoinArgs = z.object({ idempotencyKey: z.string().min(1).max(200), to: z.string().min(1).max(100), sats: z.string().max(20), mode: z.enum(["dry_run", "live"]).optional() });

async function callHttp(deps: McpDeps, route: string): Promise<unknown> {
  const fetchImpl = deps.fetchImpl ?? fetch;
  const headers: Record<string, string> = {};
  if (deps.executorAuthToken) headers.authorization = `Bearer ${deps.executorAuthToken}`;
  const response = await fetchImpl(`${deps.executorUrl.replace(/\/$/, "")}${route}`, { method: "GET", headers });
  const text = await response.text();
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return { status: response.status, text: text.slice(0, 500) };
  }
}

function commandFrom(name: string, args: Record<string, unknown>, liveSigner: boolean): WalletCommand {
  if (name === "swap" && args.mode === "live" && liveSigner) {
    if (!(typeof args.notionalUsd === "number" && args.notionalUsd > 0)) throw new Error("a live swap needs notionalUsd, a positive USD amount");
    return { ...args, kind: "swap", mode: "live", notionalUsd: args.notionalUsd } as WalletCommand;
  }
  if (name === "swap") return { ...args, kind: "swap", mode: "dry_run" } as WalletCommand;
  if (name === "bridge") return { kind: "bridge", ...bridgeRequestSchema.parse(args) };
  if (name === "transfer") return { ...args, kind: name, mode: args.mode === "live" ? "live" : "dry_run" } as WalletCommand;
  if (name === "send_bitcoin") {
    const parsed = sendBitcoinArgs.parse(args);
    return { kind: "send_bitcoin", idempotencyKey: parsed.idempotencyKey, to: parsed.to, sats: parsed.sats, mode: parsed.mode ?? "dry_run" };
  }
  if (name === "bitcoin_wallet") return { kind: "bitcoin_wallet" };
  if (name === "perp_positions") return { kind: "perp_positions" };
  if (name === "quote" || name === "balance") return { ...args, kind: name } as WalletCommand;
  throw new Error(`unknown tool ${name}`);
}

export async function callTool(deps: McpDeps, name: string, args: Record<string, unknown>): Promise<unknown> {
  if (name === "wallet_status") return callHttp(deps, "/status");
  if (name === "perp") {
    const order = { kind: "perp" as const, ...perpOrderSchema.parse(args) };
    if (!deps.localSend) return { kind: "perp", status: "skipped", reason: "a perp order needs whale-signer. set WHALE_SIGNER_KEYSTORE and run whale-signer serve" };
    return deps.localSend(order);
  }
  const execute = deps.runCommand ?? run;
  const command = commandFrom(name, args, Boolean(deps.localSend));
  if (deps.localSend && command.kind === "send_bitcoin") return deps.localSend(command);
  if (deps.localSend && (command.kind === "transfer" || command.kind === "swap") && command.mode === "live") return deps.localSend(command);
  if (command.kind === "transfer" || command.kind === "send_bitcoin" || (command.kind === "swap" && command.mode !== "dry_run")) return execute(command);
  const { commandDeps } = await import("./command-callers.js");
  return execute(command, commandDeps(process.env, command));
}

type JsonRpcRequest = { jsonrpc?: string; id?: unknown; method?: string; params?: { name?: string; arguments?: Record<string, unknown> } };

export function createHandler(deps: McpDeps) {
  return async (request: JsonRpcRequest): Promise<unknown> => {
    if (request.method === "initialize") {
      return { jsonrpc: "2.0", id: request.id ?? null, result: { protocolVersion: "2025-03-26", capabilities: { tools: {} }, serverInfo: { name: "whale", version: "0.1.0" } } };
    }
    if (request.method === "ping") return { jsonrpc: "2.0", id: request.id ?? null, result: {} };
    if (request.method === "tools/list") return { jsonrpc: "2.0", id: request.id ?? null, result: { tools: TOOLS } };
    if (request.method === "tools/call") {
      const name = request.params?.name ?? "";
      try {
        const value = await callTool(deps, name, request.params?.arguments ?? {});
        return { jsonrpc: "2.0", id: request.id ?? null, result: { content: [{ type: "text", text: JSON.stringify(value) }] } };
      } catch (error) {
        const { commandErrorText } = await import("./command-callers.js");
        return { jsonrpc: "2.0", id: request.id ?? null, result: { isError: true, content: [{ type: "text", text: commandErrorText(process.env, error) }] } };
      }
    }
    if (request.id === undefined) return null;
    return { jsonrpc: "2.0", id: request.id, error: { code: -32601, message: "method not found" } };
  };
}

export async function main(): Promise<void> {
  const deps: McpDeps = {
    executorUrl: process.env.EXECUTOR_URL ?? "http://127.0.0.1:8788",
    executorAuthToken: process.env.EXECUTOR_AUTH_TOKEN ?? process.env.AUTH_TOKEN ?? null,
  };
  const gatewayUrl = process.env.WHALE_GATEWAY_URL || undefined;
  const apiKey = process.env.WHALE_API_KEY || undefined;
  if (Boolean(gatewayUrl) !== Boolean(apiKey)) {
    process.stderr.write("whale: set both WHALE_GATEWAY_URL and WHALE_API_KEY to use a hosted gateway, or neither to use local tools\n");
    process.exit(1);
  }
  const { checkApiKey, createBridge, mcpEndpoint } = await import("./hosted-client.js");
  if (apiKey) {
    try {
      checkApiKey(apiKey);
    } catch {
      process.stderr.write("whale: WHALE_API_KEY must be one line of printable characters with no spaces\n");
      process.exit(1);
    }
  }
  if (gatewayUrl) {
    try {
      mcpEndpoint(gatewayUrl);
    } catch (error) {
      const reason = error instanceof TypeError ? "is not a URL" : "must be an https URL (http only for localhost) with no credentials, query, fragment, or API key in it";
      process.stderr.write(`whale: WHALE_GATEWAY_URL ${reason}\n`);
      process.exit(1);
    }
  }
  if (!gatewayUrl) {
    const { whaleSignerSetup } = await import("./whale-signer.js");
    let setup: ReturnType<typeof whaleSignerSetup> = null;
    try {
      setup = whaleSignerSetup(process.env);
    } catch (error) {
      process.stderr.write(`whale: whale-signer is not usable: ${error instanceof Error ? error.message : String(error)}\n`);
      process.exit(1);
    }
    if (setup) {
      const { startSignerQueue } = await import("./signer-queue.js");
      const { localSender } = await import("./local-sends.js");
      const queue = await startSignerQueue({ token: setup.token, port: setup.port, answerTimeoutMs: setup.answerTimeoutMs }).catch((error: unknown) => {
        process.stderr.write(`whale: cannot listen for whale-signer on 127.0.0.1:${setup.port}: ${error instanceof Error ? error.message : String(error)}\n`);
        process.exit(1);
      });
      try {
        deps.localSend = localSender(process.env, queue, setup);
      } catch (error) {
        await queue.close();
        const { commandErrorText } = await import("./command-callers.js");
        process.stderr.write(`whale: config is not usable: ${commandErrorText(process.env, error)}\n`);
        process.exit(1);
      }
      process.stdin.once("end", () => void queue.close());
      process.stderr.write(`whale: live sends go to whale-signer. run: whale-signer serve --gateway ${queue.url} --keystore <keystore> --policy <policy> --ledger <ledger>\n`);
    }
  }
  const handle = gatewayUrl && apiKey ? createBridge({ gatewayUrl, apiKey }) : createHandler(deps);
  const lines = createInterface({ input: process.stdin });
  lines.on("line", (line) => {
    void (async () => {
      if (!line.trim()) return;
      let message: unknown;
      try {
        message = JSON.parse(line);
      } catch {
        message = undefined;
      }
      if (typeof message !== "object" || message === null) {
        const error = message === undefined ? { code: -32700, message: "parse error" } : { code: -32600, message: "invalid request" };
        process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id: null, error })}\n`);
        return;
      }
      const reply = await handle(message as JsonRpcRequest);
      if (reply !== null) process.stdout.write(`${JSON.stringify(reply)}\n`);
    })();
  });
}

if ((process.argv[1] ?? "").endsWith("mcp-server.js")) await main();
