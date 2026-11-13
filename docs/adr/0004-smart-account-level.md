# ADR 0004: The smart-account level uses audited modules and checks only static offsets

## Status

Proposed on 2026-11-03. No code ships with this record. The `smart_account` level stays listed as unavailable until the verification steps below are done.

## Context

ADR 0003 defines three signing levels. At the third, the chain itself enforces the rules. The user's key owns an on-chain account, and Whale holds a session key whose permissions an on-chain module checks. A full Whale compromise can then do only what the module allows.

Whale must not write an account or a module contract. Its exposure would be the funds of every user, and it has no audit budget for that. This record picks the existing pieces and the limits they impose. The sources are listed at the end, with links and the versions current on 2026-11-13. Several of them are vendor documentation, and the steps under "Verify before code" exist for that reason.

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
| Allowed chains | One swap session per chain and sell token, enabled by the owner. A transfer to a further destination gets a transfer-only session with no `exec` action |
| Per-token caps | A limited universal-action rule on the amount of each allowed call, described under "The cap is the bound" |
| Daily caps | A session that expires after 24 hours, or a periodic spending-limit module if an audited one exists. Smart Sessions v1.0.0 has no time or period policy outside its tests, so either choice needs a module from outside that release. Step 4 under "Verify before code" picks one, and the period caps that ADR 0003 promises wait on it |
| A 0x swap calls only a pinned Settler | Universal-action rules that pin the `exec` `operator` and `target` to the chain's Settler |
| Swap recipient must be the account | Universal-action rules on **static** calldata offsets, listed below. They stop accidental and naive misuse. They do not bound loss, because the Settler actions are unchecked |
| Transfers to listed destinations | A universal-action rule on the `transfer` recipient, which sits at a static offset, and a limited rule on its amount. A rule holds one value, so a session allows one destination. Each further destination gets a transfer-only session, which adds its transfer cap to the token's bound and no swap cap |

**Static offsets only.** A universal-action rule compares one 32-byte word at a fixed position with one reference value, and every rule of the action must pass. In Smart Sessions v1.0.0, `UniActionPolicy` reads the word at `4 + offset`, so a rule's `offset` counts from the end of the selector. A rule at a fixed position works only when the field cannot move.

0x `AllowanceHolder.exec(address,address,uint256,address,bytes)` wraps `Settler.execute`. Every `exec` argument except `data` sits at a fixed word. The caller reaches `data` through the offset word at byte 132, and the caller chooses that offset. This is the same flaw that rules out KyberSwap below. The ABI encoder writes `0xa0`, which puts the inner call at byte 196 and the Settler recipient word at byte 200. A caller can instead point the offset past a decoy that keeps the account address at byte 200. The real inner call then sits after the decoy and pays another recipient. A rule on byte 200 alone accepts that calldata, so the session also pins the offset word. The `exec` action carries these rules. Every rule except the `amount` rule is `EQUAL`.

| Calldata byte | Rule `offset` | Field | Required value |
| --- | --- | --- | --- |
| 4 | 0 | `operator` | The chain's pinned Settler |
| 36 | 32 | `token` | The session's sell token |
| 68 | 64 | `amount` | `GREATER_THAN` 0, with `isLimited` set and the session's swap cap as the limit |
| 100 | 96 | `target` | The same Settler |
| 132 | 128 | Offset of `data` | `0xa0` |
| 196 | 192 | Inner selector and the first 28 bytes of the recipient word | The `Settler.execute` selector, then those 28 bytes for the account address |
| 200 | 196 | `slippage.recipient` | The account address |

On 2026-11-13 these positions were checked again with viem 2.57.13. Canonical calldata passes every rule. Calldata whose offset word is `0x100`, with a decoy before the real inner call, passes the byte-200 rule but ABI-decodes to another recipient, and the byte-132 rule refuses it.

**The recipient rules do not bound loss.** `Settler.execute` also takes `bytes[] actions`, and no rule reads them. The caller chooses the actions. Each action is reached through an offset that the caller chooses, which is the flaw that rules out KyberSwap below. The recipients inside the actions are pool addresses that change with each quote, so no static rule could pin them anyway. A compromised Whale can send `slippage.recipient` set to the account, `buyToken` set to zero, `minAmountOut` set to 0, and one action `TRANSFER_FROM(attacker, permit, sig)`. Every rule in the table passes. Settler sends the lent amount to the attacker (`Settler.sol:69-78` and `Permit2Payment.sol:476-497`). It then skips the slippage check, because `minAmountOut` and `buyToken` are both zero (`SettlerBase.sol:113-114`). The recipient, offset, and selector rules refuse calldata that names another recipient where the ABI puts it. A buggy or naive client makes that mistake. A compromised Whale does not have to, so the bound on loss is the swap cap.

`exec` lends the sold-token allowance to `operator` for one call into `target`. Without the `operator` and `target` rules, a compromised Whale names its own contract for both and pulls the lent allowance. The app policy already requires both to be a pinned Settler, in `assertSettler` in `src/signing-policy.ts` and in the 0x entry of `docs/threat-model.md`. A rule holds one reference value, so one session pins one Settler. 0x rotates Settler addresses. After a rotation, 0x swaps at this level are refused until the owner enables a session for the new Settler. The same passkey-signed batch removes the old swap session, so a token never has two sessions that allow `exec`.

