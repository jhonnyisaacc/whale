import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { buildGateway } from "../src/gateway/app.js";
import { DEFAULT_POLICY } from "../src/gateway/policy.js";
import { delegationFromEnv, expectedPolicies, TurnkeyNotSubmitted, verifyDelegation, type CreatedSubOrg, type CreateOutcome, type DelegationConfig, type SubOrgState, type TurnkeyParent } from "../src/gateway/turnkey.js";
import { gatewayConfig, signedInAccount } from "./gateway-fixtures.js";
import { migratedSchema, TEST_DATABASE_URL } from "./pg-schema.js";
import { softAuthenticator, type SoftAuthenticator } from "./webauthn-fixtures.js";

const RP = { rpId: "whale.example", origin: "https://whale.example" };
const DELEGATE_KEY = `02${"ab".repeat(32)}`;
const SOLANA = "9xQeWvG816bUx9EPjHmaT23yvVM2ZWbrrpZb9PusVFin";
const BASE_ROUTER = "0x0000000000001ff3684f28c67538d4d072c22734";
const ETH_ROUTER = "0x1111111111111111111111111111111111111111";
const DELEGATION: DelegationConfig = { delegatePublicKey: DELEGATE_KEY, routers: { 8453: [BASE_ROUTER], 1: [ETH_ROUTER] }, maxValueWei: 2_000_000_000_000_000n };

type Fault = "unreachable" | "refused" | "timeout" | "lost" | "pending" | "fail";

