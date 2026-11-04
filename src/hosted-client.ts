// A dependency-free client for a hosted Whale gateway. It speaks MCP over HTTP with an agent key, so a bot gets the
// same tools, limits, and approvals an MCP client gets. It holds no key and signs nothing.
export type HostedClientOptions = { gatewayUrl: string; apiKey: string; fetchImpl?: typeof fetch; timeoutMs?: number };

export class WhaleToolError extends Error {
  constructor(
    readonly tool: string,
    message: string,
  ) {
    super(message);
  }
}

const LOCAL = /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/;

export function mcpEndpoint(gatewayUrl: string): string {
  const base = gatewayUrl.replace(/\/+$/, "");
  if (!base.startsWith("https://") && !LOCAL.test(base)) throw new Error("the gateway URL must be https (http only for localhost)");
  return `${base}/mcp`;
}

export function createHostedClient(options: HostedClientOptions) {
  const endpoint = mcpEndpoint(options.gatewayUrl);
  const fetchImpl = options.fetchImpl ?? fetch;
  let id = 0;

  async function rpc(method: string, params: Record<string, unknown> = {}): Promise<unknown> {
    id += 1;
    const response = await fetchImpl(endpoint, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json, text/event-stream", authorization: `Bearer ${options.apiKey}`, "mcp-protocol-version": "2025-06-18" },
      body: JSON.stringify({ jsonrpc: "2.0", id, method, params }),
      signal: AbortSignal.timeout(options.timeoutMs ?? 20_000),
    });
    if (response.status === 401) throw new Error("the gateway refused this API key");
    if (!response.ok) throw new Error(`the gateway answered ${response.status}`);
    const body = (await response.json()) as { result?: unknown; error?: { message?: string } };
    if (body.error) throw new Error(body.error.message ?? "the gateway returned an error");
    return body.result;
  }

  async function call<T>(tool: string, args: Record<string, unknown> = {}): Promise<T> {
    const result = (await rpc("tools/call", { name: tool, arguments: args })) as { isError?: boolean; content?: { type: string; text: string }[] };
    const text = result.content?.find((part) => part.type === "text")?.text ?? "";
    if (result.isError) throw new WhaleToolError(tool, text);
    try {
      return JSON.parse(text) as T;
    } catch {
      return text as T;
    }
  }

  return {
    rpc,
    call,
    tools: async () => ((await rpc("tools/list")) as { tools: { name: string; description: string }[] }).tools,
    walletStatus: () => call<Record<string, unknown>>("wallet_status"),
    depositAddress: (chain: string) => call<{ chain: string; address: string }>("deposit_address", { chain }),
    balance: (chain: string) => call<Record<string, unknown>>("balance", { chain }),
    networkCosts: () => call<{ networks: { chainKey: string; swapUsd: number; transferUsd: number }[]; cheapest: string | null }>("network_costs"),
    quote: (args: { chain: string; sellToken: string; buyToken: string; sellAmount: string; slippageBps?: number }) => call<Record<string, unknown>>("quote", args),
    swap: (args: { chain: string; sellToken: string; buyToken: string; sellAmount: string; idempotencyKey: string; slippageBps?: number }) => call<Record<string, unknown>>("swap", args),
    transfer: (args: { chain: string; token: string; to: string; amount: string; idempotencyKey: string }) => call<Record<string, unknown>>("transfer", args),
    x402Quote: (url: string) => call<Record<string, unknown>>("x402_quote", { url }),
  };
}

// Stdio clients that cannot speak HTTP get the hosted tools through this bridge: each JSON-RPC line goes to the gateway
// with the agent key, and the reply comes back on stdout. Notifications get no reply, as in stdio MCP.
export function createBridge(options: HostedClientOptions) {
  const endpoint = mcpEndpoint(options.gatewayUrl);
  const fetchImpl = options.fetchImpl ?? fetch;
  return async (message: { id?: unknown }): Promise<unknown> => {
    try {
      const response = await fetchImpl(endpoint, {
        method: "POST",
        headers: { "content-type": "application/json", accept: "application/json, text/event-stream", authorization: `Bearer ${options.apiKey}` },
        body: JSON.stringify(message),
        signal: AbortSignal.timeout(options.timeoutMs ?? 20_000),
      });
      if (response.status === 202 || message.id === undefined) return null;
      if (!response.ok) return { jsonrpc: "2.0", id: message.id ?? null, error: { code: -32000, message: `the Whale gateway answered ${response.status}` } };
      return (await response.json()) as unknown;
    } catch (error) {
      return message.id === undefined ? null : { jsonrpc: "2.0", id: message.id, error: { code: -32000, message: error instanceof Error ? error.message : "the Whale gateway is unreachable" } };
    }
  };
}
