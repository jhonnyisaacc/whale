# Run the listing trader

Use this when you want a dry-run resolver and executor on one machine. For Railway, use [the deploy guide](deploy.md).

## Create a wallet

The command prints the keystore path and the two public addresses. It does not print the keys.

```bash
cd wallet
export KEYSTORE_PASSPHRASE='a passphrase of at least 12 characters'
export KEYSTORE_PATH=wallet.keystore.json
npm run create-wallet
```

The file mode is `0600`. `*.keystore.json` is gitignored. That file is the export. Decrypt it with the same passphrase. The command does not print the keys, and a terminal prompt does not echo them. On a laptop this is the dry-run signer. Live mode does not use it. The production signer is Turnkey. See [the ceremony](#key-ceremony) below.

A HyperCore agent key is separate. Approving that agent is a manual step on the master account. This service does not sign `approveAgent`.

## Start the two processes

```bash
export PORT=8080
export RESOLVER_AUTH_TOKEN='a token of at least 16 characters'
export EXECUTOR_AUTH_TOKEN='a different token of at least 16 characters'
export DATABASE_URL=postgres://listing:listing@127.0.0.1:5432/listing
export REFRESH_ENABLED=true
npm run start:resolver
```

In a second shell, point the executor at the resolver and describe the balances the hot wallet actually holds. Decimals are required. A native row keeps the gas reserve. Live mode prices each row from CoinGecko, so `usd` is only the dry-run hint.

```bash
export PORT=8081
export EXECUTOR_AUTH_TOKEN='a token of at least 16 characters'
export RESOLVER_AUTH_TOKEN='the resolver token of at least 16 characters'
export RESOLVER_URL=http://127.0.0.1:8080
export WALLET_HOLDINGS_JSON='[{"symbol":"USDC","address":"<mint>","amount":20,"usd":20,"native":false,"decimals":6}]'
export NOTIFIER_WEBHOOK_URL=http://127.0.0.1:9/hook
npm run start:executor
```

Leave `LISTING_TRADER_LIVE` unset. `GET /health` on each port returns only `{"ok":true}`. The public config is on `GET /status` with that service's Bearer token.

Omit `chainKey` when that balance may fund a buy on any chain where the address is valid. Native gas follows its asset. SOL funds only Solana. ETH funds only an EVM chain whose native asset is ETH. BNB, POL, MON, and HYPE fund only their own chain. An untagged native row that does not name one of those assets is rejected at load. Live mode then reads and sizes an eligible holding on each of those chains. A failed read skips that holding. A failed chain leaves the other chains. Set `chainKey` to a known chain key when the address belongs to one chain. An unknown key stops boot.

## Send a fake alert

The collector, or a curl stand-in, posts the alert to the executor.

```bash
curl -s -X POST http://127.0.0.1:8081/listing \
  -H 'content-type: application/json' \
  -H "authorization: Bearer $EXECUTOR_AUTH_TOKEN" \
  -d '{"id":"alert-1","ticker":"MPLX","projectName":"Metaplex","source":"upbit","publishedAt":"2026-10-21T00:00:00Z","receivedAt":"2026-10-21T00:00:00.300Z"}'
```

A hit responds with `decision: would_send`, the route, and latency stamps measured from `receivedAt`. The same `id` returns the stored report and does not quote again. A lookalike, a thin pool with no Hyperliquid market, or a missed live lookup responds with `skipped`.

`POST /execute` with the executor token accepts a `SwapIntent` and always returns a dry-run report, including when the process is live. With a strategy token from `STRATEGY_CAPS_JSON` it runs in the process mode instead, under that strategy's caps and the global `DAILY_USD_CAP`, and the report key is `<strategyId>:<idempotencyKey>`. A `/listing` alert id is its key as is, unless it contains `:`; then the key is `listing:<id>`, and `listing` is refused as a strategy id, so the two kinds of key never collide. Dry-run and live reports are stored apart, so a dry-run preview never answers for a later live call with the same key. Live broadcast is `POST /listing`, which rebuilds the intent from the resolver, or the strategy `/execute`.

## Turn the knobs

| Variable | Default | Effect |
| --- | --- | --- |
| `MAX_USD_PER_TRADE` | 5 | Reject a larger notional |
| `DAILY_USD_CAP` | 25 | Counted only after a live broadcast. Shared by `/listing` and every strategy; a strategy reservation must also fit its own `dailyUsdCap`. Day boundary is `SPEND_TIMEZONE`, default `UTC` |
| `MAX_SLIPPAGE_BPS` | 100 | Cap for route selection. Cannot exceed `SLIPPAGE_HARD_MAX_BPS` (300) |
| `MIN_LIQUIDITY_USD` | 75000 | Floor for the top pool |
| `KILL_SWITCH` | off | `1` or `true` skips every trade. A `control_flags` row named `kill_switch` does the same without a restart |
| `MAX_LEVERAGE` | 1 | HyperCore orders above this are rejected |
| `DISABLED_CHAINS` | empty | Comma-separated chain keys to remove from the default set |
| `ENABLED_CHAINS` | empty | Comma-separated chain keys to add. Monad stays off until this list includes `monad` |
| `QUOTE_ASSET_ALLOWLIST_JSON` | built-in list | Replaces one chain's two-hop quote assets, for example `{"bnb":[{"address":"0x...","symbol":"USDT","decimals":18}]}`. Pools quoting any other address are dropped |
| `PRICE_REFRESH_MS` | 30000 | How often the executor reads holding prices from CoinGecko |
| `PRICE_MAX_AGE_MS` | 90000 | A live buy skips with `holding price stale` when the price is older |
| `PRICE_TIMEOUT_MS` | 3000 | Timeout for each CoinGecko price call |
| `OWNER_WITHDRAW_ADDRESSES` | empty | Allowlist. Empty denies every withdraw and every bridge plan |
| `EXECUTOR_AUTH_TOKEN` / `RESOLVER_AUTH_TOKEN` | unset | Required, different from each other and from every strategy token. At least 16 characters. Boot refuses a shorter value and refuses the old `AUTH_TOKEN` name |
| `STRATEGY_CAPS_JSON` | empty | Per-strategy `{dailyUsdCap, maxUsdPerTrade, token}` for copy-trading on `/execute` |
| `LISTING_RATE_LIMIT_PER_MIN` | 60 | Rate limit for `POST /listing` |
| `RESOLVER_TIMEOUT_MS` | 6500 | How long `/listing` waits for the resolver before answering `resolver_error` |
| `ROUTER_ALLOWLIST_JSON` | empty | Per-chain EVM routers, for example `{"8453":["0x..."]}`. Empty denies every swap |
| `SOLANA_PROGRAM_ALLOWLIST` | empty | Extra Solana program ids added to the base set. The base programs stay allowed |
| `TOKEN_SCREENING` | on in live, off in dry-run | `false` turns screening off. `true` turns it on. Refresh and a live buy both use it |
| `MAX_TOKEN_TAX` | 0 | GoPlus buy or sell tax above this fraction is a deny. This is a service safety floor, not a research price |
| `JITO_ENABLED` | off | `true` sends Solana through the Jito block engine |
| `ZEROX_SETTLER_ALLOWLIST_JSON` | empty | Per-chain 0x Settler addresses, for example `{"8453":["0x..."]}`. Required in live. Read the current taker-submitted Settler from the 0x deployer `0x00000000000004533Fe15556B1E086BB1A72cEae` with `ownerOf(2)`, and keep the previous one from `prev(2)` during a rotation |
| `REORG_DEPTH_JSON` | `{"56":15,"137":64}`, else 3 | Blocks below the head at which reconcile reads a mined nonce, per chain id |
| `LIFI_LIVE` | off | `true` lets LI.FI same-chain quotes be signed. The signer cannot decode the swap recipient in LI.FI calldata, so without it LI.FI stays quote-only and Blast has no signable route |
| `QUOTE_DEADLINE_MS` | 500 | Stop waiting for aggregator quotes |
| `RACE_GRACE_MS` | 60 | After the first signable quote, wait this long for others, then rank. Quote-only providers never extend the wait |
| `RACE_SLIPPAGE_BPS` | 50 | Slippage baked into race quotes from Jupiter, 0x, and LI.FI, capped at `MAX_SLIPPAGE_BPS` |
| `QUOTE_TTL_MS` | 2000 | A race quote younger than this is built and signed without a re-quote, if its minimum output still clears ours |
| `FIRM_TIMEOUT_MS` | 800 | Timeout for each firm quote, build, and Jupiter `/swap` call |
| `SCREEN_CACHE_MS` | 600000 | How long a screening verdict is reused. An outage is not cached |
| `BALANCE_CACHE_MS` | 3000 | How long a live balance read is reused. Any tx on that chain drops it |
| `SOLANA_MAX_PRIORITY_LAMPORTS` | 1000000 | Cap for the Jupiter `veryHigh` priority fee. The signer refuses a transaction whose compute-unit price times limit, plus Jito tips, exceeds it |
| `JITO_TIP_LAMPORTS` | 10000 | Jupiter `jitoTipLamports` when `JITO_ENABLED=true`. At least 1000. The signer refuses Jito tips that total more |
| `RPC_URLS_<chainId>`, `SOLANA_RPC_URLS` | empty | Comma-separated extra RPCs. Reads fail over in order. Sends go to every RPC unless `MEV_RPC_URL_<chainId>` is set |
| `MAX_BRIDGE_USD` | 25 | Largest inventory move `planRebalance` will accept |

`POST /withdraw` uses the same bearer hook as the other mutating routes, then checks `x-admin-token` against `ADMIN_TOKEN`. It stays disabled until `WITHDRAW_ENABLED=true`. The body is `{ "to", "chainKey", "amount" }` for native gas, or the same fields plus `mint` and `decimals` for an allowlisted ERC-20 or SPL recovery. `MAX_WITHDRAW_AMOUNT` defaults to 1 human unit. Dry-run returns `would_send`. Live mode sends only when the destination is allowlisted and a native send leaves the gas reserve. An SPL recovery creates the destination owner's associated token account when it is missing and transfers the tokens there. `POST /rebalance` plans a bridge and does not broadcast. This service has no bridge send.

To run live, set `LISTING_TRADER_LIVE` to the exact string `true`, set `DATABASE_URL`, and load Turnkey. Live mode refuses to boot without the database and without a Turnkey signer. The local keystore cannot override that. The daily cap is a reservation in `spend_journal`. A restart does not zero committed or reserved rows. Dry-run does not write that table.

## Key ceremony

Do this once, with two people if you can, and do not paste keys into chat.

1. In Turnkey, create an organization and a wallet with an Ethereum account, a Solana account, and a third Ethereum account for the Hyperliquid agent.
2. Create an API user that can sign and nothing else. Download the API key pair. Store the private key in the Railway secret `TURNKEY_API_PRIVATE_KEY`. Set `TURNKEY_API_PUBLIC_KEY` and `TURNKEY_ORGANIZATION_ID`.
3. Copy the three addresses into `TURNKEY_EVM_ADDRESS`, `TURNKEY_SOLANA_ADDRESS`, and `TURNKEY_HYPERLIQUID_ADDRESS`.
4. Build the Turnkey policies with `turnkeyPolicyDocument({ userId, wallets, solanaAddress, routers, selectors, maxValueWei })`, using the API user id, the EVM, Solana, and Hyperliquid wallet ids, the same map as `ROUTER_ALLOWLIST_JSON`, and `MAX_NATIVE_VALUE_WEI`. Ids must be real Turnkey UUIDs, so a placeholder throws. The file in git is `turnkeyPolicyTemplate()`, written by `npm run policy:turnkey`. Its placeholders are not valid ids and its EVM condition matches no chain. The test checks that the file matches the function.
5. Fund the hot wallet with a small USDC balance and the native gas reserve. Approve each router once with the root quorum, not with the API user. Then set `APPROVAL_CACHE_JSON` to those allowances.
6. On Hyperliquid, approve the agent from the master account in the UI. Do not import the master key here.
7. Boot with live mode off. `GET /health` must show `live: false`. Send a dry-run alert. Then set `LISTING_TRADER_LIVE=true`.

## Rotation

Create a new API key pair, add it to the same API user, set the new Railway variables, restart the executor, then delete the old API key in Turnkey. Rotation of the trading key is a new wallet: move funds with `POST /withdraw` to an allowlisted address you control, create the wallet, update the address variables, and repeat the router approval. Do not reuse a keystore passphrase you have already typed into a shell you do not trust.

## Revocation

In Turnkey, delete the API key or set the API user to a policy with no allows. Signing stops on the next request even if this process is still up. Then set `KILL_SWITCH=true` and restart. If a laptop still has a keystore, delete `EVM_PRIVATE_KEY`, `SOLANA_SECRET_KEY`, and `HYPERLIQUID_AGENT_KEY`, and move the funds. Live mode will not sign with those keys.

## Kill switch

`KILL_SWITCH=true` or `KILL_SWITCH=1` makes `checkLimits` skip every buy. Live withdraw also returns `would_send`. The key is not deleted. Leave the switch on until the incident note says to clear it.

## Incident

1. Set `KILL_SWITCH=true` on the executor and restart it.
2. Revoke the Turnkey API key.
3. If a transaction was broadcast, record the idempotency key and the journal row. Do not delete a `committed` row to retry. A retry of the same id stays `exists`.
4. If funds moved to an unexpected contract, the router allowlist was too wide or the host was compromised. Withdraw any remainder to the allowlist, then rotate the wallet.
5. Write down the UTC time, the report reason, and whether `broadcast` was true. A pre-sign failure releases the reservation. A failure after send keeps it so a retry cannot double-send.

`npm test` does not call an exchange. Do not point research CI at this tree.

## Kill switch from SQL

The database flag blocks `/listing` and `/execute` (including strategy tokens) without a restart. `/withdraw` is not blocked by this flag; it stays reachable as the incident escape hatch.

```sql
INSERT INTO control_flags (name, enabled) VALUES ('kill_switch', true)
ON CONFLICT (name) DO UPDATE SET enabled = EXCLUDED.enabled;
-- clear it with enabled = false
```

The env `KILL_SWITCH=true` does the same at boot and also holds a live withdraw at `would_send`.

## Turnkey outage

Signing requests fail before broadcast, so spend reservations are released and nothing is sent. Buys skip with the signer error. Wait for Turnkey status to clear, then check `signed_tx` for rows still `pending`; do not re-send an id whose journal row is `reserved` with a `tx_hash`. If the outage lasts, set the SQL kill switch so alerts stop quoting.

## Stuck or dropped EVM transaction

Find the row first: `SELECT idempotency_key, tx_hash, chain_key, outcome FROM spend_journal WHERE tx_hash = '<hash>'`. The sender replaces a timed-out receipt once at the same nonce with a fee bump. After a send fails or ends without a receipt, the next send re-reads the pending nonce, so a dropped transaction does not leave a gap that blocks later sends. A send the node rejected before its mempool (insufficient funds, intrinsic gas too low, invalid sender, fee cap below base fee) releases its reservation at once; a timeout or 5xx keeps it reserved.

Reconciliation looks at every hash signed for a reservation older than `RECONCILE_AFTER_MINUTES` (`signed_tx` by idempotency key). One landed hash commits it. It is released only when every hash reverted or is provably dead. An EVM hash is dead when no configured RPC has its receipt and the account's nonce, read `REORG_DEPTH` blocks below the head, has passed the nonce it was signed with: that nonce was used by another transaction, so this one can never be included. The nonce is read before the receipts, and every RPC is asked for the receipt, so a lagging node cannot report a landed hash as missing. An RPC that errors keeps the row `reserved`. A send that every sender rejected before its mempool releases the spend only when no RPC knows the hash. A row whose hashes have no recorded nonce (signed before the `signed_tx.nonce` column) stays `reserved`; settle it by hand after checking the explorer. Never delete a `committed` row to force a retry; a retry of the same id returns `exists`.

## Drained wallet

1. Set the SQL kill switch and revoke the Turnkey API key.
2. Withdraw what remains to an `OWNER_WITHDRAW_ADDRESSES` address. The route stays open under the database flag on purpose.
3. Treat the wallet as burned: new wallet, new router approvals, new `APPROVAL_CACHE_JSON`, then fund it.

## Token and API key rotation

Service tokens rotate with overlap: set `EXECUTOR_AUTH_TOKEN='old-token, new-token'` (the same for `RESOLVER_AUTH_TOKEN` or a strategy `token` list), restart, move callers to the new token, restart again with only the new one. The executor sends the first resolver token in its list, so on the executor set `RESOLVER_AUTH_TOKEN='new-token, old-token'` during the overlap and drop the old one last. Turnkey API keys follow the key ceremony: add the new key to the same API user, set the Railway variables, restart, then delete the old key. Provider keys rotate the same way, one provider at a time, with a dry-run alert between restarts.

## Hyperliquid agent-key expiry

An expired or revoked agent makes order submits fail the signature recovery check or the venue call. Re-approve the agent from the master account in the Hyperliquid UI, update `TURNKEY_HYPERLIQUID_ADDRESS` if the agent changed, restart, and send a dry-run HyperCore alert before going live. The service never signs `approveAgent`.

## Postgres backup and restore

Railway Postgres keeps its own backups; check they are enabled on the service. In addition, dump weekly from a trusted host: `pg_dump "$DATABASE_URL" > listing-$(date -u +%F).sql` and keep the file encrypted off Railway. Restore into an empty database with `psql "$DATABASE_URL" < listing-<date>.sql`, then boot the resolver first so `verified_tokens` hydrates, and only then the executor. After a restore, run one dry-run alert and check the spend journal day totals before live mode.

## Shutdown window

On SIGTERM the executor stops taking mutating work (503) and waits up to 20 seconds for tracked sends, including withdraws. That window is far shorter than one send's worst case (`sendBoundMs`, about 190 seconds at the default timeouts), so a restart during a slow confirmation often cuts it. A send whose confirmation runs past the window is not abandoned on chain: its journal row stays `reserved` with the signed hash, a retry of the same id returns `exists`, and boot reconciliation settles it. The process exits 1 when the window expires with work still in flight, so the platform restart is visible.