function fakeTurnkey() {
  const orgs = new Map<string, SubOrgState>();
  const created: { challenge: string; credentialId: string; name: string; org: CreatedSubOrg }[] = [];
  const activities = new Map<string, { outcome: CreateOutcome; land: () => void }>();
  const faults: { nextCreate: Fault | null; createDelayMs: number; findDelayMs: number; gate: Promise<void> | null; pollFails: boolean; lookupTruncated: boolean } = { nextCreate: null, createDelayMs: 0, findDelayMs: 0, gate: null, pollFails: false, lookupTruncated: false };
  const landed = (input: Parameters<TurnkeyParent["submitSubOrganization"]>[0]): CreatedSubOrg => {
    const ownerUserId = randomUUID();
    const n = created.length;
    const org = { subOrganizationId: randomUUID(), walletId: randomUUID(), ownerUserId, evm: `0x${String(n).padStart(40, "9")}`, solana: n === 0 ? SOLANA : `${SOLANA.slice(0, -4)}${String(n).padStart(4, "z")}` };
    created.push({ challenge: input.authenticator.challenge, credentialId: input.authenticator.credentialId, name: input.name, org });
    orgs.set(org.subOrganizationId, { threshold: 1, rootUserIds: [ownerUserId], users: [{ userId: ownerUserId, userName: "owner", credentialIds: [input.authenticator.credentialId], apiPublicKeys: [] }], policies: [] });
    return org;
  };
  const turnkey: TurnkeyParent = {
    async submitSubOrganization(input) {
      await new Promise((resolve) => setTimeout(resolve, faults.createDelayMs));
      await faults.gate;
      const fault = faults.nextCreate;
      faults.nextCreate = null;
      if (fault === "unreachable") throw new TurnkeyNotSubmitted("connect ECONNREFUSED", "turnkey_unreachable");
      if (fault === "refused") throw new TurnkeyNotSubmitted("400 Bad Request", "turnkey_refused");
      if (fault === "timeout") throw new Error("socket hang up");
      const activityId = randomUUID();
      if (fault === "fail") {
        activities.set(activityId, { outcome: { state: "failed", status: "ACTIVITY_STATUS_FAILED" }, land: () => undefined });
        return { activityId, outcome: { state: "failed", status: "ACTIVITY_STATUS_FAILED" } };
      }
      if (fault === "pending") {
        const activity = { outcome: { state: "pending" } as CreateOutcome, land: () => (activity.outcome = { state: "completed", created: landed(input) }) };
        activities.set(activityId, activity);
        return { activityId, outcome: { state: "pending" } };
      }
      const outcome: CreateOutcome = { state: "completed", created: landed(input) };
      activities.set(activityId, { outcome, land: () => undefined });
      if (fault === "lost") throw new Error("socket hang up");
      return { activityId, outcome };
    },
    async subOrganizationActivity(activityId) {
      if (faults.pollFails) throw new Error("fetch failed");
      const activity = activities.get(activityId);
      if (!activity) throw new Error(`no activity ${activityId}`);
      return activity.outcome;
    },
    async findSubOrganizations(rootCredentialId) {
      await new Promise((resolve) => setTimeout(resolve, faults.findDelayMs));
      if (faults.lookupTruncated) return { state: "truncated" };
      return { state: "listed", found: created.filter((entry) => entry.credentialId === rootCredentialId).map((entry) => entry.org) };
    },
    async readSubOrganization(id) {
      const state = orgs.get(id);
      if (!state) throw new Error("no sub-organization");
      return structuredClone(state);
    },
  };
  const landPending = () => {
    for (const activity of activities.values()) if (activity.outcome.state === "pending") activity.land();
  };
  const named = (walletId: string) => created.filter((entry) => entry.name === `whale-${walletId}`).length;
  return { turnkey, orgs, created, faults, landPending, named };
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
    state.policies = after.policies;
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
    const holder = await gateway.pool.connect();
    let responses;
    try {
      await holder.query("BEGIN");
      await holder.query("SELECT 1 FROM wallets WHERE id = $1 FOR UPDATE", [walletId]);
      const holderPid = (await holder.query<{ pid: number }>("SELECT pg_backend_pid() AS pid")).rows[0]?.pid;
      const racing = Promise.all([first(), second()]);
      const waiting = async () => (await gateway.pool.query<{ n: number }>("WITH direct AS (SELECT pid FROM pg_stat_activity WHERE $1 = ANY(pg_blocking_pids(pid))) SELECT count(*)::int AS n FROM pg_stat_activity WHERE pid IN (SELECT pid FROM direct) OR pg_blocking_pids(pid) && ARRAY(SELECT pid FROM direct)", [holderPid])).rows[0]?.n;
      while ((await waiting()) !== 2) await new Promise((resolve) => setTimeout(resolve, 5));
      await holder.query("COMMIT");
      responses = await racing;
    } finally {
      holder.release();
    }
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
    gateway.fake.faults.nextCreate = "unreachable";
    assert.equal((await (await gateway.create(first))()).statusCode, 503);
    assert.equal((await (await gateway.create(first))()).statusCode, 201);

    const second = await gateway.newWallet();
    await gateway.pool.query("CREATE FUNCTION refuse_address() RETURNS trigger AS $$ BEGIN RAISE EXCEPTION 'disk full'; END $$ LANGUAGE plpgsql");
    await gateway.pool.query("CREATE TRIGGER refuse_address BEFORE INSERT ON wallet_addresses FOR EACH ROW EXECUTE FUNCTION refuse_address()");
    assert.equal((await (await gateway.create(second))()).statusCode, 500);
    await gateway.pool.query("DROP TRIGGER refuse_address ON wallet_addresses");
    assert.equal(gateway.fake.created.length, 2);
    await gateway.pool.query("UPDATE wallets SET root_claimed_at = now() - interval '3 minutes' WHERE id = $1", [second]);
    const retry = await gateway.app.inject({ method: "POST", url: `/api/wallets/${second}/enclave/options`, headers: gateway.user.headers, payload: {} });
    assert.equal(retry.json().error, "enclave_exists");
    assert.deepEqual(await gateway.trackedSubOrgs(), [...gateway.fake.orgs.keys()].sort());
    const delegation = await gateway.app.inject({ method: "GET", url: `/api/wallets/${second}/enclave/delegation`, headers: gateway.user.headers });
    assert.equal(delegation.statusCode, 200, delegation.body);
    assert.equal(delegation.json().subOrganizationId, gateway.fake.created[1]?.org.subOrganizationId);
  } finally {
    await gateway.close();
  }
});

