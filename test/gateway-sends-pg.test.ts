import assert from "node:assert/strict";
import test from "node:test";
import { createAgent } from "../src/gateway/agents.js";
import { buildGateway } from "../src/gateway/app.js";
import type { ExecutorClient } from "../src/gateway/executor-client.js";
import { createWallet } from "../src/gateway/wallets.js";
import type { HostedRequest } from "../src/hosted-commands.js";
import { gatewayConfig, ORIGIN, signedInAccount } from "./gateway-fixtures.js";
import { migratedSchema, TEST_DATABASE_URL } from "./pg-schema.js";
import { softAuthenticator } from "./webauthn-fixtures.js";

const USDC = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";
const WETH = "0x4200000000000000000000000000000000000006";
const OWN = "0x9999999999999999999999999999999999999999";
const usdc = (dollars: number) => String(Math.round(dollars * 1_000_000));

type Reply = { isError: boolean; text: string; body: Record<string, unknown> | null };

async function harness(options: { approvalAboveUsd: number | null; netOutputUsd?: number }) {
  const { pool, drop } = await migratedSchema();
  const sent: HostedRequest[] = [];
  const failures: Error[] = [];
  const executor: ExecutorClient = {
    run: async (request) => {
      const failure = failures.shift();
      if (failure) throw failure;
      sent.push(request);
      return { kind: "swap", status: "would_swap", quote: { buyAmount: "42", feeUsd: 0, netOutputUsd: options.netOutputUsd } };
    },
  };
  const app = await buildGateway({ config: gatewayConfig(), pool, logger: false, keys: { key: async () => null }, executor, turnkey: null, delegation: null });
  const user = await signedInAccount(pool);
  const created = await createWallet(pool, user.accountId, { label: "main", level: "enclave" });
  const walletId = "walletId" in created ? created.walletId : "";
  await pool.query("INSERT INTO wallet_addresses (wallet_id, family, address) VALUES ($1, 'evm', $2)", [walletId, OWN]);
  const policy = await pool.query("SELECT document FROM policies WHERE wallet_id = $1", [walletId]);
  await pool.query("UPDATE policies SET document = $2 WHERE wallet_id = $1", [walletId, JSON.stringify({ ...policy.rows[0].document, actions: ["swap", "transfer"], approvalAboveUsd: options.approvalAboveUsd })]);
  const agent = await createAgent(pool, { accountId: user.accountId, walletId, name: "bot", limits: { chains: ["base"], actions: ["swap", "transfer"], maxTxUsd: 20, dailyUsd: 40 } });
  if ("refused" in agent) throw new Error(agent.refused);
  const authenticator = softAuthenticator({ rpId: "whale.example", origin: ORIGIN });
  const registration = (await app.inject({ method: "POST", url: "/api/passkeys/options", headers: user.headers, payload: {} })).json();
  const added = await app.inject({ method: "POST", url: "/api/passkeys", headers: user.headers, payload: { credential: authenticator.register(registration.challenge), label: "Mac" } });
  assert.equal(added.statusCode, 201);

  const call = async (name: string, args: Record<string, unknown>): Promise<Reply> => {
    const response = await app.inject({ method: "POST", url: "/mcp", headers: { authorization: `Bearer ${agent.apiKey}`, accept: "application/json, text/event-stream" }, payload: { jsonrpc: "2.0", id: 7, method: "tools/call", params: { name, arguments: args } } });
    const result = response.json().result as { isError: boolean; content: { text: string }[] };
    const text = result.content[0]?.text ?? "";
    let body: Record<string, unknown> | null = null;
    try {
      body = JSON.parse(text) as Record<string, unknown>;
    } catch {
      body = null;
    }
    return { isError: result.isError, text, body };
  };
  const swap = (key: string, dollars: number, sellToken = USDC) => call("swap", { chain: "base", sellToken, buyToken: sellToken === USDC ? WETH : USDC, sellAmount: sellToken === USDC ? usdc(dollars) : "1000000000000000000", idempotencyKey: key });
  const approve = async (approvalId: string) => {
    const approval = (await app.inject({ method: "GET", url: "/api/approvals", headers: user.headers })).json().approvals.find((entry: { id: string }) => entry.id === approvalId);
    const stepUp = (await app.inject({ method: "POST", url: "/api/passkeys/step-up", headers: user.headers, payload: { action: { kind: "approval.approve", approvalId, command: approval.command } } })).json();
    return app.inject({ method: "POST", url: `/api/approvals/${approvalId}/approve`, headers: user.headers, payload: { assertion: authenticator.assert(stepUp.challenge) } });
  };
  return { app, pool, user, sent, failures, call, swap, approve, drop: async () => (await app.close(), await drop()) };
}

test("a swap is priced by what it sells, so a bad quote cannot slip a large sell past the cap or the threshold", { skip: !TEST_DATABASE_URL }, async () => {
  for (const netOutputUsd of [0.5, 0, -3]) {
    const { sent, swap, drop } = await harness({ approvalAboveUsd: 10, netOutputUsd });
    try {
      const huge = await swap(`huge-${netOutputUsd}`, 1_000_000);
      assert.equal(huge.isError, true, `a 1,000,000 USDC sell netting ${netOutputUsd} USD is refused`);
      assert.match(huge.text, /1000000\.00 USD, above this agent's 20\.00 USD per-transaction cap/);
      const held = await swap(`held-${netOutputUsd}`, 15);
      assert.equal(held.body?.status, "approval_required");
      assert.equal(held.body?.estimateUsd, 15);
      const unpriced = await swap(`weth-${netOutputUsd}`, 0, WETH);
      assert.equal(unpriced.body?.status, "approval_required");
      assert.equal(unpriced.body?.estimateUsd, null);
      assert.equal(sent.length, 0);
    } finally {
      await drop();
    }
  }
});

test("an approved send that waited past its hour is refused, not spent", { skip: !TEST_DATABASE_URL }, async () => {
  const { pool, sent, swap, approve, drop } = await harness({ approvalAboveUsd: 10 });
  try {
    const asked = await swap("stale-approval", 15);
    const approvalId = String(asked.body?.approvalId);
    assert.equal((await approve(approvalId)).statusCode, 200);
    await pool.query("UPDATE approvals SET created_at = created_at - interval '30 days', decided_at = decided_at - interval '30 days', expires_at = expires_at - interval '30 days' WHERE id = $1", [approvalId]);
    const late = await swap("stale-approval", 15);
    assert.equal(late.isError, true);
    assert.match(late.text, /expired/);
    assert.equal(sent.length, 0);
  } finally {
    await drop();
  }
});
