import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { buildGateway } from "../src/gateway/app.js";
import { DEFAULT_POLICY } from "../src/gateway/policy.js";
import { delegationFromEnv, expectedPolicies, verifyDelegation, type DelegationConfig, type SubOrgState, type TurnkeyParent } from "../src/gateway/turnkey.js";
import { gatewayConfig, signedInAccount } from "./gateway-fixtures.js";
import { migratedSchema, TEST_DATABASE_URL } from "./pg-schema.js";
import { softAuthenticator, type SoftAuthenticator } from "./webauthn-fixtures.js";

const RP = { rpId: "whale.example", origin: "https://whale.example" };
const DELEGATE_KEY = `02${"ab".repeat(32)}`;
const SOLANA = "9xQeWvG816bUx9EPjHmaT23yvVM2ZWbrrpZb9PusVFin";
const BASE_ROUTER = "0x0000000000001ff3684f28c67538d4d072c22734";
const ETH_ROUTER = "0x1111111111111111111111111111111111111111";
const DELEGATION: DelegationConfig = { delegatePublicKey: DELEGATE_KEY, routers: { 8453: [BASE_ROUTER], 1: [ETH_ROUTER] }, maxValueWei: 2_000_000_000_000_000n };

function fakeTurnkey() {
  const orgs = new Map<string, SubOrgState>();
  const created: { challenge: string; credentialId: string; name: string }[] = [];
  const faults = { failNextCreate: false };
  const turnkey: TurnkeyParent = {
    async createSubOrganization(input) {
      if (faults.failNextCreate) {
        faults.failNextCreate = false;
        throw new Error("turnkey is unavailable");
      }
      const subOrganizationId = randomUUID();
      const ownerUserId = randomUUID();
      created.push({ challenge: input.authenticator.challenge, credentialId: input.authenticator.credentialId, name: input.name });
      orgs.set(subOrganizationId, { threshold: 1, rootUserIds: [ownerUserId], users: [{ userId: ownerUserId, userName: "owner", credentialIds: [input.authenticator.credentialId], apiPublicKeys: [] }], policies: [] });
      return { subOrganizationId, walletId: randomUUID(), ownerUserId, evm: `0x${"9".repeat(40)}`, solana: SOLANA };
    },
    async readSubOrganization(id) {
      const state = orgs.get(id);
      if (!state) throw new Error("no sub-organization");
      return structuredClone(state);
    },
  };
  return { turnkey, orgs, created, faults };
}

test("expected Turnkey policies follow the wallet's EVM chains and scope Whale's delegate", () => {
  const delegateUserId = randomUUID();
  const policies = expectedPolicies({ delegateUserId, walletId: randomUUID(), solanaAddress: SOLANA, policy: DEFAULT_POLICY, config: DELEGATION });
  const evm = policies.find((policy) => policy.policyName.startsWith("EVM"));
  assert.match(evm?.condition ?? "", /eth\.tx\.chain_id == 8453/);
  assert.doesNotMatch(evm?.condition ?? "", /eth\.tx\.chain_id == 1 /);
  assert.ok(policies.every((policy) => policy.consensus === `approvers.any(user, user.id == '${delegateUserId}')`));
  assert.throws(() => delegationFromEnv({ TURNKEY_DELEGATE_API_PUBLIC_KEY: "nothex" }), /compressed P-256/);
  assert.equal(delegationFromEnv({}), null);
});

