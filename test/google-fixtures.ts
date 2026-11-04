import { createSign, generateKeyPairSync, type KeyObject } from "node:crypto";

export const CLIENT_ID = "123-abc.apps.googleusercontent.com";

export function rsaKeys() {
  return generateKeyPairSync("rsa", { modulusLength: 2048 });
}

export function signIdToken(privateKey: KeyObject, claims: Record<string, unknown>, header: Record<string, unknown> = { alg: "RS256", kid: "k1" }): string {
  const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");
  const body = `${encode(header)}.${encode(claims)}`;
  return `${body}.${createSign("RSA-SHA256").update(body).sign(privateKey).toString("base64url")}`;
}

export function goodClaims(now: number, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return { iss: "https://accounts.google.com", aud: CLIENT_ID, sub: "1100", exp: now / 1000 + 600, iat: now / 1000, nonce: "n1", email: "Ana@Example.com", email_verified: true, ...overrides };
}
