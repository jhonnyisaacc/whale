-- Turnkey identifiers for enclave wallets. The owner user is the sub-organization's only root; the delegate user is
-- Whale's API-only user, which never joins the root quorum.
ALTER TABLE wallets ADD COLUMN turnkey_wallet_id text;
ALTER TABLE wallets ADD COLUMN turnkey_owner_user_id text;
ALTER TABLE wallets ADD COLUMN turnkey_delegate_user_id text;
ALTER TABLE wallets ADD COLUMN root_credential_id text REFERENCES passkeys (credential_id);
ALTER TABLE wallets ADD CONSTRAINT wallets_active_enclave_complete CHECK (
  level <> 'enclave' OR status <> 'active' OR (turnkey_sub_org_id IS NOT NULL AND turnkey_wallet_id IS NOT NULL AND turnkey_delegate_user_id IS NOT NULL AND root_credential_id IS NOT NULL)
);
