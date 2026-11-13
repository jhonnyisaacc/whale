import assert from "node:assert/strict";
import { createECDH } from "node:crypto";
import http from "node:http";
import type { AddressInfo } from "node:net";
import test from "node:test";
import { TurnkeyNotSubmitted, turnkeyParentFromEnv, type TurnkeyParent } from "../src/gateway/turnkey.js";

type Answer = { status: number; json?: unknown; text?: string };

async function fakeTurnkeyApi(routes: Record<string, (body: Record<string, unknown>) => Answer>) {
  const hits: { path: string; body: Record<string, unknown> }[] = [];
  const server = http.createServer((request, response) => {
    let raw = "";
    request.on("data", (chunk) => (raw += chunk));
    request.on("end", () => {
      const path = request.url ?? "";
      const body = JSON.parse(raw || "{}") as Record<string, unknown>;
      hits.push({ path, body });
      const answer = routes[path]?.(body) ?? { status: 500, text: "unexpected" };
      response.writeHead(answer.status, { "content-type": answer.json === undefined ? "text/html" : "application/json" });
      response.end(answer.json === undefined ? (answer.text ?? "") : JSON.stringify(answer.json));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as AddressInfo).port;
  return { parent: parentAt(`http://127.0.0.1:${port}`), hits, close: () => new Promise<void>((resolve) => server.close(() => resolve())) };
}

function parentAt(apiBase: string): TurnkeyParent {
  const ecdh = createECDH("prime256v1");
  ecdh.generateKeys();
  const parent = turnkeyParentFromEnv({ TURNKEY_PARENT_ORGANIZATION_ID: "parent-org", TURNKEY_PARENT_API_PUBLIC_KEY: ecdh.getPublicKey("hex", "compressed"), TURNKEY_PARENT_API_PRIVATE_KEY: ecdh.getPrivateKey("hex"), TURNKEY_API_BASE: apiBase });
  assert.ok(parent);
  return parent;
}

const SUBMIT = "/public/v1/submit/create_sub_organization";
const POLL = "/public/v1/query/get_activity";
const input = { name: "whale-wallet", authenticator: { name: "Mac", challenge: "c", credentialId: "cred-1", clientDataJson: "d", attestationObject: "a", transports: [] } };
const pending = { activity: { id: "act-1", status: "ACTIVITY_STATUS_PENDING", result: {} } };
const completed = {
  activity: {
    id: "act-1",
    status: "ACTIVITY_STATUS_COMPLETED",
    result: { createSubOrganizationResultV7: { subOrganizationId: "sub-1", wallet: { walletId: "w-1", addresses: ["0xabc", "So1"] }, rootUserIds: ["owner-1"] } },
  },
};

test("a pending create is submitted once and returns its activity id without polling", async () => {
  const api = await fakeTurnkeyApi({ [SUBMIT]: () => ({ status: 200, json: pending }) });
  try {
    assert.deepEqual(await api.parent.submitSubOrganization(input), { activityId: "act-1", outcome: { state: "pending" } });
    assert.deepEqual(api.hits.map((hit) => hit.path), [SUBMIT]);
    assert.equal(api.hits[0]?.body.type, "ACTIVITY_TYPE_CREATE_SUB_ORGANIZATION_V7");
  } finally {
    await api.close();
  }
});

test("only an error on the submit request itself means Turnkey did not take the create", async () => {
  const answers: Answer[] = [{ status: 429, text: "<html>no</html>" }, { status: 404, text: "<html>no</html>" }, { status: 429, json: { code: 8, message: "rate limit exceeded", details: [] } }];
  for (const answer of answers) {
    const refused = await fakeTurnkeyApi({ [SUBMIT]: () => answer });
    try {
      await assert.rejects(refused.parent.submitSubOrganization(input), (error) => error instanceof TurnkeyNotSubmitted && error.reason === "turnkey_refused");
    } finally {
      await refused.close();
    }
    const polled = await fakeTurnkeyApi({ [POLL]: () => answer });
    try {
      await assert.rejects(polled.parent.subOrganizationActivity("act-1", 1), (error) => error instanceof Error && !(error instanceof TurnkeyNotSubmitted));
    } finally {
      await polled.close();
    }
  }
  const vacated = http.createServer();
  await new Promise<void>((resolve) => vacated.listen(0, "127.0.0.1", resolve));
  const port = (vacated.address() as AddressInfo).port;
  await new Promise<void>((resolve) => vacated.close(() => resolve()));
  await assert.rejects(parentAt(`http://127.0.0.1:${port}`).submitSubOrganization(input), (error) => error instanceof TurnkeyNotSubmitted && error.reason === "turnkey_unreachable");
});

test("a polled activity reports pending, completed with the new sub-organization, or failed", async () => {
  const answers = [pending, completed, { activity: { id: "act-1", status: "ACTIVITY_STATUS_REJECTED", result: {} } }];
  const api = await fakeTurnkeyApi({ [POLL]: () => ({ status: 200, json: answers.shift() }) });
  try {
    assert.deepEqual(await api.parent.subOrganizationActivity("act-1", 1), { state: "pending" });
    assert.deepEqual(await api.parent.subOrganizationActivity("act-1", 1), { state: "completed", created: { subOrganizationId: "sub-1", walletId: "w-1", ownerUserId: "owner-1", evm: "0xabc", solana: "So1" } });
    assert.deepEqual(await api.parent.subOrganizationActivity("act-1", 1), { state: "failed", status: "ACTIVITY_STATUS_REJECTED" });
    assert.deepEqual(api.hits.map((hit) => hit.body.activityId), ["act-1", "act-1", "act-1"]);
  } finally {
    await api.close();
  }
});

test("the lookup asks Turnkey by credential id and keeps only sub-organizations whose root holds that passkey", async () => {
  const owners: Record<string, string> = { "sub-1": "cred-1", "sub-2": "cred-other" };
  const org = (body: Record<string, unknown>) => String(body.organizationId);
  const api = await fakeTurnkeyApi({
    "/public/v1/query/list_suborgs": () => ({ status: 200, json: { organizationIds: ["sub-1", "sub-2"] } }),
    "/public/v1/query/list_wallets": (body) => ({ status: 200, json: { wallets: [{ walletId: `w-${org(body)}`, walletName: "whale" }] } }),
    "/public/v1/query/get_organization_configs": (body) => ({ status: 200, json: { configs: { quorum: { threshold: 1, userIds: [`owner-${org(body)}`] } } } }),
    "/public/v1/query/list_users": (body) => ({ status: 200, json: { users: [{ userId: `owner-${org(body)}`, userName: "owner", authenticators: [{ credentialId: owners[org(body)] }], apiKeys: [] }] } }),
    "/public/v1/query/list_wallet_accounts": () => ({ status: 200, json: { accounts: [{ address: "0xabc", addressFormat: "ADDRESS_FORMAT_ETHEREUM" }, { address: "So1", addressFormat: "ADDRESS_FORMAT_SOLANA" }] } }),
  });
  try {
    assert.deepEqual(await api.parent.findSubOrganizations("cred-1"), { state: "listed", found: [{ subOrganizationId: "sub-1", walletId: "w-sub-1", ownerUserId: "owner-sub-1", evm: "0xabc", solana: "So1" }] });
    const lookup = api.hits.find((hit) => hit.path === "/public/v1/query/list_suborgs");
    assert.deepEqual([lookup?.body.filterType, lookup?.body.filterValue], ["CREDENTIAL_ID", "cred-1"]);
  } finally {
    await api.close();
  }
});

test("a lookup that fills Turnkey's largest page is reported as truncated, whatever the page holds", async () => {
  const ids = Array.from({ length: 100 }, (_, n) => `sub-${n}`);
  const api = await fakeTurnkeyApi({
    "/public/v1/query/list_suborgs": () => ({ status: 200, json: { organizationIds: ids } }),
    "/public/v1/query/list_wallets": (body) => ({ status: 200, json: { wallets: [{ walletId: `w-${String(body.organizationId)}`, walletName: "whale" }] } }),
    "/public/v1/query/get_organization_configs": () => ({ status: 200, json: { configs: { quorum: { threshold: 1, userIds: ["owner"] } } } }),
    "/public/v1/query/list_users": () => ({ status: 200, json: { users: [{ userId: "owner", userName: "owner", authenticators: [{ credentialId: "cred-other" }], apiKeys: [] }] } }),
  });
  try {
    assert.deepEqual(await api.parent.findSubOrganizations("cred-1"), { state: "truncated" });
    const lookup = api.hits.find((hit) => hit.path === "/public/v1/query/list_suborgs");
    assert.deepEqual(lookup?.body.paginationOptions, { limit: "100" });
  } finally {
    await api.close();
  }
});
