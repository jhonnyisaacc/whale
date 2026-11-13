import type { FastifyInstance } from "fastify";
import type pg from "pg";
import { z } from "zod";
import type { GatewayConfig } from "./config.js";
import { perMinute, requireSession } from "./http.js";
import { addPasskey, assertionPayload, listPasskeys, registrationOptions, registrationPayload, stepUpOptions } from "./passkeys.js";

const addBody = z.object({ credential: registrationPayload, label: z.string().trim().min(1).max(64), assertion: assertionPayload.optional() }).strict();
const REFUSED_STATUS: Record<string, number> = { step_up_required: 428, step_up_failed: 403, passkey_rejected: 400 };
const stepUpBody = z.object({ action: z.record(z.string(), z.unknown()) }).strict();

export function registerPasskeyRoutes(app: FastifyInstance, deps: { config: GatewayConfig; pool: pg.Pool }): void {
  const { config, pool } = deps;

  app.get("/api/passkeys", async (request, reply) => {
    const session = await requireSession(pool, request, reply);
    if (!session) return reply;
    return { passkeys: await listPasskeys(pool, session.accountId) };
  });

  app.post("/api/passkeys/options", { config: perMinute(20) }, async (request, reply) => {
    const session = await requireSession(pool, request, reply);
    if (!session) return reply;
    return registrationOptions(pool, config, session);
  });

  app.post("/api/passkeys", { config: perMinute(10) }, async (request, reply) => {
    const session = await requireSession(pool, request, reply);
    if (!session) return reply;
    const body = addBody.safeParse(request.body);
    if (!body.success) return reply.code(400).send({ error: "invalid_request" });
    const added = await addPasskey(pool, config, { accountId: session.accountId, payload: body.data.credential, label: body.data.label, assertion: body.data.assertion ?? null });
    if ("refused" in added) return reply.code(REFUSED_STATUS[added.refused] ?? 400).send({ error: added.refused, detail: added.detail });
    return reply.code(201).send({ credentialId: added.credentialId, label: body.data.label });
  });

  // The action travels with the challenge request, and the route that performs the action recomputes its hash.
  app.post("/api/passkeys/step-up", { config: perMinute(20) }, async (request, reply) => {
    const session = await requireSession(pool, request, reply);
    if (!session) return reply;
    const body = stepUpBody.safeParse(request.body);
    if (!body.success) return reply.code(400).send({ error: "invalid_request" });
    const options = await stepUpOptions(pool, config, session.accountId, body.data.action);
    if (!options) return reply.code(409).send({ error: "no_passkey" });
    return options;
  });
}
