-- Hosted tenancy. See docs/adr/0003-hosted-control-plane.md.
-- Composite foreign keys on (id, account_id) stop a row from pointing at another account's wallet or agent.

CREATE TABLE accounts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'frozen', 'closed')),
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE identities (
  provider text NOT NULL CHECK (provider IN ('google')),
  subject text NOT NULL CHECK (length(subject) BETWEEN 1 AND 255),
  account_id uuid NOT NULL REFERENCES accounts (id),
  email text,
  created_at timestamptz NOT NULL DEFAULT now(),
  last_login_at timestamptz,
  PRIMARY KEY (provider, subject)
);
CREATE INDEX identities_account_idx ON identities (account_id);

CREATE TABLE sessions (
  token_hash bytea PRIMARY KEY CHECK (length(token_hash) = 32),
  account_id uuid NOT NULL REFERENCES accounts (id),
  created_at timestamptz NOT NULL DEFAULT now(),
  last_seen_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  revoked_at timestamptz
);
CREATE INDEX sessions_account_idx ON sessions (account_id);

CREATE TABLE passkeys (
  credential_id text PRIMARY KEY,
  account_id uuid NOT NULL REFERENCES accounts (id),
  public_key bytea NOT NULL,
  sign_count bigint NOT NULL DEFAULT 0 CHECK (sign_count >= 0),
  label text NOT NULL CHECK (length(label) BETWEEN 1 AND 64),
  created_at timestamptz NOT NULL DEFAULT now(),
  last_used_at timestamptz,
  revoked_at timestamptz
);
CREATE INDEX passkeys_account_idx ON passkeys (account_id);

CREATE TABLE wallets (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id uuid NOT NULL REFERENCES accounts (id),
  label text NOT NULL CHECK (length(label) BETWEEN 1 AND 64),
  level text NOT NULL CHECK (level IN ('enclave', 'self_hosted', 'smart_account')),
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'active', 'frozen', 'archived')),
  live boolean NOT NULL DEFAULT false,
  turnkey_sub_org_id text UNIQUE,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (id, account_id),
  CHECK (level = 'enclave' OR turnkey_sub_org_id IS NULL)
);
CREATE INDEX wallets_account_idx ON wallets (account_id);

CREATE TABLE wallet_addresses (
  wallet_id uuid NOT NULL REFERENCES wallets (id),
  family text NOT NULL CHECK (family IN ('evm', 'solana')),
  address text NOT NULL,
  PRIMARY KEY (wallet_id, family),
  UNIQUE (family, address)
);

CREATE TABLE policies (
  wallet_id uuid PRIMARY KEY REFERENCES wallets (id),
  version integer NOT NULL CHECK (version >= 1),
  document jsonb NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE policy_changes (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  wallet_id uuid NOT NULL REFERENCES wallets (id),
  base_version integer NOT NULL,
  document jsonb NOT NULL,
  direction text NOT NULL CHECK (direction IN ('narrow', 'widen')),
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'applied', 'cancelled', 'superseded')),
  requested_at timestamptz NOT NULL DEFAULT now(),
  effective_at timestamptz NOT NULL,
  decided_at timestamptz
);
CREATE UNIQUE INDEX policy_changes_one_pending ON policy_changes (wallet_id) WHERE status = 'pending';

CREATE TABLE agents (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id uuid NOT NULL REFERENCES accounts (id),
  wallet_id uuid NOT NULL,
  name text NOT NULL CHECK (length(name) BETWEEN 1 AND 64),
  limits jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  last_used_at timestamptz,
  revoked_at timestamptz,
  UNIQUE (id, account_id),
  FOREIGN KEY (wallet_id, account_id) REFERENCES wallets (id, account_id)
);
CREATE INDEX agents_wallet_idx ON agents (wallet_id);

CREATE TABLE agent_credentials (
  id text PRIMARY KEY,
  agent_id uuid NOT NULL REFERENCES agents (id),
  kind text NOT NULL CHECK (kind IN ('api_key', 'oauth_access', 'oauth_refresh')),
  secret_hash bytea NOT NULL CHECK (length(secret_hash) = 32),
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz,
  last_used_at timestamptz,
  revoked_at timestamptz,
  CHECK (kind = 'api_key' OR expires_at IS NOT NULL)
);
CREATE INDEX agent_credentials_agent_idx ON agent_credentials (agent_id);

CREATE TABLE audit_events (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  account_id uuid NOT NULL REFERENCES accounts (id),
  wallet_id uuid,
  agent_id uuid,
  actor text NOT NULL CHECK (actor IN ('user', 'agent', 'system')),
  action text NOT NULL CHECK (length(action) BETWEEN 1 AND 64),
  detail jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (wallet_id, account_id) REFERENCES wallets (id, account_id),
  FOREIGN KEY (agent_id, account_id) REFERENCES agents (id, account_id)
);
CREATE INDEX audit_events_account_idx ON audit_events (account_id, created_at DESC);

-- The app role must not rewrite history. A database owner can still drop this trigger.
CREATE FUNCTION audit_events_append_only() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'audit_events is append-only';
END
$$;
CREATE TRIGGER audit_events_no_change BEFORE UPDATE OR DELETE ON audit_events
  FOR EACH ROW EXECUTE FUNCTION audit_events_append_only();
CREATE TRIGGER audit_events_no_truncate BEFORE TRUNCATE ON audit_events
  FOR EACH STATEMENT EXECUTE FUNCTION audit_events_append_only();
