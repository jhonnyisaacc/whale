import assert from "node:assert/strict";
import test from "node:test";
import { randomUUID } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { buildGateway } from "../src/gateway/app.js";
import type { SubOrgState, TurnkeyParent } from "../src/gateway/turnkey.js";
import { ApiError } from "../web/src/api.js";
import { addBackupPasskey, syncBackupPasskeys, type BackupDeps } from "../web/src/backup-passkey.js";
import type { Delegation } from "../web/src/turnkey.js";
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

function fakeTurnkey() {
  const orgs = new Map<string, SubOrgState>();
  const byCredential = new Map<string, string>();
  const turnkey: TurnkeyParent = {
    async submitSubOrganization(input) {
      const ownerUserId = randomUUID();
      const n = orgs.size;
      const created = { subOrganizationId: randomUUID(), walletId: randomUUID(), ownerUserId, evm: `0x${String(n).padStart(40, "7")}`, solana: `So1${String(n).padStart(40, "z")}` };
      orgs.set(created.subOrganizationId, { threshold: 1, rootUserIds: [ownerUserId], users: [{ userId: ownerUserId, userName: "owner", credentialIds: [input.authenticator.credentialId], apiPublicKeys: [] }], policies: [] });
      byCredential.set(input.authenticator.credentialId, created.subOrganizationId);
      return { activityId: randomUUID(), outcome: { state: "completed", created } };
    },
    async subOrganizationActivity() {
      throw new Error("not used");
    },
    async findSubOrganizations() {
      return { state: "listed", found: [] };
    },
    async readSubOrganization(id) {
      const state = orgs.get(id);
      if (!state) throw new Error("no sub-organization");
      return structuredClone(state);
    },
  };
  const stamps: string[][] = [];
  const addOwnerPasskeys = async (delegation: Delegation) => {
    stamps.push(delegation.ownerCredentialIds);
    const owner = orgs.get(delegation.subOrganizationId)?.users.find((user) => user.userId === delegation.ownerUserId);
    if (!owner) throw new Error("Turnkey refused: no such owner");
    for (const entry of delegation.missingAuthenticators as { attestation: { credentialId: string } }[]) owner.credentialIds.push(entry.attestation.credentialId);
  };
  return { turnkey, addOwnerPasskeys, stamps };
}

test("a backup passkey reaches every enclave, survives a cancelled approval, and joins enclaves created later", { skip: !TEST_DATABASE_URL }, async () => {
  const { pool, drop } = await migratedSchema();
  const fake = fakeTurnkey();
  const delegationConfig = { delegatePublicKey: `02${"ab".repeat(32)}`, routers: { 8453: ["0x0000000000001ff3684f28c67538d4d072c22734"] }, maxValueWei: 1n };
  const app = await buildGateway({ config: gatewayConfig(), pool, logger: false, keys: { key: async () => null }, executor: null, turnkey: fake.turnkey, delegation: delegationConfig });
  try {
    const user = await signedInAccount(pool);
    const enclave = async (root: SoftAuthenticator, approver: SoftAuthenticator | null) => {
      const wallet = (await app.inject({ method: "POST", url: "/api/wallets", headers: user.headers, payload: { label: `vault-${root.credentialId.toString("hex").slice(0, 4)}`, level: "enclave" } })).json();
      const options = (await app.inject({ method: "POST", url: `/api/wallets/${wallet.id}/enclave/options`, headers: user.headers, payload: {} })).json();
      const credential = root.register(options.challenge);
      let assertion;
      if (approver) {
        const stepUp = (await app.inject({ method: "POST", url: "/api/passkeys/step-up", headers: user.headers, payload: { action: { kind: "passkey.add", credentialId: credential.id } } })).json();
        assertion = approver.assert(stepUp.challenge);
      }
      const created = await app.inject({ method: "POST", url: `/api/wallets/${wallet.id}/enclave`, headers: user.headers, payload: { credential, label: "root", ...(assertion ? { assertion } : {}) } });
      assert.equal(created.statusCode, 201, created.body);
      return wallet.id as string;
    };
    const delegation = async (walletId: string) => (await app.inject({ method: "GET", url: `/api/wallets/${walletId}/enclave/delegation`, headers: user.headers })).json() as Delegation;
    const id = (authenticator: SoftAuthenticator) => authenticator.credentialId.toString("base64url");

    const phone = softAuthenticator(RP);
    const first = await enclave(phone, null);
    const laptop = softAuthenticator(RP);
    const deps = browser(app, user.headers, phone, laptop);
    await addBackupPasskey(deps, "Laptop");
    const pending = await delegation(first);
    assert.deepEqual(pending.ownerCredentialIds, [id(phone)]);
    assert.deepEqual(
      (pending.missingAuthenticators as { authenticatorName: string; attestation: { credentialId: string } }[]).map((entry) => [entry.authenticatorName, entry.attestation.credentialId]),
      [["Laptop", id(laptop)]],
    );

    const cancelled = async () => {
      throw new Error("The operation either timed out or was not allowed.");
    };
    await assert.rejects(syncBackupPasskeys({ api: deps.api, addOwnerPasskeys: cancelled }), /not allowed/);
    assert.equal(await syncBackupPasskeys({ api: deps.api, addOwnerPasskeys: fake.addOwnerPasskeys }), 1);
    const synced = await delegation(first);
    assert.deepEqual([synced.ownerCredentialIds, synced.missingAuthenticators], [[id(phone), id(laptop)], []]);

    const tablet = softAuthenticator(RP);
    const later = await enclave(tablet, laptop);
    assert.equal(await syncBackupPasskeys({ api: deps.api, addOwnerPasskeys: fake.addOwnerPasskeys }), 1);
    assert.deepEqual((await delegation(later)).ownerCredentialIds, [id(tablet), id(laptop)]);
    assert.deepEqual(fake.stamps, [[id(phone)], [id(tablet)]]);
  } finally {
    await app.close();
    await drop();
  }
});
