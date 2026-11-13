import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { createServer, request, type RequestListener } from "node:http";
import type { AddressInfo } from "node:net";
import test from "node:test";
import { audit } from "../src/gateway/accounts.js";
import { buildGateway } from "../src/gateway/app.js";
import { pinnedRequest } from "../src/gateway/safe-https.js";
import { deliverDue, RETRY_AFTER_MS, signature, type Send } from "../src/gateway/webhooks.js";
import { gatewayConfig, signedInAccount } from "./gateway-fixtures.js";
import { migratedSchema, TEST_DATABASE_URL } from "./pg-schema.js";

const SECRET = gatewayConfig().secret;

test("a webhook signature is an HMAC over the timestamp and the exact body", () => {
  const expected = createHmac("sha256", "whsec_x").update('1700000000.{"a":1}').digest("hex");
  assert.equal(signature("whsec_x", 1_700_000_000, '{"a":1}'), `t=1700000000,v1=${expected}`);
});

test("webhooks get only their account's chosen events, signed, retried on failure, and refused for non-public URLs", { skip: !TEST_DATABASE_URL }, async () => {
  const { pool, drop } = await migratedSchema();
  const app = await buildGateway({ config: gatewayConfig(), pool, logger: false, keys: { key: async () => null }, executor: null, turnkey: null, delegation: null });
  try {
    const user = await signedInAccount(pool);
    const other = await signedInAccount(pool);
    for (const url of ["http://hooks.example/x", "https://10.0.0.1/x", "https://hooks.example:8443/x"]) {
      const refused = await app.inject({ method: "POST", url: "/api/webhooks", headers: user.headers, payload: { url, format: "whale", events: ["wallet.frozen"] } });
      assert.equal(refused.statusCode, 400, url);
    }
    const created = await app.inject({ method: "POST", url: "/api/webhooks", headers: user.headers, payload: { url: "https://hooks.example/whale", format: "whale", events: ["wallet.frozen", "mcp.denied"] } });
    assert.equal(created.statusCode, 201);
    const { id, secret } = created.json();
    assert.match(secret, /^whsec_/);
    assert.equal(JSON.stringify((await pool.query("SELECT * FROM webhooks")).rows).includes(secret), false);
    const slack = (await app.inject({ method: "POST", url: "/api/webhooks", headers: user.headers, payload: { url: "https://hooks.slack.example/T1", format: "slack", events: ["mcp.denied"] } })).json();

    await audit(pool, { accountId: user.accountId, actor: "user", action: "wallet.frozen" });
    await audit(pool, { accountId: user.accountId, actor: "agent", action: "mcp.denied", detail: { reason: "chain outside limits" } });
    await audit(pool, { accountId: user.accountId, actor: "user", action: "policy.narrowed" });
    await audit(pool, { accountId: other.accountId, actor: "user", action: "wallet.frozen" });
    const queued = await pool.query("SELECT webhook_id FROM webhook_deliveries");
    assert.equal(queued.rows.length, 3);

    const sent: { url: string; headers: Record<string, string>; body: string }[] = [];
    let status = 200;
    const send: Send = async (url, init) => {
      sent.push({ url, headers: init.headers, body: init.body });
      return { status, body: "", truncated: false };
    };
    let clock = Date.now() + 1_000;
    assert.equal(await deliverDue(pool, SECRET, send, clock), 3);
    const signed = sent.find((entry) => entry.url === "https://hooks.example/whale" && entry.body.includes("wallet.frozen"));
    assert.ok(signed);
    const timestamp = Number(/t=(\d+)/.exec(signed.headers["whale-signature"] ?? "")?.[1]);
    assert.equal(signed.headers["whale-signature"], signature(secret, timestamp, signed.body));
    const slackBody = sent.find((entry) => entry.url === "https://hooks.slack.example/T1");
    assert.deepEqual(JSON.parse(slackBody?.body ?? "{}"), { text: "Whale · mcp.denied: chain outside limits" });
    assert.equal(await deliverDue(pool, SECRET, send, clock), 0);

    status = 500;
    assert.equal((await app.inject({ method: "POST", url: `/api/webhooks/${id}/test`, headers: user.headers, payload: {} })).statusCode, 202);
    clock = Date.now() + 1_000;
    assert.equal(await deliverDue(pool, SECRET, send, clock), 0);
    for (const wait of RETRY_AFTER_MS.slice(0, -1)) {
      clock += wait + 1;
      assert.equal(await deliverDue(pool, SECRET, send, clock), 0);
    }
    clock += (RETRY_AFTER_MS.at(-1) ?? 0) + 1;
    await deliverDue(pool, SECRET, send, clock);
    const test = await pool.query("SELECT attempts, gave_up_at IS NOT NULL AS gave_up, last_status FROM webhook_deliveries d JOIN audit_events e ON e.id = d.event_id WHERE e.action = 'webhook.test'");
    assert.deepEqual(test.rows[0], { attempts: 6, gave_up: true, last_status: 500 });
    const listed = (await app.inject({ method: "GET", url: "/api/webhooks", headers: user.headers })).json().webhooks.find((hook: { id: string }) => hook.id === id);
    assert.deepEqual([listed.failures, listed.lastStatus], [6, 500]);

    assert.equal((await app.inject({ method: "DELETE", url: `/api/webhooks/${id}`, headers: other.headers })).statusCode, 404);
    assert.equal((await app.inject({ method: "POST", url: `/api/webhooks/${slack.id}/test`, headers: other.headers, payload: {} })).statusCode, 404);
    assert.equal((await app.inject({ method: "DELETE", url: `/api/webhooks/${id}`, headers: user.headers })).statusCode, 204);
  } finally {
    await app.close();
    await drop();
  }
});

