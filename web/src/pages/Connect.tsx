import { useEffect, useState } from "react";
import { api, ApiError, describe, type Limits, type Me, type Wallet } from "../api.js";
import { LimitsFields, limitsFrom } from "../components/LimitsFields.js";
import { googleStart } from "./Login.js";

type Request = { client: { name: string; id: string; redirectHost: string; localhost: boolean } };

// The MCP spec asks the server to show the client and get consent before any third-party sign-in, so this page names
// the client first and offers Google only after that.
export function Connect({ requestId }: { requestId: string }) {
  const [request, setRequest] = useState<Request | null>(null);
  const [me, setMe] = useState<Me | null | undefined>(undefined);
  const [wallets, setWallets] = useState<Wallet[]>([]);
  const [walletId, setWalletId] = useState("");
  const [name, setName] = useState("");
  const [limits, setLimits] = useState<Limits | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api<Request>(`/oauth/requests/${encodeURIComponent(requestId)}`)
      .then((reply) => {
        setRequest(reply);
        setName(reply.client.name.trim().slice(0, 64));
      })
      .catch(() => setError("This connection request expired or was already answered. Start again from your app."));
    api<Me>("/api/me")
      .then((reply) => {
        setMe(reply);
        return api<{ wallets: Wallet[] }>("/api/wallets");
      })
      .then((reply) => {
        const usable = reply.wallets.filter((wallet) => wallet.status === "active" || wallet.status === "pending");
        setWallets(usable);
        const first = usable[0];
        if (first) {
          setWalletId(first.id);
          setLimits(limitsFrom(first.policy));
        }
      })
      .catch((caught: unknown) => (caught instanceof ApiError && caught.status === 401 ? setMe(null) : setError(describe(caught))));
  }, [requestId]);

  const chosen = wallets.find((wallet) => wallet.id === walletId);
  const leave = (redirect: string) => window.location.assign(redirect);

  const approve = async () => {
    setError(null);
    try {
      const reply = await api<{ redirect: string }>(`/api/oauth/requests/${encodeURIComponent(requestId)}/approve`, { method: "POST", body: { walletId, name, limits } });
      leave(reply.redirect);
    } catch (caught) {
      setError(describe(caught));
    }
  };
  const deny = async () => {
    const reply = await api<{ redirect: string }>(`/oauth/requests/${encodeURIComponent(requestId)}/deny`, { method: "POST", body: {} }).catch(() => null);
    if (reply) leave(reply.redirect);
  };

  if (error && !request) return <p className="error">{error}</p>;
  if (!request || me === undefined) return <p className="muted">Loading…</p>;

  return (
    <div className="card stack">
      <h1>Connect {request.client.name} to Whale</h1>
      <p>
        <strong>{request.client.name}</strong> wants to act as an agent on one of your wallets, inside limits you choose. It will be sent back to{" "}
        <span className="mono">{request.client.redirectHost}</span>.
      </p>
      {request.client.localhost ? (
        <p className="notice">This app runs on your own computer. Continue only if you just started this connection from an app on this device.</p>
      ) : null}
      {me === null ? (
        <div className="row">
          <a className="button primary" href={googleStart(`/connect?request=${encodeURIComponent(requestId)}`)}>
            Continue with Google
          </a>
          <button onClick={() => void deny()}>Deny</button>
        </div>
      ) : wallets.length === 0 ? (
        <p>You have no wallet yet. Create one from the Wallets page, then start the connection again.</p>
      ) : (
        <>
          <label>
            Wallet
            <select
              value={walletId}
              onChange={(event) => {
                setWalletId(event.target.value);
                const next = wallets.find((wallet) => wallet.id === event.target.value);
                if (next) setLimits(limitsFrom(next.policy));
              }}
            >
              {wallets.map((wallet) => (
                <option key={wallet.id} value={wallet.id}>
                  {wallet.label} ({wallet.status})
                </option>
              ))}
            </select>
          </label>
          <label>
            Agent name
            <input value={name} maxLength={64} onChange={(event) => setName(event.target.value)} />
          </label>
          {chosen && limits ? <LimitsFields policy={chosen.policy} value={limits} onChange={setLimits} /> : null}
          <div className="row">
            <button className="primary" onClick={() => void approve()}>
              Allow
            </button>
            <button onClick={() => void deny()}>Deny</button>
          </div>
        </>
      )}
      {error ? <p className="error">{error}</p> : null}
    </div>
  );
}
