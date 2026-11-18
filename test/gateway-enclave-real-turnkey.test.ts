// Opt-in check of the enclave policy resync against the real Turnkey API. It skips without credentials.
// docs/runbook.md says how to run it.
import assert from "node:assert/strict";
import test from "node:test";
import { buildGateway } from "../src/gateway/app.js";
import type { WalletPolicy } from "../src/gateway/policy.js";
import { delegationFromEnv, expectedPolicies, turnkeyParentFromEnv } from "../src/gateway/turnkey.js";
import { gatewayConfig, signedInAccount } from "./gateway-fixtures.js";
import { migratedSchema } from "./pg-schema.js";
import { softAuthenticator } from "./webauthn-fixtures.js";
import { ApiError } from "../web/src/api.js";
import { authorizeDelegate, resyncDelegation, type DelegationDeps } from "../web/src/enclave-delegation.js";
import * as turnkey from "../web/src/turnkey.js";

const REQUIRED = ["TURNKEY_PARENT_ORGANIZATION_ID", "TURNKEY_PARENT_API_PUBLIC_KEY", "TURNKEY_PARENT_API_PRIVATE_KEY", "TURNKEY_DELEGATE_API_PUBLIC_KEY", "TEST_DATABASE_URL"];
const missing = REQUIRED.filter((name) => !process.env[name]);
const skip = process.env.WHALE_REAL_TURNKEY !== "1" ? "set WHALE_REAL_TURNKEY=1 to run against real Turnkey" : missing.length > 0 ? `missing ${missing.join(", ")}` : false;

// The passkey's relying party is the gateway's host, and Turnkey checks each stamp against it.
const ORIGIN = "http://localhost:8080";
const RP = { rpId: "localhost", origin: ORIGIN };

type Activity = { id: string; type: string; status: string; result: Record<string, { policyIds?: string[] }> };
type Allow = { policyName: string; effect: string; consensus: string; condition: string };
const allowShape = (policies: Allow[]) => policies.filter((entry) => entry.effect === "EFFECT_ALLOW").map(({ policyName, effect, consensus, condition }) => ({ policyName, effect, consensus, condition })).sort((a, b) => a.policyName.localeCompare(b.policyName));

