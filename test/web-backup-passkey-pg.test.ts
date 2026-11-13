import assert from "node:assert/strict";
import test from "node:test";
import type { FastifyInstance } from "fastify";
import { buildGateway } from "../src/gateway/app.js";
import { ApiError } from "../web/src/api.js";
import { addBackupPasskey, type BackupDeps } from "../web/src/backup-passkey.js";
import { gatewayConfig, signedInAccount } from "./gateway-fixtures.js";
import { migratedSchema, TEST_DATABASE_URL } from "./pg-schema.js";
import { softAuthenticator, type SoftAuthenticator } from "./webauthn-fixtures.js";

const RP = { rpId: "whale.example", origin: "https://whale.example" };

function browser(app: FastifyInstance, headers: Record<string, string>, owner: SoftAuthenticator, next: SoftAuthenticator): BackupDeps {
  const api = (async (path: string, init: { method?: string; body?: unknown } = {}) => {
    const reply = await app.inject({ method: (init.method ?? "GET") as "GET", url: path, headers, ...(init.body === undefined ? {} : { payload: init.body as object }) });
    if (reply.statusCode === 204) return undefined;
    const body = reply.json();
    if (reply.statusCode >= 400) throw new ApiError(reply.statusCode, body.error, body.detail ?? null);
    return body;
  }) as BackupDeps["api"];
  return {
    api,
    createPasskey: async (options) => next.register(options.challenge),
    stepUp: async (action) => owner.assert((await api<{ challenge: string }>("/api/passkeys/step-up", { method: "POST", body: { action } })).challenge),
  };
}

test("the backup passkey button adds a second passkey only with a step-up from the first", { skip: !TEST_DATABASE_URL }, async () => {
  const { pool, drop } = await migratedSchema();
  const app = await buildGateway({ config: gatewayConfig(), pool, logger: false, keys: { key: async () => null }, executor: null });
  try {
    const user = await signedInAccount(pool);
    const first = softAuthenticator(RP);
    const options = (await app.inject({ method: "POST", url: "/api/passkeys/options", headers: user.headers, payload: {} })).json();
    assert.equal((await app.inject({ method: "POST", url: "/api/passkeys", headers: user.headers, payload: { credential: first.register(options.challenge), label: "Phone" } })).statusCode, 201);

    const intruder = softAuthenticator(RP);
    const sessionOnly = (await app.inject({ method: "POST", url: "/api/passkeys/options", headers: user.headers, payload: {} })).json();
    const refused = await app.inject({ method: "POST", url: "/api/passkeys", headers: user.headers, payload: { credential: intruder.register(sessionOnly.challenge), label: "Stolen session" } });
    assert.deepEqual([refused.statusCode, refused.json().error], [428, "step_up_required"]);

    const backup = softAuthenticator(RP);
    const statuses: string[] = [];
    await addBackupPasskey(browser(app, user.headers, first, backup), "Laptop", (status) => statuses.push(status));
    assert.deepEqual(statuses, ["Create the new passkey…", "Approve the new passkey with one you already have…"]);
    const listed = (await app.inject({ method: "GET", url: "/api/passkeys", headers: user.headers })).json().passkeys;
    assert.deepEqual(listed.map((entry: { label: string }) => entry.label), ["Phone", "Laptop"]);

    const wrongKey = softAuthenticator(RP);
    await assert.rejects(addBackupPasskey(browser(app, user.headers, wrongKey, softAuthenticator(RP)), "Tablet"), (error: unknown) => error instanceof ApiError && error.status === 403);
    assert.equal((await pool.query("SELECT count(*)::int AS n FROM passkeys")).rows[0]?.n, 2);
  } finally {
    await app.close();
    await drop();
  }
});
