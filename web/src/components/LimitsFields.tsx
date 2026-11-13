import type { Limits, Policy } from "../api.js";

// An agent's limits can only pick from what the wallet policy already allows, so the form offers nothing wider.
export function LimitsFields({ policy, value, onChange }: { policy: Policy; value: Limits; onChange: (next: Limits) => void }) {
  const toggle = <T extends string>(list: T[], item: T): T[] => (list.includes(item) ? list.filter((entry) => entry !== item) : [...list, item]);
  return (
    <div className="stack">
      <fieldset>
        <legend>Chains</legend>
        <div className="row">
          {policy.chains.map((chain) => (
            <label key={chain} className="row">
              <input type="checkbox" checked={value.chains.includes(chain)} onChange={() => onChange({ ...value, chains: toggle(value.chains, chain) })} /> {chain}
            </label>
          ))}
        </div>
      </fieldset>
      <fieldset>
        <legend>Actions</legend>
        <div className="row">
          {policy.actions.map((action) => (
            <label key={action} className="row">
              <input type="checkbox" checked={value.actions.includes(action)} onChange={() => onChange({ ...value, actions: toggle(value.actions, action) })} /> {action}
            </label>
          ))}
        </div>
      </fieldset>
      <div className="grid">
        <label>
          Per transaction, USD (max {policy.maxTxUsd})
          <input type="number" min={1} max={policy.maxTxUsd} value={value.maxTxUsd} onChange={(event) => onChange({ ...value, maxTxUsd: Number(event.target.value) })} />
        </label>
        <label>
          Per day, USD (max {policy.dailyUsd})
          <input type="number" min={1} max={policy.dailyUsd} value={value.dailyUsd} onChange={(event) => onChange({ ...value, dailyUsd: Number(event.target.value) })} />
        </label>
      </div>
    </div>
  );
}

export function limitsFrom(policy: Policy): Limits {
  return { chains: [...policy.chains], actions: [...policy.actions], maxTxUsd: policy.maxTxUsd, dailyUsd: policy.dailyUsd };
}