test("delegation is accepted only with the owner as sole root and exactly Whale's policies", () => {
  const owner = randomUUID();
  const delegate = randomUUID();
  const walletId = randomUUID();
  const expected = (id: string) => expectedPolicies({ delegateUserId: id, walletId, solanaAddress: SOLANA, policy: DEFAULT_POLICY, config: DELEGATION });
  const good: SubOrgState = {
    threshold: 1,
    rootUserIds: [owner],
    users: [
      { userId: owner, userName: "owner", credentialIds: ["cred"], apiPublicKeys: [] },
      { userId: delegate, userName: "whale-delegate", credentialIds: [], apiPublicKeys: [DELEGATE_KEY] },
    ],
    policies: expected(delegate),
  };
  const input = { ownerUserId: owner, rootCredentialId: "cred", delegatePublicKey: DELEGATE_KEY, expected };
  assert.deepEqual(verifyDelegation(good, input), { delegateUserId: delegate });
  const broken: [string, SubOrgState][] = [
    ["delegate is root", { ...good, rootUserIds: [owner, delegate], threshold: 1 }],
    ["two-of-two quorum", { ...good, threshold: 2, rootUserIds: [owner, delegate] }],
    ["extra allow policy", { ...good, policies: [...good.policies, { policyName: "x", effect: "EFFECT_ALLOW", consensus: "approvers.any(user, true)", condition: "true" }] }],
    ["missing policy", { ...good, policies: good.policies.slice(1) }],
    ["owner holds a key", { ...good, users: good.users.map((user) => (user.userId === owner ? { ...user, apiPublicKeys: ["03ff"] } : user)) }],
    ["delegate holds a passkey", { ...good, users: good.users.map((user) => (user.userId === delegate ? { ...user, credentialIds: ["x"] } : user)) }],
    ["no delegate", { ...good, users: good.users.slice(0, 1) }],
    ["wrong root passkey", { ...good, users: good.users.map((user) => (user.userId === owner ? { ...user, credentialIds: ["other"] } : user)) }],
  ];
  for (const [name, state] of broken) assert.ok("problems" in verifyDelegation(state, input), name);
});

test("an enclave wallet gets its passkey as Turnkey root, then activates only after Turnkey shows a safe delegation", { skip: !TEST_DATABASE_URL }, async () => {
  const { pool, drop } = await migratedSchema();
  const fake = fakeTurnkey();
  const app = await buildGateway({ config: gatewayConfig(), pool, logger: false, keys: { key: async () => null }, executor: null, turnkey: fake.turnkey, delegation: DELEGATION });
  try {
    const user = await signedInAccount(pool);
    const wallet = (await app.inject({ method: "POST", url: "/api/wallets", headers: user.headers, payload: { label: "main", level: "enclave" } })).json();
    const options = (await app.inject({ method: "POST", url: `/api/wallets/${wallet.id}/enclave/options`, headers: user.headers, payload: {} })).json();
    const authenticator = softAuthenticator(RP);
    const plainOptions = (await app.inject({ method: "POST", url: "/api/passkeys/options", headers: user.headers, payload: {} })).json();
    const wrongBinding = await app.inject({ method: "POST", url: `/api/wallets/${wallet.id}/enclave`, headers: user.headers, payload: { credential: authenticator.register(plainOptions.challenge), label: "Mac" } });
    assert.match(wrongBinding.json().detail, /expired or was already used/);
    const created = await app.inject({ method: "POST", url: `/api/wallets/${wallet.id}/enclave`, headers: user.headers, payload: { credential: authenticator.register(options.challenge), label: "Mac" } });
    assert.equal(created.statusCode, 201);
    assert.deepEqual(fake.created.map((entry) => [entry.challenge, entry.credentialId]), [[options.challenge, authenticator.credentialId.toString("base64url")]]);
    assert.equal((await app.inject({ method: "POST", url: `/api/wallets/${wallet.id}/enclave/options`, headers: user.headers, payload: {} })).json().error, "enclave_exists");

    const listed = (await app.inject({ method: "GET", url: "/api/wallets", headers: user.headers })).json().wallets[0];
    assert.equal(listed.status, "pending");
    assert.deepEqual(listed.addresses.map((entry: { family: string }) => entry.family), ["evm", "solana"]);

    const before = (await app.inject({ method: "GET", url: `/api/wallets/${wallet.id}/enclave/delegation`, headers: user.headers })).json();
    assert.equal(before.delegateUserId, null);
    assert.equal(before.delegateUser.apiKeys[0].publicKey, DELEGATE_KEY);
    const early = await app.inject({ method: "POST", url: `/api/wallets/${wallet.id}/enclave/confirm`, headers: user.headers, payload: {} });
    assert.equal(early.json().error, "delegation_not_safe");

    const state = fake.orgs.get(before.subOrganizationId) as SubOrgState;
    const delegateUserId = randomUUID();
    state.users.push({ userId: delegateUserId, userName: "whale-delegate", credentialIds: [], apiPublicKeys: [DELEGATE_KEY] });
    const after = (await app.inject({ method: "GET", url: `/api/wallets/${wallet.id}/enclave/delegation`, headers: user.headers })).json();
    assert.equal(after.delegateUserId, delegateUserId);
    assert.equal(after.policiesInPlace, false);
    state.policies = after.policies;
    const retry = (await app.inject({ method: "GET", url: `/api/wallets/${wallet.id}/enclave/delegation`, headers: user.headers })).json();
    assert.equal(retry.policiesInPlace, true);
    state.rootUserIds.push(delegateUserId);
    assert.match(JSON.stringify((await app.inject({ method: "POST", url: `/api/wallets/${wallet.id}/enclave/confirm`, headers: user.headers, payload: {} })).json().problems), /must not be root/);
    state.rootUserIds.pop();
    const confirmed = await app.inject({ method: "POST", url: `/api/wallets/${wallet.id}/enclave/confirm`, headers: user.headers, payload: {} });
    assert.deepEqual(confirmed.json(), { walletId: wallet.id, status: "active" });
    const again = await app.inject({ method: "POST", url: `/api/wallets/${wallet.id}/enclave/confirm`, headers: user.headers, payload: {} });
    assert.deepEqual(again.json(), { walletId: wallet.id, status: "active" });
    const actions = await pool.query("SELECT action FROM audit_events ORDER BY id");
    assert.deepEqual(actions.rows.map((row) => row.action), ["wallet.created", "passkey.added", "wallet.enclave_created", "wallet.delegation_refused", "wallet.delegation_refused", "wallet.activated"]);

    const other = await signedInAccount(pool);
    assert.equal((await app.inject({ method: "POST", url: `/api/wallets/${wallet.id}/enclave/confirm`, headers: other.headers, payload: {} })).statusCode, 404);
  } finally {
    await app.close();
    await drop();
  }
});

