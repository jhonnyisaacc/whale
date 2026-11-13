import { lookup } from "node:dns/promises";
import { request, type RequestOptions } from "node:https";
import { BlockList, isIP } from "node:net";

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

export type SafeResponse = { status: number; body: string; truncated: boolean };
export type SafeInit = { method: "GET" | "POST"; headers?: Record<string, string>; body?: string; maxBytes: number; timeoutMs: number };

export function pinnedRequest(url: URL, init: SafeInit, send: typeof request = request): Promise<SafeResponse> {
  return new Promise((resolve, reject) => {
    const deadline = setTimeout(() => req.destroy(new Error("timed out")), init.timeoutMs);
    const settle = <T>(finish: (value: T) => void) => (value: T) => {
      clearTimeout(deadline);
      finish(value);
    };
    const req = send(url, { method: init.method, headers: init.headers ?? {}, lookup: guardedLookup }, (response) => {
      let size = 0;
      let cut = false;
      const chunks: Buffer[] = [];
      const finish = (truncated: boolean) => settle(resolve)({ status: response.statusCode ?? 0, body: Buffer.concat(chunks).toString("utf8"), truncated });
      response.on("data", (chunk: Buffer) => {
        if (cut) return;
        if (size + chunk.byteLength <= init.maxBytes) {
          size += chunk.byteLength;
          chunks.push(chunk);
          return;
        }
        cut = true;
        chunks.push(chunk.subarray(0, init.maxBytes - size));
        finish(true);
        req.destroy();
      });
      response.on("end", () => finish(false));
      response.on("error", settle(reject));
    });
    req.on("error", settle(reject));
    req.end(init.body);
  });
}

export function safeRequest(raw: string, init: SafeInit): Promise<SafeResponse> {
  if (!publicHttpsUrl(raw)) return Promise.reject(new Error("only public https URLs are allowed"));
  return pinnedRequest(new URL(raw), init);
}
