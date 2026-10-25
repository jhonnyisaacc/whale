# 0001. One wallet directory, split by feature

## Context

The listing services held five files over about 5,000 tokens. The largest held about 10,976. An agent reading one file had to hold the whole send path at once. The directory name said listing, while the purpose is a general agentic wallet.

## Decision

The project directory is `wallet`. Large modules split by feature behind a barrel that keeps the old import path. `broadcast` splits into shared, EVM, Solana, and transfers. `aggregators` splits into shared, race, and firm. `config` splits into types, load, guard, and public. The executor keeps its state machine and moves withdraw and quote planning out. The executor server moves its chain reader out.

## Alternatives

A baseline that only shrinks would have left the large files in place. A full rewrite would have changed behavior while moving structure. Both were rejected.

## Evidence

`npm test` passed 130 tests with 2 skipped before and after the split. `node scripts/check-file-size.mjs` reports every file at or under 5,000 tokens after the split. The largest file is now about 4,862 tokens.

## How to undo

Each barrel is a re-export. Moving a module back into its barrel file restores the old layout with no caller change.

## Status

Accepted.