async function lostCreate(gateway: Awaited<ReturnType<typeof enclaveGateway>>) {
  const walletId = await gateway.newWallet();
  gateway.fake.faults.nextCreate = "lost";
  assert.deepEqual((await (await gateway.create(walletId))()).json(), { error: "enclave_in_progress" });
  await gateway.pool.query("UPDATE wallets SET root_claimed_at = now() - interval '3 minutes' WHERE id = $1", [walletId]);
  const options = () => gateway.app.inject({ method: "POST", url: `/api/wallets/${walletId}/enclave/options`, headers: gateway.user.headers, payload: {} });
  const delegation = () => gateway.app.inject({ method: "GET", url: `/api/wallets/${walletId}/enclave/delegation`, headers: gateway.user.headers });
  return { walletId, options, delegation };
}

test("two requests adopting the same sub-organization at once both answer enclave_exists", { skip: !TEST_DATABASE_URL }, async () => {
  const gateway = await enclaveGateway();
  try {
    const { options } = await lostCreate(gateway);
    gateway.fake.faults.findDelayMs = 50;
    const answers = await Promise.all([options(), options()]);
    assert.deepEqual(answers.map((answer) => [answer.statusCode, answer.json().error]), [[409, "enclave_exists"], [409, "enclave_exists"]]);
    assert.deepEqual(await gateway.trackedSubOrgs(), [gateway.fake.created[0]?.org.subOrganizationId]);
    const addresses = await gateway.pool.query("SELECT family FROM wallet_addresses ORDER BY family");
    assert.deepEqual(addresses.rows.map((row) => row.family), ["evm", "solana"]);
  } finally {
    await gateway.close();
  }
});

for (const [fault, status] of [["unreachable", 503], ["refused", 502]] as const) {
  test(`after Turnkey is ${fault}, the same passkey can be submitted again on a fresh challenge without a step-up`, { skip: !TEST_DATABASE_URL }, async () => {
    const gateway = await enclaveGateway();
    const { app, user, fake } = gateway;
    try {
      const walletId = await gateway.newWallet();
      const authenticator = softAuthenticator(RP);
      const submit = async () => {
        const options = (await app.inject({ method: "POST", url: `/api/wallets/${walletId}/enclave/options`, headers: user.headers, payload: {} })).json();
        assert.deepEqual(options.excludeCredentials, []);
        return app.inject({ method: "POST", url: `/api/wallets/${walletId}/enclave`, headers: user.headers, payload: { credential: authenticator.register(options.challenge), label: "Mac" } });
      };
      fake.faults.nextCreate = fault;
      const failed = await submit();
      assert.deepEqual([failed.statusCode, failed.json().error], [status, `turnkey_${fault}`]);
      const removed = await gateway.pool.query("SELECT detail FROM audit_events WHERE action = 'passkey.removed'");
      assert.deepEqual(removed.rows.map((row) => row.detail), [{ credentialId: authenticator.credentialId.toString("base64url"), reason: `turnkey_${fault}` }]);
      const claim = (await gateway.pool.query("SELECT root_credential_id FROM wallets WHERE id = $1", [walletId])).rows[0]?.root_credential_id;
      assert.equal(claim, null);
      const retried = await submit();
      assert.equal(retried.statusCode, 201, retried.body);
      assert.equal(fake.created.length, 1);
      assert.equal((await gateway.trackedSubOrgs()).length, 1);
    } finally {
      await gateway.close();
    }
  });
}

