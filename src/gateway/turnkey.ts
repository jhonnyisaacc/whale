import { z } from "zod";
import { chainByKey } from "../chains.js";
import { DEFAULT_MAX_VALUE_WEI, turnkeyPolicyDocument } from "../signing-policy/turnkey.js";
import type { WalletPolicy } from "./policy.js";

export type RootAuthenticator = { name: string; challenge: string; credentialId: string; clientDataJson: string; attestationObject: string; transports: string[] };
export type CreatedSubOrg = { subOrganizationId: string; walletId: string; ownerUserId: string; evm: string; solana: string };
export type SubOrgState = {
  threshold: number;
  rootUserIds: string[];
  users: { userId: string; userName: string; credentialIds: string[]; apiPublicKeys: string[] }[];
  policies: { policyId?: string; policyName: string; effect: string; consensus: string; condition: string }[];
};

export type SubOrgLookup = { state: "listed"; found: CreatedSubOrg[] } | { state: "truncated" };

export type CreateOutcome = { state: "completed"; created: CreatedSubOrg } | { state: "failed"; status: string } | { state: "pending" };

export type TurnkeyParent = {
  submitSubOrganization(input: { name: string; authenticator: RootAuthenticator }): Promise<{ activityId: string; outcome: CreateOutcome }>;
  subOrganizationActivity(activityId: string, polls: number): Promise<CreateOutcome>;
  findSubOrganizations(rootCredentialId: string): Promise<SubOrgLookup>;
  readSubOrganization(subOrganizationId: string): Promise<SubOrgState>;
};

export type DelegationConfig = { delegatePublicKey: string; routers: Readonly<Record<number, readonly string[]>>; maxValueWei: bigint };

export type NotSubmittedReason = "turnkey_refused" | "turnkey_unreachable";

export class TurnkeyNotSubmitted extends Error {
  constructor(
    message: string,
    readonly reason: NotSubmittedReason,
    options?: ErrorOptions,
  ) {
    super(message, options);
  }
}

const REFUSED_GRPC_CODES = new Set([3, 5, 7, 8, 9, 16]);
const UNREACHABLE_CODES = new Set(["ECONNREFUSED", "ENOTFOUND", "EAI_AGAIN", "UND_ERR_CONNECT_TIMEOUT"]);
const FAILED_ACTIVITY = new Set(["ACTIVITY_STATUS_FAILED", "ACTIVITY_STATUS_REJECTED"]);
const POLL_INTERVAL_MS = 1000;
const LOOKUP_PAGE = 100;

function connectCodes(error: Error): unknown[] {
  const cause = error.cause as { code?: unknown; errors?: { code?: unknown }[] } | undefined;
  return [cause?.code, ...(cause?.errors ?? []).map((entry) => entry.code)];
}

function asNotSubmitted(error: unknown): unknown {
  if (!(error instanceof Error)) return error;
  const code = (error as { code?: unknown }).code;
  if ((error.name === "TurnkeyRequestError" && typeof code === "number" && REFUSED_GRPC_CODES.has(code)) || /^(400|401|403|404|422|429) /.test(error.message)) return new TurnkeyNotSubmitted(error.message, "turnkey_refused", { cause: error });
  if (connectCodes(error).some((entry) => typeof entry === "string" && UNREACHABLE_CODES.has(entry))) return new TurnkeyNotSubmitted(error.message, "turnkey_unreachable", { cause: error });
  return error;
}

const activitySchema = z.object({
  id: z.string(),
  status: z.string(),
  result: z
    .object({
      createSubOrganizationResultV7: z
        .object({ subOrganizationId: z.string(), wallet: z.object({ walletId: z.string(), addresses: z.array(z.string()) }).optional(), rootUserIds: z.array(z.string()).optional() })
        .optional(),
    })
    .optional(),
});

