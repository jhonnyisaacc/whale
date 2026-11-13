-- Outbound notifications. A delivery points at the audit event it reports, so the payload is built from the
-- append-only record at send time and never drifts from it.
CREATE TABLE webhooks (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id uuid NOT NULL REFERENCES accounts (id),
  url text NOT NULL CHECK (length(url) BETWEEN 9 AND 512),
  format text NOT NULL CHECK (format IN ('whale', 'slack')),
  events text[] NOT NULL CHECK (cardinality(events) BETWEEN 1 AND 32),
  secret_sealed text NOT NULL,
  failures integer NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  disabled_at timestamptz,
  UNIQUE (id, account_id)
);
CREATE INDEX webhooks_account_idx ON webhooks (account_id);

CREATE TABLE webhook_deliveries (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  webhook_id uuid NOT NULL,
  account_id uuid NOT NULL,
  event_id bigint NOT NULL,
  attempts integer NOT NULL DEFAULT 0,
  next_attempt_at timestamptz NOT NULL,
  delivered_at timestamptz,
  gave_up_at timestamptz,
  last_status integer,
  last_error text CHECK (length(last_error) <= 300),
  FOREIGN KEY (webhook_id, account_id) REFERENCES webhooks (id, account_id) ON DELETE CASCADE
);
CREATE INDEX webhook_deliveries_due_idx ON webhook_deliveries (next_attempt_at) WHERE delivered_at IS NULL AND gave_up_at IS NULL;

ALTER TABLE passkeys ADD COLUMN turnkey_authenticator jsonb;
