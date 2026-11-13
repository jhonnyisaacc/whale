import type { FastifyBaseLogger, FastifyInstance } from "fastify";
import type pg from "pg";
import { z } from "zod";
import { audit, inTransaction } from "./accounts.js";
import type { GatewayConfig } from "./config.js";
import { perMinute, requireSession } from "./http.js";
import { addPasskey, assertionPayload, backupAuthenticators, REFUSED_STATUS, registrationOptions, registrationPayload } from "./passkeys.js";
import { storedPolicySchema } from "./policy.js";
import { allowPoliciesMatch, DELEGATE_USER_NAME, expectedPolicies, TurnkeyNotSubmitted, turnkeyTransports, verifyDelegation, type CreatedSubOrg, type CreateOutcome, type DelegationConfig, type NotSubmittedReason, type TurnkeyParent } from "./turnkey.js";
import type { Registration } from "./webauthn.js";

const walletParam = z.object({ id: z.uuid() });
const createBody = z.object({ credential: registrationPayload, label: z.string().trim().min(1).max(64), assertion: assertionPayload.optional() }).strict();

class EnclaveClaimed extends Error {}

const NOT_SUBMITTED_STATUS: Record<NotSubmittedReason, number> = { turnkey_refused: 502, turnkey_unreachable: 503 };
const CREATE_POLLS = 3;

type EnclaveRow = {
  id: string;
  status: string;
  level: string;
  turnkey_sub_org_id: string | null;
  turnkey_wallet_id: string | null;
  turnkey_owner_user_id: string | null;
  root_credential_id: string | null;
  turnkey_activity_id: string | null;
  lease_expired: boolean;
  unrecorded_claim_expired: boolean;
  document: unknown;
  solana: string | null;
};

async function enclaveWallet(pool: pg.Pool | pg.PoolClient, accountId: string, walletId: string): Promise<EnclaveRow | null> {
  const found = await pool.query<EnclaveRow>(
    `SELECT w.id, w.status, w.level, w.turnkey_sub_org_id, w.turnkey_wallet_id, w.turnkey_owner_user_id, w.root_credential_id, w.turnkey_activity_id, p.document,
       w.root_claimed_at < now() - interval '2 minutes' AS lease_expired,
       w.root_claimed_at < now() - interval '24 hours' AS unrecorded_claim_expired,
       (SELECT address FROM wallet_addresses a WHERE a.wallet_id = w.id AND a.family = 'solana') AS solana
     FROM wallets w JOIN policies p ON p.wallet_id = w.id WHERE w.id = $1 AND w.account_id = $2 AND w.level = 'enclave'`,
    [walletId, accountId],
  );
  return found.rows[0] ?? null;
}

async function recordSubOrg(pool: pg.Pool, accountId: string, walletId: string, credentialId: string, created: CreatedSubOrg): Promise<void> {
  await inTransaction(pool, async (client) => {
    const recorded = await client.query(
      "UPDATE wallets SET turnkey_sub_org_id = $3, turnkey_wallet_id = $4, turnkey_owner_user_id = $5 WHERE id = $1 AND root_credential_id = $2 AND turnkey_sub_org_id IS NULL",
      [walletId, credentialId, created.subOrganizationId, created.walletId, created.ownerUserId],
    );
    if (recorded.rowCount === 1) {
      await client.query("INSERT INTO wallet_addresses (wallet_id, family, address) VALUES ($1, 'evm', $2), ($1, 'solana', $3)", [walletId, created.evm, created.solana]);
      await audit(client, { accountId, walletId, actor: "user", action: "wallet.enclave_created", detail: { subOrganizationId: created.subOrganizationId } });
      return;
    }
    const current = await client.query<{ turnkey_sub_org_id: string | null }>("SELECT turnkey_sub_org_id FROM wallets WHERE id = $1", [walletId]);
    if (current.rows[0]?.turnkey_sub_org_id !== created.subOrganizationId) throw new Error(`sub-organization ${created.subOrganizationId} lost its claim on wallet ${walletId}`);
  });
}

