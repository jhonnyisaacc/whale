import type { FastifyInstance } from "fastify";
import type pg from "pg";
import { z } from "zod";
import type { GatewayConfig } from "./config.js";
import { perMinute, requireSession } from "./http.js";
import { listPasskeys, registerPasskey, registrationOptions, registrationPayload, stepUpOptions } from "./passkeys.js";

const addBody = z.object({ credential: registrationPayload, label: z.string().trim().min(1).max(64) }).strict();
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
    const added = await registerPasskey(pool, config, { accountId: session.accountId, payload: body.data.credential, label: body.data.label });
    if (typeof added === "string") return reply.code(400).send({ error: "passkey_rejected", detail: added });
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