test("an active enclave narrowed in the app resyncs its real Turnkey policies under the owner's passkey", { skip, timeout: 180_000 }, async (t) => {
  const parent = turnkeyParentFromEnv(process.env);
  const delegationConfig = delegationFromEnv(process.env);
  assert.ok(parent && delegationConfig);
  const { pool, drop } = await migratedSchema();
  const app = await buildGateway({ config: { ...gatewayConfig(), publicUrl: new URL(ORIGIN) }, pool, logger: false, keys: { key: async () => null }, executor: null, turnkey: parent, delegation: delegationConfig });
  const passkey = softAuthenticator(RP, false);
  const browser = Object.getOwnPropertyDescriptor(globalThis, "navigator");
  // web/src/turnkey.ts stamps each request with navigator.credentials.get, as the dashboard does in the browser.
  Object.defineProperty(globalThis, "navigator", {
    configurable: true,
    value: {
      credentials: {
        get: async ({ publicKey }: { publicKey: { challenge: Uint8Array; rpId: string } }) => {
          const signed = passkey.assert(Buffer.from(publicKey.challenge).toString("base64url"), { rpId: publicKey.rpId });
          const bytes = (text: string) => new Uint8Array(Buffer.from(text, "base64url")).buffer;
          return { rawId: bytes(signed.id), response: { clientDataJSON: bytes(signed.response.clientDataJSON), authenticatorData: bytes(signed.response.authenticatorData), signature: bytes(signed.response.signature) } };
        },
      },
    },
  });
  Object.assign(globalThis, { window: { location: { hostname: RP.rpId } } });
  try {
    const account = await signedInAccount(pool);
    const headers = { ...account.headers, origin: ORIGIN };
    const call = async (method: "GET" | "POST" | "PUT", url: string, payload?: object) => app.inject({ method, url, headers, ...(payload ? { payload } : {}) });
    const api = (async (path: string, init: { method?: string; body?: unknown } = {}) => {
      const reply = await call((init.method ?? "GET") as "GET", path, init.body as object | undefined);
      if (reply.statusCode >= 400) throw new ApiError(reply.statusCode, reply.json().error, reply.json().problems ?? null);
      return reply.json();
    }) as DelegationDeps["api"];
    const activities: Activity[] = [];
    const recorded = (submit: (delegation: turnkey.Delegation) => Promise<unknown>) => async (delegation: turnkey.Delegation) => {
      const reply = (await submit(delegation)) as { activity: Activity };
      activities.push(reply.activity);
      return reply;
    };
    const deps: DelegationDeps = { api, addDelegate: recorded(turnkey.addDelegate), deletePolicies: recorded(turnkey.deletePolicies), addPolicies: recorded(turnkey.addPolicies), addOwnerPasskeys: recorded(turnkey.addOwnerPasskeys) };

    const wallet = (await call("POST", "/api/wallets", { label: "real-turnkey-resync", level: "enclave" })).json();
    const options = (await call("POST", `/api/wallets/${wallet.id}/enclave/options`, {})).json();
    const created = await call("POST", `/api/wallets/${wallet.id}/enclave`, { credential: passkey.register(options.challenge), label: "software passkey" });
    assert.equal(created.statusCode, 201, created.body);
    await authorizeDelegate(deps, wallet.id);
    const delegationUrl = `/api/wallets/${wallet.id}/enclave/delegation`;
    const active = (await call("GET", delegationUrl)).json();
    t.diagnostic(`wallet ${wallet.id}, sub-organization ${active.subOrganizationId}`);
    assert.deepEqual([active.inSync, active.stalePolicyIds], [true, []]);
    assert.equal(active.delegatePolicyIds.length, active.policies.length);

    const listed = (await call("GET", "/api/wallets")).json().wallets.find((entry: { id: string }) => entry.id === wallet.id);
    assert.equal(listed.status, "active");
    assert.ok(listed.policy.chains.includes("arbitrum"));
    const document: WalletPolicy = { ...listed.policy, chains: listed.policy.chains.filter((chain: string) => chain !== "arbitrum") };
    const narrowed = await call("PUT", `/api/wallets/${wallet.id}/policy`, { baseVersion: listed.policyVersion, document });
    assert.equal(narrowed.statusCode, 200, narrowed.body);
    const drifted = (await call("GET", delegationUrl)).json();
    assert.equal(drifted.inSync, false);
    assert.deepEqual([...drifted.stalePolicyIds].sort(), [...active.delegatePolicyIds].sort());
    const early = await call("POST", `/api/wallets/${wallet.id}/enclave/resync`, {});
    assert.deepEqual([early.statusCode, early.json().error], [409, "delegation_not_safe"]);

    const before = activities.length;
    await resyncDelegation(deps, wallet.id);
    const replaced = activities.slice(before);
    for (const activity of replaced) t.diagnostic(`${activity.type} ${activity.id} ${activity.status}`);
    assert.deepEqual(replaced.map((activity) => [activity.type, activity.status]), [["ACTIVITY_TYPE_DELETE_POLICIES", "ACTIVITY_STATUS_COMPLETED"], ["ACTIVITY_TYPE_CREATE_POLICIES", "ACTIVITY_STATUS_COMPLETED"]]);
    // The dashboard deletes stalePolicyIds, not delegatePolicyIds (known bug). Here every old policy is stale, so the two agree.
    assert.deepEqual([...(replaced[0]?.result.deletePoliciesResult?.policyIds ?? [])].sort(), [...active.delegatePolicyIds].sort());

    const audit = await pool.query<{ n: number }>("SELECT count(*)::int AS n FROM audit_events WHERE wallet_id = $1 AND action = 'wallet.delegation_resynced'", [wallet.id]);
    assert.equal(audit.rows[0]?.n, 1);
    const synced = (await call("GET", delegationUrl)).json();
    t.diagnostic(`delegatePolicyIds ${JSON.stringify(active.delegatePolicyIds)} -> ${JSON.stringify(synced.delegatePolicyIds)}`);
    assert.deepEqual([synced.inSync, synced.stalePolicyIds], [true, []]);
    assert.equal(synced.delegatePolicyIds.length, synced.policies.length);
    assert.ok(synced.delegatePolicyIds.every((id: string) => !active.delegatePolicyIds.includes(id)));
    assert.deepEqual([...synced.delegatePolicyIds].sort(), [...(replaced[1]?.result.createPoliciesResult?.policyIds ?? [])].sort());

    // Read Turnkey directly: its allow set is exactly what Whale renders for the narrowed document. The rendered EVM
    // policy never includes Base (known bug), so with arbitrum removed it allows no EVM chain; expectedPolicies agrees.
    const row = await pool.query<{ turnkey_wallet_id: string }>("SELECT turnkey_wallet_id FROM wallets WHERE id = $1", [wallet.id]);
    const solanaAddress = listed.addresses.find((entry: { family: string }) => entry.family === "solana").address;
    const expected = expectedPolicies({ delegateUserId: synced.delegateUserId, walletId: row.rows[0]?.turnkey_wallet_id as string, solanaAddress, policy: document, config: delegationConfig });
    const state = await parent.readSubOrganization(active.subOrganizationId);
    assert.deepEqual(allowShape(state.policies), allowShape(expected));
    assert.deepEqual(state.policies.map((entry) => entry.policyId).sort(), [...synced.delegatePolicyIds].sort());
  } finally {
    if (browser) Object.defineProperty(globalThis, "navigator", browser);
    Reflect.deleteProperty(globalThis, "window");
    await app.close();
    await drop();
  }
});