async function releaseClaim(pool: pg.Pool, accountId: string, walletId: string, credentialId: string, reason: string): Promise<void> {
  await inTransaction(pool, async (client) => {
    const released = await client.query("UPDATE wallets SET root_credential_id = NULL, root_claimed_at = NULL, turnkey_activity_id = NULL WHERE id = $1 AND root_credential_id = $2 AND turnkey_sub_org_id IS NULL", [walletId, credentialId]);
    if (released.rowCount !== 1) return;
    await client.query("DELETE FROM passkeys WHERE credential_id = $1 AND account_id = $2", [credentialId, accountId]);
    await audit(client, { accountId, walletId, actor: "system", action: "passkey.removed", detail: { credentialId, reason } });
  });
}

function outcomeUnknown(log: FastifyBaseLogger, error: unknown): CreateOutcome {
  log.error({ err: error }, "turnkey create outcome unknown");
  return { state: "pending" };
}

type Settled = "free" | "enclave_exists" | "enclave_in_progress" | "enclave_conflict";

async function applyOutcome(pool: pg.Pool, accountId: string, walletId: string, credentialId: string, outcome: CreateOutcome): Promise<Settled> {
  if (outcome.state === "pending") return "enclave_in_progress";
  if (outcome.state === "failed") {
    await releaseClaim(pool, accountId, walletId, credentialId, outcome.status);
    return "free";
  }
  await recordSubOrg(pool, accountId, walletId, credentialId, outcome.created);
  return "enclave_exists";
}

async function settleClaim(pool: pg.Pool, turnkey: TurnkeyParent | null, accountId: string, wallet: EnclaveRow, log: FastifyBaseLogger): Promise<Settled> {
  if (wallet.turnkey_sub_org_id) return "enclave_exists";
  const credentialId = wallet.root_credential_id;
  if (!credentialId) return "free";
  if (!turnkey) return "enclave_in_progress";
  if (wallet.turnkey_activity_id) return applyOutcome(pool, accountId, wallet.id, credentialId, await turnkey.subOrganizationActivity(wallet.turnkey_activity_id, 1).catch((error: unknown) => outcomeUnknown(log, error)));
  if (!wallet.lease_expired) return "enclave_in_progress";
  const lookup = await turnkey.findSubOrganizations(credentialId);
  if (lookup.state === "truncated" || lookup.found.length > 1) return "enclave_conflict";
  if (lookup.found[0]) return applyOutcome(pool, accountId, wallet.id, credentialId, { state: "completed", created: lookup.found[0] });
  if (!wallet.unrecorded_claim_expired) return "enclave_in_progress";
  await releaseClaim(pool, accountId, wallet.id, credentialId, "unrecorded_create_never_landed");
  return "free";
}

export type EnclaveDeps = { config: GatewayConfig; pool: pg.Pool; turnkey: TurnkeyParent | null; delegation: DelegationConfig | null };

