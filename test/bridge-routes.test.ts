import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { PublicKey } from "@solana/web3.js";
import { resetProviderGuards } from "../src/aggregators.js";
import { parseCommand } from "../src/cli.js";
import { commandDeps } from "../src/command-callers.js";
import { run, type WalletCommand, type WalletResult } from "../src/commands.js";
import { callTool, createHandler, TOOLS } from "../src/mcp-server.js";

const owner = `0x${"22".repeat(20)}`;
const stranger = `0x${"44".repeat(20)}`;
const hot = `0x${"33".repeat(20)}`;
const solanaOwner = new PublicKey(new Uint8Array(32).fill(9)).toBase58();
const solanaHot = new PublicKey(new Uint8Array(32).fill(5)).toBase58();
function caseVariant(address: string): string {
  for (let index = 0; index < address.length; index += 1) {
    const char = address.charAt(index);
    const flipped = char === char.toLowerCase() ? char.toUpperCase() : char.toLowerCase();
    if (flipped === char) continue;
    const variant = address.slice(0, index) + flipped + address.slice(index + 1);
    try {
      if (new PublicKey(variant).toBase58() === variant) return variant;
    } catch {
      continue;
    }
  }
  throw new Error("no valid case variant");
}
const solanaLookalike = caseVariant(solanaOwner);

const baseEnv: NodeJS.ProcessEnv = {
  OWNER_WITHDRAW_ADDRESSES: `${owner},${solanaOwner}`,
  TURNKEY_EVM_ADDRESS: hot,
  TURNKEY_SOLANA_ADDRESS: solanaHot,
  BRIDGE_QUOTE_TIMEOUT_MS: "200",
  MAX_BRIDGE_FEE_BPS: "100",
};

type Provider = "lifi" | "across" | "relay" | "debridge";
type Call = { provider: Provider; method: string; url: URL; body: Record<string, unknown> | null };
type Answer = (url: URL, body: Record<string, unknown> | null) => unknown;

const lifi: Answer = (url) => ({
  action: { fromAmount: url.searchParams.get("fromAmount"), toAddress: url.searchParams.get("toAddress") },
  estimate: { toAmount: "9975000", gasCosts: [{ amountUSD: "0.01" }] },
});
const across: Answer = (url) => ({
  inputAmount: url.searchParams.get("amount"),
  expectedOutputAmount: "9990000",
  fees: { total: { amountUsd: "0.01" }, originGas: { amountUsd: "0.005" } },
});
const relay: Answer = (_url, body) => ({
  details: { recipient: body?.recipient, currencyIn: { amount: body?.amount }, currencyOut: { amount: "9980000" } },
  fees: { gas: { amountUsd: "0.002" } },
});

function providerOf(url: URL): Provider | null {
  if (url.host === "li.quest") return "lifi";
  if (url.host === "app.across.to") return "across";
  if (url.host === "api.relay.link") return "relay";
  if (url.host.endsWith("debridge.finance")) return "debridge";
  return null;
}

function stubFetch(answers: Partial<Record<Provider, Answer | "timeout" | "fail">>) {
  const calls: Call[] = [];
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input));
    const provider = providerOf(url);
    if (!provider) throw new Error(`unexpected host ${url.host}`);
    const body = typeof init?.body === "string" ? (JSON.parse(init.body) as Record<string, unknown>) : null;
    calls.push({ provider, method: init?.method ?? "GET", url, body });
    const answer = answers[provider];
    if (answer === undefined) throw new Error(`no stub for ${provider}`);
    if (answer === "fail") return new Response("upstream error", { status: 500 });
    if (answer === "timeout") return new Promise<Response>(() => undefined);
    return new Response(JSON.stringify(answer(url, body)), { status: 200, headers: { "content-type": "application/json" } });
  }) as typeof fetch;
  return { fetchImpl, calls };
}

function bridge(destination: { chainKey: string; address: string }, fromChainKey = "base"): Extract<WalletCommand, { kind: "bridge" }> {
  return { kind: "bridge", fromChainKey, destination, asset: "USDC", amount: "10000000" };
}

async function plan(command: Extract<WalletCommand, { kind: "bridge" }>, fetchImpl: typeof fetch, env: NodeJS.ProcessEnv = baseEnv) {
  resetProviderGuards();
  const result = await run(command, commandDeps(env, command, fetchImpl));
  assert.equal(result.kind, "bridge");
  return result as Extract<WalletResult, { kind: "bridge" }>;
}

