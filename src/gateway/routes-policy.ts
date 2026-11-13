import type { FastifyInstance, FastifyRequest } from "fastify";
import type pg from "pg";
import { z } from "zod";
import type { GatewayConfig } from "./config.js";
import { perMinute, requireSession } from "./http.js";
import { assertionPayload } from "./passkeys.js";
import { applyDueChanges, cancelPendingChange, changePolicy, freezeWallets, pendingChange, unfreezeWallet } from "./policy-changes.js";
import { walletPolicySchema } from "./policy.js";

const walletParam = z.object({ id: z.uuid() });
const changeBody = z.object({ baseVersion: z.number().int().min(1), document: walletPolicySchema, assertion: assertionPayload.optional() }).strict();
const unfreezeBody = z.object({ assertion: assertionPayload }).strict();
const REFUSED_STATUS: Record<string, number> = { not_found: 404, stale: 409, conflict: 409, wallet_frozen: 409, step_up_required: 428, step_up_failed: 403 };

function walletIdOf(request: FastifyRequest): string | null {
  const parsed = walletParam.safeParse(request.params);
  return parsed.success ? parsed.data.id : null;
}

export function registerPolicyRoutes(app: FastifyInstance, deps: { config: GatewayConfig; pool: pg.Pool; now?: () => number }): void {
  const { config, pool } = deps;
  const now = deps.now ?? Date.now;

  app.get("/api/wallets/:id/policy/pending", { config: perMinute(30) }, async (request, reply) => {
    const session = await requireSession(pool, request, reply);
    if (!session) return reply;
    const walletId = walletIdOf(request);
    if (!walletId) return reply.code(404).send({ error: "not_found" });
    await applyDueChanges(pool, deps.now?.());
    return { pending: await pendingChange(pool, session.accountId, walletId) };
  });

  // A widening without an assertion answers 428 so the client knows to ask for a step-up bound to this document.
  app.put("/api/wallets/:id/policy", { config: perMinute(10) }, async (request, reply) => {
    const session = await requireSession(pool, request, reply);
    if (!session) return reply;
    const walletId = walletIdOf(request);
    const body = changeBody.safeParse(request.body);
    if (!walletId || !body.success) return reply.code(400).send({ error: "invalid_request" });
    const result = await changePolicy(pool, config, { accountId: session.accountId, walletId, baseVersion: body.data.baseVersion, document: body.data.document, assertion: body.data.assertion ?? null }, deps.now?.());
    if ("refused" in result) return reply.code(REFUSED_STATUS[result.refused] ?? 400).send({ error: result.refused, detail: result.detail });
    return reply.code(result.status === "scheduled" ? 202 : 200).send(result);
  });

  app.delete("/api/wallets/:id/policy/pending", async (request, reply) => {
    const session = await requireSession(pool, request, reply);
    if (!session) return reply;
    const walletId = walletIdOf(request);
    if (!walletId || !(await cancelPendingChange(pool, session.accountId, walletId, now()))) return reply.code(404).send({ error: "not_found" });
    return reply.code(204).send();
  });

  app.post("/api/wallets/:id/freeze", async (request, reply) => {
    const session = await requireSession(pool, request, reply);
    if (!session) return reply;
    const walletId = walletIdOf(request);
    if (!walletId || (await freezeWallets(pool, session.accountId, walletId, now())) === 0) return reply.code(404).send({ error: "not_found" });
    return { status: "frozen" };
  });

  app.post("/api/account/freeze", async (request, reply) => {
    const session = await requireSession(pool, request, reply);
    if (!session) return reply;
    return { frozen: await freezeWallets(pool, session.accountId, null, now()) };
  });

  app.post("/api/wallets/:id/unfreeze", { config: perMinute(10) }, async (request, reply) => {
    const session = await requireSession(pool, request, reply);
    if (!session) return reply;
    const walletId = walletIdOf(request);
    const body = unfreezeBody.safeParse(request.body);
    if (!walletId || !body.success) return reply.code(400).send({ error: "invalid_request" });
    const result = await unfreezeWallet(pool, config, session.accountId, walletId, body.data.assertion, now());
    if (result !== true) return reply.code(403).send({ error: "unfreeze_refused", detail: result });
    return { status: "unfrozen" };
  });
}