test("a sub-organization whose create response was lost is adopted by the next create, not created twice", { skip: !TEST_DATABASE_URL }, async () => {
  const gateway = await enclaveGateway();
  const { app, user, fake } = gateway;
  try {
    const walletId = await gateway.newWallet();
    const authenticator = softAuthenticator(RP);
    const challenges = await Promise.all([1, 2].map(async () => (await app.inject({ method: "POST", url: `/api/wallets/${walletId}/enclave/options`, headers: user.headers, payload: {} })).json().challenge));
    const submit = (challenge: string) => app.inject({ method: "POST", url: `/api/wallets/${walletId}/enclave`, headers: user.headers, payload: { credential: authenticator.register(challenge), label: "Mac" } });
    fake.faults.nextCreate = "lost";
    assert.deepEqual((await submit(challenges[0])).json(), { error: "enclave_in_progress" });
    assert.equal((await submit(challenges[1])).json().error, "enclave_in_progress");
    await gateway.pool.query("UPDATE wallets SET root_claimed_at = now() - interval '3 minutes' WHERE id = $1", [walletId]);
    const retried = await submit(challenges[1]);
    assert.equal(retried.statusCode, 409);
    assert.equal(retried.json().error, "enclave_exists");
    assert.equal(fake.created.length, 1);
    assert.deepEqual(await gateway.trackedSubOrgs(), [fake.created[0]?.org.subOrganizationId]);
    const listed = (await app.inject({ method: "GET", url: "/api/wallets", headers: user.headers })).json().wallets[0];
    assert.deepEqual(listed.addresses.map((entry: { address: string }) => entry.address), [fake.created[0]?.org.evm, SOLANA]);
    const delegation = await app.inject({ method: "GET", url: `/api/wallets/${walletId}/enclave/delegation`, headers: user.headers });
    assert.equal(delegation.json().subOrganizationId, fake.created[0]?.org.subOrganizationId);
  } finally {
    await gateway.close();
  }
});

test("a claim whose create was never recorded is freed only when Turnkey has nothing for its passkey a day later", { skip: !TEST_DATABASE_URL }, async () => {
  const gateway = await enclaveGateway();
  const { app, user, fake, pool } = gateway;
  try {
    const walletId = await gateway.newWallet();
    const options = (await app.inject({ method: "POST", url: `/api/wallets/${walletId}/enclave/options`, headers: user.headers, payload: {} })).json();
    const credential = softAuthenticator(RP).register(options.challenge);
    await pool.query("INSERT INTO passkeys (credential_id, account_id, public_key, label) VALUES ($1, $2, $3, 'Mac')", [credential.id, user.accountId, Buffer.from("stale")]);
    await pool.query("UPDATE wallets SET root_credential_id = $2, root_claimed_at = now() WHERE id = $1", [walletId, credential.id]);
    const submit = () => app.inject({ method: "POST", url: `/api/wallets/${walletId}/enclave`, headers: user.headers, payload: { credential, label: "Mac" } });

    const inFlight = await submit();
    assert.equal(inFlight.statusCode, 409);
    assert.equal(inFlight.json().error, "enclave_in_progress");
    for (const age of ["3 minutes", "23 hours"]) {
      await pool.query(`UPDATE wallets SET root_claimed_at = now() - interval '${age}' WHERE id = $1`, [walletId]);
      assert.equal((await submit()).json().error, "enclave_in_progress", age);
    }
    assert.equal(fake.created.length, 0);
    await pool.query("UPDATE wallets SET root_claimed_at = now() - interval '25 hours' WHERE id = $1", [walletId]);
    const created = await submit();
    assert.equal(created.statusCode, 201, created.body);
    const removed = await pool.query("SELECT detail->>'reason' AS reason FROM audit_events WHERE action = 'passkey.removed'");
    assert.deepEqual(removed.rows, [{ reason: "unrecorded_create_never_landed" }]);
    assert.equal(fake.created.length, 1);
    assert.deepEqual(await gateway.trackedSubOrgs(), [fake.created[0]?.org.subOrganizationId]);
  } finally {
    await gateway.close();
  }
});

