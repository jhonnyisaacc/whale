// Preloaded with `node --import` by whale-verify. Appends one JSON line per outbound request to
// $WHALE_VERIFY_NETLOG and passes every request through unchanged. It never writes to stdout,
// because stdout carries the MCP protocol.
import diagnostics from "node:diagnostics_channel";
import { appendFileSync } from "node:fs";

const file = process.env.WHALE_VERIFY_NETLOG;
const LONG_SEGMENT = /^[A-Za-z0-9_-]{24,}$/;

function log(entry) {
  if (file) appendFileSync(file, `${JSON.stringify({ at: Date.now(), ...entry })}\n`);
}

// Provider keys can sit in a URL path segment or the query, so neither is logged as is.
function cleanPath(pathname) {
  return pathname
    .split("?")[0]
    .split("/")
    .map((part) => (LONG_SEGMENT.test(part) ? "<redacted>" : part))
    .join("/");
}

function rpcMethods(body) {
  if (typeof body !== "string") return undefined;
  try {
    const parsed = JSON.parse(body);
    const methods = (Array.isArray(parsed) ? parsed : [parsed]).map((item) => item?.method).filter((method) => typeof method === "string");
    return methods.length > 0 ? methods : undefined;
  } catch {
    return undefined;
  }
}

const original = globalThis.fetch;
globalThis.fetch = function loggedFetch(input, init) {
  try {
    const url = new URL(typeof input === "string" || input instanceof URL ? input : input.url);
    const method = (init?.method ?? (input instanceof Request ? input.method : "GET")).toUpperCase();
    log({ via: "fetch", method, origin: url.origin, path: cleanPath(url.pathname), rpc: rpcMethods(init?.body) });
  } catch {}
  return original.call(this, input, init);
};

diagnostics.subscribe("http.client.request.start", ({ request }) => {
  try {
    log({ via: "http", method: request.method, origin: `${request.protocol}//${request.host}`, path: cleanPath(String(request.path)) });
  } catch {}
});