test("bridge routes are fetched from each provider and ranked by fee", async () => {
  const { fetchImpl, calls } = stubFetch({ lifi, across, relay });
  const result = await plan(bridge({ chainKey: "arbitrum", address: owner }), fetchImpl);
  assert.deepEqual(calls.map((call) => call.provider).sort(), ["across", "lifi", "relay"]);
  assert.deepEqual(result.quotes.map((quote) => quote.provider), ["across", "relay", "lifi"]);
  assert.equal(result.plan.kind, "would_send");
  if (result.plan.kind !== "would_send") return;
  assert.equal(result.plan.quote.provider, "across");
  assert.equal(result.plan.quote.amountInUsd, 10);
  assert.ok(Math.abs(result.plan.quote.feeUsd - 0.015) < 1e-9);
  assert.deepEqual(result.plan.quote.destination, { chainKey: "arbitrum", address: owner });
  assert.equal(result.plan.broadcast, false);
  const lifiCall = calls.find((call) => call.provider === "lifi");
  assert.equal(lifiCall?.url.searchParams.get("fromAddress"), hot);
  assert.equal(lifiCall?.url.searchParams.get("toAddress"), owner);
});

test("one provider timing out and another failing do not sink the rest", async () => {
  const { fetchImpl, calls } = stubFetch({ lifi: "fail", across: "timeout", relay });
  const started = Date.now();
  const result = await plan(bridge({ chainKey: "arbitrum", address: owner }), fetchImpl);
  assert.ok(Date.now() - started < 2_000, "a hung provider is cut off by the bridge quote timeout");
  assert.equal(calls.length, 3);
  assert.deepEqual(result.quotes.map((quote) => quote.provider), ["relay"]);
  assert.equal(result.plan.kind, "would_send");
  if (result.plan.kind === "would_send") assert.equal(result.plan.quote.provider, "relay");
});

test("a quote whose provider reports another recipient or amount is dropped", async () => {
  const { fetchImpl } = stubFetch({
    lifi: (url) => ({ action: { fromAmount: url.searchParams.get("fromAmount"), toAddress: stranger }, estimate: { toAmount: "9999000" } }),
    across: (url) => ({ ...(across(url, null) as object), inputAmount: "1" }),
    relay,
  });
  const result = await plan(bridge({ chainKey: "arbitrum", address: owner }), fetchImpl);
  assert.deepEqual(result.quotes.map((quote) => quote.provider), ["relay"]);
});

test("a destination outside the owner allowlist or on a disabled chain is refused before any fetch", async () => {
  const { fetchImpl, calls } = stubFetch({ lifi, across, relay });
  const foreign = await plan(bridge({ chainKey: "arbitrum", address: stranger }), fetchImpl);
  assert.equal(foreign.plan.kind, "skip");
  assert.match(foreign.plan.reason, /allowlist/);
  const disabled = await plan(bridge({ chainKey: "ethereum", address: owner }), fetchImpl);
  assert.equal(disabled.plan.kind, "skip");
  assert.match(disabled.plan.reason, /ethereum is not enabled/);
  const wrongFormat = await plan(bridge({ chainKey: "arbitrum", address: solanaOwner }), fetchImpl);
  assert.equal(wrongFormat.plan.kind, "skip");
  const disabledSource = await plan(bridge({ chainKey: "arbitrum", address: owner }, "ethereum"), fetchImpl);
  assert.equal(disabledSource.plan.kind, "skip");
  assert.match(disabledSource.plan.reason, /ethereum is not enabled/);
  assert.equal(calls.length, 0);
});

test("a Solana destination keeps its case and a case variant is refused", async () => {
  const { fetchImpl, calls } = stubFetch({ lifi, across, relay });
  const result = await plan(bridge({ chainKey: "solana", address: solanaOwner }), fetchImpl);
  assert.deepEqual(calls.map((call) => call.provider).sort(), ["lifi", "relay"]);
  assert.equal(calls.find((call) => call.provider === "lifi")?.url.searchParams.get("toAddress"), solanaOwner);
  assert.equal(calls.find((call) => call.provider === "relay")?.body?.recipient, solanaOwner);
  assert.equal(result.plan.kind, "would_send");
  if (result.plan.kind === "would_send") assert.deepEqual(result.plan.quote.destination, { chainKey: "solana", address: solanaOwner });

  const before = calls.length;
  const lookalike = await plan(bridge({ chainKey: "solana", address: solanaLookalike }), fetchImpl);
  assert.equal(lookalike.plan.kind, "skip");
  assert.equal(calls.length, before);

  const lowered = stubFetch({ lifi: (url) => ({ ...(lifi(url, null) as object), action: { fromAmount: "10000000", toAddress: solanaLookalike } }), relay: (url, body) => relay(url, { ...body, recipient: solanaLookalike }) });
  const echoed = await plan(bridge({ chainKey: "solana", address: solanaOwner }), lowered.fetchImpl);
  assert.equal(echoed.plan.kind, "skip");
  assert.deepEqual(echoed.quotes, []);
});

