# Adversarial security review — 2026-11-14

## Working context

- Project: Whale, multichain wallet for AI agents.
- Baseline: `main` at `bdb0372` (`test(signer): refuse any signer crate that does not resolve from crates.io (#66)`).
- Branch: `security/adversarial-audit-2026-11-13`.
- Scope: gateway authentication and tenancy, OAuth/WebAuthn, agent credentials, transaction construction, quote-to-signature binding, spend limits, EVM/Solana policy checks, the Rust self-hosted signer, outbound HTTP, logging, database races, deployment and supply-chain controls.
- Method: static adversarial review by three independent review tracks plus direct review, targeted local regression probes, full unit/integration suites, and dependency advisory checks. No seed phrases or private keys were requested or printed. No live transaction, live wallet, or production endpoint was touched.

## Executive summary

Sixteen confirmed findings are fixed in this branch: seven high, seven medium, and two low severity. The highest-impact theme was a mismatch between what a policy authorized and what a provider, RPC, or crafted transaction could make the signer sign. Other themes were Solana Base58 identity confusion, fee accounting, unsafe opaque calldata, credential disclosure, and races.

The fixes favor explicit, early rejection over silent loss of funds. Two capabilities are intentionally closed until they can be verified:

- live OP Stack transactions (Optimism, Base, and Blast), because L1 data fees cannot be bounded from the transaction alone;
- opaque LI.FI and direct Settler calldata, because recipient fields alone do not prove input, actions, or output.

Quotes and dry-runs remain available. Normal `AllowanceHolder.exec`, Kyber, and Jupiter transactions with fully matching terms remain supported. These operational changes are intentional and must be reviewed before deployment.

### Severity and status

| ID | Severity | Finding | Status |
| --- | --- | --- | --- |
| W-01 | High | Solana token-list substitution without passkey | Fixed |
| W-02 | High | Jupiter `/swap` could change input, mints, or minimum after the quote | Fixed |
| W-03 | High | Kyber/native EVM builds were not bound to the authorized input | Fixed |
| W-04 | High | Direct Settler calls could hide token spend and prior-allowance use | Fixed |
| W-05 | High | OP Stack L1 data fees bypassed local native limits | Fixed by closing live OP Stack signing |
| W-06 | High | LI.FI live opt-in accepted opaque recipient/calldata | Fixed by closing LI.FI live signing |
| W-07 | High | Solana screening cache let a lookalike mint inherit `allow` | Fixed |
| W-08 | Medium | `chainKey` and `chain` could authorize one chain and sign on another | Fixed |
| W-09 | Medium | x402 could price a case-variant Solana mint as USDC/USDT | Fixed |
| W-10 | Medium | Solana recovery allowlist ignored Base58 case | Fixed |
| W-11 | Medium | EVM execution fees had no total cap | Fixed |
| W-12 | Medium | Signer gateway URL userinfo bypassed the loopback-only HTTP rule | Fixed |
| W-13 | Medium | Error stacks could disclose RPC credentials in logs | Fixed |
| W-14 | Medium | Other Solana caches and price/balance views merged distinct mints | Fixed |
| W-15 | Low | Existing signer token files retained broad permissions | Fixed |
| W-16 | Low | OAuth cleanup could delete a client during authorization | Fixed |

## Fixed findings

### W-01 — Solana token-list substitution without passkey

**Problem.** `changeDirection` lowercased every token address when deciding whether a policy edit was a widening. Solana Base58 addresses are case-sensitive. Replacing a mint with a different mint that differed only by case was classified as a narrowing and applied immediately without the required passkey assertion and 24-hour delay.

**Detection.** Compared `changeDirection` in `src/gateway/policy.ts` with the case-sensitive enforcement in `src/gateway/mcp-tools.ts`. A unit probe returned `narrow` for two distinct Solana mints.

**Exploit and preconditions.** An attacker with a dashboard session, but no passkey, could replace an allowed mint with a case-variant lookalike and then use an agent within the remaining policy. The destination and chain checks did not restore the lost asset identity.

**Solution.** All token identity comparisons now use the existing chain-aware `addressKey`: EVM hex is case-insensitive; Solana and unknown-chain addresses remain exact. The same helper is used at policy evaluation and enforcement boundaries.

