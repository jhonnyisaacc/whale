import assert from "node:assert/strict";
import test from "node:test";
import { quoteHop } from "../src/clients.js";
import { loadConfig } from "../src/config.js";

test("quote requests carry the sized sell amount and skip a zero amount", async () => {
  const config = loadConfig({});
  let called = false;
  const skipped = await quoteHop(
    config,
    { sellAddress: "usdc", buyAddress: "mplx", sellAmount: "0", chain: { kind: "solana" } },
    null,
    async () => {
      called = true;
      return new Response("{}", { status: 200 });
    },
  );
  assert.equal(called, false);
  assert.equal(skipped.priceImpactPct, null);
  let seen = "";
  const quoted = await quoteHop(
    config,
    { sellAddress: "usdc", buyAddress: "mplx", sellAmount: "5000000", chain: { kind: "solana" } },
    null,
    async (input) => {
      seen = String(input);
      return new Response(JSON.stringify({ outAmount: "10", priceImpactPct: "0.01" }), { status: 200 });
    },
  );
  assert.match(seen, /amount=5000000/);
  assert.equal(quoted.priceImpactPct, 1);
});