async function harness() {
  const { pool, drop } = await migratedSchema();
  const app = await buildGateway({ config: gatewayConfig(), pool, logger: false, keys: { key: async () => null }, executor: null, turnkey: null, delegation: null });
  const user = await signedInAccount(pool);
  const hook = async (events: string[] = ["wallet.frozen"]) =>
    (await app.inject({ method: "POST", url: "/api/webhooks", headers: user.headers, payload: { url: "https://hooks.example/whale", format: "whale", events } })).json() as { id: string; secret: string };
  return { app, pool, user, hook, drop: async () => (await app.close(), await drop()) };
}

test("a delivery row cannot point one account's webhook at another account's event", { skip: !TEST_DATABASE_URL }, async () => {
  const { pool, user, hook, drop } = await harness();
  try {
    const other = await signedInAccount(pool);
    const { id } = await hook();
    await audit(pool, { accountId: other.accountId, actor: "user", action: "wallet.frozen" });
    const event = (await pool.query<{ id: string }>("SELECT id FROM audit_events WHERE account_id = $1", [other.accountId])).rows[0]?.id;
    await assert.rejects(
      pool.query("INSERT INTO webhook_deliveries (webhook_id, account_id, event_id, next_attempt_at) VALUES ($1, $2, $3, now())", [id, other.accountId, event]),
      /violates foreign key constraint/,
    );
    await pool.query("INSERT INTO webhook_deliveries (webhook_id, account_id, event_id, next_attempt_at) VALUES ($1, $2, $3, now())", [id, user.accountId, event]);
    const sent: string[] = [];
    assert.equal(await deliverDue(pool, SECRET, async (_url, init) => (sent.push(init.body), { status: 200, body: "", truncated: false })), 0);
    assert.deepEqual(sent, []);
  } finally {
    await drop();
  }
});

async function receiver(handler: RequestListener) {
  const server = createServer(handler);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const url = new URL(`http://127.0.0.1:${(server.address() as AddressInfo).port}/hook`);
  const send: Send = (_url, init) => pinnedRequest(url, init, request);
  return { send, close: () => (server.closeAllConnections(), server.close()) };
}

test("a 200 with a body over the cap counts as delivered, once", { skip: !TEST_DATABASE_URL }, async () => {
  const { pool, user, hook, drop } = await harness();
  const endpoint = await receiver((_request, response) => {
    response.writeHead(200, { "content-type": "text/plain" });
    response.end("x".repeat(64 * 1024));
  });
  try {
    await hook();
    await audit(pool, { accountId: user.accountId, actor: "user", action: "wallet.frozen" });
    const clock = Date.now() + 1_000;
    assert.equal(await deliverDue(pool, SECRET, endpoint.send, clock), 1);
    const row = (await pool.query("SELECT attempts, delivered_at IS NOT NULL AS delivered, last_status, last_error FROM webhook_deliveries")).rows[0];
    assert.deepEqual(row, { attempts: 1, delivered: true, last_status: 200, last_error: null });
    assert.equal((await pool.query("SELECT failures FROM webhooks")).rows[0]?.failures, 0);
    assert.equal(await deliverDue(pool, SECRET, endpoint.send, clock + RETRY_AFTER_MS[0]! + 1), 0);
  } finally {
    endpoint.close();
    await drop();
  }
});

test("a receiver that drips its answer is cut off at the send deadline, well inside the lease", { skip: !TEST_DATABASE_URL }, async () => {
  const { pool, user, hook, drop } = await harness();
  let hits = 0;
  const endpoint = await receiver((_request, response) => {
    hits += 1;
    response.writeHead(200, { "content-type": "text/plain" });
    const drip = setInterval(() => response.write(" "), 50);
    response.on("close", () => clearInterval(drip));
  });
  try {
    await hook();
    await audit(pool, { accountId: user.accountId, actor: "user", action: "wallet.frozen" });
    const started = Date.now();
    const outcome = await Promise.race([deliverDue(pool, SECRET, endpoint.send, Date.now() + 1_000), new Promise((resolve) => setTimeout(() => resolve("still sending after 8 s"), 8_000))]);
    assert.equal(outcome, 0);
    assert.ok(Date.now() - started < 7_000, `took ${Date.now() - started} ms`);
    const row = (await pool.query("SELECT attempts, delivered_at IS NULL AS pending, last_error FROM webhook_deliveries")).rows[0];
    assert.deepEqual(row, { attempts: 1, pending: true, last_error: "timed out" });
    assert.equal(hits, 1);
  } finally {
    endpoint.close();
    await drop();
  }
});
