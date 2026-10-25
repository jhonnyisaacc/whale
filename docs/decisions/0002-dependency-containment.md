# 0002. Contain the jayson and stream-json mismatch

## Context

`@solana/web3.js` 1.x depends on `jayson`, which imports a `stream-json` path that current `stream-json` no longer ships. The overrides pin `uuid` and `stream-json`. `scripts/patch-jayson-stream-json.mjs` rewrites the jayson require after install. It runs in tests and in both Docker stages. It exits 1 when the expected upstream code is absent.

## Decision

Keep the patch as a contained bridge. `npm audit` reports zero vulnerabilities at every severity with it. Do not replace it with an audit exception. An exception would trade a loud build failure for a quiet security waiver.

## Expiry

This decision expires on the first of these events. An upstream jayson release imports a supported stream-json path. A Solana SDK migration removes `@solana/web3.js` 1.x from the tree. The patch script fails on a routine dependency update and a maintainer judges the repair cost higher than the migration.

## Evidence

The Docker build runs the patch before compiling, so a broken patch stops the image, not a trade. The test command runs it before the suite.

## How to undo

Remove the script, the overrides, and the Docker steps in the same change that removes the dependency need. Run `npm audit` and the full suite in that change.

## Status

Accepted.