async function enclaveGateway() {
  const { pool, drop } = await migratedSchema();
  const fake = fakeTurnkey();
  const app = await buildGateway({ config: gatewayConfig(), pool, logger: false, keys: { key: async () => null }, executor: null, turnkey: fake.turnkey, delegation: DELEGATION });
  const user = await signedInAccount(pool);
  const newWallet = async (): Promise<string> => (await app.inject({ method: "POST", url: "/api/wallets", headers: user.headers, payload: { label: "main", level: "enclave" } })).json().id;
  const authenticators = new Map<string, SoftAuthenticator>();
  const create = async (walletId: string) => {
    const options = (await app.inject({ method: "POST", url: `/api/wallets/${walletId}/enclave/options`, headers: user.headers, payload: {} })).json();
    const authenticator = softAuthenticator(RP);
    const credential = authenticator.register(options.challenge);
    authenticators.set(credential.id, authenticator);
    const held = await pool.query<{ credential_id: string }>("SELECT credential_id FROM passkeys WHERE account_id = $1 LIMIT 1", [user.accountId]);
    const approver = held.rows[0] ? authenticators.get(held.rows[0].credential_id) : undefined;
    const stepUp = approver ? (await app.inject({ method: "POST", url: "/api/passkeys/step-up", headers: user.headers, payload: { action: { kind: "passkey.add", credentialId: credential.id } } })).json() : null;
    const assertion = approver && stepUp ? { assertion: approver.assert(stepUp.challenge) } : {};
    return () => app.inject({ method: "POST", url: `/api/wallets/${walletId}/enclave`, headers: user.headers, payload: { credential, label: "Mac", ...assertion } });
  };
  const trackedSubOrgs = async () => (await pool.query<{ id: string }>("SELECT turnkey_sub_org_id AS id FROM wallets WHERE turnkey_sub_org_id IS NOT NULL")).rows.map((row) => row.id).sort();
  return { app, pool, fake, user, newWallet, create, trackedSubOrgs, close: async () => (await app.close(), await drop()) };
}

