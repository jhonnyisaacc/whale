# whale-signer

The `self_hosted` signing level from [ADR 0003](../docs/adr/0003-hosted-control-plane.md). The keys and the policy live on the user's machine. Whale can ask for a signature. It cannot read a key, edit the policy, or reset the daily totals.

## Use

```bash
cargo build --release --locked
export WHALE_SIGNER_PASSPHRASE='at least twelve characters'
./target/release/whale-signer init --keystore keystore.json
./target/release/whale-signer address --keystore keystore.json
./target/release/whale-signer address --keystore keystore.json --network bitcoin
./target/release/whale-signer sign --keystore keystore.json --policy policy.json --ledger ledger.json < job.json
```

To work with a hosted gateway, ask the dashboard for a connection code (it takes your passkey), then:

```bash
./target/release/whale-signer connect --keystore keystore.json --gateway https://<gateway> --wallet <wallet id> --code wreg_...
./target/release/whale-signer serve --keystore keystore.json --gateway https://<gateway> --policy policy.json --ledger ledger.json
```

To work with the local Whale MCP server instead, write a random token of at least 32 characters to `keystore.token` with mode 0600, start the MCP server with `WHALE_SIGNER_KEYSTORE=keystore.json`, then:

```bash
./target/release/whale-signer serve --keystore keystore.json --gateway http://127.0.0.1:8790 --policy policy.json --ledger ledger.json
```

The MCP server reads only the public addresses from the keystore. It never holds the passphrase or the policy.

`connect` signs the registration text (wallet id plus code) with both keys. The EVM key uses EIP-191. The gateway checks both signatures before it takes these addresses, and stores the returned token next to the keystore with owner-only permissions. `serve` long-polls `/signer/v1/jobs` over https, so no inbound port is opened. It checks each job with the same code as `sign` and posts the decision back. `--once` handles at most one job, for testing.

`init` refuses if the file already exists. On Unix it creates the keystore readable only by its owner (mode 0600). Other platforms have no such mode, so the file inherits the permissions of its directory, and `init` prints a warning to stderr. `sign` prints one JSON decision and exits:
- 0 when it signed;
- 3 when it refused;
- 2 on a usage or file error.

## Keystore

An EVM key (secp256k1) and a Solana key (ed25519) are generated from the OS random source. On disk they sit under scrypt (N = 2^17, r = 8, p = 1) and ChaCha20-Poly1305. The file also carries the public addresses and `bitcoinPublicKey`, the 33-byte compressed public key of the EVM key in hex, so `address` needs no passphrase. Seed buffers are zeroized once the signing keys exist.