function outcomeOf(activity: z.infer<typeof activitySchema>): CreateOutcome {
  if (FAILED_ACTIVITY.has(activity.status)) return { state: "failed", status: activity.status };
  if (activity.status !== "ACTIVITY_STATUS_COMPLETED") return { state: "pending" };
  const result = activity.result?.createSubOrganizationResultV7;
  const [evm, solana] = result?.wallet?.addresses ?? [];
  const ownerUserId = result?.rootUserIds?.[0];
  if (!result || !result.wallet || !evm || !solana || !ownerUserId) throw new Error(`turnkey activity ${activity.id} completed with an incomplete sub-organization`);
  return { state: "completed", created: { subOrganizationId: result.subOrganizationId, walletId: result.wallet.walletId, ownerUserId, evm, solana } };
}

export const DELEGATE_USER_NAME = "whale-delegate";
const TRANSPORTS: Record<string, string> = {
  internal: "AUTHENTICATOR_TRANSPORT_INTERNAL",
  hybrid: "AUTHENTICATOR_TRANSPORT_HYBRID",
  usb: "AUTHENTICATOR_TRANSPORT_USB",
  nfc: "AUTHENTICATOR_TRANSPORT_NFC",
  ble: "AUTHENTICATOR_TRANSPORT_BLE",
};

export function turnkeyTransports(transports: readonly string[] | undefined): string[] {
  return (transports ?? []).map((entry) => TRANSPORTS[entry]).filter((entry): entry is string => entry !== undefined);
}

const routersSchema = z.record(z.string().regex(/^\d+$/), z.array(z.string().regex(/^0x[0-9a-fA-F]{40}$/)).max(32));

export function delegationFromEnv(env: NodeJS.ProcessEnv): DelegationConfig | null {
  const delegatePublicKey = env.TURNKEY_DELEGATE_API_PUBLIC_KEY?.trim();
  if (!delegatePublicKey) return null;
  if (!/^0[23][0-9a-f]{64}$/i.test(delegatePublicKey)) throw new Error("TURNKEY_DELEGATE_API_PUBLIC_KEY must be a compressed P-256 public key in hex");
  const parsed = routersSchema.parse(JSON.parse(env.ROUTER_ALLOWLIST_JSON ?? "{}"));
  const routers = Object.fromEntries(Object.entries(parsed).map(([id, list]) => [Number(id), list]));
  return { delegatePublicKey: delegatePublicKey.toLowerCase(), routers, maxValueWei: BigInt(env.MAX_NATIVE_VALUE_WEI ?? DEFAULT_MAX_VALUE_WEI.toString()) };
}

// The sub-organization's Turnkey policy is the operator policy from ADR 0001, scoped to Whale's delegate user and to
// the EVM chains this wallet's policy enables. One HD wallet holds both the EVM and the Solana account.
export function expectedPolicies(input: { delegateUserId: string; walletId: string; solanaAddress: string; policy: WalletPolicy; config: DelegationConfig }): { policyName: string; effect: string; consensus: string; condition: string; notes: string }[] {
  const chainIds = input.policy.chains.map((key) => chainByKey(key)?.chain).flatMap((chain) => (chain?.kind === "evm" ? [chain.chainId] : []));
  const routers = Object.fromEntries(Object.entries(input.config.routers).filter(([id]) => chainIds.includes(Number(id))));
  return turnkeyPolicyDocument({
    userId: input.delegateUserId,
    wallets: { evm: input.walletId, solana: input.walletId, hyperliquid: null },
    solanaAddress: input.solanaAddress,
    routers,
    maxValueWei: input.config.maxValueWei,
  }) as { policyName: string; effect: string; consensus: string; condition: string; notes: string }[];
}

