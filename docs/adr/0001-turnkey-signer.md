# ADR 0001: Turnkey is the live signer

## Status

Accepted for the listing trader. This does not admit a research experiment and it does not enable Rocket orders.

## Context

Live mode has to sign EVM swaps, Solana swaps, and Hyperliquid agent typed data. The owner asked for a managed signer, a policy engine on the provider, and the local keystore only as a fallback that stays off unless it is explicitly allowed.

Four options were compared against the public docs on 2026-10-21.

| Provider | What the policy can see | Fit |
| --- | --- | --- |
| Turnkey | `eth.tx.to`, `eth.tx.value`, `eth.tx.chain_id`, ABI function name, `solana.tx.program_keys.all`, and EIP-712 `primary_type`, domain, and message. Docs name Hyperliquid. | Meets the bar. |
| Privy server wallets | Contract, value, chain id, Solana program ids, and EIP-712. | Documented server-side user wallets need a user access token, which this unattended path does not have. |
| Coinbase CDP server wallets | EVM and Solana policies, including `netUSDChange` and program ids. Spend permissions are smart-account based. | Hyperliquid's custom Agent domain (chain id 1337) was not a documented first-class policy target. |
| AWS KMS | `ECC_SECG_P256K1` and `ECC_NIST_EDWARDS25519`. IAM can pin the signing algorithm. | IAM cannot parse transaction `to`, value, chain id, or a Solana program id. That fails the provider-side policy requirement. |

Turnkey latency is one HTTPS round trip after the quote. That cost is accepted. The enclave is the control that the app cannot forge.

## Decision

`TransactionSigner` is the interface. `loadManagedSigner` builds a Turnkey backend when `TURNKEY_ORGANIZATION_ID`, `TURNKEY_API_PUBLIC_KEY`, `TURNKEY_API_PRIVATE_KEY`, and `TURNKEY_EVM_ADDRESS` are set. Solana and Hyperliquid addresses come from `TURNKEY_SOLANA_ADDRESS` and `TURNKEY_HYPERLIQUID_ADDRESS`. They are not derived in this process.

The encrypted keystore remains for dry-run on a laptop. Live mode throws if Turnkey is not configured. There is no flag that puts the keystore back into live mode.

Policies are code. `assertEvmSigning`, `assertSolanaSigning`, and `assertHyperliquidSigning` run in `withPolicy` before the backend is called. `policies/turnkey.json` is `turnkeyPolicyTemplate()` and a test fails if the file drifts. The console copy is `turnkeyPolicyDocument` with the real API user id, the wallet ids, `ROUTER_ALLOWLIST_JSON`, and `MAX_NATIVE_VALUE_WEI`. Each policy is scoped by `wallet.id`. An empty router list for a chain denies every EVM swap on that chain. Native value defaults to `2000000000000000` wei (0.002 of the native token) and follows `MAX_NATIVE_VALUE_WEI`. That number is a service policy, not a price. A token sell must send value 0. A Solana native transfer may pay the hot wallet, an allowlisted withdraw address, the hot wallet's wrapped SOL account, or a published Jito tip account.

## Hyperliquid limit

Hyperliquid L1 actions are msgpack-hashed into `connectionId`. The EIP-712 payload is `Agent { source, connectionId }` with domain `Exchange`, version `1`, chain id `1337`, and the zero verifying contract. Turnkey can pin that domain and `source == "a"`. It cannot see `withdraw3` inside `connectionId`. The app calls `assertTradableAction` and refuses `withdraw3`, `usdSend`, `spotSend`, `sendAsset`, `agentSendAsset`, `usdClassTransfer`, `vaultTransfer`, and `approveAgent` before submit. This is an application ban. The official pages checked do not state a protocol-level agent withdraw ban. The signature has not been golden-tested against the Python SDK. A staging signature is required before mainnet Hyperliquid sends are trusted.

## Consequences

The API private key can ask Turnkey to sign, and the policy is what stops a bad transaction. Compromise of that API key is still an incident: revoke the API user. The root quorum is the only path for a new router approval. One executor replica, because the approval cache and the idempotency map are in memory.
