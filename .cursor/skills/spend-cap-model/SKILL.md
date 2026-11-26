---
name: spend-cap-model
description: "Model-check Whale's daily USD cap on live sends with TLA+: the spend_journal reservation through commitLive, the EVM send path, executor restarts, same-key retries and reconcileReserved. Use when a change touches src/spend.ts, commitLive or execute in src/executor.ts, submitEvm, confirmEvm or replaceEvm in src/broadcast/evm.ts, runLegs or journal in src/broadcast/shared.ts, lookupAgedTx, src/nonce.ts, the reconcile timer in src/executor-server.ts, or RECONCILE_AFTER_MINUTES and the send bound."
---

# Spend cap model

A live send reserves its notional in `spend_journal` before it signs, and the reservation must keep counting unless the chain proves the send can never land. `SpendCap.tla` checks every order of reservation, signing, broadcast, receipt, replacement, restart, retry with the same key, chain inclusion, and reconcile pass within its bounds.

## What it checks

| Invariant | Promise | Harm when it breaks |
| --- | --- | --- |
| `LandedStaysCounted` | A send whose transaction landed keeps its row `reserved` or `committed`. | Today's total forgets money that left the wallet, so the cap lets more through, and the same key can send again. |
| `WithinCap` | The hot wallet never lands more than `DAILY_USD_CAP` of notional in a day. | The owner loses more than they allowed. |
| `OneLandingPerKey` | One idempotency key lands at most one transaction. | One strategy decision moves money twice. |

## Run

```sh
node .cursor/skills/spend-cap-model/check.mjs
```

It needs `pnpm install --frozen-lockfile`, Java 11 or later, and network on the first run, which downloads `tla2tools.jar` 1.7.4, checks its pinned sha256, and caches it under `~/.cache/whale`. It runs `tsc`, writes `SpendCode.tla` from `reserveDecision` and `reconcileDecision` in `dist/src/spend.js`, and runs TLC on both configs. About a minute on four cores. The result today:

```
ok   SpendCapOnePass.cfg: every invariant holds (3062062 distinct states) ...
ok   SpendCap.cfg: LandedStaysCounted is violated (... distinct states) ...
```

Exit 0 means both results match `RUNS` in `check.mjs`: the one-pass config holds and the two-pass config reproduces finding F1. Exit 1 means a result changed. Exit 2 means the check could not run. `check.mjs FILE.cfg` runs one config, which must hold; copy `SpendCapOnePass.cfg` and keep one invariant to check one promise.

`SpendCap.cfg` is the executor as it runs. `SpendCapOnePass.cfg` allows one reconcile pass at a time, so F1 cannot hide a second bug there. Every change must keep it passing.

## Read the result

Read every result with the `/statechart` skill. For a violation it gives the shortest path to the broken invariant in plain words; for a pass it charts how the journal moves. Give it `SpendCap.tla` from the directory that `check.mjs` prints on its last line, which also holds the generated `SpendCode.tla`, and take its labels from the plain words below. TLC's own output is the `.out` file next to each config.

## Real bug or modeling error

Walk the counterexample one step at a time through the table below and check that the code can take each step in that order. If every step can happen, it is a real bug. Report it with the path in the code's words, and do not weaken an invariant or the model to make it pass. Change product code only when asked. If a step cannot happen in the code, the model is wrong: fix that action and say what you fixed. Then replay the path against `src/spend.ts` on Postgres if you can; `replay-f1.mjs` shows how.

| Action | Plain words | Code |
| --- | --- | --- |
| `Call` | a strategy sends with a key | `execute` in `src/executor.ts` returns the `reportsOf` entry for a key it has seen in this process |
| `Reserve` | the executor reserves the amount | `commitLive`: `reportsOf.set`, then `recordSpend` in `src/spend.ts`, one transaction under `pg_advisory_xact_lock`: `reserveDecision`, then `RESERVE_UPSERT_SQL`. `cap` deletes the report |
| `Journal` | the executor signs and records a transaction | `submitEvm` in `src/broadcast/evm.ts`: `nonces.use` (`src/nonce.ts`), `signEvm`, `journal` (`src/broadcast/shared.ts`) runs `onTx`, then `recordTx` writes `signed_tx` before `broadcastEvm` |
| `FailBeforeBroadcast` | the send fails before broadcast | `BroadcastError(false)` from leg preparation, signing, journaling, or a rejection every sender gave before its mempool; the `commitLive` catch releases and deletes the report |
| `Broadcast` | the executor broadcasts | `broadcastEvm`: accepted goes on to `confirmEvm`; a timeout or 5xx throws `BroadcastError(true)` and `commitLive` keeps the reservation |
| `Receipt` | the executor sees a receipt | `pollReceipts` in `confirmEvm`; `runLegs` calls `onTx(landed)`, which commits; `commitLive` commits a landed send, releases a reverted one, and deletes its report |
| `Replace` | the executor sends a fee-bumped replacement | `replaceEvm` signs the same nonce, journals it, then broadcasts it, or returns null |
| `GiveUp` | the executor stops waiting | the second poll times out; the records stay `pending` and `commitLive` keeps the reservation |
| `Restart` | the executor restarts | process exit: calls in flight, `reportsOf`, and running reconcile passes are gone |
| `Mine`, `OtherTx` | a block includes a transaction; another wallet transaction takes the nonce | the chain |
| `Select` | a reconcile pass picks up held rows | the `setInterval` in `main` of `src/executor-server.ts` calls `reconcileReserved`, which runs `RESERVED_SQL` |
| `ReadSigned` | the pass reads a row's transactions | `SIGNED_FOR_KEY_SQL`, then `agedTxs` |
| `Settle` | the pass settles the row | `lookupAgedTx` in `src/broadcast.ts` for each transaction (a failure becomes null), `reconcileDecision`, then `COMMIT_SQL` or `RELEASE_SQL` |
| `EndPass` | the pass ends | the end of the loop in `reconcileReserved` |