Bitcoin uses the EVM key. The wallet's bitcoin address is the P2WPKH (BIP84 format) address of `bitcoinPublicKey`. The key is a raw key with no HD seed, so no `m/84'` path applies. `address --network bitcoin|testnet|signet|regtest` prints that address. Before it prints, it checks that `bitcoinPublicKey` derives the keystore's `evmAddress`, so an edited field cannot redirect deposits.

A keystore made before bitcoin support has no `bitcoinPublicKey`. Run `upgrade` once to add it:

```bash
./target/release/whale-signer upgrade --keystore keystore.json
```

`upgrade` opens the keystore with `WHALE_SIGNER_PASSPHRASE` and derives the key from the sealed secret. It writes a temporary file with mode 0600, flushes it, and renames it over the keystore, so a crash leaves the old file or the new one. A second run changes nothing. If the file already has a `bitcoinPublicKey` that does not match the sealed key, `upgrade` refuses and leaves the file unchanged.

## Jobs

```json
{ "id": "...", "kind": "evm", "chainId": 1, "tx": { "nonce": "7", "to": "0x...", "value": "0", "data": "0x...", "gas": "300000", "maxFeePerGas": "...", "maxPriorityFeePerGas": "..." } }
{ "id": "...", "kind": "solana", "message": "<base64 message bytes>" }
{ "id": "...", "kind": "hypercore", "network": "testnet", "nonce": 1793664000000, "action": { "type": "order", ... } }
{ "id": "...", "kind": "bitcoin", "transaction": "<unsigned tx hex>", "previous": ["<full previous tx hex for input 0>", "..."] }
```

An EVM job returns `signedTransaction`, an EIP-1559 transaction the signer encoded from the fields it checked. A Solana job returns the base58 `signature` over the exact message it parsed. The signer only signs as the sole signer and fee payer. A HyperCore job returns `signature` as `{ r, s, v }`, the form Hyperliquid's `/exchange` takes. The signer decodes `order`, `cancel`, `updateLeverage`, and `withdraw3`. It refuses every other action type and any field it does not decode, such as a client order id, a builder fee, or a vault. It re-encodes the decoded action as canonical msgpack and signs the L1 phantom agent, or for `withdraw3` the `HyperliquidTransaction:Withdraw` typed data. The HyperCore account is this wallet's EVM key, so it signs withdrawals as the account owner.

A bitcoin job returns `signedTransaction`, the hex of the same transaction with a P2WPKH witness on every input. `transaction` is the unsigned transaction with empty scriptSigs and no witness. `previous` lists, in input order, the whole transaction each input spends. It may be in witness form, and it may repeat. The job states no amount, no script, no network, and no sighash type. The signer hashes each previous transaction, requires the hash to equal the input's outpoint txid, and reads the amount and script from that transaction. It signs every input with `SIGHASH_ALL` over the BIP143 digest, with RFC 6979 nonces and low S.

The signer needs whole previous transactions because the BIP143 digest commits only to the amount of the input it signs. If the signer took amounts from the job, a compromised Whale could understate them, and the real fee would be far above the fee the signer checked. The 2020 segwit fee attack on hardware wallets worked this way. A previous transaction cannot lie about an amount, because then it no longer hashes to the txid the input names.

## Policy

Everything not listed is refused. See `vectors/policy.json` for a full example.

| EVM call | Rule |
| --- | --- |
| Native transfer | `to` is in `evm.destinations`, and the value fits the `<chainId>:native` daily limit |
| ERC-20 `transfer` | Recipient in `evm.destinations`, no native value, and the amount fits the `<chainId>:<token>` daily limit |
| ERC-20 `approve` | Spender is a router or a bridge contract listed for the chain and is not a Settler in `evm.settlers`, no native value, and the amount counts against the `<chainId>:<token>` daily limit. An unlimited approval is refused. A swap that needs an approval first therefore counts twice |
| KyberSwap `swap` / `swapSimpleMode`, 0x `AllowanceHolder.exec` into `Settler.execute` | The router is listed. The decoded recipient is this wallet. For 0x, the call reaches a Settler listed in `evm.settlers` for the chain, and `exec`'s `operator` equals its `target`. For KyberSwap, the executor (`caller` or `callTarget`), a nonzero `approveTarget`, every `srcReceivers` entry, and every `feeReceivers` entry are listed in `evm.kyberExecutors` for the chain, and the `srcAmounts` add up to no more than `amount`. The sold token and amount count against the daily limit. Native value stays at or under `evm.maxValueWei` |
| LI.FI `startBridgeTokensViaAcrossV4` and `swapAndStartBridgeTokensViaAcrossV4`, Across SpokePool `deposit` | The call goes to the contract `evm.bridges` lists for that provider on the chain. The destination chain is another chain in `evm.chains`. The recipient is this wallet or in `evm.destinations`, and the refund address is this wallet. LI.FI's `BridgeData.receiver` and `receiverAddress` must agree. No destination call or message, no exclusive relayer and no exclusivity period, and no native value. The input token and the output token (`outputToken`, or LI.FI's `receivingAssetId`) must be the same USDC, USDT, or WETH on the two chains, from the table in `src/bridge_tokens.rs`. The minimum output (`outputAmount`, or for `swapAndStartBridgeTokensViaAcrossV4` the `minAmount` times `outputAmountMultiplier`, which is what the facet bridges at least) must be at least the charge less `evm.maxBridgeFeeBps` (default 50), after the two tokens' decimals are matched. LI.FI's `outputAmountMultiplier` may not be above par (1e18, scaled by the two tokens' decimals). The exact token pull (LI.FI's `minAmount`, the `fromAmount` of each swap step that `requiresDeposit` before a LI.FI bridge, or Across's `inputAmount`) counts against the `<chainId>:<token>` daily limit. Before a LI.FI bridge, every pulled swap step sends the bridged token and the last step receives it, and each step passes the LI.FI swap step table, so a fee step forwards at most 50 bps. Relay's `depositErc20` names no destination, so it is refused |
| LI.FI GenericSwapFacetV3 `swapTokens*` | The diamond is listed. The decoded `_receiver` is this wallet. Every swap step's `callTo` and `approveTo` are in the built-in LI.FI step table for the chain (`src/lifi.rs`, the same table as the app's `src/signing-policy/lifi-steps.ts`), which has entries for chains 324, 8453, and 42161 only. A step to the chain's LI.FI FeeForwarder must be `forwardERC20Fees` of the deposited token, or `forwardNativeFees` when the swap sells native, and all fee steps together may forward at most 50 bps of the deposit (the native value for a native sale). The deposited token and amount count against the daily limit |
| Anything else | Refused, unless `allowUndecodedRouterCalls` is true and the target is a listed router |

A bridge may land only on a chain in `evm.chains`. List there the same EVM chains the app enables through `ENABLED_CHAINS` and `DISABLED_CHAINS`, and set `evm.maxBridgeFeeBps` to the app's `MAX_BRIDGE_FEE_BPS`. Ethereum (1) is off in the app until `ENABLED_CHAINS` names it, so leave 1 out of `evm.chains` until then. The signer cannot read the app's config, so the two must be kept in step by hand.

Direct `Settler.execute` is refused while its `actions` are not decoded: a recipient field alone cannot prove which token or amount the call spends, especially when an allowance already exists.

**The recipient rules do not bound loss. The daily limits do.** The swap rules stop a naive or buggy client from naming another recipient where the ABI puts it. A compromised Whale does not have to make that mistake:
- The signer never reads 0x `Settler.execute` `actions`. `exec(Settler, USDC, amount, Settler, execute({recipient: this wallet, buyToken: 0, minAmountOut: 0}, [TRANSFER_FROM(attacker, ...)]))` passes every rule, and Settler sends the lent `amount` to the attacker.
- KyberSwap's `targetData` is chosen by Whale and runs in the listed executor, so it decides where the sold tokens go.
- A LI.FI swap step's `callData` is chosen by Whale. The listed step targets are generic aggregator routers (1inch, Sushi, OKX, Paraswap, KyberSwap, and others), and their calldata names the executor or pool that receives the sold tokens.

So each swap can lose its whole sold amount. What a compromised Whale can move in a day is bounded by the daily limits, the fee caps, and `evm.maxValueWei`, not by who the calldata names. [ADR 0004](../docs/adr/0004-smart-account-level.md) reaches the same conclusion for the smart account level. Set each limit to what you accept losing in a day. `allowUndecodedRouterCalls` lifts this bound for tokens: an undecoded call to a listed router can spend an allowance approved on an earlier day without charging today, so keep it false unless you accept that.

Every EVM transaction also pays its fee from the native balance. `gas` times `maxFeePerGas` must be at or under `evm.maxFeeWei`, and that amount counts against the `<chainId>:native` daily limit. `maxPriorityFeePerGas` may not exceed `maxFeePerGas`. Chains 10 (Optimism), 8453 (Base), 81457 (Blast), and 534352 (Scroll) also charge a separate L1 data fee, which the transaction does not cap and the signer cannot read from the chain. On Optimism, Base, and Scroll the signer adds a fixed L1 fee budget to `gas` times `maxFeePerGas`, both for the `evm.maxFeeWei` check and for the `<chainId>:native` charge, and refuses calldata above the cap that budget covers:

| Chain | Calldata cap | L1 fee budget |
| --- | --- | --- |
| Optimism (10) | 20,480 bytes | 70,000,000,000,000 wei |
| Base (8453) | 20,480 bytes | 60,000,000,000,000 wei |
| Scroll (534352) | 4,096 bytes | 5,000,000,000,000,000 wei |

The network still charges the real L1 fee. The budget is bookkeeping, so the native daily limit fills faster than the real spend. Each budget covers a transaction at the cap with random calldata at an L1 base fee of 20 gwei and a blob base fee of 2 gwei, measured with `node scripts/l1-fee-budget.mjs`. Above those prices the real fee can pass the budget. Blast is refused and has no budget, because the chain is winding down. The table lives in `l1_data_fee` in `src/evm.rs`. `tests/l1_fee.rs` checks it against `vectors/chains.json`, which `generate.mjs` writes from the app's `DEFAULT_EVM_FEE_LIMITS`.

On Solana, every program must be one of these:
- System, Compute Budget, Token, Token-2022, or Associated Token Account;
- a program in `solana.programs`.

The instruction rules:

| Program | What is allowed |
| --- | --- |
| System | Only SOL transfers from this wallet: to itself, to its wrapped SOL account, to a Jito tip account, or to a listed destination within the `solana:native` daily limit |
| Token and Token-2022 | `SyncNative`, `CloseAccount` back to this wallet, and `InitializeAccount3` owned by it. `TransferChecked` only to a listed token account, counted against `solana:<mint>` |
| Associated Token Account | A create funded by this wallet, for itself or a listed destination. Every create counts 4,454,400 lamports, the rent for a 512-byte account, against `solana:native`. A create for this wallet counts too, because a mint can make the account impossible to close |
| Compute Budget | Unit price times unit limit, plus tips, at or under `solana.maxPriorityLamports` |

Every Solana transaction also pays its fee from the wallet. The 5000 lamport signature fee, plus the priority fee at the requested unit limit (1,400,000 units when none is set), plus every Jito tip, counts against the `solana:native` daily limit.

A rule that needs an account loaded from an address lookup table refuses.

A program in `solana.programs` must also have an instruction rule in the signer, or every instruction to it is refused. Listing a program never trusts it unchecked.

The signer parses a message the way the runtime does. It refuses an account index at or past the static plus lookup-table account count, a compact length that is not canonical or is above u16, bytes after the lookups, and any message version other than legacy and v0.

### Jupiter

When Jupiter v6 is in `solana.programs`, the signer signs only its `shared_accounts_route` instruction. It refuses `route`, the token ledger, exact-out, v2 and attestation routes, and every other Jupiter instruction. A Solana job that holds a Jupiter swap must name the bought mint in `buyMint`. The signer reads these accounts of the instruction, and each must be a static key:

| Slot | Account | Rule |
| --- | --- | --- |
| 2 | Transfer authority | This wallet |
| 3 | Source | This wallet's wrapped SOL account, which counts against `solana:native`, or its Token account for a mint with a `solana:<mint>` daily limit |
| 6 | Destination | This wallet's Token account for `buyMint`. A Token-2022 `buyMint` is refused for now |
| 9 | Platform fee | Unset, which Jupiter encodes as its own program id |

This wallet's key may appear in no other slot of the instruction, at index 0 or at any other static index. A signer cannot be loaded from a lookup table, so a route step cannot use this wallet's signature to move its tokens. Every other slot may come from a lookup table, because the rule does not read it. The signer never resolves lookup tables.

`buyMint` binds the destination by derivation. The signer derives this wallet's associated token account for `buyMint` under the Token program and requires the destination to equal it. A false `buyMint` derives another address, and the swap is refused. The signer trusts `buyMint` for nothing else. The signed bytes, and so the ledger's work digest, stay the message alone.

The signer decodes the whole argument list: every route plan step with its `Swap` variant, `percent`, `inputIndex` and `outputIndex`, then `inAmount`, `quotedOutAmount`, `slippageBps` and `platformFeeBps`, with no bytes left over. `inAmount` counts against the source token's daily limit. A step through a `Swap` variant the signer does not know, or one whose payload it cannot size, is refused. Today that is `DynamicV1` and `DynamicV2`. The payload sizes in `src/jupiter_swaps.rs` come from Jupiter's on-chain Anchor IDL, read from account `C88XWfp26heEmDkmfSzeXP7Fd7GQJ2j9dDTUsyiZbUTa` at slot 469066528 on 2026-11-13 and unchanged at slot 471382659 on 2026-11-19. The inflated IDL JSON has SHA-256 `11e04af55c8b102ac4230b55cb77df7ab1ce30295f18e5cdb2432d8279e7b981`. `node vectors/jupiter-swaps.mjs` reads the current IDL and rewrites the table.

**The Jupiter rule bounds what a swap sells, not what it gets back.** A compromised Whale can set `quotedOutAmount` to 0 and route through a pool it controls, so each swap can lose its whole `inAmount`. That amount counts against the sold token's daily limit, as an EVM swap's does. A token with no `solana:<mint>` limit cannot be sold through Jupiter. Set each limit to what you accept losing in a day.

Some real Jupiter routes pass this wallet to a step, for example a Manifest step. The signer refuses those. `vectors/jupiter-capture.mjs` rebuilds `vectors/jupiter.json` from `lite-api.jup.ag` for a public key whose seed is in that file and for a funded public address, and `vectors/jupiter-simulate.mjs` simulates the funded cases on mainnet with `sigVerify` off, as is and with a foreign token program in slot 0.

On HyperCore, the policy needs a `hypercore` section. The signer signs only for its `network` (`mainnet` or `testnet`). It refuses a job for the other network.

| Action | Rule |
| --- | --- |
| `order` | Every order is an immediate-or-cancel limit order. A builder-deployed perp (asset 100000 and up) is refused. What is charged depends on the side, because a sell's limit price is only a floor and can sit far below where it fills. A perp buy (asset below 10000) charges price times size, rounded up to micro-USD, against `hypercore:usdc`. A spot buy (asset 10000 to 99999) charges the same product against `hypercore:spot:<asset>` in micro-units of its quote token, because the action does not prove that the quote is USDC. A spot sell charges its size, in 1e-8 units of the sold token, against `hypercore:spot:<asset>:sold`. A perp sell charges its size, in 1e-8 units of the asset, against `hypercore:perp:<asset>:sold`, whether it is reduce-only or opens a short. A sell is refused when the policy sets no limit for its key |
| `updateLeverage` | Isolated only, from 1 to `hypercore.maxLeverage` (default 3, the same default as the app's `MAX_PERP_LEVERAGE`; a value above 50 is refused at load) |
| `cancel` | Allowed, with no charge |
| `withdraw3` | `destination` is this wallet's EVM address or in `evm.destinations`, written as lowercase hex. `hyperliquidChain` matches the network, `signatureChainId` is `0x66eee`, and `time` equals the job nonce. The amount, at most 6 decimals, counts against `hypercore:usdc` |

Trading fees are not charged. Hyperliquid takes them from the account on top of the notional.

The signer cannot see the account's current leverage or margin mode, so an order runs at whatever the account already has for that asset. A Hyperliquid order carries no margin mode, and Hyperliquid uses cross margin by default. A long cannot lose more than its notional at any leverage, so its USD charge bounds the loss. A perp short is bounded by its size per day, not by USD. Under cross margin a short can lose up to the whole HyperCore perp balance, because its loss grows with the price and draws on the whole account. The signer cannot force isolated margin on an order. Jhonny accepted this on 2026-11-19 to keep shorts. `updateLeverage` is bounded so that Whale's own leverage step stays isolated and small, but a job can skip that step.

Hyperliquid pays every `withdraw3` on Arbitrum. Before you list an address in `evm.destinations`, check that you control that address on Arbitrum. A contract deployed only on another chain may have no owner there.

On Bitcoin, the policy needs a `bitcoin` section:

```json
"bitcoin": { "network": "bitcoin", "destinations": ["bc1q..."], "maxFeeSats": "10000", "maxInputs": 20, "dailyLimits": { "bitcoin:native": "1000000" } }
```

`network` is `bitcoin`, `testnet`, `signet` or `regtest`. Each destination must be a P2PKH, P2SH, P2WPKH, P2WSH or P2TR address for that network, or the policy does not load. `maxFeeSats` is required. `maxInputs` defaults to 20. Without the section, every bitcoin job is refused. The signer checks the rules below in this order and refuses with the first one that fails. The app's `assertBitcoinSigning` checks the same rules in the same order with the same text, and `vectors/bitcoin.json` holds both to it.

| Rule | Refusal |
| --- | --- |
| `previous` has one transaction per input | `previous must list one transaction per input` |
| Each previous transaction hashes to the input's txid | `input <i>: the previous transaction does not hash to <txid>` |
| The previous transaction has the output the input names | `input <i>: the previous transaction has no output <vout>` |
| Version 2, lock time 0, sequence `0xfffffffd` on every input | `the transaction must be version 2, lock time 0, and sequence 0xfffffffd on every input` |
| No input has a scriptSig or a witness | `input <i> carries a signature already` |
| From 1 to `maxInputs` inputs | `the transaction has no inputs`, `<n> inputs is above the <max> input limit` |
| No outpoint is spent twice | `input <i> spends the same coin as an earlier input` |
| Every input spends this wallet's P2WPKH script | `input <i> does not spend this wallet's address` |
| At least one output | `the transaction has no outputs` |
| Each output pays this wallet's own script (change) or a listed destination, compared as script bytes | `output <j> is OP_RETURN`, `output <j> has an unknown script`, `output <j> pays <address>, which is not an allowed destination` |
| Outputs do not exceed inputs | `outputs spend more than the inputs hold` |
| The fee, inputs minus outputs, is at most `maxFeeSats` | `the fee <fee> sats is above the <max> sats cap` |
| Inputs minus change fits the `bitcoin:native` daily limit, in sats | the daily limit reasons above |

