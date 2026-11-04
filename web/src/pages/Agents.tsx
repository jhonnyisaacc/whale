import { useEffect, useState } from "react";
import { api, describe, type Agent, type Wallet } from "../api.js";
import { LimitsFields, limitsFrom } from "../components/LimitsFields.js";

function mcpConfig(origin: string, apiKey: string): string {
  return JSON.stringify({ mcpServers: { whale: { type: "http", url: `${origin}/mcp`, headers: { Authorization: `Bearer ${apiKey}` } } } }, null, 2);
}

export function Agents({ wallet }: { wallet: Wallet }) {
  const [agents, setAgents] = useState<Agent[]>([]);
  const [name, setName] = useState("My agent");
  const [limits, setLimits] = useState(limitsFrom(wallet.policy));
  const [secret, setSecret] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = () =>
    api<{ agents: Agent[] }>(`/api/wallets/${wallet.id}/agents`)
      .then((reply) => setAgents(reply.agents))
      .catch((caught: unknown) => setError(describe(caught)));
  useEffect(() => {
    void load();
  }, [wallet.id]);

  const act = async (work: () => Promise<{ apiKey?: string } | undefined>) => {
    setError(null);
    try {
      const result = await work();
      if (result?.apiKey) setSecret(result.apiKey);
      await load();
    } catch (caught) {
      setError(describe(caught));
    }
  };

  return (
    <div className="card stack">
      <h2>Agents</h2>
      <p className="muted">
        Each agent is one connection with its own limits. Connect from Claude, Cursor, or any MCP client with the URL <span className="mono">{window.location.origin}/mcp</span>
        : clients that support sign-in open this page, and the rest use an API key.
      </p>
      {secret ? (
        <div className="secret stack">
          <strong>Copy this key now. Whale stores only its hash and cannot show it again.</strong>
          <div className="mono">{secret}</div>
          <pre className="mono">{mcpConfig(window.location.origin, secret)}</pre>
          <button onClick={() => setSecret(null)}>I saved it</button>
        </div>
      ) : null}
      <table>
        <tbody>
          {agents.map((agent) => (
            <tr key={agent.id}>
              <td>
                <strong>{agent.name}</strong>
                <div className="muted">
                  {agent.limits.chains.join(", ")} · {agent.limits.actions.join(", ")} · ${agent.limits.maxTxUsd}/tx · ${agent.limits.dailyUsd}/day
                </div>
              </td>
              <td className="muted">{agent.revoked ? "revoked" : agent.lastUsedAt ? `used ${new Date(agent.lastUsedAt).toLocaleString()}` : "never used"}</td>
              <td>
                {agent.revoked ? null : (
                  <div className="row">
                    {agent.keyPrefixes.length > 0 ? <button onClick={() => void act(() => api(`/api/agents/${agent.id}/rotate`, { method: "POST", body: {} }))}>New key</button> : null}
                    <button className="danger" onClick={() => void act(() => api(`/api/agents/${agent.id}/revoke`, { method: "POST", body: {} }))}>
                      Revoke
                    </button>
                  </div>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      <fieldset className="stack">
        <legend>New agent with an API key</legend>
        <input value={name} maxLength={64} onChange={(event) => setName(event.target.value)} aria-label="Agent name" />
        <LimitsFields policy={wallet.policy} value={limits} onChange={setLimits} />
        <button className="primary" onClick={() => void act(() => api(`/api/wallets/${wallet.id}/agents`, { method: "POST", body: { name, limits } }))}>
          Create agent
        </button>
      </fieldset>
      {error ? <p className="error">{error}</p> : null}
    </div>
  );
}
