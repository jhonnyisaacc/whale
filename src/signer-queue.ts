import { randomUUID } from "node:crypto";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { z } from "zod";
import { tokenMatches } from "./managed-signer.js";

export type SignerJob = { kind: "evm" | "solana" | "hypercore"; payload: Record<string, unknown> };
export type SignerAnswer = { decision: "signed"; result: unknown } | { decision: "refused"; reasons: string[] };

export type SignerQueue = {
  url: string;
  submit(job: SignerJob): Promise<{ id: string; answer: SignerAnswer }>;
  close(): Promise<void>;
};

type Entry = SignerJob & { id: string; leasedUntil: number; settle: (answer: SignerAnswer) => void };

const LEASE_MS = 60_000;
const MAX_WAIT_S = 25;
const POLL_MS = 100;
const MAX_BODY_BYTES = 64 * 1024;
const resultBody = z
  .object({ decision: z.enum(["signed", "refused"]), result: z.unknown().optional(), reasons: z.array(z.string().max(300)).max(20).optional() })
  .strict();

function send(response: ServerResponse, status: number, body?: unknown): void {
  response.writeHead(status, body === undefined ? {} : { "content-type": "application/json", "cache-control": "no-store" });
  response.end(body === undefined ? undefined : JSON.stringify(body));
}

async function readBody(request: IncomingMessage): Promise<unknown> {
  let size = 0;
  const chunks: Buffer[] = [];
  for await (const chunk of request) {
    size += (chunk as Buffer).length;
    if (size > MAX_BODY_BYTES) throw new Error("body too large");
    chunks.push(chunk as Buffer);
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

export async function startSignerQueue(options: { token: string; port: number; answerTimeoutMs: number; now?: () => number }): Promise<SignerQueue> {
  const now = options.now ?? Date.now;
  const jobs = new Map<string, Entry>();
  const authorized = (request: IncomingMessage) => {
    const header = request.headers.authorization;
    return typeof header === "string" && header.startsWith("Bearer ") && tokenMatches(header.slice(7).trim(), options.token);
  };
  const lease = (): Entry | null => {
    for (const entry of jobs.values()) {
      if (entry.leasedUntil <= now()) {
        entry.leasedUntil = now() + LEASE_MS;
        return entry;
      }
    }
    return null;
  };
  const server = createServer((request, response) => {
    void (async () => {
      if (!authorized(request)) return send(response, 401, { error: "unauthorized" });
      const url = new URL(request.url ?? "/", "http://127.0.0.1");
      if (request.method === "GET" && url.pathname === "/signer/v1/jobs") {
        const wait = Math.min(MAX_WAIT_S, Math.max(0, Number(url.searchParams.get("wait") ?? "0") || 0));
        const deadline = Date.now() + wait * 1000;
        for (;;) {
          if (request.socket.destroyed) return;
          const entry = lease();
          if (entry) return send(response, 200, { id: entry.id, kind: entry.kind, payload: entry.payload });
          if (Date.now() + POLL_MS > deadline) return send(response, 204);
          await new Promise((resolve) => setTimeout(resolve, POLL_MS));
        }
      }
      const answered = /^\/signer\/v1\/jobs\/([0-9a-f-]{36})\/result$/.exec(url.pathname);
      if (request.method === "POST" && answered) {
        const parsed = resultBody.safeParse(await readBody(request).catch(() => null));
        if (!parsed.success) return send(response, 400, { error: "invalid_request" });
        const entry = jobs.get(answered[1] as string);
        if (!entry || entry.leasedUntil === 0) return send(response, 409, { error: "not_leased" });
        jobs.delete(entry.id);
        const { decision, result, reasons } = parsed.data;
        entry.settle(decision === "signed" ? { decision, result: result ?? null } : { decision, reasons: reasons ?? [] });
        return send(response, 204);
      }
      return send(response, 404, { error: "not_found" });
    })().catch(() => send(response, 500, { error: "internal" }));
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(options.port, "127.0.0.1", () => resolve());
  });
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return {
    url,
    submit(job) {
      const id = randomUUID();
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          jobs.delete(id);
          reject(new Error(`whale-signer did not answer job ${id} within ${Math.round(options.answerTimeoutMs / 1000)}s. Run whale-signer serve --gateway ${url}`));
        }, options.answerTimeoutMs);
        jobs.set(id, {
          ...job,
          id,
          leasedUntil: 0,
          settle: (answer) => {
            clearTimeout(timer);
            resolve({ id, answer });
          },
        });
      });
    },
    close: () =>
      new Promise((resolve) => {
        server.close(() => resolve());
        server.closeAllConnections();
      }),
  };
}
