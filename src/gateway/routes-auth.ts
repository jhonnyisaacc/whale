import { timingSafeEqual } from "node:crypto";
import type { FastifyInstance } from "fastify";
import type pg from "pg";
import { z } from "zod";
import { createSession, revokeSession, SESSION_COOKIE, signInWithGoogle } from "./accounts.js";
import type { GatewayConfig } from "./config.js";
import { exchangeGoogleCode, googleAuthorizeUrl, randomToken, verifyGoogleIdToken, type KeySource } from "./google.js";
import { clearedCookie, cookie, perMinute, readCookie, requireSession, safeReturnTo } from "./http.js";
import { sealer } from "./seal.js";

export const LOGIN_COOKIE = "__Host-whale_login";
const LOGIN_TTL_MS = 10 * 60 * 1000;

const loginState = z.object({ state: z.string(), nonce: z.string(), verifier: z.string(), returnTo: z.string() });

export type AuthDeps = { config: GatewayConfig; pool: pg.Pool; fetchImpl: typeof fetch; keys: KeySource; now: () => number };

function sameToken(left: string, right: string): boolean {
  const a = Buffer.from(left);
  const b = Buffer.from(right);
  return a.byteLength === b.byteLength && timingSafeEqual(a, b);
}

export function registerAuthRoutes(app: FastifyInstance, deps: AuthDeps): void {
  const { config, pool } = deps;
  const login = sealer(config.secret, "google-login");
  const redirectUri = new URL("/auth/google/callback", config.publicUrl).toString();
  const fail = (code: string) => `/login?error=${code}`;

  app.get("/auth/google/start", { config: perMinute(20) }, async (request, reply) => {
    const query = request.query as Record<string, unknown>;
    const state = { state: randomToken(), nonce: randomToken(), verifier: randomToken(48), returnTo: safeReturnTo(query.return_to) };
    reply.header("set-cookie", cookie(LOGIN_COOKIE, login.seal(state, LOGIN_TTL_MS, deps.now()), LOGIN_TTL_MS / 1000));
    return reply.redirect(googleAuthorizeUrl({ clientId: config.google.clientId, redirectUri, ...state }), 302);
  });

  app.get("/auth/google/callback", { config: perMinute(20) }, async (request, reply) => {
    reply.header("set-cookie", clearedCookie(LOGIN_COOKIE));
    const query = request.query as Record<string, unknown>;
    const sealed = readCookie(request.headers.cookie, LOGIN_COOKIE);
    const parsed = loginState.safeParse(sealed ? login.open(sealed, deps.now()) : null);
    if (!parsed.success) return reply.redirect(fail("expired"), 302);
    if (typeof query.error === "string") return reply.redirect(fail("denied"), 302);
    if (typeof query.state !== "string" || typeof query.code !== "string" || !sameToken(query.state, parsed.data.state)) return reply.redirect(fail("state"), 302);
    try {
      const idToken = await exchangeGoogleCode(deps.fetchImpl, { ...config.google, redirectUri, code: query.code, verifier: parsed.data.verifier });
      const claims = await verifyGoogleIdToken(idToken, { clientId: config.google.clientId, nonce: parsed.data.nonce, keys: deps.keys, now: deps.now() });
      const signedIn = await signInWithGoogle(pool, claims);
      if ("refused" in signedIn) return reply.redirect(fail("closed"), 302);
      const session = await createSession(pool, signedIn.accountId, deps.now());
      reply.header("set-cookie", [clearedCookie(LOGIN_COOKIE), cookie(SESSION_COOKIE, session.token, session.maxAgeSeconds)]);
      return reply.redirect(parsed.data.returnTo, 302);
    } catch (error) {
      request.log.warn({ err: error }, "google sign-in failed");
      return reply.redirect(fail("signin_failed"), 302);
    }
  });

  app.post("/auth/logout", { config: perMinute(20) }, async (request, reply) => {
    const token = readCookie(request.headers.cookie, SESSION_COOKIE);
    if (token) await revokeSession(pool, token);
    return reply.header("set-cookie", clearedCookie(SESSION_COOKIE)).code(204).send();
  });

  app.get("/api/me", async (request, reply) => {
    const session = await requireSession(pool, request, reply);
    if (!session) return reply;
    return { accountId: session.accountId, email: session.email };
  });
}
