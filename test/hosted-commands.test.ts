import assert from "node:assert/strict";
import test from "node:test";
import type { CommandDeps, WalletCommand } from "../src/commands.js";
import { hostedServiceToken, registerHostedRoutes } from "../src/executor-server/hosted.js";
import { hostedCommandSchema, walletCommandOf } from "../src/hosted-commands.js";
import { buildApp } from "../src/http.js";

const USDC = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";
const WETH = "0x4200000000000000000000000000000000000006";
const HOSTED_TOKEN = "h".repeat(40);
const IDS = { walletId: "8f0c1a52-3f0e-4c7e-9a0b-0d9c1f6a2b31", agentId: "1b6e7d3c-9a2f-4e18-8c55-2f7a9d0e4c6b" };

test("the hosted wire shape refuses a mode, fractional or zero amounts, and unknown chains", () => {
  const quote = { kind: "quote", chainKey: "base", sellToken: USDC, buyToken: WETH, sellAmount: "1000000", slippageBps: 50, taker: null };
  assert.equal(hostedCommandSchema.safeParse(quote).success, true);
  for (const bad of [{ ...quote, mode: "live" }, { ...quote, sellAmount: "1.5" }, { ...quote, sellAmount: "0" }, { ...quote, sellAmount: "-1" }, { ...quote, chainKey: "dogechain" }, { ...quote, slippageBps: 5000 }]) {
    assert.equal(hostedCommandSchema.safeParse(bad).success, false, JSON.stringify(bad));
  }
});

test("a hosted swap becomes a quote and a hosted transfer stays a dry-run", () => {
  const swap = walletCommandOf({ kind: "swap", chainKey: "base", sellToken: USDC, buyToken: WETH, sellAmount: "5", slippageBps: 50, taker: null, idempotencyKey: "swap-0001" });
  assert.equal(swap.kind, "quote");
  const transfer = walletCommandOf({ kind: "transfer", chainKey: "base", token: USDC, to: WETH, amount: "5", idempotencyKey: "xfer-0001" });
  assert.deepEqual(transfer.kind === "transfer" && transfer.mode, "dry_run");
});

test("the hosted service token must be long and must differ from the executor token", () => {
  assert.equal(hostedServiceToken({}, ["executor-token-123456"]), null);
  assert.throws(() => hostedServiceToken({ HOSTED_SERVICE_TOKEN: "short" }, []), /at least 32/);
  assert.throws(() => hostedServiceToken({ HOSTED_SERVICE_TOKEN: HOSTED_TOKEN }, [HOSTED_TOKEN]), /must differ/);
  assert.equal(hostedServiceToken({ HOSTED_SERVICE_TOKEN: HOSTED_TOKEN }, ["executor-token-123456"]), HOSTED_TOKEN);
  assert.equal(hostedServiceToken({ HOSTED_SERVICE_TOKEN: `${HOSTED_TOKEN}\n` }, ["executor-token-123456"]), HOSTED_TOKEN);
  assert.throws(() => hostedServiceToken({ HOSTED_SERVICE_TOKEN: ` ${HOSTED_TOKEN} ` }, [HOSTED_TOKEN]), /must differ/);
  assert.throws(() => hostedServiceToken({ HOSTED_SERVICE_TOKEN: " ".repeat(40) }, []), /at least 32/);
});

test("the executor's hosted route accepts only its own token and never reaches a sender", async () => {
  const seen: WalletCommand[] = [];
  const depsFor = async (command: WalletCommand): Promise<CommandDeps> => {
    seen.push(command);
    return {
      quote: async (item) => ({ planId: "zeroex", kind: "aggregator", hops: [], priceImpactPct: 0.1, feeUsd: 0, buyAmount: "42", chain: item.sell.chain, chainKey: item.sell.chainKey }),
      execute: async () => {
        throw new Error("a hosted command reached execute");
      },
    };
  };
  const app = await buildApp({ authTokens: ["executor-token-123456"], logger: false });
  registerHostedRoutes(app, { token: HOSTED_TOKEN, depsFor });
  try {
    const swap = { ...IDS, command: { kind: "swap", chainKey: "base", sellToken: USDC, buyToken: WETH, sellAmount: "1000000", slippageBps: 50, taker: null, idempotencyKey: "swap-0001" } };
    const post = (token: string, payload: unknown) => app.inject({ method: "POST", url: "/hosted/commands", headers: { authorization: `Bearer ${token}` }, payload: payload as Record<string, unknown> });
    assert.equal((await post("executor-token-123456", swap)).statusCode, 401);
    const planned = await post(HOSTED_TOKEN, swap);
    assert.equal(planned.statusCode, 200);
    assert.equal(planned.json().status, "would_swap");
    assert.equal(planned.json().quote.buyAmount, "42");
    const transfer = await post(HOSTED_TOKEN, { ...IDS, command: { kind: "transfer", chainKey: "base", token: USDC, to: WETH, amount: "5", idempotencyKey: "xfer-0001" } });
    assert.equal(transfer.json().status, "would_send");
    assert.equal((await post(HOSTED_TOKEN, { ...swap, command: { ...swap.command, mode: "live" } })).statusCode, 400);
    assert.deepEqual(seen.map((command) => command.kind), ["quote", "transfer"]);
  } finally {
    await app.close();
  }
});
