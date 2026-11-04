import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import { parseDeploymentManifest, type DeploymentManifestV2 } from "../src/deployment-manifest.js";
import { decideLocalPolicy, type LocalPolicyInput, type LocalSignRequest, type LocalSignTx } from "../src/signing-policy/local.js";
import { kyberData } from "./fixtures.js";

const OWNER = "0x3333333333333333333333333333333333333333";
const ROUTER_A = "0x1111111111111111111111111111111111111111";
const ROUTER_B = "0x2222222222222222222222222222222222222222";
const BUY = "0x4200000000000000000000000000000000000006";
const OUTSIDER = "0x9999999999999999999999999999999999999999";
const NOW = new Date(Date.UTC(2026, 10, 1, 12));

function dataHash(data: string): string {
  return createHash("sha256").update(Buffer.from(data.slice(2), "hex")).digest("hex");
}

function manifest(overrides: Record<string, unknown> = {}, omit: string[] = []): DeploymentManifestV2 {
  const raw: Record<string, unknown> = {
    version: 2,
    chains: ["base"],
    routers: { "8453": [ROUTER_A] },
    settlers: {},
    solanaPrograms: [],
    maxUsdPerTrade: "5",
    dailyUsdCap: "25",
    maxValueWei: "2000000000000000",
    ...overrides,
  };
  for (const key of omit) delete raw[key];
  const parsed = parseDeploymentManifest(raw);
  if (parsed.version !== 2) throw new Error("fixture is not version 2");
  return parsed;
}

function swapCall(recipient: string) {
  return kyberData("0x01", { recipient, buyToken: BUY, minOut: 1n });
}

function request(data: string, overrides: Partial<LocalSignRequest> = {}): LocalSignRequest {
  return {
    idempotencyKey: "s1",
    purpose: "swap",
    chainKey: "base",
    chainId: 8453,
    to: ROUTER_A,
    value: "0",
    dataHash: dataHash(data),
    notionalUsd: "1",
    recipient: OWNER,
    buyToken: BUY,
    minOut: "1",
    ...overrides,
  };
}

function evmTx(data: string, overrides: Partial<Extract<LocalSignTx, { kind: "evm" }>> = {}): LocalSignTx {
  return {
    kind: "evm",
    chainId: 8453,
    to: ROUTER_A,
    data,
    value: "0",
    gas: "21000",
    nonce: 0,
    maxFeePerGas: "1",
    maxPriorityFeePerGas: "1",
    ...overrides,
  };
}

function input(overrides: Partial<LocalPolicyInput> = {}, manifestOverrides: Record<string, unknown> = {}, omit: string[] = []): LocalPolicyInput {
  const data = swapCall(OWNER);
  return {
    manifest: manifest(manifestOverrides, omit),
    kill: { filePresent: false },
    approvalsMacOk: true,
    request: request(data),
    tx: evmTx(data),
    spend: { day: "2026-11-01", spentUsd: "0", keys: {} },
    now: NOW,
    owner: OWNER,
    allowHotApproval: false,
    maxLeverage: 1,
    ...overrides,
  };
}

test("a capped base swap is allowed and counts the notional once", () => {
  const first = decideLocalPolicy(input());
  assert.equal(first.ok, true);
  if (!first.ok) return;
  assert.equal(first.spend.day, "2026-11-01");
  assert.equal(first.spend.spentUsd, "1");
  assert.equal(first.spend.keys.s1, "1");
  const replay = decideLocalPolicy(input({ spend: first.spend }));
  assert.equal(replay.ok, true);
  if (!replay.ok) return;
  assert.equal(replay.spend.spentUsd, "1");
  const changed = decideLocalPolicy(input({ spend: first.spend, request: request(swapCall(OWNER), { notionalUsd: "2" }) }));
  assert.deepEqual(changed, { ok: false, code: "tx_mismatch" });
});

test("a chain outside the manifest or outside evmChainIds is denied", () => {
  const data = "0x";
  const ethereum = input({
    request: request(data, { chainKey: "ethereum", chainId: 1, recipient: undefined, buyToken: undefined, minOut: undefined }),
    tx: evmTx(data, { chainId: 1 }),
  });
  assert.deepEqual(decideLocalPolicy(ethereum), { ok: false, code: "chain_denied" });
  const unknown = input({
    request: request(data, { chainId: 999999, recipient: undefined, buyToken: undefined, minOut: undefined }),
    tx: evmTx(data, { chainId: 999999 }),
  });
  assert.deepEqual(decideLocalPolicy(unknown), { ok: false, code: "chain_denied" });
  const empty = input({}, { chains: [] });
  assert.deepEqual(decideLocalPolicy(empty), { ok: false, code: "chain_denied" });
});

test("a router is denied on a chain that does not list it", () => {
  const data = "0x";
  const otherChain = input(
    {
      request: request(data, { recipient: undefined, buyToken: undefined, minOut: undefined }),
      tx: evmTx(data),
    },
    { chains: ["base", "ethereum"], routers: { "1": [ROUTER_A] } },
  );
  assert.deepEqual(decideLocalPolicy(otherChain), { ok: false, code: "router_not_approved" });
  const missing = input(
    {
      request: request(data, { recipient: undefined, buyToken: undefined, minOut: undefined }),
      tx: evmTx(data),
    },
    { routers: { "8453": [ROUTER_B] } },
  );
  assert.deepEqual(decideLocalPolicy(missing), { ok: false, code: "router_not_approved" });
});

