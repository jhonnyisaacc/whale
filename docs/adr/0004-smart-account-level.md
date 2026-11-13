# ADR 0004: The smart-account level uses audited modules and checks only static offsets

## Status

Proposed on 2026-11-03. No code ships with this record. The `smart_account` level stays listed as unavailable until the verification steps below are done.

## Context

ADR 0003 defines three signing levels. At the third, the chain itself enforces the rules: the user's key owns an on-chain account, and Whale holds a session key whose permissions an on-chain module checks. A full Whale compromise can then do only what the module allows.

Whale must not write an account or a module contract. Its exposure would be the funds of every user, and it has no audit budget for that. This record picks the existing pieces and the limits they impose. The sources were read on 2026-11-03 and are listed at the end. Several of them are vendor documentation, and the steps under "Verify before code" exist for that reason.

## Options considered

| Option | What it gives | Why it fits or not |
| --- | --- | --- |
| ERC-4337 account with ERC-7579 modules (Safe with the Safe7579 adapter, or another 7579 account) and Rhinestone Smart Sessions | Passkey owner through a WebAuthn validator. Session keys with spending-limit, universal-action (calldata rules), time, and usage policies | Fits. The account stays the user's, and the session is the bound |
| EIP-7702 delegation of an existing EOA to a 7579 implementation | The same modules, for users who already hold an EOA in MetaMask or similar | Fits as a second entry. 7702 adds no rules by itself, so everything rests on the delegate contract and its modules |
| Coinbase Smart Wallet with `SpendPermissionManager` | A spender pulls an allowance per period | Does not fit swaps. Funds move to the spender, which makes Whale hold them during the period. Possible later for x402 payments |
| Squads on Solana (multisig v4 spending limits, or the Smart Account Program) | Per-member allowances, and in the newer program session keys and policies | v4 limits cover transfers to set destinations, not swaps. The Smart Account Program needs its own review first |

## Decision

**EVM:**
- The account is a 7579 account with a WebAuthn (P-256) validator as the owner. The owner is the same passkey that owns the user's other wallets.
- The chains must offer the P-256 precompile (RIP-7212), so the passkey verifies on-chain at a sane gas cost.
- Whale's agent key is a Smart Sessions session.
- Only modules listed in the Rhinestone registry with an audit that covers the configuration Whale uses are allowed.

The wallet policy maps onto session policies:

| Whale policy | Session policy |
| --- | --- |
| Allowed chains | One session per chain, enabled by the owner |
| Per-token caps | The spending-limit policy, per token |
| Daily caps | A session that expires after 24 hours, or a periodic spending-limit module if an audited one exists. Step 4 under "Verify before code" picks one |
| Swap recipient must be the account | Universal-action rules on **static** calldata offsets, listed below |
| Transfers to listed destinations | A universal-action rule on the `transfer` recipient, which sits at a static offset |

**Static offsets only.** A universal-action rule compares one 32-byte word at a fixed position with one reference value, and every rule of the action must pass. In Smart Sessions v1.0.0, `UniActionPolicy` reads the word at `4 + offset`, so a rule's `offset` counts from the end of the selector. A rule at a fixed position works only when the field cannot move.

0x `AllowanceHolder.exec(address,address,uint256,address,bytes)` wraps `Settler.execute`. Every `exec` argument except `data` sits at a fixed word. The caller reaches `data` through the offset word at byte 132, and the caller chooses that offset. This is the same flaw that rules out KyberSwap below. The ABI encoder writes `0xa0`, which puts the inner call at byte 196 and the Settler recipient word at byte 200. A caller can instead point the offset past a decoy that keeps the account address at byte 200. The real inner call then sits after the decoy and pays another recipient. A rule on byte 200 alone accepts that calldata, so the session also pins the offset word. The `exec` action carries these rules, all `EQUAL`:

| Calldata byte | Rule `offset` | Field | Required value |
| --- | --- | --- | --- |
| 132 | 128 | Offset of `data` | `0xa0` |
| 196 | 192 | Inner selector and the first 28 bytes of the recipient word | The `Settler.execute` selector, then those 28 bytes for the account address |
| 200 | 196 | `slippage.recipient` | The account address |

The `exec` token and amount sit at fixed words too, at bytes 36 and 68. On 2026-11-13 these positions were checked again with viem 2.57.13. Canonical calldata passes every rule. Calldata whose offset word is `0x100`, with a decoy before the real inner call, passes the byte-200 rule but ABI-decodes to another recipient, and the byte-132 rule refuses it.

In KyberSwap's `swap` and `swapSimpleMode`, the description is a dynamic tuple reached through an offset that the caller chooses. A rule at a fixed position can be dodged with a non-canonical offset.

So the `smart_account` level routes swaps through 0x only, plus plain transfers. Kyber, LI.FI, and other routers are refused at this level. The app policy and the self-hosted signer, which decode offsets properly, keep them.

**Solana:** the level is not offered on Solana at first. Squads v4 spending limits cannot bound a swap. The Smart Account Program's session keys need a review of the program, its audits, and its upgrade authority before Whale relies on them.

## Verify before code

1. Read the Smart Sessions spending-limit and universal-action policy source at the version Whale would pin, and its audit report. Confirm the audit covers use through Safe7579 and through a 7702 delegate.
2. Confirm which 7579 account and WebAuthn validator are in the registry with audits, and their deployed addresses on each chain Whale enables.
3. Confirm RIP-7212 availability on each enabled chain, or the gas cost of the fallback verifier.
4. Pick between 24-hour sessions and a periodic spending-limit module.
5. Write a fork test with a session key that tries each of these. Each must revert on-chain:
   - pay a swap to another recipient;
   - send `exec` calldata whose `data` offset points past a decoy that keeps the account address at byte 200;
   - exceed the token cap;
   - call a non-0x router.

## Consequences

- A full Whale compromise at this level can spend only inside the active session's per-token caps, only through 0x to the account itself, and only until the session expires. That is the strongest guarantee of the three levels, and it costs route choice.
- Every new chain needs the owner's passkey to enable a session.
- Gas is higher than for an EOA, because of the 4337 entry point and on-chain P-256 verification. On the cheap L2s Whale defaults to, that is cents.

## Sources

- Rhinestone Module SDK, Smart Sessions: the policies offered are spending limits, universal action, and sudo, among others.
- Rhinestone module registry: lists audited 7579 modules with their auditor and report.
- EIP-7702 guides (Fluent docs): 7702 adds delegation only. Session keys and limits live in the delegate.
- Coinbase `SpendPermissionManager` (coinbase/spend-permissions, CDP and Base docs): a spender pulls an allowance.
- Squads blog and docs on v4 spending limits.