test("two concurrent enclave creates for one wallet reach Turnkey once", { skip: !TEST_DATABASE_URL }, async () => {
  const gateway = await enclaveGateway();
  try {
    const walletId = await gateway.newWallet();
    const first = await gateway.create(walletId);
    const second = await gateway.create(walletId);
    const responses = await Promise.all([first(), second()]);
    assert.deepEqual(responses.map((response) => response.statusCode).sort(), [201, 409]);
    assert.equal(gateway.fake.created.length, 1);
    assert.deepEqual(await gateway.trackedSubOrgs(), [...gateway.fake.orgs.keys()].sort());
    const passkeys = await gateway.pool.query("SELECT 1 FROM passkeys WHERE account_id = $1", [gateway.user.accountId]);
    assert.equal(passkeys.rowCount, 1);
  } finally {
    await gateway.close();
  }
});

test("a failure after Turnkey creates the sub-organization still leaves it recorded on the wallet", { skip: !TEST_DATABASE_URL }, async () => {
  const gateway = await enclaveGateway();
  try {
    const first = await gateway.newWallet();
    gateway.fake.faults.failNextCreate = true;
    assert.equal((await (await gateway.create(first))()).statusCode, 500);
    assert.equal((await (await gateway.create(first))()).statusCode, 201);

    const second = await gateway.newWallet();
    assert.equal((await (await gateway.create(second))()).statusCode, 500);
    assert.equal(gateway.fake.created.length, 2);
    assert.deepEqual(await gateway.trackedSubOrgs(), [...gateway.fake.orgs.keys()].sort());
    const retry = await gateway.app.inject({ method: "POST", url: `/api/wallets/${second}/enclave/options`, headers: gateway.user.headers, payload: {} });
    assert.equal(retry.json().error, "enclave_exists");
  } finally {
    await gateway.close();
  }
});

test("reading the delegation is rate limited per route", { skip: !TEST_DATABASE_URL }, async () => {
  const gateway = await enclaveGateway();
  try {
    const url = `/api/wallets/${randomUUID()}/enclave/delegation`;
    const statuses: number[] = [];
    for (let i = 0; i < 11; i += 1) statuses.push((await gateway.app.inject({ method: "GET", url, headers: gateway.user.headers })).statusCode);
    assert.deepEqual(statuses, [...Array(10).fill(404), 429]);
  } finally {
    await gateway.close();
  }
});

test("an enclave create on an account that already has a passkey needs a step-up from it before Turnkey is called", { skip: !TEST_DATABASE_URL }, async () => {
  const gateway = await enclaveGateway();
  const { app, user, fake, pool } = gateway;
  try {
    const existing = softAuthenticator(RP);
    const plainOptions = (await app.inject({ method: "POST", url: "/api/passkeys/options", headers: user.headers, payload: {} })).json();
    assert.equal((await app.inject({ method: "POST", url: "/api/passkeys", headers: user.headers, payload: { credential: existing.register(plainOptions.challenge), label: "MacBook" } })).statusCode, 201);
    const approval = async (credentialId: string) => {
      const options = (await app.inject({ method: "POST", url: "/api/passkeys/step-up", headers: user.headers, payload: { action: { kind: "passkey.add", credentialId } } })).json();
      return existing.assert(options.challenge);
    };

    const walletId = await gateway.newWallet();
    const options = (await app.inject({ method: "POST", url: `/api/wallets/${walletId}/enclave/options`, headers: user.headers, payload: {} })).json();
    const credential = softAuthenticator(RP).register(options.challenge);
    const submit = (assertion?: unknown) => app.inject({ method: "POST", url: `/api/wallets/${walletId}/enclave`, headers: user.headers, payload: { credential, label: "Phone", ...(assertion ? { assertion } : {}) } });
    const claim = async () => (await pool.query("SELECT root_credential_id FROM wallets WHERE id = $1", [walletId])).rows[0]?.root_credential_id;

    const bare = await submit();
    assert.equal(bare.statusCode, 428);
    assert.equal(bare.json().error, "step_up_required");
    assert.equal(fake.created.length, 0);
    assert.equal(await claim(), null);

    const elsewhere = await submit(await approval("c".repeat(43)));
    assert.equal(elsewhere.statusCode, 403);
    assert.equal(elsewhere.json().error, "step_up_failed");
    assert.equal(fake.created.length, 0);
    assert.equal(await claim(), null);

    const approved = await submit(await approval(credential.id));
    assert.equal(approved.statusCode, 201);
    assert.equal(fake.created.length, 1);
    assert.equal(await claim(), credential.id);
  } finally {
    await gateway.close();
  }
});
