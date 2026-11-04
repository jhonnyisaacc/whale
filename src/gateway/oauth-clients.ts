import { request } from "node:https";
import type pg from "pg";
import { z } from "zod";
import { pinnedRequest, publicHttpsUrl } from "./safe-https.js";

export type OAuthClient = { id: string; kind: "registered" | "metadata_document"; name: string; redirectUris: string[] };

const BLOCKED_SCHEMES = new Set(["javascript:", "data:", "file:", "vbscript:", "about:", "blob:", "ftp:", "ws:", "wss:"]);
const LOOPBACK = new Set(["localhost", "127.0.0.1", "[::1]"]);
const METADATA_TTL_MS = 60 * 60 * 1000;
const METADATA_MAX_BYTES = 64 * 1024;
const METADATA_DEADLINE_MS = 5_000;
const METADATA_FAILURE_TTL_MS = 60 * 1000;

// Redirects go to https, to a loopback port for native apps, or to an app's own private scheme (cursor://, vscode://).
export function redirectUriAllowed(raw: string): boolean {
  if (raw.length > 512) return false;
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return false;
  }
  if (url.hash || url.username || url.password) return false;
  if (url.protocol === "https:") return true;
  if (url.protocol === "http:") return LOOPBACK.has(url.hostname);
  return /^[a-z][a-z0-9+.-]*:$/.test(url.protocol) && !BLOCKED_SCHEMES.has(url.protocol);
}

export function isLoopbackRedirect(raw: string): boolean {
  const url = new URL(raw);
  return url.protocol === "http:" && LOOPBACK.has(url.hostname);
}

export function redirectMatches(registered: string[], presented: string): boolean {
  if (registered.includes(presented)) return true;
  if (!redirectUriAllowed(presented) || !isLoopbackRedirect(presented)) return false;
  const withoutPort = (raw: string) => {
    const url = new URL(raw);
    url.port = "";
    return url.toString();
  };
  const wanted = withoutPort(presented);
  return registered.some((uri) => isLoopbackRedirect(uri) && withoutPort(uri) === wanted);
}

export const registrationSchema = z
  .object({
    redirect_uris: z.array(z.string()).min(1).max(5),
    client_name: z.string().trim().min(1).max(128).optional(),
    token_endpoint_auth_method: z.literal("none").optional(),
    grant_types: z.array(z.enum(["authorization_code", "refresh_token"])).optional(),
    response_types: z.array(z.literal("code")).optional(),
  })
  .loose();

const metadataSchema = z
  .object({ client_id: z.string(), client_name: z.string().trim().min(1).max(128), redirect_uris: z.array(z.string()).min(1).max(5) })
  .loose();

export { publicAddress } from "./safe-https.js";

export function metadataUrlAllowed(raw: string): boolean {
  return publicHttpsUrl(raw) && new URL(raw).pathname.length > 1;
}

export type MetadataFetch = (url: string) => Promise<string>;

export const fetchMetadataDocument = async (raw: string, { deadlineMs = METADATA_DEADLINE_MS, send = request }: { deadlineMs?: number; send?: typeof request } = {}): Promise<string> => {
  const response = await pinnedRequest(new URL(raw), { method: "GET", headers: { accept: "application/json" }, maxBytes: METADATA_MAX_BYTES, timeoutMs: deadlineMs }, send).catch((error: Error) => {
    throw new Error(`client metadata ${error.message}`);
  });
  if (response.status !== 200) throw new Error(`client metadata answered ${response.status}`);
  return response.body;
};

export async function registerClient(pool: pg.Pool, id: string, body: z.infer<typeof registrationSchema>): Promise<OAuthClient | string> {
  if (!body.redirect_uris.every(redirectUriAllowed)) return "a redirect_uri must be https, a loopback http address, or an app scheme";
  const client: OAuthClient = { id, kind: "registered", name: body.client_name ?? "MCP client", redirectUris: body.redirect_uris };
  await pool.query("INSERT INTO oauth_clients (id, kind, name, redirect_uris) VALUES ($1, 'registered', $2, $3)", [client.id, client.name, client.redirectUris]);
  return client;
}

async function storedClient(pool: pg.Pool, id: string): Promise<(OAuthClient & { fetchedAt: Date | null }) | null> {
  const found = await pool.query<{ id: string; kind: OAuthClient["kind"]; name: string; redirect_uris: string[]; fetched_at: Date | null }>(
    "SELECT id, kind, name, redirect_uris, fetched_at FROM oauth_clients WHERE id = $1",
    [id],
  );
  const row = found.rows[0];
  return row ? { id: row.id, kind: row.kind, name: row.name, redirectUris: row.redirect_uris, fetchedAt: row.fetched_at } : null;
}

export function clientResolver(pool: pg.Pool, fetchDocument: MetadataFetch): (clientId: string, now: number) => Promise<OAuthClient | null> {
  const failedUntil = new Map<string, number>();
  return async (clientId, now) => {
    if ((failedUntil.get(clientId) ?? 0) > now) return null;
    const client = await resolveClient(pool, clientId, fetchDocument, now);
    if (client) return client;
    if (failedUntil.size >= 1_000) for (const [id, until] of failedUntil) if (until <= now) failedUntil.delete(id);
    failedUntil.set(clientId, now + METADATA_FAILURE_TTL_MS);
    return null;
  };
}

// A URL client_id is a Client ID Metadata Document. Its client_id must equal the URL exactly, and its redirect URIs
// pass the same rules as a registered client's.
async function resolveClient(pool: pg.Pool, clientId: string, fetchDocument: MetadataFetch, now = Date.now()): Promise<OAuthClient | null> {
  const stored = await storedClient(pool, clientId);
  if (stored && (stored.kind === "registered" || (stored.fetchedAt && now - stored.fetchedAt.getTime() < METADATA_TTL_MS))) return stored;
  if (!metadataUrlAllowed(clientId)) return null;
  let parsed: z.infer<typeof metadataSchema>;
  try {
    parsed = metadataSchema.parse(JSON.parse(await fetchDocument(clientId)));
  } catch {
    return null;
  }
  if (parsed.client_id !== clientId || !parsed.redirect_uris.every(redirectUriAllowed)) return null;
  await pool.query(
    `INSERT INTO oauth_clients (id, kind, name, redirect_uris, fetched_at) VALUES ($1, 'metadata_document', $2, $3, $4)
     ON CONFLICT (id) DO UPDATE SET name = EXCLUDED.name, redirect_uris = EXCLUDED.redirect_uris, fetched_at = EXCLUDED.fetched_at`,
    [clientId, parsed.client_name, parsed.redirect_uris, new Date(now)],
  );
  return { id: clientId, kind: "metadata_document", name: parsed.client_name, redirectUris: parsed.redirect_uris };
}
