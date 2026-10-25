# ADR 0002: Service boundaries

## Status

Accepted for the listing trader. Rocket stays read-only. This tree is not imported by `rocket/`.

## Decision

Two processes share Postgres and nothing else.

The resolver owns the watchlist. `GET /health` is open. `/alert` requires `Authorization: Bearer` compared with `AUTH_TOKEN` by SHA-256 and `timingSafeEqual`. There is no `/replace` route. Fastify sets a 32 KiB body limit, a 10 second request timeout, a global rate limit of 60 requests a minute, and a limit of 10 a minute on `/execute`, `/listing`, `/withdraw`, `/rebalance`, and `/alert`. A POST that is not JSON is a 415. Request bodies and aggregator responses are parsed with Zod. A shape that does not match is a skip or a 400, not a guess.

The executor owns quotes, the spend journal, and signing. `execute()` is the only buy path. Dry-run is the default. `LISTING_TRADER_LIVE` must be the exact string `true`.

Spend is a reservation. The executor keeps one `pg.Pool` per database URL. Inside one transaction it takes `pg_advisory_xact_lock(hashtext(day))`, sums `reserved` and `committed` rows for that day, and inserts `reserved` only when the sum plus the notional is inside `DAILY_USD_CAP`. The day is `SPEND_TIMEZONE`, default `UTC`. `America/Argentina/Buenos_Aires` is the ART boundary. A conflict with a reserved or committed key returns `exists`. A released key can be reserved again. After a successful broadcast the row becomes `committed`. A failure before broadcast sets `released`. A committed row is not deleted. Rows from the previous schema default to `committed`, so they still count.

Quotes race with `AbortSignal.timeout` per provider and a shared deadline (`QUOTE_TIMEOUT_MS` 350, `QUOTE_DEADLINE_MS` 500). A provider budget (30 a minute), three failures, or one compliance response opens that provider for 30 seconds. A 451, or a body matching sanction, OFAC, compliance, restricted jurisdiction, or geoblock, skips that provider. It is not retried on another host.

`TOKEN_SCREENING=true` runs only on the resolver's unlisted live lookup. GoPlus `token_security` is required. GoPlus covers chain ids 1, 10, 56, 137, 143, 324, 4663, 8453, 42161, 59144, 81457, 534352 and Solana (its `supported_chains` list), so HyperEVM is always denied. Blockaid `POST /v0/token/scan` runs only when `BLOCKAID_API_KEY` is set and the chain has a Blockaid name. A chain without one is screened by GoPlus alone. A schema mismatch, a timeout, a honeypot, or a Blockaid result other than `Benign` rejects the token. The watchlist hot path does not call either vendor. Screening is off by default.

Railway services bind `0.0.0.0` so the private network can reach them. If `RAILWAY_PUBLIC_DOMAIN` is set, boot throws. Do not attach a public domain. The dashboard setting is the operator's job. The code only refuses the variable Railway injects when a public domain exists.

Logs are pino. Authorization, API keys, and OKX signature headers are on the redact list. Error text also goes through `redactError`.

## Consequences

Run one executor. A second replica can double-send a dry-run idempotency miss, and the approval cache would disagree. The journal primary key still blocks a second live reservation for the same alert id.
