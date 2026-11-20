import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { bridgeStatus, readAcrossStatus, readLifiStatus, trackBridge, type BridgeStatus } from "../src/bridge/status.js";
import { loadConfig } from "../src/config.js";

type Captured = { source: string; txHash: string; answer: Record<string, unknown> };
const captured = (name: string) => JSON.parse(readFileSync(new URL(`../../test/fixtures/bridge/${name}.json`, import.meta.url), "utf8")) as Captured;
const lookup = (provider: "lifi" | "across", fixture: Captured) => ({ provider, fromChainId: 8453, txHash: fixture.txHash });

test("a real LI.FI DONE answer for this transaction reads as landed with the destination transaction", () => {
  const done = captured("lifi-status-done");
  assert.deepEqual(readLifiStatus(lookup("lifi", done), done.answer), {
    provider: "lifi",
    state: "landed",
    sourceTx: done.txHash,
    destinationTx: "0x27cb9071c1196a01df3c49fb2a4d7edec4a594718d72f93b31fc27794e3d55cb",
    detail: "DONE COMPLETED",
  });
});

test("a LI.FI answer about another transfer is not taken as this one", () => {
  const other = captured("lifi-status-other-transfer");
  assert.equal(readLifiStatus(lookup("lifi", other), other.answer).state, "not_found");
});

test("a real Across filled answer reads as landed, and a missing deposit reads as not found", () => {
  const filled = captured("across-status-filled");
  const status = readAcrossStatus(lookup("across", filled), filled.answer);
  assert.equal(status.state, "landed");
  assert.equal(status.destinationTx, "0x6e34dd1bc0ee7b8b616c728e9e889a2c3509bf501e52cc2d7171c3cfca67e1cf");
  const missing = captured("across-status-not-found");
  assert.equal(readAcrossStatus(lookup("across", missing), missing.answer).state, "not_found");
  assert.equal(readAcrossStatus(lookup("across", missing), { ...filled.answer, status: "refunded", depositRefundTxHash: "0xabc" }).state, "not_found");
  assert.deepEqual(
    [readAcrossStatus(lookup("across", filled), { ...filled.answer, status: "expired" }).state, readAcrossStatus(lookup("across", filled), { ...filled.answer, status: "refunded" }).state],
    ["expired", "refunded"],
  );
});

test("bridgeStatus asks each provider's status API for this source transaction", async () => {
  const urls: string[] = [];
  const answers: Record<string, Captured> = { "li.quest": captured("lifi-status-done"), "app.across.to": captured("across-status-not-found") };
  const fetchImpl: typeof fetch = async (input) => {
    const url = new URL(String(input));
    urls.push(url.toString());
    const fixture = answers[url.host];
    return new Response(JSON.stringify(fixture?.answer ?? {}), { status: url.host === "app.across.to" ? 404 : 200 });
  };
  const config = loadConfig({});
  assert.equal((await bridgeStatus(config, lookup("lifi", captured("lifi-status-done")), fetchImpl)).state, "landed");
  assert.equal((await bridgeStatus(config, lookup("across", captured("across-status-not-found")), fetchImpl)).state, "not_found");
  assert.deepEqual(urls, [
    `https://li.quest/v1/status?txHash=${captured("lifi-status-done").txHash}&fromChain=8453`,
    `https://app.across.to/api/deposit/status?originChainId=8453&depositTxHash=${captured("across-status-not-found").txHash}`,
  ]);
});

test("trackBridge polls through misses and errors until the transfer lands or the deadline passes", async () => {
  let clock = 0;
  const io = { now: () => clock, sleep: async (ms: number) => void (clock += ms), pollMs: 1_000 };
  const order: (BridgeStatus["state"] | Error)[] = ["not_found", new Error("status timed out"), "pending", "landed"];
  const read = async (item: { provider: "lifi" | "across"; txHash: string }) => {
    const next = order.shift() ?? "pending";
    if (next instanceof Error) throw next;
    return { provider: item.provider, state: next, sourceTx: item.txHash, destinationTx: null, detail: next };
  };
  const target = { provider: "across" as const, fromChainId: 8453, txHash: "0x01" };
  assert.equal((await trackBridge(target, read, io, 60_000)).state, "landed");
  assert.equal(clock, 3_000);
  assert.equal((await trackBridge(target, read, io, clock + 2_500)).state, "pending");
});
