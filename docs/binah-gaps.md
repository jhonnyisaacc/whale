# Binah gaps for the wallet

The source is Binah rules v4.6, read on 2026-10-21. Each row names the rule, the state in this tree, and its enforcer. A rule with no enforcer is a gap, not a claim.

| Rule | State in the wallet | Enforcer |
| --- | --- | --- |
| One project directory per product | Done. The directory is `wallet`. | This PR stack. Review. |
| File-size ratchet at about 5,000 tokens | Done. Every source file sits at or under the budget. | `scripts/check-file-size.mjs` in the hygiene job |
| Enforced import boundaries | Done for domain, config, and engines. | `scripts/check-boundaries.mjs` in the hygiene job |
| One fast check command | Done. `npm run check` runs size, boundaries, build, and tests. | The wallet workflow |
| Short AGENTS.md as a map | Done. `wallet/AGENTS.md` names what an agent cannot infer. | Review |
| Feature map with a check per feature | Started. Six rows. Each new feature adds one. | `wallet/feature-map.md`. Review |
| Decisions recorded in the repo | Started. The modular split holds a record. | `wallet/docs/decisions/` |
| Pin behavior before a refactor | Done for this split. The test count held at 130 passed before and after. | `npm test` |
| Explicit contracts at every boundary | Held. Zod parses requests and vendor bodies. Types live in `domain.ts`. | `npm test`. The parsers tests |
| No code comments as a rule with a lint | Gap. No lint enforces it yet. | Planned. No enforcer |
| Branch-name and PR-body checks | Gap in this repo. The wallet PRs follow the shape by hand. | Planned. The repo hygiene job does not exist yet |
| Guard-paths for Tier A files | Gap. Signing policy, CI, and deploy files hold no automated gate. | Planned. Needs the repo ruleset work |
| Duplicate-code and cycle ratchets | Gap. Only size and the hand-written boundary rules run. | Planned. Needs a chosen tool |
| Verification skill and a control CLI | Gap. `feature-map.md` lists checks. No driver skill exists yet. | Planned. Generate it before the next feature |
| Signed, owner-authored, trailer-free commits | Gap. This host does not carry the agent signing key. | Planned. The preflight script does not exist in this repo |

## CI audit, 2026-10-21

The wallet workflows split cleanly. `wallet.yml` runs hygiene, unit tests, entrypoint smoke, and the Docker build. `wallet-security.yml` runs CodeQL, Semgrep, and Gitleaks. `research-governance.yml` covers Python paths only and never overlaps a wallet path. Two duplications remain by design. The smoke job compiles again after the test job, and `npm run check` locally repeats the hygiene scripts that CI runs on their own. The Semgrep container digest in `wallet-security.yml` has no automated update path. Dependabot covers the Dockerfile at `/wallet`, not a workflow container image. That digest stays a manual review item until the repo adopts a tool that scans workflow containers.

## Order

The next gap to close is the verification skill. It turns the feature map rows into commands an agent can run. The repo-level gaps wait on the repo hygiene work. They do not block wallet features, because the wallet workflow already runs its own checks.
