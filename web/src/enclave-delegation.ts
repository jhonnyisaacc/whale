import type { Delegation } from "./turnkey.js";

type Call = <T>(path: string, init?: { method?: string; body?: unknown }) => Promise<T>;
type Submit = (delegation: Delegation) => Promise<unknown>;
export type DelegationDeps = { api: Call; addDelegate: Submit; deletePolicies: Submit; addPolicies: Submit; addOwnerPasskeys: Submit };

export async function authorizeDelegate(deps: DelegationDeps, walletId: string, onStatus: (status: string) => void = () => undefined): Promise<void> {
  let delegation = await deps.api<Delegation>(`/api/wallets/${walletId}/enclave/delegation`);
  if (!delegation.delegateUserId) {
    onStatus("Approve Whale's limited key with your passkey…");
    await deps.addDelegate(delegation);
    delegation = await deps.api<Delegation>(`/api/wallets/${walletId}/enclave/delegation`);
  }
  if (!delegation.policiesInPlace) {
    if (delegation.stalePolicyIds.length > 0) {
      onStatus("Approve removing the outdated signing policy with your passkey…");
      await deps.deletePolicies(delegation);
    }
    onStatus("Approve the signing policy with your passkey…");
    await deps.addPolicies(delegation);
  }
  onStatus("Checking Turnkey…");
  await deps.api(`/api/wallets/${walletId}/enclave/confirm`, { method: "POST", body: {} });
  if (delegation.missingAuthenticators.length > 0) {
    onStatus("Approve adding your backup passkeys to this enclave…");
    await deps.addOwnerPasskeys(delegation).catch(() => undefined);
  }
}
