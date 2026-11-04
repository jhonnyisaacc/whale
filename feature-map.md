# Feature map

Each row names a feature and the check that proves it. Add a row when a feature moves.

| Feature | Check |
| --- | --- |
| Quote, swap, bridge, balance, and transfer share one command union | `pnpm test`. `test/commands.test.ts` covers the dispatcher. |
| A dry-run swap does not broadcast, and a quote with no provider skips | `pnpm test`. The command and executor tests cover it. |
| Bridge ranking refuses an empty allowlist and does not broadcast | `pnpm test`. The command and controls tests cover it. |
| Live send is screened, simulated, reserved, and policy checked | `pnpm test`. The send-path and security-review tests cover it. |
| Withdraw needs the admin token, the allowlist, and the per-call cap | `pnpm test`. The custody and controls tests cover it. |
| Installs wait a week, keep publisher trust, run no dependency scripts, and pin every version and action | `pnpm test`. `test/supply-chain.test.ts` covers it. |
| No file grows past the agent budget | `node scripts/check-file-size.mjs` |
| Layers keep their import rules | `node scripts/check-boundaries.mjs` |
| Migrations apply once under a lock, refuse a changed file, and the tenant schema refuses cross-account links | `pnpm test` with `TEST_DATABASE_URL`. `test/migrate.test.ts` and `test/tenancy-pg.test.ts` cover it. CI runs Postgres. |
| Google sign-in verifies the ID token, keys the account by subject, and opens a hashed, expiring session; cross-origin posts get 403 | `pnpm test`. `test/gateway-auth.test.ts`, and `test/gateway-pg.test.ts` with `TEST_DATABASE_URL`. `pnpm run smoke` boots the gateway. |
| A wallet starts pending with a default policy. An agent's limits sit inside it. API keys are shown once, stored as hashes, rotate, revoke, and stop when the wallet or account freezes. One account cannot reach another's rows | `pnpm test`. `test/gateway-policy.test.ts`, and `test/gateway-wallets-pg.test.ts` with `TEST_DATABASE_URL`. |
| MCP over HTTP authenticates an agent key, refuses foreign origins and unknown versions, keeps every tool inside the agent's limits and the wallet policy, and reaches the executor only through a dry-run route with its own token | `pnpm test`. `test/hosted-commands.test.ts`, and `test/gateway-mcp-pg.test.ts` with `TEST_DATABASE_URL`. |
| MCP clients connect by OAuth: discovery metadata, client registration or a metadata document fetched only from public addresses, PKCE S256, resource-bound tokens, single-use codes, rotating refresh tokens, and family revocation on replay | `pnpm test`. `test/gateway-oauth.test.ts`, and `test/gateway-oauth-pg.test.ts` with `TEST_DATABASE_URL`. |
| Passkeys register and assert with ES256 only, check origin, relying party, user verification, and counters, and a step-up approves exactly one action once | `pnpm test`. `test/webauthn.test.ts`, and `test/gateway-passkeys-pg.test.ts` with `TEST_DATABASE_URL`. |
| An enclave wallet's Turnkey sub-organization has the user's passkey as its only root, and the wallet activates only after Whale reads Turnkey and finds its delegate non-root with exactly the rendered policies | `pnpm test`. `test/gateway-enclave-pg.test.ts` (the Postgres part needs `TEST_DATABASE_URL`). |
| Narrowing a policy applies at once; widening needs a passkey bound to the exact document, waits 24 hours, can be cancelled, and never lands on a newer version. Freezing stops every agent; unfreezing needs a passkey | `pnpm test`. `test/gateway-policy-pg.test.ts` with `TEST_DATABASE_URL`. |
| The dashboard builds from pinned packages, is served under a strict CSP with hashed assets, and never falls back to HTML for a server route | `pnpm run check` builds `web/`. `test/gateway-static.test.ts` and `test/supply-chain.test.ts` cover serving and the workspace pins. |
| A hosted swap above the agent's cap is refused; above the approval threshold, or unpriced, it waits for a passkey approval of that exact command, spent once; a transfer out asks whenever a threshold is set; activity lists refusals too | `pnpm test`. `test/gateway-mcp-pg.test.ts` with `TEST_DATABASE_URL`. |
| Webhooks go only to public https URLs, receive only their account's chosen events, carry an HMAC signature over the timestamp and body, retry on a backoff, and give up after six tries | `pnpm test`. `test/gateway-webhooks-pg.test.ts` with `TEST_DATABASE_URL`. |
| Network costs rank chains by a live swap and transfer estimate, fall back to the static ceiling when a read fails, and cache for 30 s; an x402 challenge becomes a plan inside the agent's limits and pays nothing | `pnpm test`. `test/network-costs.test.ts`. |
| The self-hosted Rust signer refuses anything outside its local policy, checks 0x and Kyber swap recipients and daily totals, and signs bytes identical to viem and node:crypto | `cargo test --locked` in `signer/`, run by the `signer` CI job. `test/signer-vectors.test.ts` keeps the app decoder in step. |
| A self-hosted signer registers only with a passkey-issued one-time code and signatures from both keys, then leases jobs over an outbound long-poll; leases expire, frozen wallets get no work, revoked signers are refused | `pnpm test`. `test/gateway-signers-pg.test.ts` with `TEST_DATABASE_URL`, and `cargo test` in `signer/` for `personal_sign`. |
| The hosted client and the stdio bridge reach the gateway's tools with an agent key, under the same limits as any MCP client | `pnpm test`. `test/hosted-client-pg.test.ts` with `TEST_DATABASE_URL`. |
