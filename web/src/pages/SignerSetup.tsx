import { useState } from "react";
import { api, describe, type Wallet } from "../api.js";
import { stepUp } from "../stepup.js";

// The signer runs on the user's machine and calls Whale; Whale never calls it. The passkey approves handing out a
// one-time code, because whoever registers decides this wallet's deposit addresses.
export function SignerSetup({ wallet }: { wallet: Wallet }) {
  const [command, setCommand] = useState<string | null>(null);
  const [expiresAt, setExpiresAt] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const issue = async () => {
    setError(null);
    try {
      const assertion = await stepUp({ kind: "signer.register", walletId: wallet.id });
      const reply = await api<{ command: string; expiresAt: string }>(`/api/wallets/${wallet.id}/signer/code`, { method: "POST", body: { assertion } });
      setCommand(reply.command);
      setExpiresAt(reply.expiresAt);
    } catch (caught) {
      setError(describe(caught));
    }
  };

  return (
    <div className="card stack">
      <h2>Connect your signer</h2>
      <p>
        This wallet's keys live in <span className="mono">whale-signer</span> on your own machine, under a policy file only you can edit. Build it from the{" "}
        <span className="mono">signer/</span> folder, run <span className="mono">whale-signer init</span>, then connect it with a one-time code.
      </p>
      {command ? (
        <div className="secret stack">
          <span>Run this within ten minutes ({expiresAt ? new Date(expiresAt).toLocaleTimeString() : ""}):</span>
          <pre className="mono">{command}</pre>
          <span className="muted">Then keep it running: whale-signer serve --keystore keystore.json --gateway {window.location.origin} --policy policy.json --ledger ledger.json</span>
          <button onClick={() => window.location.reload()}>I connected it</button>
        </div>
      ) : (
        <button className="primary" onClick={() => void issue()}>
          Get a connection code
        </button>
      )}
      {error ? <p className="error">{error}</p> : null}
    </div>
  );
}