test("each omitted cap is named, and a manifest with none of them does not sign", () => {
  for (const cap of ["chains", "maxUsdPerTrade", "dailyUsdCap", "maxValueWei"] as const) {
    assert.deepEqual(decideLocalPolicy(input({}, {}, [cap])), { ok: false, code: "missing_cap", cap });
  }
  const transferData = "0x";
  const transfer = input(
    {
      request: request(transferData, { purpose: "transfer", value: "1", recipient: undefined, buyToken: undefined, minOut: undefined, to: OUTSIDER }),
      tx: evmTx(transferData, { value: "1", to: OUTSIDER }),
    },
    {},
    ["transferRecipients"],
  );
  assert.deepEqual(decideLocalPolicy(transfer), { ok: false, code: "missing_cap", cap: "transferRecipients" });
  const bare = parseDeploymentManifest({ version: 2, routers: {}, settlers: {}, solanaPrograms: [] });
  if (bare.version !== 2) assert.fail("version 2");
  const denied = decideLocalPolicy(input({ manifest: bare }));
  assert.equal(denied.ok, false);
  if (!denied.ok) assert.deepEqual(denied, { ok: false, code: "missing_cap", cap: "chains" });
});

test("notional above the per-trade cap or across the daily cap is denied", () => {
  assert.deepEqual(decideLocalPolicy(input({ request: request(swapCall(OWNER), { notionalUsd: "6" }) })), { ok: false, code: "per_trade_cap" });
  assert.deepEqual(decideLocalPolicy(input({ request: request(swapCall(OWNER), { notionalUsd: "0" }) })), { ok: false, code: "per_trade_cap" });
  const crossing = input(
    {
      request: request(swapCall(OWNER), { notionalUsd: "6" }),
      spend: { day: "2026-11-01", spentUsd: "20", keys: {} },
    },
    { maxUsdPerTrade: "10" },
  );
  assert.deepEqual(decideLocalPolicy(crossing), { ok: false, code: "daily_cap" });
});

test("a kill file or WHALE_SIGNER_KILL refuses a sign the manifest would allow", () => {
  assert.equal(decideLocalPolicy(input()).ok, true);
  assert.deepEqual(decideLocalPolicy(input({ kill: { filePresent: true } })), { ok: false, code: "kill_switch" });
  assert.deepEqual(decideLocalPolicy(input({ kill: { filePresent: false, env: "1" } })), { ok: false, code: "kill_switch" });
  assert.deepEqual(decideLocalPolicy(input({ kill: { filePresent: false, env: "true" } })), { ok: false, code: "kill_switch" });
  assert.equal(decideLocalPolicy(input({ kill: { filePresent: false, env: "false" } })).ok, true);
  assert.deepEqual(decideLocalPolicy(input({ kill: { filePresent: true } }, {}, ["chains"])), { ok: false, code: "kill_switch" });
  assert.deepEqual(decideLocalPolicy(input({ approvalsMacOk: false }, {}, ["chains"])), { ok: false, code: "approvals_integrity" });
});

test("a transfer recipient must be listed, and an empty list denies", () => {
  const data = "0x";
  const fields = { purpose: "transfer" as const, value: "1", to: OUTSIDER, recipient: undefined, buyToken: undefined, minOut: undefined };
  const allowed = input(
    { request: request(data, fields), tx: evmTx(data, { value: "1", to: OUTSIDER }) },
    { transferRecipients: [OUTSIDER] },
  );
  assert.equal(decideLocalPolicy(allowed).ok, true);
  const outside = input(
    { request: request(data, fields), tx: evmTx(data, { value: "1", to: OUTSIDER }) },
    { transferRecipients: [ROUTER_A] },
  );
  assert.deepEqual(decideLocalPolicy(outside), { ok: false, code: "transfer_recipient_denied" });
  const empty = input(
    { request: request(data, fields), tx: evmTx(data, { value: "1", to: OUTSIDER }) },
    { transferRecipients: [] },
  );
  assert.deepEqual(decideLocalPolicy(empty), { ok: false, code: "transfer_recipient_denied" });
});

test("a tampered router, value, or swap recipient is tx_mismatch", () => {
  const data = "0x";
  const bothRouters = { routers: { "8453": [ROUTER_A, ROUTER_B] } };
  const router = input(
    {
      request: request(data, { to: ROUTER_A, recipient: undefined, buyToken: undefined, minOut: undefined }),
      tx: evmTx(data, { to: ROUTER_B }),
    },
    bothRouters,
  );
  assert.deepEqual(decideLocalPolicy(router), { ok: false, code: "tx_mismatch" });
  const value = input({
    request: request(data, { value: "0", recipient: undefined, buyToken: undefined, minOut: undefined }),
    tx: evmTx(data, { value: "1" }),
  });
  assert.deepEqual(decideLocalPolicy(value), { ok: false, code: "tx_mismatch" });
  const paidElsewhere = swapCall(OUTSIDER);
  const recipient = input({
    request: request(paidElsewhere, { recipient: OWNER }),
    tx: evmTx(paidElsewhere),
  });
  assert.deepEqual(decideLocalPolicy(recipient), { ok: false, code: "tx_mismatch" });
});