test("nothing is signed or sent, even with WHALE_BROADCAST set", async () => {
  const { fetchImpl, calls } = stubFetch({ lifi, across, relay });
  const command = bridge({ chainKey: "arbitrum", address: owner });
  const env = { ...baseEnv, WHALE_BROADCAST: "true" };
  const deps = commandDeps(env, command, fetchImpl);
  assert.equal(deps.execute, undefined);
  const result = await plan(command, fetchImpl, env);
  assert.equal(result.plan.kind, "would_send");
  if (result.plan.kind === "would_send") assert.equal(result.plan.broadcast, false);
  for (const call of calls) {
    const quoteOnly = (call.method === "GET" && /\/(quote|swap\/approval)$/.test(call.url.pathname)) || (call.method === "POST" && call.url.pathname === "/quote/v2");
    assert.ok(quoteOnly, `${call.method} ${call.url.pathname} is a quote request`);
  }
  assert.equal(JSON.stringify(result).includes("signature"), false);
});

test("the cli parses bridge flags and refuses a missing or malformed one", () => {
  const args = ["bridge", "--from-chain", "base", "--to-chain", "arbitrum", "--asset", "USDC", "--amount", "10000000", "--to", owner];
  assert.deepEqual(parseCommand(args), bridge({ chainKey: "arbitrum", address: owner }));
  assert.throws(() => parseCommand(args.slice(0, -2)), /--to/);
  assert.throws(() => parseCommand(args.map((arg) => (arg === "10000000" ? "10.5" : arg))), /--amount/);
  assert.throws(() => parseCommand(args.map((arg) => (arg === "arbitrum" ? "nowhere" : arg))), /--to-chain/);
});

const preload = `
const seen = [];
globalThis.fetch = async (input, init = {}) => {
  const url = new URL(String(input));
  const body = typeof init.body === "string" ? JSON.parse(init.body) : null;
  process.stderr.write("CALL " + (init.method ?? "GET") + " " + url.host + url.pathname + "\\n");
  const answer = url.host === "li.quest"
    ? { action: { fromAmount: url.searchParams.get("fromAmount"), toAddress: url.searchParams.get("toAddress") }, estimate: { toAmount: "9975000" } }
    : url.host === "app.across.to"
      ? { inputAmount: url.searchParams.get("amount"), expectedOutputAmount: "9990000", fees: { originGas: { amountUsd: "0.005" } } }
      : url.host === "api.relay.link"
        ? { details: { recipient: body.recipient, currencyIn: { amount: body.amount }, currencyOut: { amount: "9980000" } }, fees: {} }
        : null;
  if (answer === null) return new Response("no network in tests", { status: 599 });
  return new Response(JSON.stringify(answer), { status: 200, headers: { "content-type": "application/json" } });
};
`;

test("the cli bridge fetches routes and prints the plan", async () => {
  const cli = fileURLToPath(new URL("../src/cli.js", import.meta.url));
  const env = { PATH: process.env.PATH, ...baseEnv, BRIDGE_QUOTE_TIMEOUT_MS: "2000" };
  const args = ["--import", `data:text/javascript,${encodeURIComponent(preload)}`, cli, "bridge", "--from-chain", "base", "--to-chain", "arbitrum", "--asset", "USDC", "--amount", "10000000", "--to", owner];
  const { stdout, stderr } = await new Promise<{ stdout: string; stderr: string }>((resolve, reject) => {
    execFile(process.execPath, args, { env }, (error, out, err) => (error ? reject(error) : resolve({ stdout: out, stderr: err })));
  });
  const printed = JSON.parse(stdout) as Extract<WalletResult, { kind: "bridge" }>;
  assert.equal(printed.kind, "bridge");
  assert.equal(printed.plan.kind, "would_send");
  if (printed.plan.kind === "would_send") {
    assert.equal(printed.plan.quote.provider, "across");
    assert.equal(printed.plan.broadcast, false);
  }
  const seen = stderr.split("\n").filter((line) => line.startsWith("CALL ")).sort();
  assert.deepEqual(seen, ["CALL GET app.across.to/api/swap/approval", "CALL GET li.quest/v1/quote", "CALL POST api.relay.link/quote/v2"]);
});

const mcpDeps = { executorUrl: "http://127.0.0.1:1", executorAuthToken: null };

test("the mcp bridge tool has a typed schema and rejects malformed input", async () => {
  const tool = TOOLS.find((item) => item.name === "bridge");
  const schema = tool?.inputSchema as { additionalProperties?: unknown; required?: readonly string[] };
  assert.equal(schema.additionalProperties, false);
  assert.deepEqual([...(schema.required ?? [])].sort(), ["amount", "asset", "destination", "fromChainKey"]);
  const valid = { fromChainKey: "base", destination: { chainKey: "arbitrum", address: stranger }, asset: "USDC", amount: "10000000" };
  for (const args of [
    {},
    { ...valid, amount: 10 },
    { ...valid, amount: "-1" },
    { ...valid, destination: "arbitrum" },
    { ...valid, allowlist: [{ chainKey: "arbitrum", address: stranger }] },
    { ...valid, quotes: [] },
  ]) {
    await assert.rejects(callTool(mcpDeps, "bridge", args as Record<string, unknown>));
  }
  const reply = (await createHandler(mcpDeps)({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "bridge", arguments: { amount: "1" } } })) as { result: { isError?: boolean } };
  assert.equal(reply.result.isError, true);
});
