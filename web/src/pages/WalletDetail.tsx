import { useEffect, useState } from "react";
import { api, describe, type Wallet } from "../api.js";
import { stepUp } from "../stepup.js";
import { Agents } from "./Agents.js";
import { EnclaveSetup } from "./EnclaveSetup.js";
import { PolicyEditor } from "./PolicyEditor.js";

export function WalletDetail({ walletId, chains }: { walletId: string; chains: string[] }) {
  const [wallet, setWallet] = useState<Wallet | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = () =>
    api<{ wallets: Wallet[] }>("/api/wallets")
      .then((reply) => {
        const found = reply.wallets.find((entry) => entry.id === walletId);
        if (found) setWallet(found);
        else setError("This wallet does not exist or is not yours.");
      })
      .catch((caught: unknown) => setError(describe(caught)));
  useEffect(() => {
    void load();
  }, [walletId]);

  const freeze = async () => {
    setError(null);
    await api(`/api/wallets/${walletId}/freeze`, { method: "POST", body: {} }).catch((caught: unknown) => setError(describe(caught)));
    await load();
  };

  const unfreeze = async () => {
    setError(null);
    try {
      const assertion = await stepUp({ kind: "wallet.unfreeze", walletId });
      await api(`/api/wallets/${walletId}/unfreeze`, { method: "POST", body: { assertion } });
    } catch (caught) {
      setError(describe(caught));
    }
    await load();
  };

  if (!wallet) return error ? <p className="error">{error}</p> : <p className="muted">Loading…</p>;
  const settingUp = wallet.level === "enclave" && wallet.status === "pending";

  return (
    <div className="stack">
      <div className="row">
        <h1>{wallet.label}</h1>
        <span className={`badge ${wallet.status}`}>{wallet.status}</span>
        <span className="badge">{wallet.level}</span>
        <span className="badge">{wallet.live ? "live" : "dry-run"}</span>
      </div>
      {error ? <p className="error">{error}</p> : null}
      {settingUp ? <EnclaveSetup wallet={wallet} onDone={() => void load()} /> : null}
      {wallet.addresses.length > 0 ? (
        <div className="card stack">
          <h2>Deposit addresses</h2>
          {wallet.addresses.map((entry) => (
            <div key={entry.family}>
              <span className="muted">{entry.family === "evm" ? "EVM chains" : "Solana"}</span>
              <div className="mono">{entry.address}</div>
            </div>
          ))}
        </div>
      ) : null}
      <PolicyEditor wallet={wallet} chains={chains} onSaved={() => void load()} />
      <Agents wallet={wallet} />
      <div className="card row">
        {wallet.status === "frozen" ? (
          <>
            <span>Frozen: no agent can act. Unfreezing takes your passkey.</span>
            <button className="primary" onClick={() => void unfreeze()}>
              Unfreeze
            </button>
          </>
        ) : (
          <>
            <span>Freeze stops every agent on this wallet at once. No passkey needed.</span>
            <button className="danger" onClick={() => void freeze()}>
              Freeze wallet
            </button>
          </>
        )}
      </div>
    </div>
  );
}
