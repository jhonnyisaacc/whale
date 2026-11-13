import type { FastifyInstance, FastifyRequest } from "fastify";
import type pg from "pg";
import { z } from "zod";
import type { GatewayConfig } from "./config.js";
import { perMinute, requireSession } from "./http.js";
import { assertionPayload, verifyStepUp } from "./passkeys.js";
import { authenticateSigner, completeJob, leaseJob, newRegistrationCode, registerSigner, registrationMessage, REGISTRATION_TTL_MS } from "./signers.js";

const walletParam = z.object({ id: z.uuid() });
const codeBody = z.object({ assertion: assertionPayload }).strict();
const registerBody = z
  .object({
    code: z.string().regex(/^wreg_[A-Za-z0-9_-]{32}$/),
    walletId: z.uuid(),
    evmAddress: z.string().max(42),
    solanaAddress: z.string().max(44),
    evmSignature: z.string().max(132),
    solanaSignature: z.string().max(90),
  })
  .strict();
const reasonsBody = z.array(z.string()).transform((reasons) => reasons.slice(0, 20).map((reason) => reason.slice(0, 300)));
const resultBody = z.object({ decision: z.enum(["signed", "refused"]), result: z.unknown().optional(), reasons: reasonsBody.optional() }).strict();
const MAX_WAIT_S = 25;

function bearer(request: FastifyRequest): string {
  const header = request.headers.authorization;
  return typeof header === "string" && header.startsWith("Bearer ") ? header.slice(7).trim() : "";
}

export function signerCodeAction(walletId: string) {
  return { kind: "signer.register", walletId };
}

export function registerSignerRoutes(app: FastifyInstance, deps: { config: GatewayConfig; pool: pg.Pool; now?: () => number; pollMs?: number }): void {
  const { config, pool } = deps;
  const now = deps.now ?? Date.now;
  const pollMs = deps.pollMs ?? 1_000;

  // A registered signer decides what the wallet's deposit addresses are, so issuing a code takes the owner's passkey.
  app.post("/api/wallets/:id/signer/code", { config: perMinute(10) }, async (request, reply) => {
    const session = await requireSession(pool, request, reply);
    if (!session) return reply;
    const params = walletParam.safeParse(request.params);
    const body = codeBody.safeParse(request.body);
    if (!params.success) return reply.code(404).send({ error: "not_found" });
    if (!body.success) return reply.code(428).send({ error: "step_up_required" });
    const approved = await verifyStepUp(pool, config, session.accountId, signerCodeAction(params.data.id), body.data.assertion, now());
    if (approved !== true) return reply.code(403).send({ error: "step_up_failed", detail: approved });
    const code = await newRegistrationCode(pool, session.accountId, params.data.id, now());
    if (!code) return reply.code(404).send({ error: "not_found" });
    return {
      code,
      expiresAt: new Date(now() + REGISTRATION_TTL_MS).toISOString(),
      command: `whale-signer connect --keystore keystore.json --gateway ${config.publicUrl.origin} --wallet ${params.data.id} --code ${code}`,
    };
  });

  app.post("/signer/v1/register", { config: perMinute(10) }, async (request, reply) => {
    const body = registerBody.safeParse(request.body);
    if (!body.success) return reply.code(400).send({ error: "invalid_request" });
    const registered = await registerSigner(pool, body.data, now());
    if (typeof registered === "string") return reply.code(400).send({ error: "registration_refused", detail: registered });
    return reply.code(201).send({ ...registered, message: registrationMessage(body.data.walletId, body.data.code) });
  });

  app.get("/signer/v1/jobs", { config: perMinute(120) }, async (request, reply) => {
    const signer = await authenticateSigner(pool, bearer(request), now());
    if (!signer) return reply.code(401).send({ error: "unauthorized" });
    const wait = Math.min(MAX_WAIT_S, Math.max(0, Number((request.query as { wait?: string }).wait ?? "0") || 0));
    const deadline = Date.now() + wait * 1000;
    for (;;) {
      if (request.raw.socket.destroyed) return reply.code(204).send();
      const job = await leaseJob(pool, signer, now());
      if (job) return reply.header("cache-control", "no-store").send(job);
      if (Date.now() + pollMs > deadline) return reply.code(204).send();
      await new Promise((resolve) => setTimeout(resolve, pollMs));
    }
  });

  app.post("/signer/v1/jobs/:id/result", { config: perMinute(120) }, async (request, reply) => {
    const signer = await authenticateSigner(pool, bearer(request), now());
    if (!signer) return reply.code(401).send({ error: "unauthorized" });
    const params = walletParam.safeParse(request.params);
    const body = resultBody.safeParse(request.body);
    if (!params.success || !body.success) return reply.code(400).send({ error: "invalid_request" });
    const stored = await completeJob(pool, signer, params.data.id, { decision: body.data.decision, body: body.data.decision === "signed" ? body.data.result ?? null : { reasons: body.data.reasons ?? [] } }, now());
    if (!stored) return reply.code(409).send({ error: "not_leased" });
    return reply.code(204).send();
  });
}
