import { ApiError } from "./api.js";
import type { CreationOptions } from "./webauthn.js";

type Call = <T>(path: string, init?: { method?: string; body?: unknown }) => Promise<T>;
type Credential = { id: string; type: "public-key"; response: { clientDataJSON: string; attestationObject: string; transports?: string[] } };
type Assertion = { id: string; type: "public-key"; response: { clientDataJSON: string; authenticatorData: string; signature: string } };
export type BackupDeps = { api: Call; createPasskey: (options: CreationOptions) => Promise<Credential>; stepUp: (action: Record<string, unknown>) => Promise<Assertion> };

export async function addBackupPasskey(deps: BackupDeps, label: string, onStatus: (status: string) => void = () => undefined): Promise<{ challenge: string; credential: Credential }> {
  onStatus("Create the new passkey…");
  const options = await deps.api<CreationOptions>("/api/passkeys/options", { method: "POST", body: {} });
  const credential = await deps.createPasskey(options);
  const body = { credential, label };
  await deps.api("/api/passkeys", { method: "POST", body }).catch(async (caught: unknown) => {
    if (!(caught instanceof ApiError) || caught.status !== 428) throw caught;
    onStatus("Approve the new passkey with one you already have…");
    const assertion = await deps.stepUp({ kind: "passkey.add", credentialId: credential.id });
    return deps.api("/api/passkeys", { method: "POST", body: { ...body, assertion } });
  });
  return { challenge: options.challenge, credential };
}
