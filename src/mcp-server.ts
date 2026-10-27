import { createInterface } from "node:readline";
import { run, type WalletCommand } from "./commands.js";

export type McpDeps = {
  executorUrl: string;
  executorAuthToken: string | null;
  fetchImpl?: typeof fetch;
  runCommand?: typeof run;
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
  { name: "swap", description: "Dry-run a swap. It broadcasts nothing.", inputSchema: { type: "object", properties: { idempotencyKey: { type: "string" }, sell: assetSchema, buy: assetSchema, sellAmount: { type: "string" }, slippageBps: { type: "number" } }, required: ["idempotencyKey", "sell", "buy", "sellAmount", "slippageBps"] } },
  { name: "bridge", description: "Rank caller-supplied bridge quotes. The plan never broadcasts.", inputSchema: { type: "object", properties: {}, additionalProperties: true } },
  { name: "balance", description: "Read holdings for one chain and address. With no reader this returns an empty list.", inputSchema: { type: "object", properties: { chainKey: { type: "string" }, address: { type: "string" } }, required: ["chainKey", "address"] } },
  { name: "transfer", description: "Dry-run a transfer. Live mode is skipped because local signing is not wired for live sends.", inputSchema: { type: "object", properties: { idempotencyKey: { type: "string" }, asset: assetSchema, to: { type: "string" }, amount: { type: "string" }, mode: { type: "string" } }, required: ["idempotencyKey", "asset", "to", "amount"] } },
] as const;

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

function commandFrom(name: string, args: Record<string, unknown>): WalletCommand {
  if (name === "swap") return { kind: "swap", ...args, mode: "dry_run" } as WalletCommand;
  if (name === "quote" || name === "bridge" || name === "balance" || name === "transfer") {
    return { kind: name, ...args } as WalletCommand;
  }
  throw new Error(`unknown tool ${name}`);
}

export async function callTool(deps: McpDeps, name: string, args: Record<string, unknown>): Promise<unknown> {
  if (name === "wallet_status") return callHttp(deps, "/status");
  const execute = deps.runCommand ?? run;
  const command = commandFrom(name, args);
  if (command.kind !== "quote" && command.kind !== "balance") return execute(command);
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
        return { jsonrpc: "2.0", id: request.id ?? null, result: { isError: true, content: [{ type: "text", text: error instanceof Error ? error.message : "tool failed" }] } };
      }
    }
    if (request.id === undefined) return null;
    return { jsonrpc: "2.0", id: request.id, error: { code: -32601, message: "method not found" } };
  };
}

const entry = process.argv[1] ?? "";
if (entry.endsWith("mcp-server.js")) {
  const deps: McpDeps = {
    executorUrl: process.env.EXECUTOR_URL ?? "http://127.0.0.1:8788",
    executorAuthToken: process.env.EXECUTOR_AUTH_TOKEN ?? process.env.AUTH_TOKEN ?? null,
  };
  const handle = createHandler(deps);
  const lines = createInterface({ input: process.stdin });
  lines.on("line", (line) => {
    void (async () => {
      if (!line.trim()) return;
      const reply = await handle(JSON.parse(line) as JsonRpcRequest);
      if (reply !== null) process.stdout.write(`${JSON.stringify(reply)}\n`);
    })();
  });
}
