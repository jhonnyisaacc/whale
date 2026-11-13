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

`init` refuses if the file already exists. On Unix it creates the keystore readable only by its owner (mode 0600). Other platforms have no such mode, so the file inherits the permissions of its directory, and `init` prints a warning to stderr. `sign` prints one JSON decision and exits:
- 0 when it signed;
- 3 when it refused;
- 2 on a usage or file error.

The connection to the gateway, an outbound long-poll, is the next step. Until then `sign` is the whole interface.

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
| ERC-20 `approve` | Spender is a router listed for the chain and is not a Settler in `evm.settlers`, no native value, and the amount counts against the `<chainId>:<token>` daily limit. An unlimited approval is refused. A swap that needs an approval first therefore counts twice |
| KyberSwap `swap` / `swapSimpleMode`, 0x `AllowanceHolder.exec` into `Settler.execute`, direct `Settler.execute` | The router is listed. The decoded recipient is this wallet. For 0x, the call reaches a Settler listed in `evm.settlers` for the chain, and `exec`'s `operator` equals its `target`. For KyberSwap, the executor (`caller` or `callTarget`), a nonzero `approveTarget`, every `srcReceivers` entry, and every `feeReceivers` entry are listed in `evm.kyberExecutors` for the chain, and the `srcAmounts` add up to no more than `amount`. The sold token and amount count against the daily limit. Native value stays at or under `evm.maxValueWei` |
| Anything else | Refused, unless `allowUndecodedRouterCalls` is true and the target is a listed router |

**The recipient rules do not bound loss. The daily limits do.** The swap rules stop a naive or buggy client from naming another recipient where the ABI puts it. A compromised Whale does not have to make that mistake:
- The signer never reads 0x `Settler.execute` `actions`. `exec(Settler, USDC, amount, Settler, execute({recipient: this wallet, buyToken: 0, minAmountOut: 0}, [TRANSFER_FROM(attacker, ...)]))` passes every rule, and Settler sends the lent `amount` to the attacker.
- KyberSwap's `targetData` is chosen by Whale and runs in the listed executor, so it decides where the sold tokens go.

So each swap can lose its whole sold amount. What a compromised Whale can move in a day is bounded by the daily limits, the fee caps, and `evm.maxValueWei`, not by who the calldata names. [ADR 0004](../docs/adr/0004-smart-account-level.md) reaches the same conclusion for the smart account level. Set each limit to what you accept losing in a day. `allowUndecodedRouterCalls` lifts this bound for tokens: an undecoded call to a listed router can spend an allowance approved on an earlier day without charging today, so keep it false unless you accept that.

Every EVM transaction also pays its fee from the native balance. `gas` times `maxFeePerGas` must be at or under `evm.maxFeeWei`, and that amount counts against the `<chainId>:native` daily limit. `maxPriorityFeePerGas` may not exceed `maxFeePerGas`.

On Solana, every program must be one of these:
- System, Compute Budget, Token, Token-2022, or Associated Token Account;
- a program in `solana.programs`.

The instruction rules:

| Program | What is allowed |
| --- | --- |
| System | Only SOL transfers from this wallet: to itself, to its wrapped SOL account, to a Jito tip account, or to a listed destination within the `solana:native` daily limit. A transfer to itself or its wrapped SOL account counts nothing |
| Token and Token-2022 | `SyncNative`, `CloseAccount` back to this wallet, and `InitializeAccount3` owned by it. `TransferChecked` only to a listed token account, counted against `solana:<mint>` |
| Associated Token Account | A create funded by this wallet, for itself or a listed destination. Every create counts 4,454,400 lamports, the rent for a 512-byte account, against `solana:native`. A create for this wallet counts too, because a mint can make the account impossible to close |
| Compute Budget | Unit price times unit limit, plus tips, at or under `solana.maxPriorityLamports` |

Every Solana transaction also pays its fee from the wallet. The 5000 lamport signature fee, plus the priority fee at the requested unit limit (1,400,000 units when none is set), plus every Jito tip, counts against the `solana:native` daily limit.

A rule that needs an account loaded from an address lookup table refuses. The one exception is the Jupiter output mint, below.

A program in `solana.programs` must also have an instruction rule in the signer, or every instruction to it is refused. Listing a program never trusts it unchecked.

Jupiter v6, when listed in `solana.programs`, passes only its two exact-in routes that carry their sold amount, `route` and `sharedAccountsRoute`. Each one must meet five conditions:
- the transfer authority is this wallet;
- the platform fee account is unset;
- every destination is this wallet's wrapped SOL account, or its associated token account for the output mint under Token or Token-2022;
- the source is this wallet's wrapped SOL account, or its associated token account for a mint with a `solana:<mint>` daily limit;
- the arguments decode exactly, with no bytes left over.

