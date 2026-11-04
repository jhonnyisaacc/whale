import { createHash, createPublicKey, timingSafeEqual, verify } from "node:crypto";
import { decodeCbor, type CborValue } from "./cbor.js";

const FLAG_USER_PRESENT = 0x01;
const FLAG_USER_VERIFIED = 0x04;
const FLAG_ATTESTED = 0x40;
const ES256 = -7;

export type RelyingParty = { rpId: string; origin: string };
export type AuthenticatorData = { rpIdHash: Buffer; flags: number; signCount: number; credentialId: Buffer | null; publicKey: Buffer | null };

function sha256(data: Buffer | string): Buffer {
  return createHash("sha256").update(data).digest();
}

function sameBytes(left: Buffer, right: Buffer): boolean {
  return left.byteLength === right.byteLength && timingSafeEqual(left, right);
}

function bytesAt(map: Map<CborValue, CborValue>, key: number | string): Buffer {
  const value = map.get(key);
  if (!Buffer.isBuffer(value)) throw new Error(`webauthn: ${String(key)} is not a byte string`);
  return value;
}

// ES256 on P-256 only. Turnkey takes the same key as the wallet root, and one algorithm keeps the verifier small.
export function coseToSpki(cose: CborValue): Buffer {
  if (!(cose instanceof Map) || cose.get(1) !== 2 || cose.get(3) !== ES256 || cose.get(-1) !== 1) throw new Error("webauthn: only ES256 P-256 keys are accepted");
  const x = bytesAt(cose, -2);
  const y = bytesAt(cose, -3);
  if (x.byteLength !== 32 || y.byteLength !== 32) throw new Error("webauthn: malformed P-256 point");
  const key = createPublicKey({ key: { kty: "EC", crv: "P-256", x: x.toString("base64url"), y: y.toString("base64url") }, format: "jwk" });
  return key.export({ format: "der", type: "spki" });
}

export function parseAuthenticatorData(data: Buffer): AuthenticatorData {
  if (data.byteLength < 37) throw new Error("webauthn: authenticator data is too short");
  const flags = data.readUInt8(32);
  const parsed: AuthenticatorData = { rpIdHash: data.subarray(0, 32), flags, signCount: data.readUInt32BE(33), credentialId: null, publicKey: null };
  if ((flags & FLAG_ATTESTED) === 0) return parsed;
  if (data.byteLength < 55) throw new Error("webauthn: attested data is too short");
  const idLength = data.readUInt16BE(53);
  if (idLength < 16 || idLength > 1023 || 55 + idLength > data.byteLength) throw new Error("webauthn: bad credential id length");
  parsed.credentialId = data.subarray(55, 55 + idLength);
  parsed.publicKey = coseToSpki(decodeCbor(data, 55 + idLength).value);
  return parsed;
}

function checkClientData(clientDataJSON: Buffer, type: string, challenge: string, rp: RelyingParty): void {
  let client: unknown;
  try {
    client = JSON.parse(clientDataJSON.toString("utf8"));
  } catch {
    throw new Error("webauthn: client data is not JSON");
  }
  if (typeof client !== "object" || client === null) throw new Error("webauthn: client data is not an object");
  const fields = client as Record<string, unknown>;
  if (fields.type !== type) throw new Error("webauthn: wrong ceremony type");
  if (typeof fields.challenge !== "string" || !sameBytes(Buffer.from(fields.challenge), Buffer.from(challenge))) throw new Error("webauthn: challenge does not match");
  if (fields.origin !== rp.origin) throw new Error("webauthn: origin does not match");
  if (fields.crossOrigin === true) throw new Error("webauthn: cross-origin ceremony");
}

function checkFlags(data: AuthenticatorData, rp: RelyingParty): void {
  if (!sameBytes(data.rpIdHash, sha256(rp.rpId))) throw new Error("webauthn: relying party does not match");
  if ((data.flags & FLAG_USER_PRESENT) === 0 || (data.flags & FLAG_USER_VERIFIED) === 0) throw new Error("webauthn: user presence and verification are required");
}

export type Registration = { credentialId: string; publicKey: Buffer; signCount: number };

// Attestation statements are not trusted: the browser is asked for "none", and the key is bound to the account by
// the session that started the ceremony, not by the authenticator's maker.
export function verifyRegistration(input: { credentialId: string; clientDataJSON: Buffer; attestationObject: Buffer; challenge: string }, rp: RelyingParty): Registration {
  checkClientData(input.clientDataJSON, "webauthn.create", input.challenge, rp);
  const attestation = decodeCbor(input.attestationObject).value;
  if (!(attestation instanceof Map)) throw new Error("webauthn: attestation object is not a map");
  const data = parseAuthenticatorData(bytesAt(attestation, "authData"));
  checkFlags(data, rp);
  if (!data.credentialId || !data.publicKey) throw new Error("webauthn: no attested credential");
  if (!sameBytes(data.credentialId, Buffer.from(input.credentialId, "base64url"))) throw new Error("webauthn: credential id does not match");
  return { credentialId: data.credentialId.toString("base64url"), publicKey: data.publicKey, signCount: data.signCount };
}

// A counter that fails to move forward means a cloned authenticator. Zero on both sides means the authenticator
// does not count, which synced passkeys do.
export function verifyAssertion(
  input: { clientDataJSON: Buffer; authenticatorData: Buffer; signature: Buffer; challenge: string; publicKey: Buffer; storedSignCount: number },
  rp: RelyingParty,
): { signCount: number } {
  checkClientData(input.clientDataJSON, "webauthn.get", input.challenge, rp);
  const data = parseAuthenticatorData(input.authenticatorData);
  checkFlags(data, rp);
  const signed = Buffer.concat([input.authenticatorData, sha256(input.clientDataJSON)]);
  const key = createPublicKey({ key: input.publicKey, format: "der", type: "spki" });
  if (!verify("sha256", signed, { key, dsaEncoding: "der" }, input.signature)) throw new Error("webauthn: signature is invalid");
  if ((data.signCount !== 0 || input.storedSignCount !== 0) && data.signCount <= input.storedSignCount) throw new Error("webauthn: signature counter went backwards");
  return { signCount: data.signCount };
}
