import type { FastifyInstance } from "fastify";
import type pg from "pg";
import { z } from "zod";
import { decideApproval, listActivity, listApprovals } from "./approvals.js";
import type { GatewayConfig } from "./config.js";
import { perMinute, requireSession } from "./http.js";
import { assertionPayload } from "./passkeys.js";

const idParam = z.object({ id: z.uuid() });
const approveBody = z.object({ assertion: assertionPayload }).strict();
const approvalsQuery = z.object({ status: z.enum(["pending", "approved", "denied", "used", "expired"]).optional() });
const activityQuery = z.object({ walletId: z.uuid().optional(), before: z.coerce.number().int().positive().optional() });
const DECISION_STATUS: Record<string, number> = { not_found: 404, not_pending: 409, step_up_required: 428 };

export function registerApprovalRoutes(app: FastifyInstance, deps: { config: GatewayConfig; pool: pg.Pool; now?: () => number }): void {
  const { config, pool } = deps;
  const now = deps.now ?? Date.now;

  app.get("/api/approvals", async (request, reply) => {
    const session = await requireSession(pool, request, reply);
    if (!session) return reply;
    const query = approvalsQuery.safeParse(request.query);
    if (!query.success) return reply.code(400).send({ error: "invalid_request" });
    return { approvals: await listApprovals(pool, session.accountId, query.data.status ?? null, now()) };
  });

  app.post("/api/approvals/:id/approve", { config: perMinute(20) }, async (request, reply) => {
    const session = await requireSession(pool, request, reply);
    if (!session) return reply;
    const params = idParam.safeParse(request.params);
    const body = approveBody.safeParse(request.body);
    if (!params.success) return reply.code(404).send({ error: "not_found" });
    if (!body.success) return reply.code(428).send({ error: "step_up_required" });
    const result = await decideApproval(pool, config, { accountId: session.accountId, approvalId: params.data.id, approve: true, assertion: body.data.assertion }, now());
    if (result !== true) return reply.code(DECISION_STATUS[result] ?? 403).send({ error: DECISION_STATUS[result] ? result : "step_up_failed", detail: result });
    return { status: "approved" };
  });

  app.post("/api/approvals/:id/deny", { config: perMinute(20) }, async (request, reply) => {
    const session = await requireSession(pool, request, reply);
    if (!session) return reply;
    const params = idParam.safeParse(request.params);
    if (!params.success) return reply.code(404).send({ error: "not_found" });
    const result = await decideApproval(pool, config, { accountId: session.accountId, approvalId: params.data.id, approve: false, assertion: null }, now());
    if (result !== true) return reply.code(DECISION_STATUS[result] ?? 400).send({ error: result });
    return { status: "denied" };
  });

  app.get("/api/activity", async (request, reply) => {
    const session = await requireSession(pool, request, reply);
    if (!session) return reply;
    const query = activityQuery.safeParse(request.query);
    if (!query.success) return reply.code(400).send({ error: "invalid_request" });
    return { events: await listActivity(pool, session.accountId, query.data.walletId ?? null, query.data.before ?? null) };
  });
}
