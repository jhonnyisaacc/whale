# Threat model

A live executor can move the funds in the hot wallet. Default boot leaves `WHALE_BROADCAST` unset and does not broadcast. If `LISTING_TRADER_LIVE` is set, boot throws. If `WITHDRAW_ENABLED` is set, boot throws. `POST /withdraw` is absent. This page uses STRIDE so each control is tied to a threat. The controls are what the code does. They are not a promise about an exchange or a signer vendor.

## Spoofing

`EXECUTOR_AUTH_TOKEN` is required at boot and must be at least 16 characters. `RESOLVER_AUTH_TOKEN` is required only when `RESOLVER_URL` is set, and the two tokens must differ. `STRATEGY_CAPS_JSON` throws at boot, so there is no strategy bearer. Mutating routes compare `Authorization: Bearer` with SHA-256 and `timingSafeEqual`. `GET /health` is the only open route and returns only `{"ok":true}`. The public config is on an authenticated `GET /status`. Secrets, the router list, and the approval cache are not in either payload.

The executor token guards `POST /execute` and `POST /rebalance`. A bearer that does not match gets 401. This tree has no resolver process. A missing, short, or reused token refuses boot.

## Tampering

Zod parses every request and every aggregator or screening body this service acts on. A mismatch is a 400 or a null quote. Firm quotes are checked again against the slippage cap before sign.

App policy constrains the chain, native value, router, Solana instructions, and, where the calldata can be decoded, the swap recipient. Per provider:

- Solana (Jupiter): the destination token account must belong to the hot wallet, checked per instruction below.
- KyberSwap (MetaAggregationRouterV2 `swap` and `swapSimpleMode`): the signer decodes `desc.dstReceiver` and refuses any recipient but the hot wallet. Before signing, the sender also requires `desc.dstToken` to be the bought token and uses `desc.minReturnAmount` as the minimum output, which must clear ours.
- 0x (AllowanceHolder `exec` wrapping Settler `execute`, or Settler `execute` directly): the signer decodes `slippage.recipient` and refuses any recipient but the hot wallet. The sender requires `slippage.buyToken` to be the bought token and uses `slippage.minAmountOut` as the minimum. Settler checks that minimum against what it pays the recipient. `exec` lends the sell-token allowance to `operator` for one call into `target`, so the signer requires `operator` to equal `target` and both to be in `ZEROX_SETTLER_ALLOWLIST_JSON` for that chain; a direct Settler call must target a listed Settler. The sender requires the `exec` token and amount to be the leg's sell token and amount. An AllowanceHolder `exec` whose inner call is not Settler `execute` is refused even with `LIFI_LIVE=true`. Settler addresses rotate, and the 0x-settler README says not to hardcode them, so the list is operator config: when 0x deploys a new Settler, 0x swaps are refused until the list names it.
- LI.FI: the calldata targets the LI.FI diamond with facet-specific encodings this app does not decode, so the recipient is not checked. LI.FI is quote-only unless `LIFI_LIVE=true`. With it on, the signer accepts swap calldata it cannot decode, and only the router allowlist, simulation, and the received-amount check stand between a bad quote and the wallet.

Calldata to an allowlisted router that decodes as none of these is refused unless `LIFI_LIVE=true`. The Turnkey EVM policy constrains only the router in `eth.tx.to`, the chain, the native value cap, and the selector prefix; it cannot see the swap recipient, so that check lives in the app policy and the pre-sign simulation. The Turnkey Solana policy constrains native transfer recipients and program ids. Each Turnkey policy is scoped to one wallet with `wallet.id`. The checked-in file is `policies/turnkey.json`, a template with placeholder ids. `ROUTER_ALLOWLIST_JSON` is a map of chain id to router addresses. A router allowed on one chain is denied on another. An empty list for that chain denies the swap. A token sell with a non-zero native value is denied. Solana program ids outside the base set plus `SOLANA_PROGRAM_ALLOWLIST` deny the signature. `SOLANA_PROGRAM_ALLOWLIST` adds program ids. It does not replace the base set.

The app decodes every top-level instruction of a base program against a default-deny table in `signing-policy.ts`. An instruction that is not in the table is denied. The table allows these:

- System Program Transfer from the hot wallet to the hot wallet, an allowlisted withdraw address, the hot wallet's wrapped SOL account, or a published Jito tip account. Tips across the transaction may total at most `JITO_TIP_LAMPORTS`. Assign, CreateAccount, TransferWithSeed, AdvanceNonceAccount, and every other System instruction are denied.
- Token and Token-2022 SyncNative, CloseAccount that pays the hot wallet, InitializeAccount3 owned by the hot wallet, and Transfer or TransferChecked into an associated token account of the hot wallet or an allowlisted withdraw address. Approve, ApproveChecked, SetAuthority, and the rest are denied.
- Associated Token Account CreateIdempotent funded by the hot wallet for the hot wallet or an allowlisted withdraw address.
- Compute Budget unit limit, unit price, and loaded-data limit. Unit price times unit limit (1.4M units when no limit is set), plus Jito tips, may total at most `SOLANA_MAX_PRIORITY_LAMPORTS`.
- Jupiter `route`, `routeWithTokenLedger`, `sharedAccountsRoute`, and `sharedAccountsRouteWithTokenLedger`. The transfer authority must be the hot wallet, the platform fee account must be unset, and the destination must be the hot wallet's token account for the output mint. Quotes are always `exactIn`, so `exactOutRoute`, `sharedAccountsExactOutRoute`, and newer v2 routes are denied until they are added to the table.