// Three steps, each idempotent from the user's side: create the sub-organization with the new passkey as its only
// root, let the browser add Whale's delegate under that passkey, then confirm by reading Turnkey.
export function registerEnclaveRoutes(app: FastifyInstance, deps: EnclaveDeps): void {
  const { config, pool } = deps;
  const binding = (walletId: string) => `enclave:${walletId}`;

  app.post("/api/wallets/:id/enclave/options", { config: perMinute(10) }, async (request, reply) => {
    const session = await requireSession(pool, request, reply);
    if (!session) return reply;
    const params = walletParam.safeParse(request.params);
    const wallet = params.success ? await enclaveWallet(pool, session.accountId, params.data.id) : null;
    if (!wallet) return reply.code(404).send({ error: "not_found" });
    const settled = await settleClaim(pool, deps.turnkey, session.accountId, wallet, request.log);
    if (settled !== "free") return reply.code(409).send({ error: settled });
    return registrationOptions(pool, config, session, binding(wallet.id));
  });

  app.post("/api/wallets/:id/enclave", { config: perMinute(5) }, async (request, reply) => {
    const session = await requireSession(pool, request, reply);
    if (!session) return reply;
    if (!deps.turnkey) return reply.code(503).send({ error: "enclave_unavailable" });
    const turnkey = deps.turnkey;
    const params = walletParam.safeParse(request.params);
    const body = createBody.safeParse(request.body);
    if (!params.success || !body.success) return reply.code(400).send({ error: "invalid_request" });
    const wallet = await enclaveWallet(pool, session.accountId, params.data.id);
    if (!wallet) return reply.code(404).send({ error: "not_found" });
    const settled = await settleClaim(pool, turnkey, session.accountId, wallet, request.log);
    if (settled !== "free") return reply.code(409).send({ error: settled });
    const { credential } = body.data;
    let root: (Registration & { challenge: string }) | undefined;
    let result: Awaited<ReturnType<typeof addPasskey>>;
    try {
      result = await addPasskey(pool, config, { accountId: session.accountId, payload: credential, label: body.data.label, assertion: body.data.assertion ?? null, binding: binding(wallet.id) }, async (client, registration) => {
        const claimed = await client.query("UPDATE wallets SET root_credential_id = $2, root_claimed_at = now() WHERE id = $1 AND root_credential_id IS NULL AND turnkey_sub_org_id IS NULL", [wallet.id, registration.credentialId]);
        if (claimed.rowCount !== 1) throw new EnclaveClaimed();
        root = registration;
      });
    } catch (error) {
      if (error instanceof EnclaveClaimed) return reply.code(409).send({ error: "enclave_in_progress" });
      throw error;
    }
    if ("refused" in result) return reply.code(REFUSED_STATUS[result.refused]).send({ error: result.refused, detail: result.detail });
    if (!root) throw new Error(`passkey ${result.credentialId} registered without claiming wallet ${wallet.id}`);
    const credentialId = root.credentialId;
    let submitted: Awaited<ReturnType<TurnkeyParent["submitSubOrganization"]>>;
    try {
      submitted = await turnkey.submitSubOrganization({
        name: `whale-${wallet.id}`,
        authenticator: {
          name: body.data.label,
          challenge: root.challenge,
          credentialId,
          clientDataJson: credential.response.clientDataJSON,
          attestationObject: credential.response.attestationObject,
          transports: turnkeyTransports(credential.response.transports),
        },
      });
    } catch (error) {
      if (!(error instanceof TurnkeyNotSubmitted)) {
        outcomeUnknown(request.log, error);
        return reply.code(409).send({ error: "enclave_in_progress" });
      }
      await releaseClaim(pool, session.accountId, wallet.id, credentialId, error.reason);
      return reply.code(NOT_SUBMITTED_STATUS[error.reason]).send({ error: error.reason, detail: error.message });
    }
    await pool.query("UPDATE wallets SET turnkey_activity_id = $3 WHERE id = $1 AND root_credential_id = $2 AND turnkey_sub_org_id IS NULL", [wallet.id, credentialId, submitted.activityId]);
    const outcome = submitted.outcome.state === "pending" ? await turnkey.subOrganizationActivity(submitted.activityId, CREATE_POLLS).catch((error: unknown) => outcomeUnknown(request.log, error)) : submitted.outcome;
    const settledCreate = await applyOutcome(pool, session.accountId, wallet.id, credentialId, outcome);
    if (outcome.state === "failed") return reply.code(502).send({ error: "turnkey_refused", detail: outcome.status });
    if (settledCreate !== "enclave_exists") return reply.code(409).send({ error: settledCreate });
    return reply.code(201).send({ walletId: wallet.id, next: "delegate" });
  });

  // What the browser submits to Turnkey under the user's passkey. Policies need the delegate's user id, so they appear
  // once the delegate exists.
  app.get("/api/wallets/:id/enclave/delegation", { config: perMinute(10) }, async (request, reply) => {
    const session = await requireSession(pool, request, reply);
    if (!session) return reply;
    if (!deps.turnkey || !deps.delegation) return reply.code(503).send({ error: "enclave_unavailable" });
    const params = walletParam.safeParse(request.params);
    const wallet = params.success ? await enclaveWallet(pool, session.accountId, params.data.id) : null;
    if (!wallet?.turnkey_sub_org_id || !wallet.turnkey_wallet_id || !wallet.solana) return reply.code(404).send({ error: "not_found" });
    const state = await deps.turnkey.readSubOrganization(wallet.turnkey_sub_org_id);
    const delegate = state.users.find((user) => user.apiPublicKeys.some((key) => key.toLowerCase() === deps.delegation?.delegatePublicKey));
    const policy = storedPolicySchema.parse(wallet.document);
    const policies = delegate ? expectedPolicies({ delegateUserId: delegate.userId, walletId: wallet.turnkey_wallet_id, solanaAddress: wallet.solana, policy, config: deps.delegation }) : null;
    const ownerCredentialIds = state.users.find((user) => user.userId === wallet.turnkey_owner_user_id)?.credentialIds ?? [];
    const policiesInPlace = policies !== null && allowPoliciesMatch(state.policies, policies);
    const stalePolicyIds = policies !== null && !policiesInPlace ? state.policies.flatMap((entry) => (entry.effect === "EFFECT_ALLOW" && entry.policyId ? [entry.policyId] : [])) : [];
    return {
      subOrganizationId: wallet.turnkey_sub_org_id,
      ownerUserId: wallet.turnkey_owner_user_id,
      ownerCredentialIds,
      missingAuthenticators: await backupAuthenticators(pool, session.accountId, ownerCredentialIds),
      delegateUser: { userName: DELEGATE_USER_NAME, apiKeys: [{ apiKeyName: "whale-executor", publicKey: deps.delegation.delegatePublicKey, curveType: "API_KEY_CURVE_P256" }], authenticators: [], oauthProviders: [], userTags: [] },
      delegateUserId: delegate?.userId ?? null,
      policies,
      policiesInPlace,
      stalePolicyIds,
    };
  });

  app.post("/api/wallets/:id/enclave/confirm", { config: perMinute(10) }, async (request, reply) => {
    const session = await requireSession(pool, request, reply);
    if (!session) return reply;
    if (!deps.turnkey || !deps.delegation) return reply.code(503).send({ error: "enclave_unavailable" });
    const delegation = deps.delegation;
    const params = walletParam.safeParse(request.params);
    const wallet = params.success ? await enclaveWallet(pool, session.accountId, params.data.id) : null;
    if (!wallet?.turnkey_sub_org_id || !wallet.turnkey_wallet_id || !wallet.turnkey_owner_user_id || !wallet.root_credential_id || !wallet.solana) return reply.code(404).send({ error: "not_found" });
    if (wallet.status !== "pending") return { walletId: wallet.id, status: wallet.status };
    const { turnkey_wallet_id: turnkeyWalletId, solana } = wallet;
    const policy = storedPolicySchema.parse(wallet.document);
    const state = await deps.turnkey.readSubOrganization(wallet.turnkey_sub_org_id);
    const verdict = verifyDelegation(state, {
      ownerUserId: wallet.turnkey_owner_user_id,
      rootCredentialId: wallet.root_credential_id,
      delegatePublicKey: delegation.delegatePublicKey,
      expected: (delegateUserId) => expectedPolicies({ delegateUserId, walletId: turnkeyWalletId, solanaAddress: solana, policy, config: delegation }),
    });
    if ("problems" in verdict) {
      await audit(pool, { accountId: session.accountId, walletId: wallet.id, actor: "system", action: "wallet.delegation_refused", detail: { problems: verdict.problems } });
      return reply.code(409).send({ error: "delegation_not_safe", problems: verdict.problems });
    }
    const activated = await pool.query("UPDATE wallets SET turnkey_delegate_user_id = $2, status = 'active' WHERE id = $1 AND status = 'pending'", [wallet.id, verdict.delegateUserId]);
    if (activated.rowCount === 1) await audit(pool, { accountId: session.accountId, walletId: wallet.id, actor: "user", action: "wallet.activated", detail: { delegateUserId: verdict.delegateUserId } });
    return { walletId: wallet.id, status: "active" };
  });
}