Each action is one step that nothing else can interleave with. `Reserve` is one database transaction. `Journal` spans several awaits, but no other actor can see its middle states. `Settle` looks the transactions up at the moment it writes; the code looks them up a little earlier, but an outcome only moves from pending to final, and a failed lookup gives the model the same keep. The model has no reorgs.

## Intended changes

When a change to covered code is deliberate:

1. Find each changed function in the table, and edit its action so that it does what the new code does.
2. Changes to `reserveDecision` and `reconcileDecision` reach the model through the generated `SpendCode.tla`. If their signatures change, update `spendCode()` in `check.mjs`. If `reconcileDecision` starts to depend on the order of outcomes, `check.mjs` stops and says so.
3. Run `check.mjs` and read the results with `/statechart`.
4. When a fix makes F1 stop reproducing, set its `expect` in `RUNS` to `null`, move F1 to resolved below, and replay `replay-f1.mjs` to confirm.
5. Move the sync commit forward only after you have confirmed that the model describes the code at the new commit.

## Coverage

Sync commit: `d1657ec` on main. List the covered files that changed since then:

```sh
git diff --stat d1657ec -- src/spend.ts src/executor.ts src/broadcast/evm.ts src/broadcast/shared.ts src/broadcast.ts src/nonce.ts src/executor-server.ts src/managed-signer.ts src/config/public.ts
```

| File | What the model covers |
| --- | --- |
| `src/spend.ts` | `reserveDecision` and `reconcileDecision` (generated), `recordSpend`, `RESERVE_UPSERT_SQL`, `COMMIT_SQL`, `RELEASE_SQL`, `recordTx`, `RESERVED_SQL`, `SIGNED_FOR_KEY_SQL`, `reconcileReserved`, `agedTxs` |
| `src/executor.ts` | `execute` (the `reportsOf` check), `commitLive` |
| `src/broadcast/evm.ts` | `submitEvm`, `broadcastEvm`, `confirmEvm`, `pollReceipts`, `replaceEvm` |
| `src/broadcast/shared.ts` | `journal`, `runLegs` for one leg |
| `src/broadcast.ts` | the EVM branch of `lookupAgedTx` |
| `src/nonce.ts` | the nonce `createNonceManager` hands out: cached or pending |
| `src/executor-server.ts` | `main`: the bare `setInterval` around `reconcile`; `deps`: `recordTx` as the journal |
| `src/managed-signer.ts`, `src/config/public.ts` | `assertBoot` keeps `RECONCILE_AFTER_MINUTES` above `drainTimeoutMs`, which bounds a send |

## Bounds and assumptions

- Two keys at 1 USD each, a 1 USD cap, nonces 0 to 2, three signed transactions, three `/execute` calls, two restarts, one or two reconcile passes. Keys are symmetric.
- One EVM chain and hot wallet, one spend day, no strategy cap from `STRATEGY_CAPS_JSON`, single-leg routes.
- Assumed and not checked: every send ends within the send bound, so a pass selects only rows whose call has returned or died. A rejection that `broadcastEvm` calls definite means no mempool holds the transaction. RPCs agree with each other, and nothing reorgs deeper than `REORG_DEPTH`.
- The boot reconcile in `main` runs alone. The model has no separate step for it, because an interval pass with nothing interleaved does the same.

## Not covered

Solana, HyperCore, and Bitcoin sends; multi-leg routes; the hosted ledger in `src/gateway/send-ledger.ts` and `hosted_sends`, which today answers quotes only; local MCP transfers in `src/local-sends.ts`; `withdraw_journal`; per-trade limits in `src/limits.ts`; legacy rows; day rollover; the in-memory journal of dry runs. A pass covers the model within these bounds, not the whole executor.

## Findings

### F1 (open): two overlapping reconcile passes release a retry's reservation

`SpendCap.cfg` breaks `LandedStaysCounted` in 14 steps:

1. A strategy sends key k1, and `recordSpend` reserves 1 USD.
2. The executor restarts before the send signs anything.
3. A reconcile pass selects k1. It is still busy with other rows when `RECONCILE_INTERVAL_MS` (5 minutes by default) fires again, and the second pass selects k1 too.
4. Both passes read `signed_tx` for k1 and find nothing.
5. The first pass releases k1, which is right, because nothing was signed.
6. The strategy retries k1. `recordSpend` re-reserves the released row, and the send signs, journals, and broadcasts a transaction that lands.
7. The second pass settles k1 from its empty read and releases it. `RELEASE_SQL` matches on `status = 'reserved'` alone, so it releases the retry's reservation.
8. The retry's `commitSpend` finds no reserved row. The landed 1 USD no longer counts: a second key now fits under the cap, and another k1 call that passed the `reportsOf` check before the retry reserved, or any k1 call after a restart, reserves and sends again.

Checked alone with two passes, `WithinCap` and `OneLandingPerKey` also break through F1 (about 10 million states each, two minutes each).

The bug needs a pass that outlasts the interval, for example while RPC lookups time out on several pending rows, which is also when sends end up pending. `replay-f1.mjs` reproduces it against the real `src/spend.ts`; it drops and recreates the spend tables, so point `TEST_DATABASE_URL` at a scratch database. The gateway already guards its sweeper with `oneAtATime` and matches `reserved_at` in `settleSend`; either guard on the executor's reconcile would close it.
