import { createHash, createPublicKey, randomBytes, verify, type KeyObject } from "node:crypto";
import { z } from "zod";
import { readVendorText, vendorResponse } from "../vendor-fetch.js";

export const GOOGLE_AUTHORIZE_URL = "https://accounts.google.com/o/oauth2/v2/auth";
export const GOOGLE_TOKEN_URL = "https://oauth2.googleapis.com/token";
export const GOOGLE_JWKS_URL = "https://www.googleapis.com/oauth2/v3/certs";
const ISSUERS = new Set(["https://accounts.google.com", "accounts.google.com"]);
const SKEW_MS = 60_000;
const FETCH_TIMEOUT_MS = 5_000;

export type GoogleClaims = { sub: string; email: string | null };

export function randomToken(bytes = 32): string {
  return randomBytes(bytes).toString("base64url");
}

export function pkceChallenge(verifier: string): string {
  return createHash("sha256").update(verifier).digest("base64url");
}

export function googleAuthorizeUrl(input: { clientId: string; redirectUri: string; state: string; nonce: string; verifier: string }): string {
  const url = new URL(GOOGLE_AUTHORIZE_URL);
  url.search = new URLSearchParams({
    client_id: input.clientId,
    redirect_uri: input.redirectUri,
    response_type: "code",
    scope: "openid email",
    state: input.state,
    nonce: input.nonce,
    code_challenge: pkceChallenge(input.verifier),
    code_challenge_method: "S256",
    prompt: "select_account",
  }).toString();
  return url.toString();
}

const tokenReply = z.object({ id_token: z.string().min(1) }).loose();

export async function exchangeGoogleCode(
  fetchImpl: typeof fetch,
  input: { clientId: string; clientSecret: string; redirectUri: string; code: string; verifier: string },
): Promise<string> {
  const response = await vendorResponse(
    fetchImpl,
    GOOGLE_TOKEN_URL,
    {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" },
      body: new URLSearchParams({
        grant_type: "authorization_code",
        code: input.code,
        redirect_uri: input.redirectUri,
        client_id: input.clientId,
        client_secret: input.clientSecret,
        code_verifier: input.verifier,
      }).toString(),
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    },
    false,
  );
  if (!response.ok) throw new Error(`google token exchange failed with ${response.status}`);
  return tokenReply.parse(JSON.parse(await readVendorText(response, 64 * 1024))).id_token;
}

const jwkSchema = z.object({ kid: z.string(), kty: z.literal("RSA"), n: z.string(), e: z.string() }).loose();
const jwksSchema = z.object({ keys: z.array(z.unknown()) });

export type KeySource = { key(kid: string): Promise<KeyObject | null> };

// Google rotates keys. An unknown kid refetches the set, at most once a minute, so a forged kid cannot
// turn every login attempt into a request to Google.
export function googleKeys(fetchImpl: typeof fetch, now: () => number = Date.now): KeySource {
  let keys = new Map<string, KeyObject>();
  let fresh = 0;
  let fetched = 0;
  async function refresh(): Promise<void> {
    const response = await vendorResponse(fetchImpl, GOOGLE_JWKS_URL, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) }, false);
    if (!response.ok) throw new Error(`google keys fetch failed with ${response.status}`);
    const body = jwksSchema.parse(JSON.parse(await readVendorText(response, 64 * 1024)));
    const next = new Map<string, KeyObject>();
    for (const entry of body.keys) {
      const jwk = jwkSchema.safeParse(entry);
      if (jwk.success) next.set(jwk.data.kid, createPublicKey({ key: { kty: "RSA", n: jwk.data.n, e: jwk.data.e }, format: "jwk" }));
    }
    const maxAge = /max-age=(\d+)/.exec(response.headers.get("cache-control") ?? "")?.[1];
    keys = next;
    fetched = now();
    fresh = fetched + Math.min(Number(maxAge ?? "3600"), 86_400) * 1000;
  }
  return {
    async key(kid) {
      if (now() >= fresh || (!keys.has(kid) && now() - fetched >= 60_000)) await refresh();
      return keys.get(kid) ?? null;
    },
  };
}

const headerSchema = z.object({ alg: z.literal("RS256"), kid: z.string().min(1) }).loose();
const claimsSchema = z
  .object({
    iss: z.string(),
    aud: z.union([z.string(), z.array(z.string())]),
    azp: z.string().optional(),
    sub: z.string().min(1).max(255),
    exp: z.number(),
    iat: z.number(),
    nonce: z.string().optional(),
    email: z.string().optional(),
    email_verified: z.boolean().optional(),
  })
  .loose();

function part(segment: string | undefined): unknown {
  if (!segment) throw new Error("id token is malformed");
  return JSON.parse(Buffer.from(segment, "base64url").toString("utf8"));
}

export async function verifyGoogleIdToken(
  idToken: string,
  expected: { clientId: string; nonce: string; keys: KeySource; now?: number },
): Promise<GoogleClaims> {
  const segments = idToken.split(".");
  if (segments.length !== 3) throw new Error("id token is malformed");
  const header = headerSchema.parse(part(segments[0]));
  const key = await expected.keys.key(header.kid);
  if (!key) throw new Error("id token key is unknown");
  const signed = Buffer.from(`${segments[0]}.${segments[1]}`);
  if (!verify("RSA-SHA256", signed, key, Buffer.from(segments[2] as string, "base64url"))) throw new Error("id token signature is invalid");
  const claims = claimsSchema.parse(part(segments[1]));
  const now = expected.now ?? Date.now();
  const audiences = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
  if (!ISSUERS.has(claims.iss)) throw new Error("id token issuer is not Google");
  if (!audiences.includes(expected.clientId) || (claims.azp !== undefined && claims.azp !== expected.clientId)) throw new Error("id token audience is not this client");
  if (claims.exp * 1000 + SKEW_MS <= now) throw new Error("id token expired");
  if (claims.iat * 1000 - SKEW_MS > now) throw new Error("id token is from the future");
  if (claims.nonce !== expected.nonce) throw new Error("id token nonce does not match");
  return { sub: claims.sub, email: claims.email_verified === true && claims.email ? claims.email.toLowerCase() : null };
}
