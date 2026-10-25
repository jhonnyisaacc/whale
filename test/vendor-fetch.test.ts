import assert from "node:assert/strict";
import test from "node:test";
import { readVendorText, vendorResponse } from "../src/vendor-fetch.js";

test("a vendor redirect to another host is rejected and a same-host redirect is followed once", async () => {
  const seen: string[] = [];
  const cross = async (url: string | URL | Request) => {
    seen.push(String(url));
    return new Response(null, { status: 302, headers: { location: "http://169.254.169.254/latest/meta-data" } });
  };
  await assert.rejects(() => vendorResponse(cross as typeof fetch, "https://vendor.example/quote", {}), /left the vendor host/);
  assert.deepEqual(seen, ["https://vendor.example/quote"]);

  const modes: (string | undefined)[] = [];
  const same = async (url: string | URL | Request, init?: RequestInit) => {
    modes.push(init?.redirect);
    if (new URL(String(url)).pathname === "/quote") return new Response(null, { status: 302, headers: { location: "/v2/quote" } });
    return new Response(JSON.stringify({ ok: true }), { status: 200 });
  };
  const response = await vendorResponse(same as typeof fetch, "https://vendor.example/quote", {});
  assert.equal(response.status, 200);
  assert.deepEqual(modes, ["manual", "manual"]);
});

test("a vendor redirect that drops to plaintext is rejected", async () => {
  const downgrade = async () => new Response(null, { status: 302, headers: { location: "http://vendor.example/v2/quote" } });
  await assert.rejects(() => vendorResponse(downgrade as typeof fetch, "https://vendor.example/quote", {}), /left the vendor host/);
});

test("a vendor body over the cap is rejected", async () => {
  const response = new Response("x".repeat(64), { status: 200 });
  await assert.rejects(() => readVendorText(response, 16), /too large/);
  const declared = new Response("ok", { status: 200, headers: { "content-length": "9999" } });
  await assert.rejects(() => readVendorText(declared, 16), /too large/);
});
