-- OAuth for MCP clients. See docs/adr/0003-hosted-control-plane.md.
-- A client is either registered here (id dcr_...) or identified by its metadata document URL.

CREATE TABLE oauth_clients (
  id text PRIMARY KEY CHECK (length(id) BETWEEN 8 AND 512),
  kind text NOT NULL CHECK (kind IN ('registered', 'metadata_document')),
  name text NOT NULL CHECK (length(name) BETWEEN 1 AND 128),
  redirect_uris text[] NOT NULL CHECK (cardinality(redirect_uris) BETWEEN 1 AND 5),
  created_at timestamptz NOT NULL DEFAULT now(),
  fetched_at timestamptz
);

CREATE TABLE oauth_requests (
  id text PRIMARY KEY CHECK (length(id) = 43),
  client_id text NOT NULL REFERENCES oauth_clients (id),
  redirect_uri text NOT NULL,
  code_challenge text NOT NULL CHECK (length(code_challenge) = 43),
  state text CHECK (length(state) <= 512),
  resource text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  decided_at timestamptz
);

CREATE TABLE oauth_codes (
  code_hash bytea PRIMARY KEY CHECK (length(code_hash) = 32),
  request_id text NOT NULL REFERENCES oauth_requests (id),
  client_id text NOT NULL REFERENCES oauth_clients (id),
  agent_id uuid NOT NULL REFERENCES agents (id),
  redirect_uri text NOT NULL,
  code_challenge text NOT NULL,
  resource text NOT NULL,
  expires_at timestamptz NOT NULL,
  used_at timestamptz
);

ALTER TABLE agents ADD COLUMN oauth_client_id text REFERENCES oauth_clients (id);
ALTER TABLE agent_credentials ADD COLUMN audience text;
ALTER TABLE agent_credentials ADD COLUMN rotated_at timestamptz;
ALTER TABLE agent_credentials ADD CONSTRAINT agent_credentials_oauth_audience CHECK (kind = 'api_key' OR audience IS NOT NULL);
