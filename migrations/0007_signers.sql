CREATE TABLE signer_registrations (
  code_hash bytea PRIMARY KEY CHECK (length(code_hash) = 32),
  account_id uuid NOT NULL REFERENCES accounts (id),
  wallet_id uuid NOT NULL,
  expires_at timestamptz NOT NULL,
  used_at timestamptz,
  FOREIGN KEY (wallet_id, account_id) REFERENCES wallets (id, account_id)
);

CREATE TABLE signers (
  id text PRIMARY KEY,
  account_id uuid NOT NULL REFERENCES accounts (id),
  wallet_id uuid NOT NULL,
  token_hash bytea NOT NULL CHECK (length(token_hash) = 32),
  evm_address text NOT NULL,
  solana_address text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  last_seen_at timestamptz,
  revoked_at timestamptz,
  FOREIGN KEY (wallet_id, account_id) REFERENCES wallets (id, account_id)
);
CREATE UNIQUE INDEX signers_live_wallet_idx ON signers (wallet_id) WHERE revoked_at IS NULL;

CREATE TABLE signing_jobs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id uuid NOT NULL REFERENCES accounts (id),
  wallet_id uuid NOT NULL,
  kind text NOT NULL CHECK (kind IN ('evm', 'solana')),
  payload jsonb NOT NULL,
  status text NOT NULL DEFAULT 'queued' CHECK (status IN ('queued', 'leased', 'signed', 'refused', 'expired')),
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  lease_expires_at timestamptz,
  completed_at timestamptz,
  result jsonb,
  FOREIGN KEY (wallet_id, account_id) REFERENCES wallets (id, account_id)
);
CREATE INDEX signing_jobs_queue_idx ON signing_jobs (wallet_id, created_at) WHERE status IN ('queued', 'leased');
