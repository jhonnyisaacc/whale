import assert from "node:assert/strict";
import test from "node:test";
import { resetProviderGuards } from "../src/aggregators.js";
import { commandDeps } from "../src/command-callers.js";
import type { WalletCommand } from "../src/commands.js";

test("a hosted quote with no price reference keeps EVM quotes and answers with the largest output", async () => {
  resetProviderGuards();
  const env = { ZEROX_API_KEY: "zeroex-key", LIFI_API_KEY: "lifi-key", QUOTE_TIMEOUT_MS: "200", QUOTE_DEADLINE_MS: "400" };
  const command: Extract<WalletCommand, { kind: "quote" }> = {
    kind: "quote",
    sell: { chain: { kind: "evm", chainId: 8453 }, chainKey: "base", address: "0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee", symbol: "?", decimals: null },
    buy: { chain: { kind: "evm", chainId: 8453 }, chainKey: "base", address: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913", symbol: "?", decimals: null },
    sellAmount: "1000000000000000000",
    taker: "0x9999999999999999999999999999999999999999",
    slippageBps: 50,
  };
  const hosts: string[] = [];
  const original = globalThis.fetch;
  globalThis.fetch = async (input) => {
    const host = new URL(String(input)).hostname;
    hosts.push(host);
    if (host === "api.0x.org") return new Response(JSON.stringify({ buyAmount: "3000000000", liquidityAvailable: true }), { status: 200 });
    if (host === "li.quest") return new Response(JSON.stringify({ estimate: { toAmount: "3100000000" } }), { status: 200 });
    return new Response("{}", { status: 404 });
  };
  try {
    const quote = await commandDeps(env, command).quote?.(command);
    assert.ok(hosts.includes("api.0x.org") && hosts.includes("li.quest"));
    assert.equal(quote?.buyAmount, "3100000000");
  } finally {
    globalThis.fetch = original;
  }
});
