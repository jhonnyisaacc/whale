import { randomBytes } from "node:crypto";
import type { FastifyInstance, FastifyReply } from "fastify";
import type pg from "pg";
import { z } from "zod";
import type { GatewayConfig } from "./config.js";
import { perMinute, requireSession } from "./http.js";
import { clientResolver, fetchMetadataDocument, isLoopbackRedirect, redirectMatches, registerClient, registrationSchema, type MetadataFetch } from "./oauth-clients.js";
import { approveRequest, createRequest, denyRequest, exchangeCode, pendingRequest, refreshTokens, revokeToken } from "./oauth-store.js";
import { agentLimitsSchema, limitsWithin } from "./policy.js";
import { listWallets } from "./wallets.js";

const CORS_PATHS = ["/.well-known/oauth-protected-resource", "/.well-known/oauth-protected-resource/mcp", "/.well-known/oauth-authorization-server", "/oauth/token", "/oauth/register", "/oauth/revoke"];
const requestId = z.object({ id: z.string().regex(/^[A-Za-z0-9_-]{43}$/) });
const approveBody = z.object({ walletId: z.uuid(), name: z.string().trim().min(1).max(64), limits: agentLimitsSchema }).strict();
const authorizeQuery = z.object({
  response_type: z.string().optional(),
  client_id: z.string().min(1).max(512),
  redirect_uri: z.string().min(1).max(512),
  code_challenge: z.string().optional(),
  code_challenge_method: z.string().optional(),
  state: z.string().max(512).optional(),
  scope: z.string().max(256).optional(),
  resource: z.string().max(512).optional(),
});
const tokenBody = z.record(z.string(), z.string());

function cors(reply: FastifyReply): FastifyReply {
  return reply.header("access-control-allow-origin", "*").header("access-control-allow-methods", "GET, POST, OPTIONS").header("access-control-allow-headers", "content-type, authorization, mcp-protocol-version");
}

