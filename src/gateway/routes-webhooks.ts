import type { FastifyInstance } from "fastify";
import type pg from "pg";
import { z } from "zod";
import type { GatewayConfig } from "./config.js";
import { perMinute, requireSession } from "./http.js";
import { addWebhook, listWebhooks, removeWebhook, testWebhook, WEBHOOK_EVENTS } from "./webhooks.js";

const idParam = z.object({ id: z.uuid() });
const addBody = z.object({ url: z.string().max(512), format: z.enum(["whale", "slack"]), events: z.array(z.enum(WEBHOOK_EVENTS)).min(1).max(WEBHOOK_EVENTS.length) }).strict();

export function registerWebhookRoutes(app: FastifyInstance, deps: { config: GatewayConfig; pool: pg.Pool }): void {
  const { config, pool } = deps;

  app.get("/api/webhooks", async (request, reply) => {
    const session = await requireSession(pool, request, reply);
    if (!session) return reply;
    return { webhooks: await listWebhooks(pool, session.accountId), events: WEBHOOK_EVENTS };
  });

  app.post("/api/webhooks", { config: perMinute(10) }, async (request, reply) => {
    const session = await requireSession(pool, request, reply);
    if (!session) return reply;
    const body = addBody.safeParse(request.body);
    if (!body.success) return reply.code(400).send({ error: "invalid_request" });
    const added = await addWebhook(pool, config.secret, { accountId: session.accountId, ...body.data });
    if (typeof added === "string") return reply.code(400).send({ error: "webhook_rejected", detail: added });
    return reply.code(201).send({ ...added, note: "Verify Whale-Signature with this secret. It is shown once." });
  });

  app.delete("/api/webhooks/:id", async (request, reply) => {
    const session = await requireSession(pool, request, reply);
    if (!session) return reply;
    const params = idParam.safeParse(request.params);
    if (!params.success || !(await removeWebhook(pool, session.accountId, params.data.id))) return reply.code(404).send({ error: "not_found" });
    return reply.code(204).send();
  });

  app.post("/api/webhooks/:id/test", { config: perMinute(10) }, async (request, reply) => {
    const session = await requireSession(pool, request, reply);
    if (!session) return reply;
    const params = idParam.safeParse(request.params);
    if (!params.success || !(await testWebhook(pool, session.accountId, params.data.id))) return reply.code(404).send({ error: "not_found" });
    return reply.code(202).send({ status: "queued" });
  });
}
