# Binah gaps for the wallet

The source is Binah rules v4.6, read on 2026-10-21. Each row names the rule, the state in this tree, and its enforcer. A rule with no enforcer is a gap, not a claim.

| Rule | State in the wallet | Enforcer |
| --- | --- | --- |
| One project directory per product | Done. The directory is the repository root. | This PR stack. Review. |
| File-size ratchet at about 5,000 tokens | Done. Every source file sits at or under the budget. | `scripts/check-file-size.mjs` in the hygiene job |
| Enforced import boundaries | Done for domain, config, and engines. | `scripts/check-boundaries.mjs` in the hygiene job |
| One fast check command | Done. `pnpm run check` runs size, boundaries, build, and tests. | `.github/workflows/ci.yml` |
| Supply-chain install policy | Done. pnpm waits a week for a release, refuses trust downgrades and dependency build scripts, and installs only from the lockfile. Actions are pinned by commit. | `test/supply-chain.test.ts` in `ci.yml` |
| Short AGENTS.md as a map | Done. `AGENTS.md` names what an agent cannot infer. | Review |
| Feature map with a check per feature | Started. Six rows. Each new feature adds one. | `feature-map.md`. Review |
| Decisions recorded in the repo | Started. The modular split holds a record. | `docs/decisions/` |
| Pin behavior before a refactor | Done for this split. The test count held at 130 passed before and after. | `pnpm test` |
| Explicit contracts at every boundary | Held. Zod parses requests and vendor bodies. Types live in `domain.ts`. | `pnpm test`. The parsers tests |
| No code comments as a rule with a lint | Gap. No lint enforces it yet. | Planned. No enforcer |
| Branch-name and PR-body checks | Gap in this repo. The wallet PRs follow the shape by hand. | Planned. The repo hygiene job does not exist yet |
| Guard-paths for Tier A files | Gap. Signing policy, CI, and deploy files hold no automated gate. | Planned. Needs the repo ruleset work |
| Duplicate-code and cycle ratchets | Gap. Only size and the hand-written boundary rules run. | Planned. Needs a chosen tool |
| Verification skill and a control CLI | Gap. `feature-map.md` lists checks. No driver skill exists yet. | Planned. Generate it before the next feature |
| Signed, owner-authored, trailer-free commits | Gap. This host does not carry the agent signing key. | Planned. The preflight script does not exist in this repo |

## CI, 2026-11-03

This repository runs two workflows. `ci.yml` runs `pnpm run check`, the entrypoint smoke, and the Docker build. `security.yml` runs `pnpm audit`, CodeQL for TypeScript and for the workflows, a report-only Grype scan of the built image that sends fixable findings to code scanning, and Gitleaks over the full history. The `docker` job in `ci.yml` also fails when the image runs a Node major other than `.node-version`. It also runs weekly, so a new advisory fails without a code change. `.gitleaksignore` lists the test fixture token by fingerprint, so any other token still fails. Dependabot proposes npm, Actions, and Docker updates after the same seven-day cooldown that pnpm enforces. Minor and patch updates for npm and Actions arrive in one grouped pull request per ecosystem. Dependabot never proposes major updates of Node or `@types/node`, so a person must start those upgrades. Dependabot alerts and security updates are repository settings, separate from this file, and on 2026-11-04 they were off. Security updates skip the cooldown, but pnpm still rejects a release younger than seven days, so an urgent fix needs a reviewed change to `pnpm-workspace.yaml` and `test/supply-chain.test.ts`. Branch protection and required checks are repository settings, so they are not in this tree.

## Order

The next gap to close is the verification skill. It turns the feature map rows into commands an agent can run. The repo-level gaps wait on the repo hygiene work. They do not block wallet features, because the wallet workflow already runs its own checks.