test("a day-old unrecorded claim is kept when Turnkey's lookup page is full", { skip: !TEST_DATABASE_URL }, async () => {
  const gateway = await enclaveGateway();
  const { app, user, fake, pool } = gateway;
  try {
    const walletId = await gateway.newWallet();
    const options = (await app.inject({ method: "POST", url: `/api/wallets/${walletId}/enclave/options`, headers: user.headers, payload: {} })).json();
    const credential = softAuthenticator(RP).register(options.challenge);
    await pool.query("INSERT INTO passkeys (credential_id, account_id, public_key, label) VALUES ($1, $2, $3, 'Mac')", [credential.id, user.accountId, Buffer.from("stale")]);
    await pool.query("UPDATE wallets SET root_credential_id = $2, root_claimed_at = now() - interval '25 hours' WHERE id = $1", [walletId, credential.id]);
    fake.faults.lookupTruncated = true;
    const answered = await app.inject({ method: "POST", url: `/api/wallets/${walletId}/enclave`, headers: user.headers, payload: { credential, label: "Mac" } });
    assert.deepEqual([answered.statusCode, answered.json()], [409, { error: "enclave_conflict" }]);
    const claim = (await pool.query("SELECT root_credential_id FROM wallets WHERE id = $1", [walletId])).rows[0]?.root_credential_id;
    assert.equal(claim, credential.id);
    assert.equal((await pool.query("SELECT 1 FROM passkeys WHERE credential_id = $1", [credential.id])).rowCount, 1);
    assert.equal((await pool.query("SELECT 1 FROM audit_events WHERE action = 'passkey.removed'")).rowCount, 0);
    assert.equal(fake.created.length, 0);
  } finally {
    await gateway.close();
  }
});

test("a wallet whose create response was lost is adopted when the browser asks for fresh options", { skip: !TEST_DATABASE_URL }, async () => {
  const gateway = await enclaveGateway();
  const { app, user, fake } = gateway;
  try {
    const walletId = await gateway.newWallet();
    fake.faults.nextCreate = "lost";
    assert.deepEqual((await (await gateway.create(walletId))()).json(), { error: "enclave_in_progress" });
    const options = () => app.inject({ method: "POST", url: `/api/wallets/${walletId}/enclave/options`, headers: user.headers, payload: {} });
    assert.equal((await options()).json().error, "enclave_in_progress");
    await gateway.pool.query("UPDATE wallets SET root_claimed_at = now() - interval '3 minutes' WHERE id = $1", [walletId]);
    assert.equal((await options()).json().error, "enclave_exists");
    assert.equal(fake.created.length, 1);
    assert.deepEqual(await gateway.trackedSubOrgs(), [fake.created[0]?.org.subOrganizationId]);
  } finally {
    await gateway.close();
  }
});

test("a create whose outcome is unknown keeps its claim and passkey instead of freeing the wallet at once", { skip: !TEST_DATABASE_URL }, async () => {
  const gateway = await enclaveGateway();
  const { app, user, fake, pool } = gateway;
  try {
    const walletId = await gateway.newWallet();
    fake.faults.nextCreate = "timeout";
    const created = await (await gateway.create(walletId))();
    assert.deepEqual([created.statusCode, created.json()], [409, { error: "enclave_in_progress" }]);
    const options = () => app.inject({ method: "POST", url: `/api/wallets/${walletId}/enclave/options`, headers: user.headers, payload: {} });
    assert.equal((await options()).json().error, "enclave_in_progress");
    await pool.query("UPDATE wallets SET root_claimed_at = now() - interval '3 minutes' WHERE id = $1", [walletId]);
    assert.equal((await options()).json().error, "enclave_in_progress");
    assert.equal((await pool.query("SELECT 1 FROM passkeys WHERE account_id = $1", [user.accountId])).rowCount, 1);
    assert.equal(fake.created.length, 0);
  } finally {
    await gateway.close();
  }
});

