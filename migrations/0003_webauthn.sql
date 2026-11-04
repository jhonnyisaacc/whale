-- Single-use WebAuthn challenges. A step-up challenge is bound to the hash of the action it approves.
CREATE TABLE webauthn_challenges (
  challenge_hash bytea PRIMARY KEY CHECK (length(challenge_hash) = 32),
  account_id uuid NOT NULL REFERENCES accounts (id),
  purpose text NOT NULL CHECK (purpose IN ('register', 'step_up')),
  binding text NOT NULL CHECK (length(binding) <= 128),
  expires_at timestamptz NOT NULL,
  used_at timestamptz
);
CREATE INDEX webauthn_challenges_account_idx ON webauthn_challenges (account_id);
