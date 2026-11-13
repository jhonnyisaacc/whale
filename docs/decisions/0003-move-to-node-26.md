# 0003. Move from Node 22 to Node 26 before Node 22 support ends

## Context

Whale runs Node 22, in the Dockerfile and in `.node-version`. Node 22 support ends on 2027-04-30. `.github/dependabot.yml` ignores major updates of the Node image and of every npm package, `@types/node` included, so no pull request will warn about this date.

## Decision

Move to Node 26 by 2027-03-31. Jhonny owns the move. One pull request changes the Dockerfile tag and digest, `.node-version`, `@types/node`, `engines`, the image assertion in `test/security-review.test.ts`, and the Node 22 text in `README.md`, `docs/deploy.md`, and `src/timeout.ts`. It also removes the `undici-types@6.21.0` trust exception from `pnpm-workspace.yaml` and `test/supply-chain.test.ts`, because only `@types/node` 22 needs it.

Node 25 and later images do not include corepack. Both Dockerfile stages, `ci.yml`, and `security.yml` run `corepack enable`. Install corepack first with `npm install --global corepack@0.36.0`, then run `corepack enable`, because corepack checks the pnpm hash in `package.json`. Do not run `npm install --global pnpm`: it ignores that hash, and every current test still passes. The move must add a test that fails on that command.

## Alternatives

Node 24 is the smaller step, but its support ends on 2028-04-30, one year before Node 26. It keeps corepack, but it left active support on 2026-10-20 and means another move a year sooner. If the corepack install fails in the image, Node 24 is the fallback. Staying on Node 22 past 2027-04-30 would leave a service that moves money without runtime security fixes.

## Evidence

On 2026-11-05, on darwin-arm64, the build, tests, and entrypoint smoke passed on Node 24.22.2 and on Node 26.13.0: 175 pass, 4 skipped, 0 fail. The 4 skipped tests need Postgres. With a corrupted hash in `package.json` on Node 26, `npm install --global pnpm@11.28.9` still installed and `pnpm run check` passed, while the corepack method failed with `Mismatch hashes`. An independent review also passed the build, tests, and smoke with `@types/node` 26 and `engines` at Node 26, and the 4 Postgres tests on a throwaway local Postgres. On the Node 25 image, CI failed at `corepack enable` with `corepack: not found`. All of the Node 26 runs were on darwin-arm64. Nothing has run on Node 26 in the Docker image or on Linux, and the move must do both. The corepack package itself has no hash check, and Dependabot will not track a version in a `RUN` line. Dates come from the `nodejs/Release` schedule.

## How to undo

Revert the move pull request. This returns the image and the checks to Node 22, while Node 22 still has support.

## Status

Proposed. Tracked in #35.
