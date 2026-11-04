import type { HostedRequest } from "../hosted-commands.js";
import { readVendorText } from "../vendor-fetch.js";

export type ExecutorClient = { run(request: HostedRequest): Promise<unknown> };

export function executorClient(target: { url: URL; token: string }, fetchImpl: typeof fetch = fetch): ExecutorClient {
  const endpoint = new URL("/hosted/commands", target.url).toString();
  return {
    async run(request) {
      const response = await fetchImpl(endpoint, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${target.token}` },
        body: JSON.stringify(request),
        redirect: "error",
        signal: AbortSignal.timeout(8_000),
      });
      if (!response.ok) throw new Error(`executor answered ${response.status}`);
      return JSON.parse(await readVendorText(response, 256 * 1024)) as unknown;
    },
  };
}
