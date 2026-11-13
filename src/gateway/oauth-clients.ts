import { lookup } from "node:dns/promises";
import { request } from "node:https";
import { BlockList, isIP } from "node:net";
import type pg from "pg";
import { z } from "zod";

export type OAuthClient = { id: string; kind: "registered" | "metadata_document"; name: string; redirectUris: string[] };

const BLOCKED_SCHEMES = new Set(["javascript:", "data:", "file:", "vbscript:", "about:", "blob:", "ftp:", "ws:", "wss:"]);
const LOOPBACK = new Set(["localhost", "127.0.0.1", "[::1]"]);
const METADATA_TTL_MS = 60 * 60 * 1000;
const METADATA_MAX_BYTES = 64 * 1024;

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

// Two lists: Node matches an IPv4 address against IPv6 rules too, so a mapped-range rule would block every IPv4 address.
const blocked4 = new BlockList();
const blocked6 = new BlockList();
for (const [network, prefix] of [
  ["0.0.0.0", 8], ["10.0.0.0", 8], ["100.64.0.0", 10], ["127.0.0.0", 8], ["169.254.0.0", 16], ["172.16.0.0", 12],
  ["192.0.0.0", 24], ["192.168.0.0", 16], ["198.18.0.0", 15], ["224.0.0.0", 3],
] as const) blocked4.addSubnet(network, prefix, "ipv4");
for (const [network, prefix] of [["::", 127], ["fc00::", 7], ["fe80::", 10], ["ff00::", 8], ["64:ff9b::", 96]] as const) blocked6.addSubnet(network, prefix, "ipv6");

export function publicAddress(address: string): boolean {
  const family = isIP(address);
  if (family === 4) return !blocked4.check(address, "ipv4");
  if (family !== 6) return false;
  // IPv4-mapped IPv6 reaches the IPv4 host behind it. Refuse the whole range rather than decode it.
  if (address.toLowerCase().startsWith("::ffff:")) return false;
  return !blocked6.check(address, "ipv6");
}

export function metadataUrlAllowed(raw: string): boolean {
  try {
    const url = new URL(raw);
    return url.protocol === "https:" && url.pathname.length > 1 && !url.hash && !url.username && !url.password && (url.port === "" || url.port === "443") && isIP(url.hostname.replace(/^\[|\]$/g, "")) === 0;
  } catch {
    return false;
  }
}

export type MetadataFetch = (url: string) => Promise<string>;

// The connection uses the address this lookup checked, so a DNS answer that flips to a private address after the
// check (rebinding) never reaches the socket. No redirects, a size cap, and a short timeout.
export const fetchMetadataDocument: MetadataFetch = (raw) =>
  new Promise((resolve, reject) => {
    const url = new URL(raw);
    const req = request(
      url,
      {
        method: "GET",
        headers: { accept: "application/json" },
        timeout: 5_000,
        // Node asks for every address when it races IPv4 and IPv6, and for one address otherwise.
        lookup: (hostname, options, callback) => {
          lookup(hostname, { all: true })
            .then((addresses) => {
              if (addresses.length === 0 || addresses.some((entry) => !publicAddress(entry.address))) {
                callback(new Error("client metadata host resolves to a private address"), "", 4);
              } else if (options.all) {
                callback(null, addresses);
              } else {
                const first = addresses[0] as { address: string; family: number };
                callback(null, first.address, first.family);
              }
            })
            .catch((error: Error) => callback(error, "", 4));
        },
      },
      (response) => {
        if (response.statusCode !== 200) {
          response.resume();
          reject(new Error(`client metadata answered ${response.statusCode}`));
          return;
        }
        let size = 0;
        const chunks: Buffer[] = [];
        response.on("data", (chunk: Buffer) => {
          size += chunk.byteLength;
          if (size > METADATA_MAX_BYTES) req.destroy(new Error("client metadata is too large"));
          else chunks.push(chunk);
        });
        response.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
        response.on("error", reject);
      },
    );
    req.on("timeout", () => req.destroy(new Error("client metadata timed out")));
    req.on("error", reject);
    req.end();
  });

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

// A URL client_id is a Client ID Metadata Document. Its client_id must equal the URL exactly, and its redirect URIs
// pass the same rules as a registered client's.
export async function resolveClient(pool: pg.Pool, clientId: string, fetchDocument: MetadataFetch, now = Date.now()): Promise<OAuthClient | null> {
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
