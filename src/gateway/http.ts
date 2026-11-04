import rateLimit from "@fastify/rate-limit";
import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from "fastify";
import type pg from "pg";
import { loggerOptions } from "../log.js";
import { readSession, SESSION_COOKIE, type Session } from "./accounts.js";
import type { GatewayConfig } from "./config.js";

export const GATEWAY_BODY_LIMIT = 32 * 1024;

export function perMinute(max: number) {
  return { rateLimit: { max, timeWindow: "1 minute" } };
}

export function readCookie(header: string | undefined, name: string): string | null {
  if (!header) return null;
  for (const pair of header.split(";")) {
    const index = pair.indexOf("=");
    if (index > 0 && pair.slice(0, index).trim() === name) return pair.slice(index + 1).trim();
  }
  return null;
}

export function cookie(name: string, value: string, maxAgeSeconds: number): string {
  return `${name}=${value}; Path=/; Max-Age=${maxAgeSeconds}; HttpOnly; Secure; SameSite=Lax`;
}

export function clearedCookie(name: string): string {
  return cookie(name, "", 0);
}

// Only a same-origin path survives, so a crafted return_to cannot bounce a fresh session to another site.
export function safeReturnTo(raw: unknown): string {
  if (typeof raw !== "string" || raw.length > 512) return "/";
  if (!raw.startsWith("/") || raw.startsWith("//") || /[\\\u0000-\u001f\u007f]/.test(raw)) return "/";
  return raw;
}

export async function sessionOf(pool: pg.Pool, request: FastifyRequest, now?: number): Promise<Session | null> {
  const token = readCookie(request.headers.cookie, SESSION_COOKIE);
  return token ? readSession(pool, token, now) : null;
}

export async function requireSession(pool: pg.Pool, request: FastifyRequest, reply: FastifyReply): Promise<Session | null> {
  const session = await sessionOf(pool, request);
  if (!session) await reply.code(401).send({ error: "signin_required" });
  return session;
}

const SECURITY_HEADERS: Record<string, string> = {
  "x-content-type-options": "nosniff",
  "referrer-policy": "no-referrer",
  "x-frame-options": "DENY",
  "cross-origin-opener-policy": "same-origin",
  "cross-origin-resource-policy": "same-origin",
  "permissions-policy": "camera=(), microphone=(), geolocation=(), payment=(), usb=()",
};

// Cookie-authenticated routes. Bearer routes (OAuth token, MCP) carry no ambient credential, so they skip
// the Origin check and keep their own.
function cookieRoute(url: string): boolean {
  return url.startsWith("/api/") || url.startsWith("/auth/");
}

export async function gatewayApp(config: GatewayConfig, options: { logger: boolean; secrets: readonly string[] }): Promise<FastifyInstance> {
  const app = Fastify({
    bodyLimit: GATEWAY_BODY_LIMIT,
    requestTimeout: 10_000,
    trustProxy: (_address: string, hop: number) => hop < config.trustProxyHops,
    logger: options.logger ? { ...loggerOptions(options.secrets), redact: { paths: ["req.headers.authorization", "req.headers.cookie", "res.headers['set-cookie']"], censor: "[redacted]" } } : false,
  });
  app.addHook("onRequest", async (request, reply) => {
    if (request.method === "GET" || request.method === "HEAD") return;
    if (cookieRoute(request.url) && request.headers.origin !== config.publicUrl.origin) return reply.code(403).send({ error: "cross_origin" });
  });
  app.addHook("onSend", async (request, reply, payload) => {
    for (const [name, value] of Object.entries(SECURITY_HEADERS)) reply.header(name, value);
    if (config.publicUrl.protocol === "https:") reply.header("strict-transport-security", "max-age=63072000; includeSubDomains");
    if (!reply.hasHeader("content-security-policy")) reply.header("content-security-policy", "default-src 'none'; frame-ancestors 'none'");
    if (cookieRoute(request.url)) reply.header("cache-control", "no-store");
    return payload;
  });
  await app.register(rateLimit, { global: true, max: 120, timeWindow: "1 minute" });
  app.setErrorHandler((error: unknown, _request, reply) => {
    const status = typeof error === "object" && error !== null && "statusCode" in error && typeof error.statusCode === "number" ? error.statusCode : 500;
    if (status === 429) return reply.code(429).send({ error: "rate_limit" });
    if (status >= 400 && status < 500) return reply.code(status).send({ error: "invalid_request" });
    return reply.code(500).send({ error: "internal_error" });
  });
  return app;
}