**The cap is the bound.** A universal-action rule with `isLimited` set adds the word it reads to a running total. The rule fails when the total would exceed its limit (`UniActionPolicy.sol:156-161`). The total is stored under a config id that hashes the account, the session's permission id, and the action id, and the action id hashes the call target and selector (`IdLib.sol:18-55`). Each session therefore keeps one total for each allowed call. Nothing resets the total on a schedule. Only the owner can reset it. Enabling the session again copies the total from the init data, so any re-enable resets it, even one with unchanged data (`UniActionPolicy.sol:165-171`).

The `exec` `amount` word at byte 68 feeds the swap cap. `AllowanceHolder.exec` gives `operator` an allowance of exactly `amount` of `token` from the calling account (`AllowanceHolderBase.sol:75-76`). `AllowanceHolder.transferFrom` subtracts from that allowance and reverts on underflow (`AllowanceHolderBase.sol:101-110`). `exec` clears the allowance after the call (`AllowanceHolder.sol:19-23`). AllowanceHolder reads `operator`, `token`, `amount`, and `target` from the same fixed words that the rules read (`AllowanceHolderBase.sol:158-164`). One `exec` can therefore move at most `amount` of the pinned token, whatever Settler actions the inner call carries. A policy holds one rule set for each action, so one session covers one sell token. Each sell token gets its own session.

The owner approves AllowanceHolder for the sell token in the same passkey-signed batch that enables the session. AllowanceHolder spends that standing approval only inside an `exec` that the account makes, so the `amount` rule caps it too. The session has no `approve` action. A call that the session does not list, such as `approve` or `transferFrom`, falls through to the fallback action. The session leaves the fallback action empty, so Smart Sessions reverts (`PolicyLib.sol:215-238` and `PolicyLib.sol:71`). Every action sets `valueLimitPerUse` to 0, so no call sends native value (`UniActionPolicy.sol:89`). Native sells are refused at this level. The bound also assumes that the account approves no ERC-20 spender other than AllowanceHolder. Settler's `BASIC` action can call almost any contract. It refuses only Permit2, AllowanceHolder, and on some chains Bebop (`Basic.sol:23`, `Permit2Payment.sol:213-214`, and `Permit2Payment.sol:458-459`). So it can spend an approval that the account grants to Settler, or to any contract that moves tokens from an address its caller names.

Settler can also pull funds through Permit2 with the owner's signature. The session enables no ERC-7739 content and no ERC-1271 policy, so Smart Sessions accepts no signature that the session key makes for the account (`SmartSession.sol:438-442`).

`ERC20SpendingLimitPolicy` is not used. It counts the amount of `approve`, `transfer`, and `transferFrom`, but it ignores the spender and the recipient (`ERC20SpendingLimitPolicy.sol:104-116`). A session with it passes `approve(attacker, remainingCap)`. It also fails every other selector (`ERC20SpendingLimitPolicy.sol:131-132`), so it cannot count `exec`.

The cap has these limits:
- It holds per session, not per period. Step 4 under "Verify before code" decides how a period cap works.
- The swap total and the transfer totals of a token are separate. The bound for a token is the sum of the limits of all its sessions: one swap cap and one transfer cap for each destination. Whale splits the user's per-token cap across them.
- A call consumes its amount at validation, even when the swap then reverts.
- It does not cover userOp fees. The account pays gas from its native balance, and no policy in Smart Sessions v1.0.0 limits the gas fields or the fee of a userOp. A compromised Whale can submit valid userOps with a high fee. Step 6 under "Verify before code" decides how to bound that.

In KyberSwap's `swap` and `swapSimpleMode`, the description is a dynamic tuple reached through an offset that the caller chooses. A rule at a fixed position can be dodged with a non-canonical offset.

So the `smart_account` level routes swaps through 0x only, plus plain transfers. Kyber, LI.FI, and other routers are refused at this level. The app policy and the self-hosted signer, which decode offsets properly, keep them.

**Solana.** The level is not offered on Solana at first. Squads v4 spending limits cannot bound a swap. The Smart Account Program's session keys need a review of the program, its audits, and its upgrade authority before Whale relies on them.

## Verify before code

