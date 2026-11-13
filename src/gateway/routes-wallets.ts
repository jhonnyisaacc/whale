import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type pg from "pg";
import { z } from "zod";
import { createAgent, listAgents, revokeAgent, rotateApiKey } from "./agents.js";
import { perMinute, requireSession } from "./http.js";
import { ACTIONS, agentLimitsSchema, HOSTED_CHAINS, limitsWithin } from "./policy.js";
import { AVAILABLE_LEVELS, createWallet, LEVELS, listWallets } from "./wallets.js";

const idParam = z.object({ id: z.uuid() });
const label = z.string().trim().min(1).max(64);
const createWalletBody = z.object({ label, level: z.enum(LEVELS) }).strict();
const createAgentBody = z.object({ name: label, limits: agentLimitsSchema }).strict();

function idOf(request: FastifyRequest): string | null {
  const parsed = idParam.safeParse(request.params);
  return parsed.success ? parsed.data.id : null;
}

function notFound(reply: FastifyReply) {
  return reply.code(404).send({ error: "not_found" });
}

export function registerWalletRoutes(app: FastifyInstance, pool: pg.Pool): void {
  app.get("/api/meta", async () => ({ hostedChains: HOSTED_CHAINS, actions: ACTIONS, levels: LEVELS, availableLevels: AVAILABLE_LEVELS }));

  app.get("/api/wallets", async (request, reply) => {
    const session = await requireSession(pool, request, reply);
    if (!session) return reply;
    return { wallets: await listWallets(pool, session.accountId) };
  });

  app.post("/api/wallets", { config: perMinute(10) }, async (request, reply) => {
    const session = await requireSession(pool, request, reply);
    if (!session) return reply;
    const body = createWalletBody.safeParse(request.body);
    if (!body.success) return reply.code(400).send({ error: "invalid_request" });
    const created = await createWallet(pool, session.accountId, body.data);
    if ("refused" in created) return reply.code(409).send({ error: created.refused });
    return reply.code(201).send((await listWallets(pool, session.accountId, created.walletId))[0]);
  });

  app.get("/api/wallets/:id/agents", async (request, reply) => {
    const session = await requireSession(pool, request, reply);
    if (!session) return reply;
    const walletId = idOf(request);
    if (!walletId || (await listWallets(pool, session.accountId, walletId)).length === 0) return notFound(reply);
    return { agents: await listAgents(pool, session.accountId, walletId) };
  });

  app.post("/api/wallets/:id/agents", { config: perMinute(10) }, async (request, reply) => {
    const session = await requireSession(pool, request, reply);
    if (!session) return reply;
    const walletId = idOf(request);
    const wallet = walletId ? (await listWallets(pool, session.accountId, walletId))[0] : undefined;
    if (!walletId || !wallet) return notFound(reply);
    const body = createAgentBody.safeParse(request.body);
    if (!body.success) return reply.code(400).send({ error: "invalid_request" });
    const outside = limitsWithin(body.data.limits, wallet.policy);
    if (outside) return reply.code(400).send({ error: "limits_outside_policy", detail: outside });
    const created = await createAgent(pool, { accountId: session.accountId, walletId, name: body.data.name, limits: body.data.limits });
    if ("refused" in created) return reply.code(409).send({ error: created.refused });
    const { agentId, apiKey } = created;
    return reply.code(201).send({ agentId, apiKey, note: "This key is shown once. Whale stores only its hash." });
  });

  app.post("/api/agents/:id/rotate", { config: perMinute(10) }, async (request, reply) => {
    const session = await requireSession(pool, request, reply);
    if (!session) return reply;
    const agentId = idOf(request);
    const apiKey = agentId ? await rotateApiKey(pool, session.accountId, agentId) : null;
    if (!apiKey) return notFound(reply);
    return { agentId, apiKey, note: "The old key stopped working. This key is shown once." };
  });

  app.post("/api/agents/:id/revoke", { config: perMinute(10) }, async (request, reply) => {
    const session = await requireSession(pool, request, reply);
    if (!session) return reply;
    const agentId = idOf(request);
    if (!agentId || !(await revokeAgent(pool, session.accountId, agentId))) return notFound(reply);
    return reply.code(204).send();
  });
}
