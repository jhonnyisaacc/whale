# Fees and route choice

This page explains how a quote becomes the route that can be signed. The numbers in `feeRank` and `gasCeilingUsd` are operator constants for ranking. They are not a live gas oracle and they are not a promise of the fee you will pay.

## What is compared

For each candidate chain the executor calls the aggregators that list that chain:

| Chain | Called when |
| --- | --- |
| Solana | Jupiter. OKX only when the three OKX credentials are set. Chain index `501`. |
| EVM | 0x on 1, 10, 56, 137, 8453, 42161, 59144, 534352, 4663, 999. KyberSwap where a slug is checked in. Velora on 1, 10, 56, 137, 8453, 42161. LI.FI same-chain on every EVM chain. 1inch only with `ONEINCH_API_KEY` and only on the chain ids checked in (not Blast, not Scroll, not Solana). OKX on its checked EVM set when credentials exist. |

Odos is not called. The vendor shut down the trading API. ParaSwap is called as Velora (`https://api.velora.xyz/prices`). Jumper is not called. Bridge quotes use LI.FI once.

Official hosts only. Required headers stay on those hosts: `0x-api-key` and `0x-version: v2`, Jupiter `x-api-key`, 1inch `Authorization: Bearer`, Kyber `x-client-id` (default `listing-trader`, an attribution name), Velora `partner`, LI.FI `integrator`, OKX HMAC headers. A compliance or sanctions response skips that provider. There is no mirror and no second host.

1inch Business requires the vendor's KYC or KYB. This service does not route around that.

## How a winner is chosen

Net output is bought amount times the pool USD price, minus the reported fee, minus reported gas or the gas ceiling when gas is missing.

| Chain | Gas ceiling, USD |
| --- | --- |
| Solana | 0.02 |
| Base, Arbitrum, Optimism | 0.03 |
| Polygon, BNB, Linea | 0.05 |
| Scroll, Blast | 0.08 |
| zkSync, Robinhood, HyperEVM | 0.1 |
| Ethereum | 2 |

`feeRank` breaks ties after net, impact, and fee. Lower is preferred: Solana 10, Base 20, Arbitrum 30, Optimism 40, Polygon 50, BNB 60, Linea 70, Scroll 80, Blast 90, zkSync 100, Robinhood 110, HyperEVM 120, HyperCore 150, Ethereum 200. An unknown chain is 1000. Monad is not in this table, so it ranks as 1000. That number is the unknown-chain rank, not a measured Monad fee.

The deadline is 500 ms. Each provider also has a 350 ms timeout. Late responses are aborted. They are not selected for arriving first.

## Approvals

Repeat trades should not pay approve gas. The hot path does not sign `approve` unless `ALLOW_HOT_APPROVAL=true`. A 0x quote that reports `issues.allowance.actual` at or above the sell amount is remembered. Otherwise the in-memory cache must already cover the router. One replica holds that cache. Seed it with `APPROVAL_CACHE_JSON` after the root-quorum approval.

## Bridges stay off the buy

`POST /rebalance` plans a move of inventory. It does not broadcast, and nothing else in this service submits a bridge. Destinations must be in both `ownAddresses` and `OWNER_WITHDRAW_ADDRESSES`. Caps are `MAX_BRIDGE_USD` (25), `MAX_BRIDGE_FEE_BPS` (50), and `DAILY_BRIDGE_USD_CAP` (50).

| Provider | Call |
| --- | --- |
| LI.FI | Same client as swaps, integrator query when set. |
| Across | `GET https://app.across.to/api/swap/approval` with `Authorization: Bearer` and `integratorId`. Do not cache. Quotes expire. |
| Relay | `POST https://api.relay.link/quote/v2` with `x-api-key`. `tradeType` is `EXACT_INPUT`. `details.recipient` must be our wallet. |
| deBridge | `GET https://dln.debridge.finance/v1.0/dln/order/create-tx`. `dstChainTokenOutAmount=auto`. Do not replay the returned amounts into a second call. `accesstoken` only when `DEBRIDGE_ACCESS_TOKEN` is set. |

Checked deBridge source chain ids that overlap this service are 1, 10, 56, 137, 4663, 8453, 42161, and 59144. Solana is not assumed.

Keep small USDC and native balances on the chains you actually trade. The targets in config (`TARGET_USDC_USD` 20, `TARGET_NATIVE_USD` 2) are planning hints for the operator. They do not place a bridge.

## MEV

Solana: `JITO_ENABLED=true` posts `sendTransaction` to `https://mainnet.block-engine.jito.wtf/api/v1/transactions` unless `JITO_BLOCK_ENGINE_URL` is set. The body is base64. `bundleOnly` is not set. Without Jito, the Jupiter `/swap` body asks for a `veryHigh` priority fee capped at `SOLANA_MAX_PRIORITY_LAMPORTS`. With Jito, it asks for `jitoTipLamports` (`JITO_TIP_LAMPORTS`, default 10000) instead, because Jupiter accepts one or the other. Jupiter picks the tip account. The signing policy allows a native transfer only to the hot wallet, its wrapped SOL account, or one of the eight Jito tip accounts it lists, so a tip to any other account is not signed. It also refuses tips above `JITO_TIP_LAMPORTS`, and a compute-unit price times limit that, with tips, exceeds `SOLANA_MAX_PRIORITY_LAMPORTS`.

EVM: set `MEV_RPC_URL_1=https://rpc.flashbots.net` for Ethereum. Other chains use `MEV_RPC_URL_<chainId>`. Simulation stays on the normal RPC. The protect URL is the retail `eth_sendRawTransaction` path. Do not use a deprecated `?url=` parameter.
