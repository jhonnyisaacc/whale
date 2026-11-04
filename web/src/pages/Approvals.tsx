import { useEffect, useState } from "react";
import { api, describe } from "../api.js";
import { stepUp } from "../stepup.js";

type Approval = {
  id: string;
  walletId: string;
  agentName: string;
  kind: "swap" | "transfer";
  command: Record<string, unknown>;
  estimateUsd: number | null;
  reason: string;
  status: string;
  createdAt: string;
  expiresAt: string;
};

function summary(approval: Approval): string {
  const command = approval.command;
  if (approval.kind === "transfer") return `Send ${String(command.amount)} of ${String(command.token)} on ${String(command.chainKey)} to ${String(command.to)}`;
  return `Swap ${String(command.sellAmount)} of ${String(command.sellToken)} for ${String(command.buyToken)} on ${String(command.chainKey)}`;
}

export function Approvals() {
  const [approvals, setApprovals] = useState<Approval[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = () =>
    api<{ approvals: Approval[] }>("/api/approvals?status=pending")
      .then((reply) => setApprovals(reply.approvals.filter((entry) => entry.status === "pending")))
      .catch((caught: unknown) => setError(describe(caught)));
  useEffect(() => {
    void load();
  }, []);

  // The passkey signs this approval id together with the exact command the agent asked for.
  const approve = async (approval: Approval) => {
    setError(null);
    try {
      const assertion = await stepUp({ kind: "approval.approve", approvalId: approval.id, command: approval.command });
      await api(`/api/approvals/${approval.id}/approve`, { method: "POST", body: { assertion } });
    } catch (caught) {
      setError(describe(caught));
    }
    await load();
  };
  const deny = async (approval: Approval) => {
    await api(`/api/approvals/${approval.id}/deny`, { method: "POST", body: {} }).catch((caught: unknown) => setError(describe(caught)));
    await load();
  };

  return (
    <div className="stack">
      <h1>Approvals</h1>
      {error ? <p className="error">{error}</p> : null}
      {approvals === null ? <p className="muted">Loading…</p> : null}
      {approvals?.length === 0 ? <p className="muted">Nothing is waiting for you.</p> : null}
      {approvals?.map((approval) => (
        <div key={approval.id} className="card stack">
          <strong>{approval.agentName}</strong>
          <span className="mono">{summary(approval)}</span>
          <span className="muted">
            {approval.reason}
            {approval.estimateUsd !== null ? ` · about ${approval.estimateUsd.toFixed(2)} USD` : ""} · expires {new Date(approval.expiresAt).toLocaleTimeString()}
          </span>
          <div className="row">
            <button className="primary" onClick={() => void approve(approval)}>
              Approve with passkey
            </button>
            <button className="danger" onClick={() => void deny(approval)}>
              Deny
            </button>
          </div>
        </div>
      ))}
    </div>
  );
}
