import type { FastifyInstance } from "fastify";
import type pg from "pg";
import { z } from "zod";
import { audit, inTransaction } from "./accounts.js";
import type { GatewayConfig } from "./config.js";
import { perMinute, requireSession } from "./http.js";
import { addPasskey, assertionPayload, REFUSED_STATUS, registrationOptions, registrationPayload } from "./passkeys.js";
import { storedPolicySchema } from "./policy.js";
import { DELEGATE_USER_NAME, expectedPolicies, turnkeyTransports, verifyDelegation, type CreatedSubOrg, type DelegationConfig, type TurnkeyParent } from "./turnkey.js";
import type { Registration } from "./webauthn.js";

const walletParam = z.object({ id: z.uuid() });
const createBody = z.object({ credential: registrationPayload, label: z.string().trim().min(1).max(64), assertion: assertionPayload.optional() }).strict();

class EnclaveClaimed extends Error {}

type EnclaveRow = {
  id: string;
  status: string;
  level: string;
  turnkey_sub_org_id: string | null;
  turnkey_wallet_id: string | null;
  turnkey_owner_user_id: string | null;
  root_credential_id: string | null;
  document: unknown;
  solana: string | null;
};

async function enclaveWallet(pool: pg.Pool | pg.PoolClient, accountId: string, walletId: string): Promise<EnclaveRow | null> {
  const found = await pool.query<EnclaveRow>(
    `SELECT w.id, w.status, w.level, w.turnkey_sub_org_id, w.turnkey_wallet_id, w.turnkey_owner_user_id, w.root_credential_id, p.document,
       (SELECT address FROM wallet_addresses a WHERE a.wallet_id = w.id AND a.family = 'solana') AS solana
     FROM wallets w JOIN policies p ON p.wallet_id = w.id WHERE w.id = $1 AND w.account_id = $2 AND w.level = 'enclave'`,
    [walletId, accountId],
  );
  return found.rows[0] ?? null;
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
    if (wallet.turnkey_sub_org_id || wallet.root_credential_id) return reply.code(409).send({ error: "enclave_exists" });
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
    if (wallet.turnkey_sub_org_id || wallet.root_credential_id) return reply.code(409).send({ error: "enclave_exists" });
    const { credential } = body.data;
    let root: (Registration & { challenge: string }) | undefined;
    let result: Awaited<ReturnType<typeof addPasskey>>;
    try {
      result = await addPasskey(pool, config, { accountId: session.accountId, payload: credential, label: body.data.label, assertion: body.data.assertion ?? null, binding: binding(wallet.id) }, async (client, registration) => {
        const claimed = await client.query("UPDATE wallets SET root_credential_id = $2 WHERE id = $1 AND root_credential_id IS NULL AND turnkey_sub_org_id IS NULL", [wallet.id, registration.credentialId]);
        if (claimed.rowCount !== 1) throw new EnclaveClaimed();
        root = registration;
      });
    } catch (error) {
      if (error instanceof EnclaveClaimed) return reply.code(409).send({ error: "enclave_exists" });
      throw error;
    }
    if ("refused" in result) return reply.code(REFUSED_STATUS[result.refused]).send({ error: result.refused, detail: result.detail });
    if (!root) throw new Error(`passkey ${result.credentialId} registered without claiming wallet ${wallet.id}`);
    let created: CreatedSubOrg;
    try {
      created = await turnkey.createSubOrganization({
        name: `whale-${wallet.id}`,
        authenticator: {
          name: body.data.label,
          challenge: root.challenge,
          credentialId: root.credentialId,
          clientDataJson: credential.response.clientDataJSON,
          attestationObject: credential.response.attestationObject,
          transports: turnkeyTransports(credential.response.transports),
        },
      });
    } catch (error) {
      const credentialId = root.credentialId;
      await inTransaction(pool, async (client) => {
        const released = await client.query("UPDATE wallets SET root_credential_id = NULL WHERE id = $1 AND root_credential_id = $2 AND turnkey_sub_org_id IS NULL", [wallet.id, credentialId]);
        if (released.rowCount === 1) await client.query("DELETE FROM passkeys WHERE credential_id = $1 AND account_id = $2", [credentialId, session.accountId]);
      });
      throw error;
    }
    const recorded = await pool.query(
      "UPDATE wallets SET turnkey_sub_org_id = $3, turnkey_wallet_id = $4, turnkey_owner_user_id = $5 WHERE id = $1 AND root_credential_id = $2 AND turnkey_sub_org_id IS NULL",
      [wallet.id, root.credentialId, created.subOrganizationId, created.walletId, created.ownerUserId],
    );
    if (recorded.rowCount !== 1) throw new Error(`sub-organization ${created.subOrganizationId} lost its claim on wallet ${wallet.id}`);
    await inTransaction(pool, async (client) => {
      await client.query("INSERT INTO wallet_addresses (wallet_id, family, address) VALUES ($1, 'evm', $2), ($1, 'solana', $3)", [wallet.id, created.evm, created.solana]);
      await audit(client, { accountId: session.accountId, walletId: wallet.id, actor: "user", action: "wallet.enclave_created", detail: { subOrganizationId: created.subOrganizationId } });
    });
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
    return {
      subOrganizationId: wallet.turnkey_sub_org_id,
      delegateUser: { userName: DELEGATE_USER_NAME, apiKeys: [{ apiKeyName: "whale-executor", publicKey: deps.delegation.delegatePublicKey, curveType: "API_KEY_CURVE_P256" }], authenticators: [], oauthProviders: [], userTags: [] },
      delegateUserId: delegate?.userId ?? null,
      policies: delegate ? expectedPolicies({ delegateUserId: delegate.userId, walletId: wallet.turnkey_wallet_id, solanaAddress: wallet.solana, policy, config: deps.delegation }) : null,
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
