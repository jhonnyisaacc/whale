import { useEffect, useState } from "react";
import { api, describe, type Wallet } from "../api.js";
import { addOwnerPasskey, type Delegation } from "../turnkey.js";
import { createPasskey, type CreationOptions } from "../webauthn.js";

type Passkey = { credentialId: string; label: string; createdAt: string; lastUsedAt: string | null };
type Webhook = { id: string; url: string; format: string; events: string[]; failures: number; disabled: boolean; lastStatus: number | null; lastError: string | null };

export function Settings() {
  const [passkeys, setPasskeys] = useState<Passkey[]>([]);
  const [webhooks, setWebhooks] = useState<Webhook[]>([]);
  const [events, setEvents] = useState<string[]>([]);
  const [label, setLabel] = useState("Backup device");
  const [hook, setHook] = useState({ url: "", format: "whale", events: ["approval.requested", "wallet.frozen", "mcp.denied"] });
  const [secret, setSecret] = useState<string | null>(null);
  const [status, setStatus] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = async () => {
    try {
      setPasskeys((await api<{ passkeys: Passkey[] }>("/api/passkeys")).passkeys);
      const reply = await api<{ webhooks: Webhook[]; events: string[] }>("/api/webhooks");
      setWebhooks(reply.webhooks);
      setEvents(reply.events);
    } catch (caught) {
      setError(describe(caught));
    }
  };
  useEffect(() => {
    void load();
  }, []);

  const addPasskey = async () => {
    setError(null);
    try {
      setStatus("Create the new passkey…");
      const options = await api<CreationOptions>("/api/passkeys/options", { method: "POST", body: {} });
      const credential = await createPasskey(options);
      await api("/api/passkeys", { method: "POST", body: { credential, label } });
      const wallets = (await api<{ wallets: Wallet[] }>("/api/wallets")).wallets.filter((wallet) => wallet.level === "enclave" && wallet.addresses.length > 0);
      for (const wallet of wallets) {
        setStatus(`Approve adding it to ${wallet.label} with your current passkey…`);
        const delegation = await api<Delegation>(`/api/wallets/${wallet.id}/enclave/delegation`);
        await addOwnerPasskey(delegation, { name: label, challenge: options.challenge, credential });
      }
      setStatus(wallets.length > 0 ? "The backup passkey can now open your account and your enclaves." : "Added.");
    } catch (caught) {
      setStatus(null);
      setError(describe(caught));
    }
    await load();
  };

  const addWebhook = async () => {
    setError(null);
    try {
      const reply = await api<{ secret: string }>("/api/webhooks", { method: "POST", body: hook });
      setSecret(reply.secret);
      setHook({ ...hook, url: "" });
    } catch (caught) {
      setError(describe(caught));
    }
    await load();
  };

  return (
    <div className="stack">
      <h1>Settings</h1>
      {error ? <p className="error">{error}</p> : null}
      <div className="card stack">
        <h2>Passkeys</h2>
        <p className="muted">Whale cannot recover a lost passkey, and neither can Turnkey. Keep a second one on another device.</p>
        {passkeys.map((passkey) => (
          <div key={passkey.credentialId} className="row">
            <strong>{passkey.label}</strong>
            <span className="muted">added {new Date(passkey.createdAt).toLocaleDateString()}</span>
          </div>
        ))}
        <div className="row">
          <input value={label} maxLength={64} onChange={(event) => setLabel(event.target.value)} aria-label="Passkey name" />
          <button className="primary" onClick={() => void addPasskey()}>
            Add backup passkey
          </button>
        </div>
        {status ? <p className="muted">{status}</p> : null}
      </div>
      <div className="card stack">
        <h2>Webhooks</h2>
        <p className="muted">Whale posts signed JSON (header Whale-Signature: t=…,v1=HMAC-SHA256 of "t.body"), or a Slack-style text message.</p>
        {secret ? (
          <div className="secret stack">
            <strong>Signing secret, shown once:</strong>
            <span className="mono">{secret}</span>
            <button onClick={() => setSecret(null)}>I saved it</button>
          </div>
        ) : null}
        {webhooks.map((webhook) => (
          <div key={webhook.id} className="row">
            <span className="mono">{webhook.url}</span>
            <span className="muted">
              {webhook.format} · {webhook.disabled ? "disabled" : webhook.failures > 0 ? `${webhook.failures} failures, last ${webhook.lastStatus ?? webhook.lastError}` : "healthy"}
            </span>
            <button onClick={() => void api(`/api/webhooks/${webhook.id}/test`, { method: "POST", body: {} }).then(load, (caught: unknown) => setError(describe(caught)))}>Send test</button>
            <button className="danger" onClick={() => void api(`/api/webhooks/${webhook.id}`, { method: "DELETE" }).then(load, (caught: unknown) => setError(describe(caught)))}>
              Remove
            </button>
          </div>
        ))}
        <fieldset className="stack">
          <legend>New webhook</legend>
          <div className="row">
            <input placeholder="https://…" value={hook.url} onChange={(event) => setHook({ ...hook, url: event.target.value.trim() })} />
            <select value={hook.format} onChange={(event) => setHook({ ...hook, format: event.target.value })}>
              <option value="whale">Signed JSON</option>
              <option value="slack">Slack text</option>
            </select>
          </div>
          <div className="grid">
            {events.map((name) => (
              <label key={name} className="row">
                <input
                  type="checkbox"
                  checked={hook.events.includes(name)}
                  onChange={() => setHook({ ...hook, events: hook.events.includes(name) ? hook.events.filter((entry) => entry !== name) : [...hook.events, name] })}
                />
                {name}
              </label>
            ))}
          </div>
          <button className="primary" disabled={!hook.url || hook.events.length === 0} onClick={() => void addWebhook()}>
            Add webhook
          </button>
        </fieldset>
      </div>
    </div>
  );
}
