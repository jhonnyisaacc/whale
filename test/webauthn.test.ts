import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import test from "node:test";
import { decodeCbor } from "../src/gateway/cbor.js";
import { bindingOf } from "../src/gateway/passkeys.js";
import { verifyAssertion, verifyRegistration } from "../src/gateway/webauthn.js";
import { encodeCbor, softAuthenticator } from "./webauthn-fixtures.js";

const RP = { rpId: "whale.example", origin: "https://whale.example" };
const CHALLENGE = "c".repeat(43);

function registrationInput(response: ReturnType<ReturnType<typeof softAuthenticator>["register"]>, credentialId = response.id) {
  return { credentialId, clientDataJSON: Buffer.from(response.response.clientDataJSON, "base64url"), attestationObject: Buffer.from(response.response.attestationObject, "base64url"), challenge: CHALLENGE };
}

test("CBOR decoding is strict about length, depth, keys, and tags", () => {
  assert.deepEqual(decodeCbor(encodeCbor(new Map<number | string, never>([["a", 1 as never]]))).value, new Map([["a", 1]]));
  assert.throws(() => decodeCbor(Buffer.from([0x5f])), /indefinite/);
  assert.throws(() => decodeCbor(Buffer.from([0x42, 0x01])), /truncated/);
  assert.throws(() => decodeCbor(Buffer.from([0xc0, 0x00])), /tags/);
  assert.throws(() => decodeCbor(Buffer.from([0xa2, 0x01, 0x01, 0x01, 0x02])), /duplicate/);
  assert.throws(() => decodeCbor(Buffer.from([0xa1, 0x40, 0x01])), /keys/);
  assert.throws(() => decodeCbor(Buffer.from("8181818181818181", "hex")), /too deep|truncated/);
});

test("a registration verifies only for this origin, relying party, challenge, ceremony, and a verified user", () => {
  const authenticator = softAuthenticator(RP);
  const ok = verifyRegistration(registrationInput(authenticator.register(CHALLENGE)), RP);
  assert.equal(ok.credentialId, authenticator.credentialId.toString("base64url"));
  assert.ok(ok.publicKey.byteLength > 60);
  const cases: [Parameters<typeof authenticator.register>[1], RegExp][] = [
    [{ origin: "https://evil.example" }, /origin/],
    [{ rpId: "evil.example" }, /relying party/],
    [{ type: "webauthn.get" }, /ceremony type/],
    [{ flags: 0x41 }, /verification/],
  ];
  for (const [options, reason] of cases) assert.throws(() => verifyRegistration(registrationInput(authenticator.register(CHALLENGE, options)), RP), reason);
  assert.throws(() => verifyRegistration({ ...registrationInput(authenticator.register(CHALLENGE)), challenge: "d".repeat(43) }, RP), /challenge/);
  assert.throws(() => verifyRegistration(registrationInput(authenticator.register(CHALLENGE), Buffer.alloc(32, 9).toString("base64url")), RP), /credential id/);
});

test("an assertion needs the registered key, a forward counter, and the right challenge", () => {
  const authenticator = softAuthenticator(RP);
  const { publicKey } = verifyRegistration(registrationInput(authenticator.register(CHALLENGE)), RP);
  const check = (response: ReturnType<typeof authenticator.assert>, stored = 0, challenge = CHALLENGE) =>
    verifyAssertion(
      {
        clientDataJSON: Buffer.from(response.response.clientDataJSON, "base64url"),
        authenticatorData: Buffer.from(response.response.authenticatorData, "base64url"),
        signature: Buffer.from(response.response.signature, "base64url"),
        challenge,
        publicKey,
        storedSignCount: stored,
      },
      RP,
    );
  assert.deepEqual(check(authenticator.assert(CHALLENGE)), { signCount: 1 });
  assert.throws(() => check(authenticator.assert(CHALLENGE, { counter: 1 }), 1), /counter/);
  assert.throws(() => check(authenticator.assert(CHALLENGE, { key: generateKeyPairSync("ec", { namedCurve: "P-256" }).privateKey })), /signature/);
  assert.throws(() => check(authenticator.assert(CHALLENGE, { flags: 0x01 })), /verification/);
  assert.throws(() => check(authenticator.assert(CHALLENGE), 0, "d".repeat(43)), /challenge/);
  const synced = softAuthenticator(RP, false);
  const syncedKey = verifyRegistration(registrationInput(synced.register(CHALLENGE)), RP).publicKey;
  const response = synced.assert(CHALLENGE);
  assert.deepEqual(
    verifyAssertion({ clientDataJSON: Buffer.from(response.response.clientDataJSON, "base64url"), authenticatorData: Buffer.from(response.response.authenticatorData, "base64url"), signature: Buffer.from(response.response.signature, "base64url"), challenge: CHALLENGE, publicKey: syncedKey, storedSignCount: 0 }, RP),
    { signCount: 0 },
  );
});

test("an action binding ignores key order and changes with any value", () => {
  assert.equal(bindingOf({ a: 1, b: { c: [1, 2] } }), bindingOf({ b: { c: [1, 2] }, a: 1 }));
  assert.notEqual(bindingOf({ a: 1, b: { c: [1, 2] } }), bindingOf({ a: 1, b: { c: [2, 1] } }));
});

test("an action binding refuses values that JSON cannot carry exactly", () => {
  class Thing {
    readonly at = 1;
  }
  for (const value of [new Date(0), new Map([["a", 1]]), new Set([1]), new Thing(), NaN, Infinity, -Infinity, undefined, 1n, () => 1, Symbol("s")]) {
    assert.throws(() => bindingOf({ kind: "x", value }), /cannot bind/);
    assert.throws(() => bindingOf([value]), /cannot bind/);
  }
  assert.throws(() => bindingOf({ list: [1, , 2] }), /cannot bind/);
  assert.equal(typeof bindingOf({ a: null, b: [true, "s", 1.5], c: Object.assign(Object.create(null), { d: 0 }) }), "string");
});
