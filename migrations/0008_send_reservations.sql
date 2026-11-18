ALTER TABLE agent_spends
  ADD COLUMN state text NOT NULL DEFAULT 'committed' CHECK (state IN ('reserved', 'committed', 'released')),
  ADD COLUMN reserved_at timestamptz NOT NULL DEFAULT now();
CREATE INDEX agent_spends_reserved_idx ON agent_spends (reserved_at) WHERE state = 'reserved';

ALTER TABLE approvals DROP CONSTRAINT approvals_status_check;
ALTER TABLE approvals
  ADD CONSTRAINT approvals_status_check CHECK (status IN ('pending', 'approved', 'claimed', 'denied', 'used', 'expired')),
  ADD COLUMN claimed_at timestamptz;
CREATE INDEX approvals_claimed_idx ON approvals (claimed_at) WHERE status = 'claimed';
