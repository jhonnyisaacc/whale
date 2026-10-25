import fastifyAuth from "@fastify/auth";
import rateLimit from "@fastify/rate-limit";
import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from "fastify";
import { tokenMatches } from "./managed-signer.js";
import { loggerOptions } from "./log.js";

export const BODY_LIMIT = 32 * 1024;
// Node applies requestTimeout only while the request is still arriving, so it guards slow uploads and never
// cuts off a handler that is waiting on a send confirmation.
export const REQUEST_TIMEOUT_MS = 10_000;

export const mutatingLimit = { rateLimit: { max: 10, timeWindow: "1 minute" } };

export function perMinute(max: number) {
  return { rateLimit: { max, timeWindow: "1 minute" } };
}

export type Drain = {
  readonly draining: boolean;
  readonly inFlight: number;
  start(): void;
  track<T>(work: () => Promise<T>): Promise<T>;
  idle(timeoutMs: number): Promise<boolean>;
};

export function createDrain(): Drain {
  let draining = false;
  let inFlight = 0;
  let waiters: Array<() => void> = [];
  const settle = () => {
    if (inFlight > 0) return;
    const done = waiters;
    waiters = [];
    for (const wake of done) wake();
  };
  return {
    get draining() {
      return draining;
    },
    get inFlight() {
      return inFlight;
    },
    start() {
      draining = true;
    },
    async track(work) {
      inFlight += 1;
      try {
        return await work();
      } finally {
        inFlight -= 1;
        settle();
      }
    },
    idle(timeoutMs) {
      if (inFlight === 0) return Promise.resolve(true);
      return new Promise((resolve) => {
        const timer = setTimeout(() => resolve(false), timeoutMs);
        waiters.push(() => {
          clearTimeout(timer);
          resolve(true);
        });
      });
    },
  };
}

declare module "fastify" {
  interface FastifyInstance {
    verifyBearer: (request: FastifyRequest, reply: FastifyReply) => Promise<void>;
    drain: Drain;
  }
}

export function bearerOf(request: FastifyRequest): string {
  const header = request.headers.authorization;
  return typeof header === "string" && header.startsWith("Bearer ") ? header.slice("Bearer ".length) : "";
}

export function anyTokenMatches(presented: string, tokens: readonly string[]): boolean {
  if (!presented) return false;
  return tokens.map((token) => tokenMatches(presented, token)).includes(true);
}

export async function buildApp(options: { authTokens: readonly string[]; secrets?: readonly string[]; logger?: boolean }): Promise<FastifyInstance> {
  const app = Fastify({
    bodyLimit: BODY_LIMIT,
    requestTimeout: REQUEST_TIMEOUT_MS,
    return503OnClosing: false,
    logger: options.logger === false ? false : loggerOptions(options.secrets ?? []),
  });
  const drain = createDrain();
  app.decorate("drain", drain);
  app.addHook("onRequest", async (request, reply) => {
    if (request.method === "GET" || request.method === "HEAD" || request.method === "OPTIONS") return;
    if (drain.draining) return reply.code(503).header("connection", "close").send({ error: "draining" });
    const type = request.headers["content-type"];
    if (typeof type !== "string" || !type.toLowerCase().includes("application/json")) {
      return reply.code(415).send({ error: "unsupported media type" });
    }
  });
  await app.register(rateLimit, { global: true, max: 60, timeWindow: "1 minute" });
  await app.register(fastifyAuth);
  app.decorate("verifyBearer", async function (request: FastifyRequest, reply: FastifyReply) {
    if (!anyTokenMatches(bearerOf(request), options.authTokens)) {
      return reply.code(401).send({ error: "unauthorized" });
    }
  });
  app.setErrorHandler((error: unknown, _request, reply) => {
    const status = typeof error === "object" && error !== null && "statusCode" in error && typeof error.statusCode === "number" ? error.statusCode : 500;
    if (status === 415) {
      void reply.code(415).send({ error: "unsupported media type" });
      return;
    }
    if (status === 413) {
      void reply.code(413).send({ error: "body too large" });
      return;
    }
    if (status === 429) {
      void reply.code(429).send({ error: "rate limit" });
      return;
    }
    if (status >= 400 && status < 500) {
      void reply.code(status).send({ error: "invalid request" });
      return;
    }
    void reply.code(500).send({ error: "internal error" });
  });
  return app;
}

// Stop taking mutating work, let in-flight sends finish inside the drain window, then release resources.
export async function shutdown(app: FastifyInstance, timeoutMs: number, cleanup: () => Promise<void>): Promise<boolean> {
  app.drain.start();
  const idle = await app.drain.idle(timeoutMs);
  await Promise.race([app.close(), new Promise((resolve) => setTimeout(resolve, 1_000).unref())]);
  await cleanup();
  return idle;
}
