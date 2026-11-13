import { useEffect, useState } from "react";
import { api, describe } from "../api.js";

type Event = { id: number; walletId: string | null; agentName: string | null; actor: string; action: string; detail: Record<string, unknown>; at: string };

const LABELS: Record<string, string> = {
  "mcp.denied": "Refused",
  "mcp.swap_planned": "Swap planned",
  "mcp.transfer_planned": "Transfer planned",
  "approval.requested": "Asked for approval",
  "approval.approved": "Approved",
  "approval.denied": "Denied",
  "policy.narrowed": "Policy tightened",
  "policy.widen_requested": "Policy loosening scheduled",
  "policy.widened": "Policy loosened",
  "policy.widen_cancelled": "Loosening cancelled",
  "wallet.frozen": "Wallet frozen",
  "wallet.unfrozen": "Wallet unfrozen",
  "agent.created": "Agent created",
  "agent.connected": "Agent connected",
  "agent.revoked": "Agent revoked",
};

export function Activity() {
  const [events, setEvents] = useState<Event[]>([]);
  const [done, setDone] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const more = (before: number | null) =>
    (before ? api<{ events: Event[] }>(`/api/activity?before=${before}`) : api<{ events: Event[] }>("/api/activity"))
      .then((reply) => {
        setEvents((current) => (before ? [...current, ...reply.events] : reply.events));
        setDone(reply.events.length < 50);
      })
      .catch((caught: unknown) => setError(describe(caught)));
  useEffect(() => {
    void more(null);
  }, []);

  return (
    <div className="stack">
      <h1>Activity</h1>
      {error ? <p className="error">{error}</p> : null}
      <div className="card">
        <table>
          <tbody>
            {events.map((event) => (
              <tr key={event.id}>
                <td className="muted">{new Date(event.at).toLocaleString()}</td>
                <td>
                  <strong className={event.action === "mcp.denied" ? "error" : undefined}>{LABELS[event.action] ?? event.action}</strong>
                  {event.agentName ? <span className="muted"> · {event.agentName}</span> : null}
                  {typeof event.detail.reason === "string" ? <div className="muted">{event.detail.reason}</div> : null}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        {events.length === 0 ? <p className="muted">No activity yet.</p> : null}
      </div>
      {!done && events.length > 0 ? <button onClick={() => void more(events[events.length - 1]?.id ?? null)}>Older</button> : null}
    </div>
  );
}
