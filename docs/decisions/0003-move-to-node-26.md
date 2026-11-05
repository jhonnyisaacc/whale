# 0003. Move from Node 22 to Node 26 before Node 22 support ends

## Context

Whale runs Node 22, in the Dockerfile and in `.node-version`. Node 22 support ends on 2027-04-30. `.github/dependabot.yml` ignores major updates of Node and `@types/node`, so no pull request will warn about this date.

## Decision

Move to Node 26 by 2027-03-31. Jhonny owns the move. One pull request changes the Dockerfile tag and digest, `.node-version`, `@types/node`, and the image assertion in `test/security-review.test.ts`, and it raises `engines` to Node 26.

## Alternatives

Node 24 is the smaller step, but its support ends on 2028-04-30, one year before Node 26. It would mean another move sooner, with no measured compatibility gain. Staying on Node 22 past 2027-04-30 would leave a service that moves money without runtime security fixes.

## Evidence

On 2026-11-05, on darwin-arm64, the build, tests, and entrypoint smoke passed on Node 24.22.2 and on Node 26.13.0: 175 pass, 4 skipped, 0 fail. The 4 skipped tests need Postgres. Neither Node 26 in the Docker image nor the Postgres tests on Node 26 have been run. The move must run both. Dates come from the `nodejs/Release` schedule.

## How to undo

Revert the move pull request. This returns the image and the checks to Node 22, while Node 22 still has support.

## Status

Proposed. Tracked in #35.
