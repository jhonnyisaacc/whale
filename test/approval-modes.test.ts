import assert from "node:assert/strict";
import test from "node:test";
import { approvalGate, parseApprovalMode } from "../src/approval-modes.js";

test("the default approval mode needs a passkey", () => {
  assert.equal(parseApprovalMode(undefined), "always_approve");
  assert.equal(parseApprovalMode(""), "always_approve");
});

test("a bad approval mode fails at boot, not at send time", () => {
  assert.throws(() => parseApprovalMode("yolo"), /WALLET_APPROVAL_MODE/);
});

test("a dry-run never waits on a human", () => {
  assert.equal(approvalGate("always_approve", { live: false, screened: false }).action, "sign");
});

test("an unscreened live send always needs a human", () => {
  assert.equal(approvalGate("autonomous", { live: true, screened: false }).action, "passkey");
});

test("each granted mode maps to its human step", () => {
  assert.equal(approvalGate("autonomous", { live: true, screened: true }).action, "sign");
  assert.equal(approvalGate("iframe", { live: true, screened: true }).action, "confirm");
  assert.equal(approvalGate("always_approve", { live: true, screened: true }).action, "passkey");
});
