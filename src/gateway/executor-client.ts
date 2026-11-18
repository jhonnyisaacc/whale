import { z } from "zod";
import { hostedReportSchema, type HostedReportRequest, type HostedRequest } from "../hosted-commands.js";
import { readVendorText } from "../vendor-fetch.js";

export type SendReport = z.infer<typeof hostedReportSchema>;

export type ExecutorClient = { run(request: HostedRequest): Promise<unknown>; report(request: HostedReportRequest): Promise<SendReport> };

export class ExecutorRefused extends Error {}

const DEFINITE_REFUSALS = new Set([400, 401, 403, 429]);

export function executorClient(target: { url: URL; token: string }, fetchImpl: typeof fetch = fetch): ExecutorClient {
  const base = target.url.href.endsWith("/") ? target.url : new URL(`${target.url.href}/`);
  const post = async (path: string, body: unknown): Promise<unknown> => {
    const response = await fetchImpl(new URL(path, base).toString(), {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${target.token}` },
      body: JSON.stringify(body),
      redirect: "error",
      signal: AbortSignal.timeout(8_000),
    });
    if (DEFINITE_REFUSALS.has(response.status)) throw new ExecutorRefused(`executor answered ${response.status}`);
    if (!response.ok) throw new Error(`executor answered ${response.status}`);
    return JSON.parse(await readVendorText(response, 256 * 1024)) as unknown;
  };
  return {
    run: (request) => post("hosted/commands", request),
    report: async (request) => hostedReportSchema.parse(await post("hosted/reports", request)),
  };
}
