CREATE TABLE approvals (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id uuid NOT NULL REFERENCES accounts (id),
  wallet_id uuid NOT NULL,
  agent_id uuid NOT NULL,
  kind text NOT NULL CHECK (kind IN ('swap', 'transfer')),
  idempotency_key text NOT NULL,
  command jsonb NOT NULL,
  estimate_usd double precision,
  reason text NOT NULL,
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'denied', 'used', 'expired')),
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  decided_at timestamptz,
  FOREIGN KEY (wallet_id, account_id) REFERENCES wallets (id, account_id),
  FOREIGN KEY (agent_id, account_id) REFERENCES agents (id, account_id),
  UNIQUE (agent_id, idempotency_key)
);
CREATE INDEX approvals_pending_idx ON approvals (account_id, status, created_at DESC);
CREATE TABLE agent_spends (
  agent_id uuid NOT NULL,
  idempotency_key text NOT NULL,
  binding text NOT NULL,
  account_id uuid NOT NULL,
  wallet_id uuid NOT NULL,
  usd double precision NOT NULL CHECK (usd >= 0),
  day date NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (agent_id, idempotency_key),
  FOREIGN KEY (wallet_id, account_id) REFERENCES wallets (id, account_id),
  FOREIGN KEY (agent_id, account_id) REFERENCES agents (id, account_id)
);
CREATE INDEX agent_spends_wallet_day_idx ON agent_spends (wallet_id, day);
