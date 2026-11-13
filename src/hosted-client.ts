export type HostedClientOptions = { gatewayUrl: string; apiKey: string; fetchImpl?: typeof fetch; timeoutMs?: number };

export class WhaleToolError extends Error {
  constructor(
    readonly tool: string,
    message: string,
  ) {
    super(message);
  }
}

function unreachable(error: unknown): Error {
  const cause = error instanceof Error && error.cause instanceof Error ? `: ${error.cause.message}` : "";
  return new Error(`the Whale gateway is unreachable: ${error instanceof Error ? error.message : String(error)}${cause}`, { cause: error });
}

async function refusal(response: Response): Promise<{ code: number; message: string }> {
  const body = (await response.json().catch(() => null)) as { error?: unknown } | null;
  const error = body?.error;
  if (typeof error === "object" && error !== null && typeof (error as { message?: unknown }).message === "string") {
    const { code, message } = error as { code?: unknown; message: string };
    return { code: typeof code === "number" ? code : -32000, message };
  }
  const reason = /error="([^"]*)"/.exec(response.headers.get("www-authenticate") ?? "")?.[1] ?? (typeof error === "string" ? error : null);
  const what = response.status === 401 ? "the Whale gateway refused this API key" : `the Whale gateway answered ${response.status}`;
  return { code: -32000, message: reason ? `${what}: ${reason}` : what };
}

const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);

export function mcpEndpoint(gatewayUrl: string): string {
  const url = new URL(gatewayUrl);
  const local = url.protocol === "http:" && LOCAL_HOSTS.has(url.hostname);
  if (url.protocol !== "https:" && !local) throw new Error("the gateway URL must be https (http only for localhost)");
  if (url.username || url.password || url.search || url.hash) throw new Error("the gateway URL must not carry credentials, a query, or a fragment");
  return new URL("/mcp", url.origin).toString();
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
    }).catch((error: unknown) => {
      throw unreachable(error);
    });
    if (!response.ok) throw new Error((await refusal(response)).message);
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
    quote: (args: { chain: string; sellToken: string; buyToken: string; sellAmount: string; slippageBps?: number }) => call<Record<string, unknown>>("quote", args),
    swap: (args: { chain: string; sellToken: string; buyToken: string; sellAmount: string; idempotencyKey: string; slippageBps?: number }) => call<Record<string, unknown>>("swap", args),
    transfer: (args: { chain: string; token: string; to: string; amount: string; idempotencyKey: string }) => call<Record<string, unknown>>("transfer", args),
  };
}

export function createBridge(options: HostedClientOptions) {
  const endpoint = mcpEndpoint(options.gatewayUrl);
  const fetchImpl = options.fetchImpl ?? fetch;
  return async (message: unknown): Promise<unknown> => {
    const id = typeof message === "object" && message !== null && !Array.isArray(message) ? (message as { id?: unknown }).id : null;
    try {
      const response = await fetchImpl(endpoint, {
        method: "POST",
        headers: { "content-type": "application/json", accept: "application/json, text/event-stream", authorization: `Bearer ${options.apiKey}` },
        body: JSON.stringify(message),
        signal: AbortSignal.timeout(options.timeoutMs ?? 20_000),
      });
      if (response.status === 202 || id === undefined) return null;
      if (!response.ok) return { jsonrpc: "2.0", id, error: await refusal(response) };
      return (await response.json()) as unknown;
    } catch (error) {
      return id === undefined ? null : { jsonrpc: "2.0", id, error: { code: -32000, message: unreachable(error).message } };
    }
  };
}
