export const MAX_VENDOR_BYTES = 4 * 1024 * 1024;

export async function vendorResponse(fetchImpl: typeof fetch, url: string, init: RequestInit, followSameHost = true): Promise<Response> {
  const origin = new URL(url);
  let current = url;
  for (let hops = 0; hops <= 3; hops += 1) {
    const response = await fetchImpl(current, { ...init, redirect: "manual" });
    if (response.status < 300 || response.status >= 400) return response;
    const location = response.headers.get("location");
    if (!location || !followSameHost) return response;
    if (hops === 3) throw new Error("vendor redirect limit reached");
    const next = new URL(location, current);
    if (next.host !== origin.host || next.protocol !== origin.protocol) throw new Error("vendor redirect left the vendor host");
    current = next.toString();
  }
  throw new Error("vendor redirect limit reached");
}

export async function readVendorText(response: Response, maxBytes = MAX_VENDOR_BYTES): Promise<string> {
  const declared = Number(response.headers.get("content-length") ?? "");
  if (Number.isFinite(declared) && declared > maxBytes) throw new Error("vendor body too large");
  if (!response.body) {
    const text = await response.text();
    if (new TextEncoder().encode(text).byteLength > maxBytes) throw new Error("vendor body too large");
    return text;
  }
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel();
      throw new Error("vendor body too large");
    }
    chunks.push(value);
  }
  const merged = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    merged.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(merged);
}