1. Read the Smart Sessions core and `UniActionPolicy` source at the version Whale would pin, and its audit reports. Confirm the audits cover use through Safe7579 and through a 7702 delegate.
2. Confirm which 7579 account and WebAuthn validator are in the registry with audits, and their deployed addresses on each chain Whale enables.
3. Confirm RIP-7212 availability on each enabled chain, or the gas cost of the fallback verifier.
4. Pick between 24-hour sessions and a periodic spending-limit module. Find the source and an audit for the time or period policy that the choice needs, because Smart Sessions v1.0.0 does not ship one.
5. Write a fork test with a session key. Send `exec` with `minAmountOut` 0, `buyToken` zero, and a `TRANSFER_FROM` action that pays the attacker, several times. The attacker must receive the lent amounts until the swap cap is used, and the next such `exec` must revert. Then try each of these. Each must revert on-chain:
   - pay a swap to another recipient in `slippage.recipient`;
   - send `exec` calldata whose `data` offset points past a decoy that keeps the account address at byte 200;
   - name a non-Settler contract as `operator`, with `target` still the pinned Settler;
   - name a non-Settler contract as `target`, with `operator` still the pinned Settler;
   - name the same non-Settler contract as both `operator` and `target`;
   - exceed the swap cap in one `exec`, and over several `exec` calls that each stay under it;
   - exceed the transfer cap over several transfers;
   - name a sell token other than the session's in `exec`;
   - send native value with any call;
   - call `approve(attacker, remainingCap)` on the sell token;
   - call `transferFrom` on the sell token;
   - call a non-0x router.
6. Decide how userOp fees are bounded. The options are a userOp policy with an audit, a paymaster that the owner controls, or a native balance that the owner keeps to a gas float.

## Consequences

- A full Whale compromise at this level can lose, of each sell token, at most the token's swap cap plus the transfer caps of its destinations. It can move that amount only through the pinned Settler or to the listed transfer destinations. It can choose where Settler sends a swapped amount, so the whole swap cap can go to the attacker. Until step 6 is done, it can also spend the account's native balance on userOp fees. The session lasts until the owner removes it, unless step 4 adds expiry. The bound holds only until the owner signs another enable for the token. Any enable resets the running totals, even one with unchanged data. The passkey's relying party is Whale's domain and the gateway serves the dashboard, so a compromised gateway can show an enable prompt, for example after a Settler rotation. Its enable data can reset the totals, set a larger limit, or name an attacker destination. ADR 0003 has the same property for widening a Turnkey policy. That is the strongest guarantee of the three levels, and it costs route choice.
- Every new chain needs the owner's passkey to enable a session.
- Gas is higher than for an EOA, because of the 4337 entry point and on-chain P-256 verification. On the cheap L2s Whale defaults to, that is cents.

## Sources

The versions below are the ones current on 2026-11-13. Repositories without a release tag are pinned to a commit.

- [Smart Sessions](https://github.com/erc7579/smartsessions/tree/v1.0.0) by Rhinestone and Biconomy, release `v1.0.0` (commit `dc20f0b`). Its policies under `contracts/external/policies` are `ERC20SpendingLimitPolicy`, `SudoPolicy`, and `UniActionPolicy`. `TimeFramePolicy` and `UsageLimitPolicy` exist only as mocks under `test/mock`. Their deployed addresses come from `@rhinestone/module-sdk` `0.4.0`, not from this release. The audit reports are in `audits/`. The text of the two Cantina reports names `ERC20SpendingLimitPolicy`, `SudoPolicy`, and `UniActionPolicy`, and neither names a time-frame or usage-limit policy. The other two reports have no extractable text, so step 1 under "Verify before code" reads them. `UniActionPolicy` reads each rule's word at `4 + offset` and requires every rule to pass.
- [Rhinestone Module SDK](https://www.npmjs.com/package/@rhinestone/module-sdk), `@rhinestone/module-sdk` `0.4.0`, which builds the session and policy configuration for Smart Sessions.
- [Rhinestone module registry](https://github.com/rhinestonewtf/registry/tree/v1.0.2), release `v1.0.2`. It is the on-chain registry where attesters, such as auditors, attest to 7579 modules. Its README at that tag says the contract is in active development and not for production, which step 2 under "Verify before code" has to settle.
- [Safe7579](https://github.com/rhinestonewtf/safe7579/tree/v2.0.0), release `v2.0.0`. It is the adapter that makes a Safe a 7579 account.
- [ERC-7579](https://eips.ethereum.org/EIPS/eip-7579), [EIP-7702](https://eips.ethereum.org/EIPS/eip-7702), and [RIP-7212](https://github.com/ethereum/RIPs/blob/master/RIPS/rip-7212.md).
- [Fluent's EIP-7702 guide](https://docs.fluent.xyz/developer-guides/account-abstraction/eip-7702). It says that 7702 adds delegation only. Session keys and limits live in the delegate.
- [0x Settler](https://github.com/0xProject/0x-settler/tree/ad7c844c6a2a263ae6ba6c72700534aae9bb4a48), commit `ad7c844` on `master`. `src/allowanceholder/IAllowanceHolder.sol` defines `exec`, and `src/interfaces/ISettlerTakerSubmitted.sol` defines `execute`.
- [Coinbase spend permissions](https://github.com/coinbase/spend-permissions/tree/v1.0.0), release `v1.0.0`, and the [Base spend permissions guide](https://docs.base.org/base-account/improve-ux/spend-permissions). In this model, a spender pulls an allowance.
- For Squads, the [spending limits blog post](https://squads.xyz/blog/spending-limits), the [spending limits reference](https://docs.squads.so/main/development/reference/spending-limits), and the [v4 program](https://github.com/Squads-Protocol/v4/tree/release-0.1.0) at tag `release-0.1.0`. The [Smart Account Program](https://github.com/Squads-Protocol/smart-account-program) has no release tag.
