import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { FastifyInstance } from "fastify";

export const WEB_DIST_DIR = fileURLToPath(new URL("../../../web/dist", import.meta.url));

const TYPES: Record<string, string> = {
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".woff2": "font/woff2",
  ".json": "application/json",
};
const SERVER_PREFIXES = ["/api/", "/auth/", "/oauth/", "/mcp", "/.well-known/", "/health", "/signer/"];

// The dashboard loads only its own files. Passkey ceremonies run against this origin, and the delegation step talks to
// Turnkey's API directly, so that is the one outside origin it may reach.
export const PAGE_CSP = [
  "default-src 'none'",
  "script-src 'self'",
  "style-src 'self'",
  "img-src 'self' data:",
  "font-src 'self'",
  "connect-src 'self' https://api.turnkey.com",
  "base-uri 'none'",
  "form-action 'self'",
  "frame-ancestors 'none'",
].join("; ");

// The build output is fixed for the life of the process, so it is read once at boot and served from memory: a request
// never touches the file system. Hashed asset names never change content, so they cache for a year. The page itself
// is never cached, so a deploy reaches every browser on its next load.
export function registerStatic(app: FastifyInstance, dir: string = WEB_DIST_DIR): boolean {
  const index = path.join(dir, "index.html");
  if (!existsSync(index)) return false;
  const page = readFileSync(index);
  const assetsDir = path.join(dir, "assets");
  const assets = new Map<string, { type: string; body: Buffer }>();
  if (existsSync(assetsDir)) {
    for (const entry of readdirSync(assetsDir, { withFileTypes: true })) {
      const type = TYPES[path.extname(entry.name)];
      if (entry.isFile() && type && /^[A-Za-z0-9._-]+$/.test(entry.name)) assets.set(entry.name, { type, body: readFileSync(path.join(assetsDir, entry.name)) });
    }
  }

  app.get("/assets/:file", async (request, reply) => {
    const asset = assets.get((request.params as { file: string }).file);
    if (!asset) return reply.code(404).send({ error: "not_found" });
    return reply.header("content-type", asset.type).header("cache-control", "public, max-age=31536000, immutable").send(asset.body);
  });

  app.setNotFoundHandler(async (request, reply) => {
    const url = request.url.split("?")[0] ?? "/";
    if (request.method !== "GET" || SERVER_PREFIXES.some((prefix) => url.startsWith(prefix)) || path.extname(url) !== "") {
      return reply.code(404).send({ error: "not_found" });
    }
    return reply.header("content-type", "text/html; charset=utf-8").header("cache-control", "no-cache").header("content-security-policy", PAGE_CSP).send(page);
  });
  return true;
}