The signer derives those addresses itself, with the runtime's program-derived-address search. Jupiter transactions often load the output mint from an address lookup table. The signer then cannot read the mint, so a destination passes if it is this wallet's account for wrapped SOL, USDC, or USDT, the mints the app quotes against. The app signing policy does the same. Every other Jupiter account the rules read must be static.

The signer decodes the whole argument list: every route plan step with its `Swap` variant, `percent`, `inputIndex` and `outputIndex`, then `inAmount`, `quotedOutAmount`, `slippageBps` and `platformFeeBps`. `inAmount` counts against `solana:native` when the source is the wrapped SOL account, and against `solana:<mint>` otherwise. SOL moved into the wrapped SOL account counts nothing by itself, so SOL wrapped and sold in one transaction counts once, when it is sold. A route through a `Swap` variant the signer does not know, or one whose payload it cannot size, is refused. Today that is `DynamicV1` and `DynamicV2`, whose payloads nest a second enum with fields.

The `Swap` payload sizes in `src/jupiter_swaps.rs` come from Jupiter's on-chain Anchor IDL for `JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4`, read from account `C88XWfp26heEmDkmfSzeXP7Fd7GQJ2j9dDTUsyiZbUTa` at slot 469066528 on 2026-11-13. That IDL has 211 `Swap` variants, and its inflated JSON has SHA-256 `11e04af55c8b102ac4230b55cb77df7ab1ce30295f18e5cdb2432d8279e7b981`. `node vectors/jupiter-swaps.mjs` reads the current IDL and rewrites the table, and `node vectors/jupiter-swaps.mjs <idl.json>` rebuilds it from a saved copy.

Jupiter instructions outside those two are refused. That includes `exactOutRoute`, `sharedAccountsExactOutRoute`, and `routeV2`, which most current Jupiter traffic uses. It also includes the two token ledger routes, whose sold amount is read from a token account when they run, not from the instruction.

A Jupiter swap usually comes with one or two associated token account creates, for wrapped SOL and for the output mint. Each create counts its 4,454,400 lamport rent bound against `solana:native`, also when it is idempotent and the account already exists, because the signer cannot see whether it does. A swap of 1,000,000 lamports to USDC that creates both, at 300,000 units and 100,000 micro-lamports per unit, counts 9,943,800 lamports: the 1,000,000 sold, 8,908,800 of rent bounds, the 5,000 lamport signature fee, and 30,000 lamports of priority. So a `solana:native` limit of 0.1 SOL allows 10 such swaps a day. Rent for this wallet's own accounts stays in its accounts and is recoverable by closing them, but it still leaves the spendable balance, so it counts.

**The Jupiter rules bound what a swap sells, not what it gets back.** A compromised Whale can set `quotedOutAmount` to 0 and route through a pool it controls, so each swap can lose its whole `inAmount`. That amount counts against the source token's daily limit, so a day of Jupiter swaps loses at most each `solana:<mint>` limit in that token and the `solana:native` limit in SOL and wrapped SOL, with fees, tips, and rent inside the same native limit. A token with no `solana:<mint>` limit cannot be sold through Jupiter at all. The signer does not read the accounts each route plan step passes to its AMM, so this bound assumes Jupiter takes `inAmount` from the source account the route names. Set each limit to what you accept losing in a day.

The daily totals live in `--ledger`, keyed by UTC day. The new totals are flushed to disk and then replace the file atomically, and they move only after a signature exists. A job holds an exclusive lock on a `.lock` file beside the ledger from reading the totals to writing them, so concurrent jobs cannot both spend the same headroom.

## Supply chain

- Every crate is pinned with `=` in `Cargo.toml`, and `Cargo.lock` is committed.
- Every locked crate was published at least seven days before it was added. On 2026-11-03 that meant holding `ctutils` at 0.4.6.
- The toolchain is pinned in `rust-toolchain.toml`.
- CI runs `cargo fmt --check`, `cargo clippy --locked -- -D warnings`, and `cargo test --locked`.
- There is no serde derive, so no proc-macro runs for this crate's own code.

## Tests

`vectors/generate.mjs` builds the cases with viem and `node:crypto`. The Rust tests then require the same decision for every case, and byte-identical signed transactions and signatures where one is signed. `test/signer-vectors.test.ts` checks that the app's swap decoder reads the same recipients from the same calldata.
