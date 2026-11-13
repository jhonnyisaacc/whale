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
const MAX_PENDING_LOGINS = 3;

const loginState = z.object({ state: z.string(), nonce: z.string(), verifier: z.string(), returnTo: z.string(), expiresAt: z.number() });
type LoginState = z.infer<typeof loginState>;
const pendingLogins = z.array(loginState).max(MAX_PENDING_LOGINS);

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
  const pending = (header: string | undefined): LoginState[] => {
    const sealed = readCookie(header, LOGIN_COOKIE);
    const parsed = pendingLogins.safeParse(sealed ? login.open(sealed, deps.now()) : null);
    return parsed.success ? parsed.data.filter((entry) => entry.expiresAt > deps.now()) : [];
  };
  const loginCookie = (entries: LoginState[]) =>
    entries.length > 0 ? cookie(LOGIN_COOKIE, login.seal(entries, LOGIN_TTL_MS, deps.now()), LOGIN_TTL_MS / 1000) : clearedCookie(LOGIN_COOKIE);

  app.get("/auth/google/start", { config: perMinute(20) }, async (request, reply) => {
    const query = request.query as Record<string, unknown>;
    const state = { state: randomToken(), nonce: randomToken(), verifier: randomToken(48), returnTo: safeReturnTo(query.return_to), expiresAt: deps.now() + LOGIN_TTL_MS };
    reply.header("set-cookie", loginCookie([...pending(request.headers.cookie).slice(1 - MAX_PENDING_LOGINS), state]));
    return reply.redirect(googleAuthorizeUrl({ clientId: config.google.clientId, redirectUri, ...state }), 302);
  });

  app.get("/auth/google/callback", { config: perMinute(20) }, async (request, reply) => {
    const query = request.query as Record<string, unknown>;
    const entries = pending(request.headers.cookie);
    const { state } = query;
    const match = typeof state === "string" ? entries.find((entry) => sameToken(state, entry.state)) : undefined;
    const rest = entries.filter((entry) => entry !== match);
    reply.header("set-cookie", loginCookie(rest));
    if (entries.length === 0) return reply.redirect(fail("expired"), 302);
    if (typeof query.error === "string") return reply.redirect(fail("denied"), 302);
    if (!match || typeof query.code !== "string") return reply.redirect(fail("state"), 302);
    try {
      const idToken = await exchangeGoogleCode(deps.fetchImpl, { ...config.google, redirectUri, code: query.code, verifier: match.verifier });
      const claims = await verifyGoogleIdToken(idToken, { clientId: config.google.clientId, nonce: match.nonce, keys: deps.keys, now: deps.now() });
      const signedIn = await signInWithGoogle(pool, claims);
      if ("refused" in signedIn) return reply.redirect(fail("closed"), 302);
      const session = await createSession(pool, signedIn.accountId, deps.now());
      reply.header("set-cookie", [loginCookie(rest), cookie(SESSION_COOKIE, session.token, session.maxAgeSeconds)]);
      return reply.redirect(match.returnTo, 302);
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