**Regression.** `test/gateway-policy.test.ts` requires a case-only Solana substitution to be `widen`, while an EVM case-only representation remains `same`.

### W-02 — Jupiter `/swap` could change input, mints, or minimum after the quote

**Problem.** `prepareSolanaLeg` validated `otherAmountThreshold` in the quote JSON and then deserialized any returned `swapTransaction`. It checked destinations and fees but did not bind instruction input, mints, quoted output, or slippage to the leg.

**Detection.** End-to-end local probes reached `signSolana` with route arguments inconsistent with the quote. The affected code was `src/broadcast/solana.ts` and the account-only checks in `src/signing-policy.ts`.

**Exploit and preconditions.** A compromised Jupiter endpoint could return a transaction with a larger input or a near-zero effective minimum while retaining valid destination accounts. Simulation that only checks non-reversion does not prove economic terms, and spend was reserved against the original intent.

**Solution.** Added `src/signing-policy/jupiter.ts`. Before simulation or signing it requires:

- exactly one supported route instruction;
- quote input/output mints and input amount equal to the leg;
- source ATA derived from the owner, sold mint, and token program;
- instruction input and quoted output equal to the quote;
- instruction slippage equal to the quote;
- zero platform fee;
- `quotedOut × (10000 − slippageBps) / 10000` at least the authorized minimum and quote threshold.

