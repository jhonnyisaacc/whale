import { fromBase64url, toBase64url } from "./webauthn.js";

const TURNKEY_API = "https://api.turnkey.com";

// Turnkey authenticates a browser request by a passkey assertion over the request body: the challenge is the UTF-8
// of the hex SHA-256 of the exact body, and the stamp travels in X-Stamp-WebAuthn. This mirrors @turnkey/webauthn-stamper
// so the dashboard needs no Turnkey package. The user's passkey signs; Whale never sees a Turnkey credential here.
async function stamp(body: string, credentialId: string): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(body)));
  const hex = Array.from(digest, (byte) => byte.toString(16).padStart(2, "0")).join("");
  const credential = (await navigator.credentials.get({
    publicKey: {
      challenge: new TextEncoder().encode(hex),
      rpId: window.location.hostname,
      allowCredentials: [{ type: "public-key", id: fromBase64url(credentialId) }],
      userVerification: "required",
      timeout: 300_000,
    },
  })) as PublicKeyCredential | null;
  if (!credential) throw new Error("No passkey answered.");
  const response = credential.response as AuthenticatorAssertionResponse;
  return JSON.stringify({
    authenticatorData: toBase64url(response.authenticatorData),
    clientDataJson: toBase64url(response.clientDataJSON),
    credentialId: toBase64url(credential.rawId),
    signature: toBase64url(response.signature),
  });
}

async function submit(path: string, type: string, organizationId: string, parameters: unknown, credentialId: string): Promise<unknown> {
  const body = JSON.stringify({ type, timestampMs: String(Date.now()), organizationId, parameters });
  const response = await fetch(`${TURNKEY_API}${path}`, { method: "POST", headers: { "content-type": "application/json", "X-Stamp-WebAuthn": await stamp(body, credentialId) }, body });
  const text = await response.text();
  if (!response.ok) throw new Error(`Turnkey refused ${type}: ${text.slice(0, 300)}`);
  const parsed = JSON.parse(text) as { activity?: { status?: string } };
  if (parsed.activity?.status && parsed.activity.status !== "ACTIVITY_STATUS_COMPLETED") throw new Error(`Turnkey left ${type} as ${parsed.activity.status}`);
  return parsed;
}

export type Delegation = {
  subOrganizationId: string;
  rootCredentialId: string;
  delegateUser: unknown;
  delegateUserId: string | null;
  policies: unknown[] | null;
};

export function addDelegate(delegation: Delegation): Promise<unknown> {
  return submit("/public/v1/submit/create_users", "ACTIVITY_TYPE_CREATE_USERS_V3", delegation.subOrganizationId, { users: [delegation.delegateUser] }, delegation.rootCredentialId);
}

export function addPolicies(delegation: Delegation): Promise<unknown> {
  return submit("/public/v1/submit/create_policies", "ACTIVITY_TYPE_CREATE_POLICIES", delegation.subOrganizationId, { policies: delegation.policies ?? [] }, delegation.rootCredentialId);
}
