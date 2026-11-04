# whale-signer

The `self_hosted` signing level from [ADR 0003](../docs/adr/0003-hosted-control-plane.md). The keys and the policy live on the user's machine. Whale can ask for a signature. It cannot read a key, edit the policy, or reset the daily totals.

## Use

```bash
cargo build --release --locked
export WHALE_SIGNER_PASSPHRASE='at least twelve characters'
./target/release/whale-signer init --keystore keystore.json
./target/release/whale-signer address --keystore keystore.json
./target/release/whale-signer sign --keystore keystore.json --policy policy.json --ledger ledger.json < job.json
```

To work with a hosted gateway, ask the dashboard for a connection code (it takes your passkey), then:

```bash
./target/release/whale-signer connect --keystore keystore.json --gateway https://<gateway> --wallet <wallet id> --code wreg_...
./target/release/whale-signer serve --keystore keystore.json --gateway https://<gateway> --policy policy.json --ledger ledger.json
```

`connect` signs the registration text (wallet id plus code) with both keys. The EVM key uses EIP-191. The gateway checks both signatures before it takes these addresses, and stores the returned token next to the keystore with owner-only permissions. `serve` long-polls `/signer/v1/jobs` over https, so no inbound port is opened. It checks each job with the same code as `sign` and posts the decision back. `--once` handles at most one job, for testing.

`init` refuses to overwrite a keystore. `sign` prints one JSON decision and exits:
- 0 when it signed;
- 3 when it refused;
- 2 on a usage or file error.


## Keystore

An EVM key (secp256k1) and a Solana key (ed25519) are generated from the OS random source. On disk they sit under scrypt (N = 2^17, r = 8, p = 1) and ChaCha20-Poly1305. The file also carries the public addresses, so `address` needs no passphrase. Seed buffers are zeroized once the signing keys exist.

## Jobs

```json
{ "id": "...", "kind": "evm", "chainId": 8453, "tx": { "nonce": "7", "to": "0x...", "value": "0", "data": "0x...", "gas": "300000", "maxFeePerGas": "...", "maxPriorityFeePerGas": "..." } }
{ "id": "...", "kind": "solana", "message": "<base64 message bytes>" }
```

An EVM job returns `signedTransaction`, an EIP-1559 transaction the signer encoded from the fields it checked. A Solana job returns the base58 `signature` over the exact message it parsed. The signer only signs as the sole signer and fee payer.

## Policy

Everything not listed is refused. See `vectors/policy.json` for a full example.

| EVM call | Rule |
| --- | --- |
| Native transfer | `to` is in `evm.destinations`, and the value fits the `<chainId>:native` daily limit |
| ERC-20 `transfer` | Recipient in `evm.destinations`, no native value, and the amount fits the `<chainId>:<token>` daily limit |
| ERC-20 `approve` | Spender is a router listed for the chain, and the amount is at most the token's daily limit. An unlimited approval is refused |
| KyberSwap `swap` / `swapSimpleMode`, 0x `AllowanceHolder.exec` into `Settler.execute`, direct `Settler.execute` | The router is listed. The decoded recipient is this wallet. The sold token and amount count against the daily limit. Native value stays at or under `evm.maxValueWei` |
| Anything else | Refused, unless `allowUndecodedRouterCalls` is true and the target is a listed router |

On Solana, every program must be one of these:
- System, Compute Budget, Token, Token-2022, or Associated Token Account;
- a program in `solana.programs`.

The instruction rules:

| Program | What is allowed |
| --- | --- |
| System | Only SOL transfers from this wallet: to itself, to a Jito tip account, or to a listed destination within the `solana:native` daily limit |
| Token and Token-2022 | `SyncNative`, `CloseAccount` back to this wallet, and `InitializeAccount3` owned by it. `TransferChecked` only to a listed token account, counted against `solana:<mint>` |
| Associated Token Account | A create funded by this wallet, for itself or a listed destination |
| Compute Budget | Unit price times unit limit, plus tips, at or under `solana.maxPriorityLamports` |

A rule that needs an account loaded from an address lookup table refuses.

Jupiter v6, when listed in `solana.programs`, is decoded the way the app signing policy decodes it. Only the four exact-in routes pass, and each one must meet three conditions:
- the transfer authority is this wallet;
- the platform fee account is unset;
- every destination is this wallet's wrapped SOL account, or its associated token account for the output mint under Token or Token-2022.

The signer derives those addresses itself, with the runtime's program-derived-address search. Any other program in `solana.programs` is trusted with this wallet's signature without being decoded.

The daily totals live in `--ledger`, keyed by UTC day. The file is replaced atomically, and it moves only after a signature exists.

## Supply chain

- Every crate is pinned with `=` in `Cargo.toml`, and `Cargo.lock` is committed.
- Every locked crate was published at least seven days before it was added. On 2026-11-03 that meant holding `ctutils` at 0.4.6.
- The toolchain is pinned in `rust-toolchain.toml`.
- CI runs `cargo fmt --check`, `cargo clippy --locked -- -D warnings`, and `cargo test --locked`.
- There is no serde derive, so no proc-macro runs for this crate's own code.

## Tests

`vectors/generate.mjs` builds the cases with viem and `node:crypto`. The Rust tests then require the same decision for every case, and byte-identical signed transactions and signatures where one is signed. `test/signer-vectors.test.ts` checks that the app's swap decoder reads the same recipients from the same calldata.