`route` and `shared_accounts_route` are supported. Token-ledger and opaque variants are rejected because they do not provide the same local source binding. Public layout references: [Jupiter v6 IDL](https://www.helius.dev/parsed-data/jupiter/aggregator-v6) and [swap construction](https://jupiter.mintlify.app/swap/v1/build-swap-transaction).

**Regression.** `test/jupiter-policy.test.ts` accepts both honest layouts and rejects input/output changes, wrong mints, foreign source ATA, altered slippage, platform fees, and token-ledger routes.

### W-03 — Kyber/native EVM builds were not bound to the authorized input

**Problem.** The Kyber decoder read recipient, bought token, and minimum but discarded `desc.srcToken` and `desc.amount`. Provider-controlled `transaction.value` was only compared with a broad cap.

**Detection.** `src/signing-policy/swap-terms.ts` and `src/broadcast/evm.ts`. A local probe signed a build with a different sold token and a much larger amount than the leg.

**Exploit and preconditions.** A malicious Kyber build could spend another token or more native value while preserving the expected recipient and minimum. ERC-20 theft requires allowance; native-value inflation does not.

**Solution.** `SwapTerms` now carries Kyber `sellToken` and `sellAmount`. The sender requires exact equality with the leg. For every EVM provider, native `transaction.value` must equal the leg input for a native sell and zero otherwise.

**Regression.** `test/speed.test.ts` rejects changed sold token, amount, or native value before signing, and accepts an honest native swap whose value equals the leg input. `test/custody.test.ts` retains valid policy vectors.

### W-04 — Direct Settler calls could hide token spend and prior-allowance use

**Problem.** Direct `Settler.execute` exposed a recipient but no readable sold token or amount in the policy. The Rust signer allowed it when native value was nonzero, and the app accepted it without the `AllowanceHolder.exec` binding.

**Detection.** Compared `abi::Route::ZeroEx { exec: None }` in `signer/src/abi.rs` and `signer/src/policy.rs` with the app's direct-call branch in `src/broadcast/evm.ts`.

**Exploit and preconditions.** With an existing Settler allowance, crafted actions could spend tokens outside the leg and outside the recorded input. Native value could make the transaction look like a native swap while actions consumed an allowance. A root ceremony or an older integration could have created that allowance even though new Settler approvals are refused.

**Solution.** Direct Settler calls are refused in the broadcast preparer and again in `assertEvmSigning`. The Rust signer now refuses every unreadable sold amount regardless of native value. Normal `AllowanceHolder.exec` remains subject to exact token/amount checks.

**Regression.** `test/speed.test.ts` rejects a direct call before the backend. Regenerated `signer/vectors/evm.json` includes the same refusal for the Rust signer.

### W-05 — OP Stack L1 data fees bypassed native limits

**Problem.** The self-hosted signer charged only `gas × maxFeePerGas`. OP Stack also charges an L1 data fee, so actual native spend could exceed `maxFeeWei` and the daily native total. The Turnkey executor had no separate verified L1-fee bound either.

**Detection.** `signer/src/policy.rs:check_evm` and the live executor fee path. Calldata can increase L1 cost without increasing the recorded L2 spend; even a reverting transaction pays L1 fees.

**Exploit and preconditions.** Under the compromised-Whale or malicious-RPC model, new job IDs and nonces could repeatedly burn native balance beyond the configured daily limit.

**Solution.** Live OP Stack signing is closed. The Rust signer rejects chain IDs 10, 8453, and 81457 with an explicit L1-fee reason. `assertLiveEdges` also refuses live executor boot while any of those chains is enabled. Quotes and dry-runs remain available. This avoids substituting an unverifiable estimate for a bound.

**Regression.** Regenerated Rust vectors cover Optimism, Base, and Blast. `test/speed.test.ts` requires live boot to reject an enabled OP Stack chain and to proceed when those chains are disabled. EVM cryptographic vectors now use Ethereum.

### W-06 — LI.FI live opt-in accepted opaque recipient/calldata

**Problem.** `LIFI_LIVE=true` allowed calldata whose facet, recipient, token input, and minimum could not be decoded. Post-confirmation received checks cannot prevent the initial loss.

**Detection.** `src/broadcast/evm.ts`, `src/managed-signer.ts`, and the already documented residual risk in `docs/threat-model.md`.

**Exploit and preconditions.** A compromised LI.FI endpoint could return calldata paying someone else while reporting a valid summary. This required the explicit live opt-in.

**Solution.** LI.FI is quote-only. `LIFI_LIVE=true` now throws at configuration load, `lifiLive` remains false, and unknown swap calldata is refused.

**Regression.** `test/security-review.test.ts` requires the live opt-in to fail and the false setting to remain quote-only.

### W-07 — Solana screening cache let a lookalike mint inherit `allow`

**Problem.** Screening cache keys lowercased Solana mints. A distinct case-variant token could reuse a benign mint's cached verdict without any real screening request. The GoPlus response lookup also had an unconditional lowercase fallback.

**Detection.** `src/screening.ts`. A regression probe first cached `allow` for canonical USDC and then requested a case-variant mint; the old path returned `allow` without calling the provider.

**Exploit and preconditions.** An agent could first cause screening of a benign token and then submit a lookalike mint. This bypassed a required screening control for arbitrary token routes.

**Solution.** Screening cache keys use `addressKey`. Lowercase response fallback is restricted to EVM.

**Regression.** `test/speed.test.ts` proves the second mint is independently fetched and denied when marked as a honeypot.

### W-08 — `chainKey` and `chain` could authorize one chain and sign on another

**Problem.** `intentTokenSchema` did not relate `chainKey` to `chain`. Enabled-chain and support-tier decisions could use Base while broadcast and signing used Ethereum.

**Detection.** `src/schemas.ts`, `src/executor.ts`, and `src/broadcast.ts`. A local end-to-end probe signed chain ID 1 while reporting venue `base`.

**Exploit and preconditions.** A bearer holder or upstream capable of constructing intents could bypass chain-specific enablement and support restrictions and poison chain-keyed caches.

**Solution.** `intentTokenSchema.superRefine` now requires the table entry for `chainKey` to exist and match kind, EVM chain ID, or HyperCore market. Alternates use the same schema.

**Regression.** `test/commands.test.ts` covers EVM chain-ID mismatch, EVM/Solana mismatch, and a mismatched alternate.

### W-09 — x402 could price a case-variant Solana mint as a stablecoin

**Problem.** x402 asset recognition lowercased all addresses and could treat a different Solana mint as canonical USDC or USDT.

**Detection.** `src/gateway/x402.ts`. A forged challenge with `EPj…` changed to `Epj…` was previously treated as known USDC.

**Exploit and preconditions.** A malicious x402 resource could receive a `fits` verdict for an asset whose real price and identity were unknown. Hosted x402 payments are currently disabled, so the confirmed impact was a forged security verdict rather than a payment.

**Solution.** x402 now uses `quoteAssetOf`, which already applies chain-aware identity.

**Regression.** `test/network-costs.test.ts` requires `refused`, no stable symbol, and no call to the payment judge.

### W-10 — Solana recovery allowlist ignored Base58 case

**Problem.** `decideWithdraw` compared recovery token addresses case-insensitively even for Solana.

**Detection.** `src/executor/withdraw.ts`. The old function returned HTTP 200 for a case-variant mint that should have been rejected.

**Exploit and preconditions.** A crafted recovery request could authorize a non-allowlisted mint. Token recovery is currently closed, which limits present reachability but does not make the policy function safe to enable.

**Solution.** Recovery uses `addressKey` with the supplied chain. The legacy dry-run form without a chain retains its EVM-only behavior.

**Regression.** `test/executor.test.ts` rejects the Solana lookalike and accepts EVM hex case variation.

### W-11 — EVM execution fees had no total cap

**Problem.** The Turnkey executor accepted RPC-provided fees and provider gas limits without enforcing a total `gas × maxFeePerGas` ceiling. Replacement transactions had the same gap.

**Detection.** `src/broadcast/evm.ts`, `src/managed-signer.ts`, and `src/signing-policy.ts`.

**Exploit and preconditions.** A malicious RPC or provider could consume native balance through extreme fees outside the USD notional reserved for the trade, provided the transaction was included.

**Solution.** Added `MAX_EVM_FEE_WEI`, defaulting to 0.01 native token. `assertEvmSigning` checks the total fee on every signature and rejects `maxPriorityFeePerGas > maxFeePerGas`. Because the check wraps the signer, replacements are covered too. This is an execution-fee cap, not an L1-data-fee bound; OP Stack is closed separately.

**Regression.** `test/custody.test.ts` covers the exact cap, one unit over, and priority above max fee. `test/security-review.test.ts` covers the default and strict integer configuration. Configuration is documented in `docs/runbook.md`.

### W-12 — Signer gateway URL userinfo bypassed the loopback-only HTTP rule

**Problem.** Rust `Gateway::new` used string prefixes. `http://localhost:@example.invalid` passed the localhost check while the actual remote authority was `example.invalid`.

**Detection.** `signer/src/net.rs`. The new regression test failed before the fix without making a network request.

**Exploit and preconditions.** A user induced to connect or serve with a crafted URL could send the registration code and signatures, or the signer bearer and jobs, over plaintext HTTP to a remote host.

**Solution.** Parse `ureq::http::Uri`; validate scheme, authority host, and explicit loopback port; reject userinfo on every scheme.

**Regression.** `signer/src/net.rs` tests reject both localhost and 127.0.0.1 userinfo variants and accept genuine HTTPS and loopback HTTP.

### W-13 — Error stacks could disclose RPC credentials in logs

**Problem.** The Pino error serializer redacted `error.message` but returned `error.stack` unchanged. A stack normally includes the original message and therefore restored the secret.

**Detection.** `src/log.ts`. A serializer probe showed the RPC key in `message` was removed while the same key remained in `stack`.

**Exploit and preconditions.** Any failing vendor/RPC error containing a credentialed URL could disclose it to log readers or a downstream log service.

**Solution.** Apply `redactText` with the configured secret set to the stack as well.

**Regression.** `test/redact.test.ts` requires both fields to omit the key and the stack to retain a redaction marker.

### W-14 — Other Solana caches and price/balance views merged distinct mints

**Problem.** Token-decimal, balance, executor-flag, and command balance filtering used lowercase keys for Solana. CoinGecko response fallback also assumed lowercase could identify every chain's asset.

**Detection.** `src/token-decimals.ts`, `src/balances.ts`, `src/executor.ts`, `src/commands.ts`, and `src/prices.ts`.

**Exploit and preconditions.** Distinct mints could inherit decimals, balances, flags, or prices. Wrong balances or decimals can corrupt sizing; wrong presentation can also hide which asset an operation touched. Executor flags are deny-oriented, so their confirmed extra effect was cross-token denial rather than an allow bypass.

**Solution.** All these keys and lookups now use `addressKey`.

**Regression.** `test/pricing.test.ts` separates Solana decimal caches and preserves EVM folding. `test/speed.test.ts` separates Solana balance reads. `test/commands.test.ts` excludes a case-variant holding from a balance result.

### W-15 — Existing signer token files retained broad permissions

**Problem.** `OpenOptionsExt::mode(0o600)` applies when creating a file, not when truncating an existing one. An existing `0644` token file stayed world-readable. Symlinks were not rejected.

**Detection.** `signer/src/main.rs:write_private`.

**Exploit and preconditions.** A local user able to read that file could impersonate the signer, read jobs, and submit refusals. This did not reveal the private key.

**Solution.** Reject symlinks and non-regular files and explicitly set `0600` before writing the new token.

**Regression.** The Rust binary test pre-creates a `0644` file, requires the replacement to become `0600`, and proves a symlink target is unchanged.

### W-16 — OAuth cleanup could delete a client during authorization

**Problem.** Client resolution and `INSERT INTO oauth_requests` were separate operations. Cleanup could delete an unused client in that gap, causing a foreign-key error and a 500.

**Detection.** `src/gateway/routes-oauth.ts` and `src/gateway/oauth-store.ts`. Existing race tests covered the interval after insertion began, not the earlier resolution gap.

**Exploit and preconditions.** An unauthenticated caller could time cleanup against an authorization for a dynamic client older than 24 hours with no grants, requests, or codes. The confirmed impact was denial of that authorization, not code or token theft.

**Solution.** Insert or restore the already validated client and create its request in one transaction. Cleanup then sees the in-flight request and cannot remove the client.

**Regression.** `test/gateway-oauth-race-pg.test.ts` deletes the client between those steps and requires the request and client to survive atomically. Existing OAuth race suites still pass.

## Attack-class matrix

| Attack class | Result in this review |
| --- | --- |
| Owner impersonation, session fixation, Google token forgery | No bypass confirmed; OIDC signature/issuer/audience/nonce/PKCE and random hashed sessions held |
| OAuth redirect theft, PKCE downgrade, refresh replay | No theft confirmed; exact redirects, S256, audience binding, and family revocation held; W-16 was availability only |
| Passkey challenge replay or action substitution | No bypass confirmed; account/purpose/action-bound, single-use challenges and signature/counter checks held |
| Cross-tenant IDOR | No bypass confirmed; credential-derived tenant context and composite foreign keys held |
| Malicious quote or calldata substitution | W-02, W-03, W-04, and W-06 fixed |
| Prior allowance abuse | W-04 closed direct Settler; nested-action residual risk remains bounded as described below |
| Chain/network confusion | W-08 fixed |
| Lookalike Solana mint/address poisoning | W-01, W-07, W-09, W-10, and W-14 fixed |
| Replay/idempotency/double spend | Existing approval and signer digest controls held; hosted live remains closed, with the ordering caveat below |
| RPC fee manipulation | W-05 and W-11 address OP Stack and execution-fee paths |
| SSRF/DNS rebinding | Public-HTTPS checks, DNS pinning, no redirects, and MCP Origin checks held; W-12 was the separate Rust URL-parser gap |
| Secret exfiltration through logs or files | W-13 and W-15 fixed |
| Supply-chain scripts and dependency confusion | Lockfiles, release-age policy, pinned actions/crates/images, and dependency audit held; remaining assurance gaps are listed below |

## Controls that resisted attack

- **Hosted live sends are closed.** `/hosted/commands` only quotes or reads balances/costs, and hosted commands reject a live mode.
- **Google/OIDC.** RS256 against Google JWKS, issuer, audience/azp, expiration, nonce, PKCE, and account keyed by Google `sub`, not email.
- **Sessions and CSRF.** Random 256-bit hashed tokens, `__Host-` cookie, HttpOnly/Secure/SameSite=Lax, idle and absolute expiry, and exact-Origin mutation checks.
- **OAuth.** S256 PKCE, exact redirect matching except loopback ports, `/mcp` audience binding, single-use codes, and family revocation on code/refresh replay including concurrent refreshes.
- **WebAuthn.** RP ID, origin, UP/UV, ceremony, signature, and counter checks; single-use challenges bound to account, purpose, and exact action.
- **Tenancy.** Account IDs come from the session or credential. Composite foreign keys prevent cross-account wallet/agent links.
- **Spend and replay.** Postgres advisory locking protects legacy spend reservations; ambiguous broadcast outcomes keep reservations. Signer job IDs bind to a digest of exact signed work and concurrent jobs cannot both consume the same headroom.
- **Outbound requests.** Public HTTPS, private/loopback IP rejection across all DNS answers, no redirects for webhooks/metadata, response byte and time limits.
- **Turnkey delegation.** Activation requires the user's sole root, the exact delegate key, and exact rendered policies.
- **HyperCore.** Only tradable actions, size/price limits, and signature recovery to the expected agent.

## Residual risks and deliberate boundaries

These are not silently presented as fixed.

### Nested router actions can still lose a whole allowed swap

0x `Settler.actions` and Kyber `targetData` are not fully interpreted. A compromised Whale can construct economically malicious behavior even when the decoded recipient is the wallet. Direct Settler is now refused and exact inputs are bound, but a swap can still return dust. The Rust README explicitly states that recipient checks do not bound loss. Daily token/native limits, fee caps, and `evm.maxValueWei` are the actual bound. Keep `allowUndecodedRouterCalls` false and set daily limits to the amount whose loss is acceptable.

### Hosted transfers can bypass USD caps only by explicit owner configuration

A transfer asks for approval whenever `approvalAboveUsd` is non-null. If the owner widens policy to `approvalAboveUsd: null`, transfers to owner-listed destinations are not charged against `maxTxUsd` or `dailyUsd`. This is documented behavior, not a hidden bypass. An agent with transfer permission can therefore drain an allowed asset to an allowed destination under that configuration. Stablecoin transfers should gain quote-based caps before live hosted sends are enabled.

### Hosted approval/spend ordering is safe only because hosted sends are dry-run

`planSend` currently calls the executor before consuming approval and recording planned spend. Concurrent live sends would need reservation and approval consumption before the irreversible operation, with explicit release/reconciliation semantics. Do not enable hosted live sends on this ordering. The current executor route cannot sign or broadcast.

### Enclave daily caps depend on Whale remaining intact

Turnkey policies are stateless. A full executor compromise can sign what the delegated per-transaction Turnkey policy allows, and daily caps depend on Whale's application state. Self-hosted is the level whose local ledger survives a Whale compromise.

### Dashboard sessions can create and rotate agent credentials

This is the documented trust model: Google sign-in opens the account, while passkeys guard policy widening, held operations, signer registration, and unfreeze. A stolen dashboard session can act through newly created agents inside existing policy. It cannot directly produce a Turnkey or self-hosted signature. Session protection and short idle expiry remain important.

### Bridge planning is not chain-typed

`planRebalance` lowercases destinations without carrying chain identity and would be unsafe for case-sensitive Solana addresses if reused for live Solana bridging. It currently always returns `broadcast: false` and fetches no bridge transaction. Add chain identity before enabling broadcast.

### x402 is a planner only

The x402 asset-identity fix is confirmed, but hosted x402 payments remain disabled. No payment path was enabled or tested live.

### Registration and challenge first-try consumption is an availability tradeoff

Signer registration codes and some WebAuthn/OAuth challenges are intentionally consumed on the first attempt, including an invalid one. This slows online guessing and replay but allows someone who already possesses a code to cause a retry. These are high-entropy, short-lived capabilities; no practical guessing attack was found.

### Webhook receivers must enforce freshness and event ID uniqueness

The HMAC covers timestamp and exact body. A receiver that only compares the signature can still accept a replay. Receivers should enforce a timestamp tolerance and persist `whale-event-id`.

### Assurance gaps

This was a code audit with regression probes, not a formal proof or a live protocol review. Router contracts and Turnkey's policy interpreter were not independently audited. `pnpm audit` reported no known vulnerabilities, but that does not prove dependency safety. Rust advisory scanning was not available in the local toolchain, and the container image workflow records high-severity SARIF with `fail-build: false`; those should be made release gates with explicit exception review.

## Verification

Baseline before edits:

- `pnpm run check` passed all 383 Node tests with the dedicated PostgreSQL service.
- `cargo test --locked` passed all 19 Rust tests.

Final verification for this branch:

- Full file-size and import-boundary checks: passed.
- TypeScript build and **400/400 Node tests**, including PostgreSQL integration: passed.
- Web production build: passed.
- Entrypoint smoke tests: passed (`executor boots with logging on, dry-run holds, provider-health is authenticated`).
- Rust formatting and Clippy with warnings denied: passed.
- **21/21 Rust tests**, including regenerated EVM/Solana vectors, replay, concurrency, URL validation, and file-permission cases: passed.
- `pnpm audit`: no known vulnerabilities found.