OP_RETURN and unknown scripts are refused even when no allowlist entry could match. Every BTC swap venue, such as THORChain, Maya or NEAR Intents, needs either an OP_RETURN memo or a deposit to a venue address, so this rule also keeps the signer out of swaps. A witness program of version 2 or above counts as unknown. The fee cap is absolute. The signer does not cap the fee rate, which is the app's choice.

The daily totals live in `--ledger`, keyed by UTC day. The new totals are flushed to disk and then replace the file atomically, and they move only after a signature exists. A job holds an exclusive lock on a `.lock` file beside the ledger from reading the totals to writing them, so concurrent jobs cannot both spend the same headroom. The ledger also records each charged job id with a digest of what it signed. A job the gateway hands out again after a lost answer is signed again without a second charge. The same id with different work is refused.

## Supply chain

- Every crate is pinned with `=` in `Cargo.toml`, and `Cargo.lock` is committed.
- Every locked crate was published at least seven days before it was added. On 2026-11-03 that meant holding `ctutils` at 0.4.6.
- The toolchain is pinned in `rust-toolchain.toml`.
- CI runs `cargo fmt --check`, `cargo clippy --locked -- -D warnings`, and `cargo test --locked`.
- There is no serde derive, so no proc-macro runs for this crate's own code.
- Bitcoin parsing, txids, BIP143 digests, script classification and address decoding come from the `bitcoin` crate, with default features off. Its `secp256k1` dependency builds libsecp256k1 with `cc`, which is held at 1.10.0. Bitcoin signatures still come from the k256 key, the same code that signs EVM transactions.

## Tests

`vectors/generate.mjs` builds the cases with viem, `@msgpack/msgpack`, and `node:crypto`. `tests/hypercore.rs` also checks the Hyperliquid Python SDK's published signing vectors. The Rust tests then require the same decision for every case, and byte-identical signed transactions and signatures where one is signed. `test/signer-vectors.test.ts` checks that the app's swap decoder reads the same recipients from the same calldata.

`vectors/bitcoin.mjs` builds the bitcoin cases with `@scure/btc-signer` on regtest, spending coins from `vectors/bitcoin-funding.json`. Those funding transactions were sent by Bitcoin Core: `node vectors/bitcoin-capture.mjs <bitcoin-cli wrapper>` pays the vector key from a funded regtest wallet named `miner` and records the raw transactions, so the generator runs offline. `tests/bitcoin.rs` requires the same decision, the exact reason, and the same signed bytes as scure for every case. It also checks the ledger limit, an idempotent replay, and `upgrade`. `test/bitcoin-policy.test.ts` runs the same cases through the app's rule.