function normalized(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

export function allowPoliciesMatch(policies: SubOrgState["policies"], expected: { effect: string; consensus: string; condition: string }[]): boolean {
  const key = (policy: { effect: string; consensus: string; condition: string }) => `${policy.effect}|${normalized(policy.consensus)}|${normalized(policy.condition)}`;
  const wanted = expected.map(key);
  const allows = policies.filter((policy) => policy.effect === "EFFECT_ALLOW").map(key);
  return allows.length === wanted.length && wanted.every((entry) => allows.includes(entry));
}

// Whale activates a wallet only after reading Turnkey and finding: the user's passkey as the only root, Whale's key on
// a separate non-root user, and no allow policy beyond the expected ones. The browser's word is never enough.
export function verifyDelegation(
  state: SubOrgState,
  input: { ownerUserId: string; rootCredentialId: string; delegatePublicKey: string; expected: (delegateUserId: string) => { effect: string; consensus: string; condition: string }[] },
): { delegateUserId: string } | { problems: string[] } {
  const problems: string[] = [];
  if (state.threshold !== 1 || state.rootUserIds.length !== 1 || state.rootUserIds[0] !== input.ownerUserId) problems.push("the root quorum must be the owner alone");
  const owner = state.users.find((user) => user.userId === input.ownerUserId);
  if (!owner?.credentialIds.includes(input.rootCredentialId)) problems.push("the owner must hold the registered passkey");
  if (owner && owner.apiPublicKeys.length > 0) problems.push("the owner must not hold an API key");
  const delegates = state.users.filter((user) => user.apiPublicKeys.some((key) => key.toLowerCase() === input.delegatePublicKey));
  const delegate = delegates[0];
  if (delegates.length !== 1 || !delegate) return { problems: [...problems, "exactly one user must hold Whale's delegate key"] };
  if (state.rootUserIds.includes(delegate.userId)) problems.push("Whale's delegate must not be root");
  if (delegate.credentialIds.length > 0 || delegate.apiPublicKeys.length !== 1) problems.push("Whale's delegate must hold only its one API key");
  if (!allowPoliciesMatch(state.policies, input.expected(delegate.userId))) problems.push("the allow policies must be exactly the ones Whale rendered");
  return problems.length === 0 ? { delegateUserId: delegate.userId } : { problems };
}

export function turnkeyParentFromEnv(env: NodeJS.ProcessEnv): TurnkeyParent | null {
  const organizationId = env.TURNKEY_PARENT_ORGANIZATION_ID;
  const apiPublicKey = env.TURNKEY_PARENT_API_PUBLIC_KEY;
  const apiPrivateKey = env.TURNKEY_PARENT_API_PRIVATE_KEY;
  if (!organizationId || !apiPublicKey || !apiPrivateKey) return null;
  const client = async () => {
    const { Turnkey } = await import("@turnkey/sdk-server");
    return new Turnkey({ apiBaseUrl: env.TURNKEY_API_BASE ?? "https://api.turnkey.com", apiPublicKey, apiPrivateKey, defaultOrganizationId: organizationId }).apiClient();
  };
  return {
    async submitSubOrganization(input) {
      const api = await client();
      const body = {
        type: "ACTIVITY_TYPE_CREATE_SUB_ORGANIZATION_V7",
        timestampMs: String(Date.now()),
        organizationId,
        parameters: {
          subOrganizationName: input.name,
          rootQuorumThreshold: 1,
          rootUsers: [
            {
              userName: "owner",
              apiKeys: [],
              oauthProviders: [],
              authenticators: [
                {
                  authenticatorName: input.authenticator.name,
                  challenge: input.authenticator.challenge,
                  attestation: {
                    credentialId: input.authenticator.credentialId,
                    clientDataJson: input.authenticator.clientDataJson,
                    attestationObject: input.authenticator.attestationObject,
                    transports: input.authenticator.transports,
                  },
                },
              ],
            },
          ],
          wallet: {
            walletName: "whale",
            accounts: [
              { curve: "CURVE_SECP256K1", pathFormat: "PATH_FORMAT_BIP32", path: "m/44'/60'/0'/0/0", addressFormat: "ADDRESS_FORMAT_ETHEREUM" },
              { curve: "CURVE_ED25519", pathFormat: "PATH_FORMAT_BIP32", path: "m/44'/501'/0'/0'", addressFormat: "ADDRESS_FORMAT_SOLANA" },
            ],
          },
          disableEmailRecovery: true,
          disableEmailAuth: true,
          disableSmsAuth: true,
          disableOtpEmailAuth: true,
        },
      };
      const response = await api.request<typeof body, unknown>("/public/v1/submit/create_sub_organization", body).catch((error: unknown) => {
        throw asNotSubmitted(error);
      });
      const activity = activitySchema.parse((response as { activity?: unknown }).activity);
      return { activityId: activity.id, outcome: outcomeOf(activity) };
    },
    async subOrganizationActivity(activityId, polls) {
      const api = await client();
      for (let poll = 1; ; poll += 1) {
        const outcome = outcomeOf(activitySchema.parse((await api.getActivity({ activityId })).activity));
        if (outcome.state !== "pending" || poll >= polls) return outcome;
        await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
      }
    },
    async findSubOrganizations(rootCredentialId) {
      const api = await client();
      const { organizationIds } = await api.getSubOrgIds({ filterType: "CREDENTIAL_ID", filterValue: rootCredentialId, paginationOptions: { limit: String(LOOKUP_PAGE) } });
      if (organizationIds.length >= LOOKUP_PAGE) return { state: "truncated" };
      const found = await Promise.all(
        organizationIds.map(async (subOrganizationId): Promise<CreatedSubOrg | null> => {
          const [{ wallets }, { configs }, { users }] = await Promise.all([
            api.getWallets({ organizationId: subOrganizationId }),
            api.getOrganizationConfigs({ organizationId: subOrganizationId }),
            api.getUsers({ organizationId: subOrganizationId }),
          ]);
          const ownerUserId = configs.quorum?.userIds?.[0];
          const owner = users.find((user) => user.userId === ownerUserId);
          if (!ownerUserId || !owner?.authenticators.some((entry) => entry.credentialId === rootCredentialId)) return null;
          const wallet = wallets.find((entry) => entry.walletName === "whale");
          const { accounts } = wallet ? await api.getWalletAccounts({ organizationId: subOrganizationId, walletId: wallet.walletId }) : { accounts: [] };
          const evm = accounts.find((entry) => entry.addressFormat === "ADDRESS_FORMAT_ETHEREUM")?.address;
          const solana = accounts.find((entry) => entry.addressFormat === "ADDRESS_FORMAT_SOLANA")?.address;
          if (!wallet || !evm || !solana) throw new Error(`turnkey sub-organization ${subOrganizationId} rooted in the claimed passkey is incomplete`);
          return { subOrganizationId, walletId: wallet.walletId, ownerUserId, evm, solana };
        }),
      );
      return { state: "listed", found: found.filter((entry): entry is CreatedSubOrg => entry !== null) };
    },
    async readSubOrganization(subOrganizationId) {
      const api = await client();
      const [configs, users, policies] = await Promise.all([
        api.getOrganizationConfigs({ organizationId: subOrganizationId }),
        api.getUsers({ organizationId: subOrganizationId }),
        api.getPolicies({ organizationId: subOrganizationId }),
      ]);
      return {
        threshold: configs.configs.quorum?.threshold ?? 0,
        rootUserIds: configs.configs.quorum?.userIds ?? [],
        users: users.users.map((user) => ({
          userId: user.userId,
          userName: user.userName,
          credentialIds: user.authenticators.map((entry) => entry.credentialId),
          apiPublicKeys: user.apiKeys.map((entry) => entry.credential.publicKey),
        })),
        policies: policies.policies.map((policy) => ({ policyId: policy.policyId, policyName: policy.policyName, effect: policy.effect, consensus: policy.consensus, condition: policy.condition })),
      };
    },
  };
}