test("a create Turnkey still holds as pending is never freed and lands as the wallet's only sub-organization", { skip: !TEST_DATABASE_URL }, async () => {
  const gateway = await enclaveGateway();
  const { app, user, fake, pool } = gateway;
  try {
    const walletId = await gateway.newWallet();
    fake.faults.nextCreate = "pending";
    const created = await (await gateway.create(walletId))();
    assert.deepEqual([created.statusCode, created.json().error], [409, "enclave_in_progress"]);
    const options = () => app.inject({ method: "POST", url: `/api/wallets/${walletId}/enclave/options`, headers: user.headers, payload: {} });
    await pool.query("UPDATE wallets SET root_claimed_at = now() - interval '25 hours' WHERE id = $1", [walletId]);
    assert.equal((await options()).json().error, "enclave_in_progress");
    assert.equal((await pool.query("SELECT 1 FROM passkeys WHERE account_id = $1", [user.accountId])).rowCount, 1);
    fake.landPending();
    assert.equal((await options()).json().error, "enclave_exists");
    assert.equal(fake.named(walletId), 1);
    assert.deepEqual(await gateway.trackedSubOrgs(), [fake.created[0]?.org.subOrganizationId]);
    const delegation = await app.inject({ method: "GET", url: `/api/wallets/${walletId}/enclave/delegation`, headers: user.headers });
    assert.equal(delegation.statusCode, 200, delegation.body);
  } finally {
    await gateway.close();
  }
});

test("a Turnkey error while polling a pending create answers enclave_in_progress and keeps the claim, activity, and passkey", { skip: !TEST_DATABASE_URL }, async () => {
  const gateway = await enclaveGateway();
  const { app, user, fake, pool } = gateway;
  try {
    const walletId = await gateway.newWallet();
    fake.faults.nextCreate = "pending";
    fake.faults.pollFails = true;
    const created = await (await gateway.create(walletId))();
    assert.deepEqual([created.statusCode, created.json()], [409, { error: "enclave_in_progress" }]);
    const options = () => app.inject({ method: "POST", url: `/api/wallets/${walletId}/enclave/options`, headers: user.headers, payload: {} });
    const polled = await options();
    assert.deepEqual([polled.statusCode, polled.json()], [409, { error: "enclave_in_progress" }]);
    const row = (await pool.query<{ root_credential_id: string | null; turnkey_activity_id: string | null }>("SELECT root_credential_id, turnkey_activity_id FROM wallets WHERE id = $1", [walletId])).rows[0];
    assert.ok(row?.root_credential_id && row.turnkey_activity_id);
    assert.equal((await pool.query("SELECT 1 FROM passkeys WHERE account_id = $1", [user.accountId])).rowCount, 1);
    fake.faults.pollFails = false;
    fake.landPending();
    assert.equal((await options()).json().error, "enclave_exists");
    assert.equal(fake.named(walletId), 1);
  } finally {
    await gateway.close();
  }
});

test("a create whose Turnkey activity failed frees the wallet for a retry", { skip: !TEST_DATABASE_URL }, async () => {
  const gateway = await enclaveGateway();
  const { fake, pool } = gateway;
  try {
    const walletId = await gateway.newWallet();
    fake.faults.nextCreate = "fail";
    const failed = await (await gateway.create(walletId))();
    assert.deepEqual(failed.json(), { error: "turnkey_refused", detail: "ACTIVITY_STATUS_FAILED" });
    assert.equal(failed.statusCode, 502);
    const removed = await pool.query("SELECT detail->>'reason' AS reason FROM audit_events WHERE action = 'passkey.removed'");
    assert.deepEqual(removed.rows, [{ reason: "ACTIVITY_STATUS_FAILED" }]);
    assert.equal((await (await gateway.create(walletId))()).statusCode, 201);
    assert.equal(fake.named(walletId), 1);
  } finally {
    await gateway.close();
  }
});

