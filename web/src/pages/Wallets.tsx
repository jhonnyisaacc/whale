import { useEffect, useState } from "react";
import { api, describe, type Wallet } from "../api.js";
import { Link, navigate } from "../router.js";

export function Wallets() {
  const [wallets, setWallets] = useState<Wallet[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [label, setLabel] = useState("Main wallet");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    api<{ wallets: Wallet[] }>("/api/wallets")
      .then((reply) => setWallets(reply.wallets))
      .catch((caught: unknown) => setError(describe(caught)));
  }, []);

  const create = async (level: "enclave" | "self_hosted") => {
    setBusy(true);
    setError(null);
    try {
      const wallet = await api<Wallet>("/api/wallets", { method: "POST", body: { label, level } });
      navigate(`/wallets/${wallet.id}`);
    } catch (caught) {
      setError(describe(caught));
      setBusy(false);
    }
  };

  return (
    <div className="stack">
      <h1>Wallets</h1>
      {error ? <p className="error">{error}</p> : null}
      {wallets === null && !error ? <p className="muted">Loading…</p> : null}
      {wallets?.length === 0 ? <p className="muted">No wallet yet. Create one below.</p> : null}
      {wallets?.map((wallet) => (
        <Link key={wallet.id} to={`/wallets/${wallet.id}`} className="card row link">
          <span>
            <strong>{wallet.label}</strong> <span className="muted">· {wallet.level}</span>
          </span>
          <span className={`badge ${wallet.status}`}>{wallet.status}</span>
        </Link>
      ))}
      <div className="card stack">
        <h2>New wallet</h2>
        <p className="muted">
          <strong>Enclave:</strong> the key lives in Turnkey's secure enclave and only your passkey owns it. Whale gets a limited key that signs what the enclave
          policy allows, one transaction at a time. Daily caps hold only while Whale is intact.
        </p>
        <p className="muted">
          <strong>Self-hosted:</strong> the key and the policy live in whale-signer on your machine. Whale can only ask; your signer checks every transaction and
          keeps its own daily totals, so even a full Whale compromise cannot spend outside your file.
        </p>
        <p className="muted">
          <strong>Smart account:</strong> rules enforced on-chain. Not available yet.
        </p>
        <div className="row">
          <input value={label} maxLength={64} onChange={(event) => setLabel(event.target.value)} aria-label="Wallet name" />
          <button className="primary" disabled={busy || label.trim().length === 0} onClick={() => void create("enclave")}>
            Create enclave wallet
          </button>
          <button disabled={busy || label.trim().length === 0} onClick={() => void create("self_hosted")}>
            Create self-hosted wallet
          </button>
        </div>
      </div>
    </div>
  );
}