An account that comes from an address lookup table cannot be checked offline, so a rule that needs it denies the signature. Instructions of an extra program from `SOLANA_PROGRAM_ALLOWLIST` are not decoded. Only add a program you trust with the hot wallet's signature.

The Turnkey Solana policy allows native transfers only to the hot wallet, its wrapped SOL account, or a Jito tip account, and denies every top-level SPL transfer. Turnkey's policy language has no condition that derives an owner's associated token account for an arbitrary mint, so SPL recovery under Turnkey needs a root-quorum approval. The Turnkey EVM policy checks chain, router, native value, and, when `selectors` is passed, the first four bytes of calldata through `eth.tx.data[0..10]`. `eth.tx.function_name` needs an ABI uploaded to Turnkey for each router, so the policy does not use it. The app does not check router selectors.

Pre-sign simulation is viem `simulateCalls` on EVM and `simulateTransaction` on Solana. A revert is `simulation rejected the transaction` and `broadcast` is false, so the spend reservation is released.

`TOKEN_SCREENING=true` rejects a live-lookup token when GoPlus or Blockaid fails, times out, or reports a honeypot, `cannot_sell_all`, or a result other than `Benign`. That path is the unlisted fallback only.

## Repudiation

pino logs the execution report. Authorization, API keys, and OKX signature headers are redacted. `redactError` still strips a 64-hex key and a long base58 string. The spend journal records the idempotency key, the strategy id (`listing` for alerts), the USD amount, the UTC day, and `reserved`, `committed`, or `released`. `signed_tx` records every signed hash with its nonce.

## Information disclosure

With Turnkey, the trading keys are not in this process. The process holds the Turnkey API key, which can request a signature inside the policy. The local keystore decrypts into the process only for a dry-run. Live mode does not accept it. Live boot refuses to start when `EVM_PRIVATE_KEY`, `SOLANA_SECRET_KEY`, `HYPERLIQUID_AGENT_KEY`, `KEYSTORE_PATH`, or `KEYSTORE_PASSPHRASE` is set. A dry-run deletes those variables from `process.env` after it loads them. Every config API key, the auth and admin tokens, the notifier URL, and the Turnkey key are redacted from error text. A Hyperliquid signature from Turnkey must recover to the agent address before it is submitted. Logs do not print `Secret` values.

Do not attach a Railway public domain. Boot throws when `RAILWAY_PUBLIC_DOMAIN` is set. Use the private network URL for Postgres. Leave `RESOLVER_URL` unset. This tree has no resolver process.

## Denial of service

Fastify limits the body to 32 KiB. The global rate limit is 60 a minute. `POST /execute` and `POST /rebalance` are 10 a minute. Provider calls have a per-minute budget, a 350 ms timeout, and a 500 ms deadline. Three failures, or one compliance response, open that provider. A compliance skip is not retried on another host.

## Elevation of privilege

`POST /withdraw` is absent. Setting `WITHDRAW_ENABLED` throws at boot. The signing policy still refuses a `withdraw` purpose whose destination is not on `OWNER_WITHDRAW_ADDRESSES`. An empty allowlist makes `POST /rebalance` skip with `bridge allowlist is empty`. Bridge plans set `broadcast` to false.

HyperCore refuses `withdraw3`, `usdSend`, `spotSend`, `sendAsset`, `agentSendAsset`, `usdClassTransfer`, `vaultTransfer`, and `approveAgent`. Turnkey's Agent policy cannot see those names inside `connectionId`. The ban is in this process, before submit. Load the agent key, not the master key. The signature scheme follows the Python SDK and has not been checked against a mainnet vector.

`KILL_SWITCH=true`, or the `kill_switch` row in `control_flags`, skips new buys on `POST /execute`. Neither deletes a key. Revoke the Turnkey API user to stop signing. See the [runbook](runbook.md).

The daily cap is enforced inside a Postgres transaction with one advisory lock per day. A second executor cannot pass the boot advisory lock when `DATABASE_URL` is set, and `railway.json` runs one replica, so the in-memory idempotency map is never shared.

A compromised or mispriced Hyperliquid agent could try to drain the account through IOC orders crossed far from the mark. The app bounds that path before signing: the order size comes from the per-trade USD cap, and the limit price is the mark moved by at most the slippage cap, rounded to the venue wire format. An order the venue reports as an error, or that fills nothing, releases the spend reservation.

## What this does not cover

A quoted router can still be a hostile contract the aggregator returned, inside the allowlist you configured. The caps bound the size. Screening does not run on the watchlist hot path. Research CI does not run these tests and does not fetch market data for them.
