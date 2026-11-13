import { useState } from "react";
import { api, ApiError, describe, type Wallet } from "../api.js";
import { stepUp } from "../stepup.js";
import { addDelegate, addPolicies, type Delegation } from "../turnkey.js";
import { createPasskey, type CreationOptions } from "../webauthn.js";

// Two passkey moments. First the passkey becomes the only owner of a new Turnkey enclave. Then the same passkey adds
// Whale's limited key and its policies; Whale checks Turnkey before it marks the wallet active.
export function EnclaveSetup({ wallet, onDone }: { wallet: Wallet; onDone: () => void }) {
  const [step, setStep] = useState<"passkey" | "delegate">(wallet.addresses.length > 0 ? "delegate" : "passkey");
  const [label, setLabel] = useState("This device");
  const [status, setStatus] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const run = async (work: () => Promise<void>) => {
    setBusy(true);
    setError(null);
    try {
      await work();
    } catch (caught) {
      setError(describe(caught));
    } finally {
      setBusy(false);
      setStatus(null);
    }
  };

  const createEnclave = () =>
    run(async () => {
      setStatus("Waiting for your passkey…");
      const options = await api<CreationOptions>(`/api/wallets/${wallet.id}/enclave/options`, { method: "POST", body: {} });
      const credential = await createPasskey(options);
      setStatus("Creating your enclave…");
      const url = `/api/wallets/${wallet.id}/enclave`;
      const body = { credential, label };
      await api(url, { method: "POST", body }).catch(async (caught: unknown) => {
        if (!(caught instanceof ApiError) || caught.status !== 428) throw caught;
        setStatus("Approve the new passkey with one you already have…");
        const assertion = await stepUp({ kind: "passkey.add", credentialId: credential.id });
        setStatus("Creating your enclave…");
        return api(url, { method: "POST", body: { ...body, assertion } });
      });
      setStep("delegate");
      onDone();
    });

  const delegate = () =>
    run(async () => {
      let delegation = await api<Delegation>(`/api/wallets/${wallet.id}/enclave/delegation`);
      if (!delegation.delegateUserId) {
        setStatus("Approve Whale's limited key with your passkey…");
        await addDelegate(delegation);
        delegation = await api<Delegation>(`/api/wallets/${wallet.id}/enclave/delegation`);
      }
      if (!delegation.policiesInPlace) {
        setStatus("Approve the signing policy with your passkey…");
        await addPolicies(delegation);
      }
      setStatus("Checking Turnkey…");
      await api(`/api/wallets/${wallet.id}/enclave/confirm`, { method: "POST", body: {} });
      onDone();
    });

  return (
    <div className="card stack">
      <h2>Finish setup</h2>
      {step === "passkey" ? (
        <>
          <p>Create a passkey on this device. It becomes the only owner of your wallet's enclave. Whale cannot recover it, so add a second passkey later. If your account already has a passkey, Whale asks for it to approve the new one before it creates the enclave.</p>
          <div className="row">
            <input value={label} maxLength={64} onChange={(event) => setLabel(event.target.value)} aria-label="Passkey name" />
            <button className="primary" disabled={busy} onClick={() => void createEnclave()}>
              Create passkey and enclave
            </button>
          </div>
        </>
      ) : (
        <>
          <p>
            Give Whale a limited key. Your passkey adds it to the enclave together with a policy: allowlisted routers on your enabled chains, a small native
            value cap, and no transfers out. Whale activates the wallet only after reading that exact setup back from Turnkey.
          </p>
          <button className="primary" disabled={busy} onClick={() => void delegate()}>
            Authorize Whale's limited key
          </button>
        </>
      )}
      {status ? <p className="muted">{status}</p> : null}
      {error ? <p className="error">{error}</p> : null}
    </div>
  );
}
