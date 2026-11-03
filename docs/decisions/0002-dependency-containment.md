# 0002. Contain the jayson and stream-json mismatch

## Context

`@solana/web3.js` 1.x depends on `jayson`, which imports a `stream-json` path that current `stream-json` no longer ships. `pnpm-workspace.yaml` overrides jayson's `uuid` to `11.1.1` and its `stream-json` to `3.7.0`. `patches/jayson@4.3.0.patch` points the jayson require at the 3.7 stream adapters.

Until 2026-11-03 the repair was `scripts/patch-jayson-stream-json.mjs`, which rewrote the installed file after `npm ci`. Under pnpm that file is a link into the shared content store, so a script that edits it in place would change the store copy. pnpm applies a registered patch during install instead, and the install fails when the patch no longer applies to the pinned jayson version.

## Decision

Keep the patch as a contained bridge. Do not replace it with an audit exception. An exception would trade a loud build failure for a quiet security waiver.

## Expiry

This decision expires on the first of these events. An upstream jayson release imports a supported stream-json path. A Solana SDK migration removes `@solana/web3.js` 1.x from the tree. The patch fails on a routine dependency update and a maintainer judges the repair cost higher than the migration.

## Evidence

Every install applies the patch, including both Docker stages and CI, so a broken patch stops the install, not a trade. `test/security-review.test.ts` loads `jayson/lib/utils` through `@solana/web3.js` and checks the overrides.

## How to undo

Remove the patch file, its `patchedDependencies` entry, and the jayson overrides in the same change that removes the dependency need. Run `pnpm audit` and the full suite in that change.

## Status

Accepted. Mechanism changed from a post-install script to a pnpm patch on 2026-11-03.
