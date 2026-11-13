import assert from "node:assert/strict";
import test from "node:test";
import { createAgent } from "../src/gateway/agents.js";
import { buildGateway } from "../src/gateway/app.js";
import { createWallet } from "../src/gateway/wallets.js";
import { gatewayConfig, signedInAccount } from "./gateway-fixtures.js";
import { migratedSchema, TEST_DATABASE_URL } from "./pg-schema.js";

const USDC = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";
const LISTED = "0x1111111111111111111111111111111111111111";
const STRANGER = "0x2222222222222222222222222222222222222222";
const usdc = (dollars: number) => String(Math.round(dollars * 1_000_000));

type Option = { payTo: string; amount: string; verdict: string; reasons: string[] };
type Plan = { status: string; options: Option[]; best: Option | null };

async function harness(options: { approvalAboveUsd: number | null; actions: ("swap" | "transfer")[] }) {
  const { pool, drop } = await migratedSchema();
  let challenge: unknown = null;
  const fetch402 = async () => ({ status: 402, body: JSON.stringify(challenge) });
  const app = await buildGateway({ config: gatewayConfig(), pool, logger: false, keys: { key: async () => null }, executor: null, turnkey: null, delegation: null, fetch402 });
  const user = await signedInAccount(pool);
  const created = await createWallet(pool, user.accountId, { label: "main", level: "enclave" });
  const walletId = "walletId" in created ? created.walletId : "";
  const policy = await pool.query("SELECT document FROM policies WHERE wallet_id = $1", [walletId]);
  const document = { ...policy.rows[0].document, actions: ["swap", "transfer"], maxTxUsd: 100, dailyUsd: 1000, approvalAboveUsd: options.approvalAboveUsd, destinations: [{ family: "evm", address: LISTED, label: "vendor" }] };
  await pool.query("UPDATE policies SET document = $2 WHERE wallet_id = $1", [walletId, JSON.stringify(document)]);
  const agent = await createAgent(pool, { accountId: user.accountId, walletId, name: "bot", limits: { chains: ["base"], actions: options.actions, maxTxUsd: 20, dailyUsd: 40 } });
  if ("refused" in agent) throw new Error(agent.refused);
  const quote = async (accepts: unknown[]): Promise<Plan> => {
    challenge = { x402Version: 1, accepts };
    const response = await app.inject({ method: "POST", url: "/mcp", headers: { authorization: `Bearer ${agent.apiKey}`, accept: "application/json, text/event-stream" }, payload: { jsonrpc: "2.0", id: 7, method: "tools/call", params: { name: "x402_quote", arguments: { url: "https://paid.example/data" } } } });
    return JSON.parse(response.json().result.content[0].text) as Plan;
  };
  const spent = (dollars: number) =>
    pool.query("INSERT INTO agent_spends (agent_id, idempotency_key, binding, account_id, wallet_id, usd, day) VALUES ($1, 'earlier', 'b', $2, $3, $4, CURRENT_DATE)", [agent.agentId, user.accountId, walletId, dollars]);
  return { quote, spent, drop: async () => (await app.close(), await drop()) };
}

const pay = (dollars: number, payTo: string) => ({ scheme: "exact", network: "base", maxAmountRequired: usdc(dollars), asset: USDC, payTo });

test("an x402 option fits only when the hosted transfer checks and the USD caps allow the same payment", { skip: !TEST_DATABASE_URL }, async () => {
  const { quote, spent, drop } = await harness({ approvalAboveUsd: null, actions: ["swap", "transfer"] });
  try {
    const plan = await quote([pay(1, STRANGER), pay(30, LISTED), pay(5, LISTED)]);
    assert.deepEqual(plan.options.map((entry) => entry.verdict), ["refused", "refused", "fits"]);
    assert.match(plan.options[0]?.reasons.join("; ") ?? "", /not on the wallet's destination list/);
    assert.match(plan.options[1]?.reasons.join("; ") ?? "", /30\.00 USD, above this agent's 20\.00 USD per-transaction cap/);
    assert.equal(plan.best?.amount, usdc(5));
    await spent(38);
    const late = await quote([pay(5, LISTED)]);
    assert.equal(late.best, null);
    assert.match(late.options[0]?.reasons.join("; ") ?? "", /above this agent's 40\.00 USD daily cap/);
  } finally {
    await drop();
  }
});

test("an x402 payment needs approval when the owner set a threshold, and is refused to an agent that may not transfer", { skip: !TEST_DATABASE_URL }, async () => {
  const held = await harness({ approvalAboveUsd: 10, actions: ["swap", "transfer"] });
  try {
    const plan = await held.quote([pay(5, LISTED)]);
    assert.equal(plan.best?.verdict, "needs_approval");
    assert.match(plan.best?.reasons.join("; ") ?? "", /owner's approval/);
  } finally {
    await held.drop();
  }
  const swapper = await harness({ approvalAboveUsd: null, actions: ["swap"] });
  try {
    const plan = await swapper.quote([pay(5, LISTED)]);
    assert.equal(plan.best, null);
    assert.match(plan.options[0]?.reasons.join("; ") ?? "", /may not transfer/);
  } finally {
    await swapper.drop();
  }
});