test("a create slower than the lease keeps its wallet and is recorded when Turnkey answers", { skip: !TEST_DATABASE_URL }, async () => {
  const gateway = await enclaveGateway();
  const { app, user, fake, pool } = gateway;
  try {
    const walletId = await gateway.newWallet();
    let open = () => undefined as void;
    fake.faults.gate = new Promise<void>((resolve) => (open = resolve));
    const slow = (await gateway.create(walletId))();
    const claim = async () => (await pool.query("SELECT root_credential_id FROM wallets WHERE id = $1", [walletId])).rows[0]?.root_credential_id;
    while (!(await claim())) await new Promise((resolve) => setTimeout(resolve, 5));
    await pool.query("UPDATE wallets SET root_claimed_at = now() - interval '3 minutes' WHERE id = $1", [walletId]);
    const during = await app.inject({ method: "POST", url: `/api/wallets/${walletId}/enclave/options`, headers: user.headers, payload: {} });
    assert.equal(during.json().error, "enclave_in_progress");
    open();
    const answered = await slow;
    assert.equal(answered.statusCode, 201, answered.body);
    assert.equal(fake.named(walletId), 1);
    assert.deepEqual(await gateway.trackedSubOrgs(), [fake.created[0]?.org.subOrganizationId]);
  } finally {
    await gateway.close();
  }
});

test("adoption takes only a sub-organization rooted in the claimed passkey and will not pick between two", { skip: !TEST_DATABASE_URL }, async () => {
  const gateway = await enclaveGateway();
  const { fake, pool } = gateway;
  try {
    const { walletId, options } = await lostCreate(gateway);
    const mine = fake.created[0];
    assert.ok(mine);
    fake.created.unshift({ ...mine, credentialId: "someone-else", org: { ...mine.org, subOrganizationId: randomUUID() } });
    fake.created.push({ ...mine, org: { ...mine.org, subOrganizationId: randomUUID() } });
    const conflicted = await options();
    assert.deepEqual([conflicted.statusCode, conflicted.json().error], [409, "enclave_conflict"]);
    assert.deepEqual(await gateway.trackedSubOrgs(), []);
    assert.equal((await pool.query("SELECT 1 FROM passkeys WHERE credential_id = $1", [mine.credentialId])).rowCount, 1);
    fake.created.pop();
    assert.equal((await options()).json().error, "enclave_exists");
    assert.deepEqual(await gateway.trackedSubOrgs(), [mine.org.subOrganizationId]);
    const root = await pool.query("SELECT root_credential_id FROM wallets WHERE id = $1", [walletId]);
    assert.equal(root.rows[0]?.root_credential_id, mine.credentialId);
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

test("a chain this build dropped from the stored policy is left out of the delegation, which still reads and confirms", { skip: !TEST_DATABASE_URL }, async () => {
  const { app, pool, fake, user, newWallet, create, close } = await enclaveGateway();
  try {
    const walletId = await newWallet();
    assert.equal((await (await create(walletId))()).statusCode, 201);
    const url = `/api/wallets/${walletId}/enclave/delegation`;
    const subOrganizationId = (await app.inject({ method: "GET", url, headers: user.headers })).json().subOrganizationId;
    const state = fake.orgs.get(subOrganizationId) as SubOrgState;
    state.users.push({ userId: randomUUID(), userName: "whale-delegate", credentialIds: [], apiPublicKeys: [DELEGATE_KEY] });
    const baseline = (await app.inject({ method: "GET", url, headers: user.headers })).json().policies;

    await pool.query(`UPDATE policies SET document = document || jsonb_build_object('chains', (document->'chains') || '["dogechain"]'::jsonb)`);
    const delegation = await app.inject({ method: "GET", url, headers: user.headers });
    assert.equal(delegation.statusCode, 200, delegation.body);
    assert.deepEqual(delegation.json().policies, baseline);
    state.policies = baseline;
    const confirmed = await app.inject({ method: "POST", url: `/api/wallets/${walletId}/enclave/confirm`, headers: user.headers, payload: {} });
    assert.deepEqual(confirmed.json(), { walletId, status: "active" });
  } finally {
    await close();
  }
});