export function registerOAuthRoutes(app: FastifyInstance, deps: { config: GatewayConfig; pool: pg.Pool; fetchDocument?: MetadataFetch; now?: () => number }): void {
  const { config, pool } = deps;
  const now = deps.now ?? Date.now;
  const resolveClient = clientResolver(pool, deps.fetchDocument ?? fetchMetadataDocument);
  const issuer = config.publicUrl.origin;
  const resource = new URL("/mcp", config.publicUrl).toString();
  const endpoint = (path: string) => new URL(path, config.publicUrl).toString();

  app.addContentTypeParser("application/x-www-form-urlencoded", { parseAs: "string", bodyLimit: 8_192 }, (_request, body, done) => {
    done(null, Object.fromEntries(new URLSearchParams(String(body))));
  });
  for (const path of CORS_PATHS) app.options(path, async (_request, reply) => cors(reply).code(204).send());

  const protectedResource = async (_request: unknown, reply: FastifyReply) =>
    cors(reply).send({ resource, authorization_servers: [issuer], scopes_supported: ["wallet"], bearer_methods_supported: ["header"], resource_name: "Whale wallet" });
  app.get("/.well-known/oauth-protected-resource", protectedResource);
  app.get("/.well-known/oauth-protected-resource/mcp", protectedResource);
  app.get("/.well-known/oauth-authorization-server", async (_request, reply) =>
    cors(reply).send({
      issuer,
      authorization_endpoint: endpoint("/oauth/authorize"),
      token_endpoint: endpoint("/oauth/token"),
      registration_endpoint: endpoint("/oauth/register"),
      revocation_endpoint: endpoint("/oauth/revoke"),
      response_types_supported: ["code"],
      grant_types_supported: ["authorization_code", "refresh_token"],
      code_challenge_methods_supported: ["S256"],
      token_endpoint_auth_methods_supported: ["none"],
      revocation_endpoint_auth_methods_supported: ["none"],
      scopes_supported: ["wallet"],
      client_id_metadata_document_supported: true,
      authorization_response_iss_parameter_supported: true,
    }),
  );

  app.post("/oauth/register", { config: perMinute(10) }, async (request, reply) => {
    cors(reply);
    const body = registrationSchema.safeParse(request.body);
    if (!body.success) return reply.code(400).send({ error: "invalid_client_metadata" });
    const client = await registerClient(pool, `dcr_${randomBytes(16).toString("hex")}`, body.data);
    if (typeof client === "string") return reply.code(400).send({ error: "invalid_redirect_uri", error_description: client });
    return reply.code(201).send({ client_id: client.id, client_name: client.name, redirect_uris: client.redirectUris, token_endpoint_auth_method: "none", grant_types: ["authorization_code", "refresh_token"], response_types: ["code"] });
  });

  app.get("/oauth/authorize", { config: perMinute(30) }, async (request, reply) => {
    const query = authorizeQuery.safeParse(request.query);
    if (!query.success) return reply.code(400).send({ error: "invalid_request" });
    const client = await resolveClient(query.data.client_id, now());
    if (!client) return reply.code(400).send({ error: "invalid_client" });
    if (!redirectMatches(client.redirectUris, query.data.redirect_uri)) return reply.code(400).send({ error: "invalid_redirect_uri" });
    if (query.data.response_type !== "code") return reply.code(400).send({ error: "unsupported_response_type" });
    if (query.data.code_challenge_method !== "S256" || !/^[A-Za-z0-9_-]{43}$/.test(query.data.code_challenge ?? "")) return reply.code(400).send({ error: "invalid_request" });
    if ((query.data.resource ?? resource) !== resource) return reply.code(400).send({ error: "invalid_target" });
    const id = await createRequest(pool, { clientId: client.id, redirectUri: query.data.redirect_uri, codeChallenge: query.data.code_challenge as string, state: query.data.state ?? null, resource }, client, now());
    return reply.redirect(`/connect?request=${id}`, 302);
  });

  app.get("/oauth/requests/:id", async (request, reply) => {
    const params = requestId.safeParse(request.params);
    const pending = params.success ? await pendingRequest(pool, params.data.id, now()) : null;
    if (!pending) return reply.code(404).send({ error: "not_found" });
    const redirect = new URL(pending.redirectUri);
    return reply.header("cache-control", "no-store").send({
      client: { name: pending.clientName, id: pending.clientId, redirectHost: redirect.host || redirect.protocol, localhost: isLoopbackRedirect(pending.redirectUri) },
      resource: pending.resource,
    });
  });

  app.post("/api/oauth/requests/:id/deny", { config: perMinute(10) }, async (request, reply) => {
    const params = requestId.safeParse(request.params);
    const redirect = params.success ? await denyRequest(pool, params.data.id, issuer, now()) : null;
    if (!redirect) return reply.code(404).send({ error: "not_found" });
    return { redirect };
  });

  app.post("/api/oauth/requests/:id/approve", { config: perMinute(10) }, async (request, reply) => {
    const session = await requireSession(pool, request, reply);
    if (!session) return reply;
    const params = requestId.safeParse(request.params);
    const body = approveBody.safeParse(request.body);
    if (!params.success || !body.success) return reply.code(400).send({ error: "invalid_request" });
    const wallet = (await listWallets(pool, session.accountId, body.data.walletId))[0];
    if (!wallet) return reply.code(404).send({ error: "not_found" });
    const outside = limitsWithin(body.data.limits, wallet.policy);
    if (outside) return reply.code(400).send({ error: "limits_outside_policy", detail: outside });
    const redirect = await approveRequest(pool, { requestId: params.data.id, accountId: session.accountId, walletId: wallet.id, name: body.data.name, limits: body.data.limits, issuer }, now());
    if (!redirect) return reply.code(404).send({ error: "not_found" });
    return { redirect };
  });

  app.post("/oauth/token", { config: perMinute(60) }, async (request, reply) => {
    cors(reply).header("cache-control", "no-store").header("pragma", "no-cache");
    const body = tokenBody.safeParse(request.body);
    if (!body.success || !body.data.client_id) return reply.code(400).send({ error: "invalid_request" });
    const form = body.data;
    let result;
    if (form.grant_type === "authorization_code") {
      if (!form.code || !form.redirect_uri || !form.code_verifier) return reply.code(400).send({ error: "invalid_request" });
      result = await exchangeCode(pool, { code: form.code, clientId: form.client_id as string, redirectUri: form.redirect_uri, verifier: form.code_verifier, resource: form.resource ?? resource }, now());
    } else if (form.grant_type === "refresh_token") {
      if (!form.refresh_token || (form.resource !== undefined && form.resource !== resource)) return reply.code(400).send({ error: "invalid_request" });
      result = await refreshTokens(pool, { refreshToken: form.refresh_token, clientId: form.client_id as string }, now());
    } else {
      return reply.code(400).send({ error: "unsupported_grant_type" });
    }
    return "error" in result ? reply.code(400).send(result) : result;
  });

  app.post("/oauth/revoke", { config: perMinute(60) }, async (request, reply) => {
    cors(reply);
    const body = tokenBody.safeParse(request.body);
    if (body.success && body.data.token) await revokeToken(pool, body.data.token);
    return reply.code(200).send({});
  });
}
