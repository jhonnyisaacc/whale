import { mkdirSync, writeFileSync } from "node:fs";

const URL_INFO = "https://api.hyperliquid.xyz/info";
const TYPES = ["meta", "spotMeta", "allMids"];

async function info(type) {
  for (let attempt = 1; attempt <= 6; attempt += 1) {
    const response = await fetch(URL_INFO, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ type }) });
    if (response.ok) return response.json();
    if (response.status !== 429) throw new Error(`${type} answered ${response.status}`);
    await new Promise((resolve) => setTimeout(resolve, attempt * 10_000));
  }
  throw new Error(`${type} stayed rate limited`);
}

const dir = new URL("../test/fixtures/hyperliquid-markets/", import.meta.url);
mkdirSync(dir, { recursive: true });
for (const type of TYPES) {
  const body = await info(type);
  const fixture = { captured: new Date().toISOString().slice(0, 10), source: URL_INFO, request: { type }, body };
  writeFileSync(new URL(`${type}.json`, dir), `${JSON.stringify(fixture)}\n`);
  console.log(`${type}: ${JSON.stringify(body).length} chars`);
}
