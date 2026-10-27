# ADR 0002: Service boundaries

## Status

Accepted. Rocket stays read-only. This tree is not imported by `rocket/`.

## Decision

One HTTP process, the executor, owns quotes, the spend journal, and signing. This tree has no resolver process. The Dockerfile command is `node dist/src/executor-server.js`, and the Railway root is the repository root. `npm run start:executor` runs that same file. `npm run start:cli` and `npm run start:mcp` are the local CLI and MCP scripts. The MCP tools are `wallet_status`, `quote`, `swap`, `bridge`, `balance`, and `transfer`.

`GET /health` is open and returns `{"ok":true}`. Mutating routes require `Authorization: Bearer` compared with `EXECUTOR_AUTH_TOKEN` by SHA-256 and `timingSafeEqual`. Fastify sets a 32 KiB body limit, a 10 second request timeout, a global rate limit of 60 requests a minute, and a limit of 10 a minute on `POST /execute` and `POST /rebalance`. A POST that is not JSON is a 415. Request bodies and aggregator responses are parsed with Zod. A shape that does not match is a skip or a 400, not a guess.

`execute()` is the only buy path. Dry-run is the default because default boot leaves `WHALE_BROADCAST` unset. `config.live` is true only when that variable is the exact string `true`. If `LISTING_TRADER_LIVE` is set, boot throws. If `WITHDRAW_ENABLED` is set, boot throws. `POST /withdraw` is absent.

Spend is a reservation. The executor keeps one `pg.Pool` per database URL. Inside one transaction it takes `pg_advisory_xact_lock(hashtext(day))`, sums `reserved` and `committed` rows for that day, and inserts `reserved` only when the sum plus the notional is inside `DAILY_USD_CAP`. The day is `SPEND_TIMEZONE`, default `UTC`. `America/Argentina/Buenos_Aires` is the ART boundary. A conflict with a reserved or committed key returns `exists`. A released key can be reserved again. After a successful broadcast the row becomes `committed`. A failure before broadcast sets `released`. A committed row is not deleted. Rows from the previous schema default to `committed`, so they still count.

Quotes race with `AbortSignal.timeout` per provider and a shared deadline (`QUOTE_TIMEOUT_MS` 350, `QUOTE_DEADLINE_MS` 500). A provider budget (30 a minute), three failures, or one compliance response opens that provider for 30 seconds. A 451, or a body matching sanction, OFAC, compliance, restricted jurisdiction, or geoblock, skips that provider. It is not retried on another host.

Screening runs in the executor before a live send. It is off when `WHALE_BROADCAST` is unset, and on in live mode unless `TOKEN_SCREENING=false`. GoPlus `token_security` is required when screening is on. GoPlus covers chain ids 1, 10, 56, 137, 143, 324, 4663, 8453, 42161, 59144, 81457, 534352 and Solana (its `supported_chains` list), so HyperEVM is denied. Blockaid `POST /v0/token/scan` runs only when `BLOCKAID_API_KEY` is set and the chain has a Blockaid name. A chain without one is screened by GoPlus alone. A schema mismatch, a timeout, a honeypot, or a Blockaid result other than `Benign` rejects the token.

The executor binds `0.0.0.0` so the private network can reach it. If `RAILWAY_PUBLIC_DOMAIN` is set, boot throws. Do not attach a public domain. The dashboard setting is the operator's job. The code only refuses the variable Railway injects when a public domain exists.

Logs are pino. Authorization, API keys, and OKX signature headers are on the redact list. Error text also goes through `redactError`.

## Consequences

Run one executor. A second replica can double-send a dry-run idempotency miss, and the approval cache would disagree. The journal primary key still blocks a second live reservation for the same idempotency key.
