import { useEffect, useState } from "react";
import { api, ApiError, describe, type Policy, type Wallet } from "../api.js";
import { stepUp } from "../stepup.js";

type Pending = { id: string; document: Policy; requestedAt: string; effectiveAt: string } | null;

export function PolicyEditor({ wallet, chains, onSaved }: { wallet: Wallet; chains: string[]; onSaved: () => void }) {
  const [draft, setDraft] = useState<Policy>(wallet.policy);
  const [pending, setPending] = useState<Pending>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [destination, setDestination] = useState({ family: "evm" as "evm" | "solana", address: "", label: "" });

  const loadPending = () =>
    api<{ pending: Pending }>(`/api/wallets/${wallet.id}/policy/pending`)
      .then((reply) => setPending(reply.pending))
      .catch((caught: unknown) => setError(describe(caught)));
  useEffect(() => {
    setDraft(wallet.policy);
    void loadPending();
  }, [wallet.id, wallet.policyVersion]);

  const toggle = <T extends string>(list: T[], item: T): T[] => (list.includes(item) ? list.filter((entry) => entry !== item) : [...list, item]);

  // Narrowing saves at once. A widening comes back 428, and the same document is then approved with the passkey.
  const save = async () => {
    setBusy(true);
    setError(null);
    setMessage(null);
    const body = { baseVersion: wallet.policyVersion, document: draft };
    try {
      const result = await api<{ status: string; effectiveAt?: string }>(`/api/wallets/${wallet.id}/policy`, { method: "PUT", body }).catch(async (caught: unknown) => {
        if (!(caught instanceof ApiError) || caught.status !== 428) throw caught;
        const assertion = await stepUp({ kind: "policy.widen", walletId: wallet.id, baseVersion: wallet.policyVersion, document: draft });
        return api<{ status: string; effectiveAt?: string }>(`/api/wallets/${wallet.id}/policy`, { method: "PUT", body: { ...body, assertion } });
      });
      if (result.status === "scheduled") setMessage(`This loosens the wallet, so it applies at ${new Date(result.effectiveAt ?? "").toLocaleString()}. You can cancel it until then.`);
      else if (result.status === "applied") setMessage("Saved. Tighter limits apply now.");
      else setMessage("Nothing changed.");
      onSaved();
      await loadPending();
    } catch (caught) {
      setError(describe(caught));
    } finally {
      setBusy(false);
    }
  };

  const cancel = async () => {
    await api(`/api/wallets/${wallet.id}/policy/pending`, { method: "DELETE" }).catch((caught: unknown) => setError(describe(caught)));
    await loadPending();
  };

  const number = (key: "maxTxUsd" | "dailyUsd" | "maxSlippageBps") => (
    <input type="number" min={1} value={draft[key]} onChange={(event) => setDraft({ ...draft, [key]: Number(event.target.value) })} />
  );

  return (
    <div className="card stack">
      <h2>Policy · version {wallet.policyVersion}</h2>
      {pending ? (
        <div className="notice row">
          <span>A loosening waits until {new Date(pending.effectiveAt).toLocaleString()}.</span>
          <button onClick={() => void cancel()}>Cancel it</button>
        </div>
      ) : null}
      <fieldset>
        <legend>Chains</legend>
        <div className="row">
          {chains.map((chain) => (
            <label key={chain} className="row">
              <input type="checkbox" checked={draft.chains.includes(chain)} onChange={() => setDraft({ ...draft, chains: toggle(draft.chains, chain) })} /> {chain}
            </label>
          ))}
        </div>
      </fieldset>
      <fieldset>
        <legend>Actions</legend>
        <div className="row">
          {(["swap", "transfer", "bridge"] as const).map((action) => (
            <label key={action} className="row">
              <input type="checkbox" checked={draft.actions.includes(action)} onChange={() => setDraft({ ...draft, actions: toggle(draft.actions, action) })} /> {action}
            </label>
          ))}
        </div>
      </fieldset>
      <div className="grid">
        <label>Per transaction, USD{number("maxTxUsd")}</label>
        <label>Per day, USD{number("dailyUsd")}</label>
        <label>Max slippage, bps{number("maxSlippageBps")}</label>
        <label>
          Ask me above, USD (empty: never)
          <input type="number" min={1} value={draft.approvalAboveUsd ?? ""} onChange={(event) => setDraft({ ...draft, approvalAboveUsd: event.target.value === "" ? null : Number(event.target.value) })} />
        </label>
      </div>
      <fieldset className="stack">
        <legend>Transfer destinations</legend>
        {draft.destinations.map((entry) => (
          <div key={`${entry.family}:${entry.address}`} className="row">
            <span className="mono">{entry.address}</span> <span className="muted">{entry.label}</span>
            <button onClick={() => setDraft({ ...draft, destinations: draft.destinations.filter((item) => item !== entry) })}>Remove</button>
          </div>
        ))}
        <div className="row">
          <select value={destination.family} onChange={(event) => setDestination({ ...destination, family: event.target.value as "evm" | "solana" })}>
            <option value="evm">EVM</option>
            <option value="solana">Solana</option>
          </select>
          <input placeholder="Address" value={destination.address} onChange={(event) => setDestination({ ...destination, address: event.target.value.trim() })} />
          <input placeholder="Label" value={destination.label} maxLength={64} onChange={(event) => setDestination({ ...destination, label: event.target.value })} />
          <button
            disabled={!destination.address || !destination.label}
            onClick={() => {
              setDraft({ ...draft, destinations: [...draft.destinations, destination] });
              setDestination({ ...destination, address: "", label: "" });
            }}
          >
            Add
          </button>
        </div>
      </fieldset>
      <div className="row">
        <button className="primary" disabled={busy} onClick={() => void save()}>
          Save policy
        </button>
        <span className="muted">Tightening applies now. Loosening needs your passkey and waits 24 hours.</span>
      </div>
      {message ? <p>{message}</p> : null}
      {error ? <p className="error">{error}</p> : null}
    </div>
  );
}
