import { lookup } from "node:dns/promises";
import { request, type RequestOptions } from "node:https";
import { BlockList, isIP } from "node:net";

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

export function publicHttpsUrl(raw: string): boolean {
  try {
    const url = new URL(raw);
    return url.protocol === "https:" && !url.hash && !url.username && !url.password && (url.port === "" || url.port === "443") && isIP(url.hostname.replace(/^\[|\]$/g, "")) === 0;
  } catch {
    return false;
  }
}

// Node asks for every address when it races IPv4 and IPv6, and for one address otherwise. Either way the socket
// connects to an address this function checked, so a DNS answer that flips to a private address after the check
// (rebinding) never reaches it.
const guardedLookup: RequestOptions["lookup"] = (hostname, options, callback) => {
  lookup(hostname, { all: true })
    .then((addresses) => {
      if (addresses.length === 0 || addresses.some((entry) => !publicAddress(entry.address))) callback(new Error("host resolves to a private address"), "", 4);
      else if (options.all) callback(null, addresses);
      else {
        const first = addresses[0] as { address: string; family: number };
        callback(null, first.address, first.family);
      }
    })
    .catch((error: Error) => callback(error, "", 4));
};

export type SafeResponse = { status: number; body: string };

// Outbound calls to user-supplied URLs: https on 443 only, public addresses only, no redirects, capped body, short timeout.
export function safeRequest(raw: string, init: { method: "GET" | "POST"; headers?: Record<string, string>; body?: string; maxBytes: number; timeoutMs: number }): Promise<SafeResponse> {
  return new Promise((resolve, reject) => {
    if (!publicHttpsUrl(raw)) {
      reject(new Error("only public https URLs are allowed"));
      return;
    }
    const req = request(new URL(raw), { method: init.method, headers: init.headers ?? {}, timeout: init.timeoutMs, lookup: guardedLookup }, (response) => {
      let size = 0;
      const chunks: Buffer[] = [];
      response.on("data", (chunk: Buffer) => {
        size += chunk.byteLength;
        if (size > init.maxBytes) req.destroy(new Error("response is too large"));
        else chunks.push(chunk);
      });
      response.on("end", () => resolve({ status: response.statusCode ?? 0, body: Buffer.concat(chunks).toString("utf8") }));
      response.on("error", reject);
    });
    req.on("timeout", () => req.destroy(new Error("request timed out")));
    req.on("error", reject);
    req.end(init.body);
  });
}
