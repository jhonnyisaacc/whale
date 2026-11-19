# Whale landing page and docs design

The design source is `whale.pen`. Open it in Pencil (pen.dev). The PNGs in `exports/` are review copies of the same frames.

| File | What it shows |
| --- | --- |
| `whale.pen` | Landing page at 1440 and 390 wide, docs page at 1440, components, notes |
| `exports/landing-desktop.png` | The 9 landing sections stacked, desktop |
| `exports/landing-mobile.png` | The 9 landing sections stacked, mobile |
| `exports/docs-desktop.png` | Docs: chapter 1 Install, chapter 2 Comparison |
| `exports/auth-browser.png` | Auth: connect chooser, sign-in, consent, connected, device code, agents, passkey approval, Grok connector |
| `exports/auth-terminal.png` | Auth: `whale init`, `whale login` (device code), Claude Code OAuth, `whale status` |
| `exports/auth-mobile.png` | Auth: device code entry and passkey approval on a phone |
| `logos/` | Chain and host logos that the `.pen` file loads as image fills |

## Canvas layout

- Landing, desktop: x = 0. Sections run 01 Nav, 02 Hero, 03 Compare, 04 Networks, 05 Install, 06 Hosts, 07 Safety, 08 Contribute, 09 Footer.
- Landing, mobile: x = 1640, same order.
- Docs: x = 2700. Install comes first, then Comparison.
- Auth: x = 4300 (browser), 5700 (terminal), 6800 (mobile).
- Components sit above the origin: buttons, network chip, status badge, code card, `InstallBlock`, and the `WhaleBreachSketch` hero drawing.
- Notes to the right of the mobile stack hold the motion, accessibility and open-item contracts.

## Visual rules

- White background, black text, and 1px lines. No shadows.
- Geist Light display type at 96 to 132px with -0.035em tracking. Geist Mono for code.
- Card corners are 24 to 28px. Buttons and badges are pills.
- Pastel accents (lavender, violet, mint, peach, sky, butter) appear only on icons, dots and highlights.
- Every color is a variable with a light and a dark value.
- The hero is a static line-art pencil sketch of a southern right whale (ballena franca austral) breaching onto its back, drawn from a reference photo. Black lines on white with hatching for tone, no filled areas.

## Install

One block that a user pastes into any agent host that can run shell commands. The agent clones and builds the repo, starts the executor, registers the MCP server and skills, and then calls `wallet_status`. The local MCP is dry-run only. The block is the `InstallBlock` component. The mobile instance overrides the text with narrower line breaks, so change both when the steps change.

## Comparison

The competitor cells and the Known issues block come from public docs and public GitHub issues as of 2026-11-18. Check them again before publishing.

- MetaMask: https://metamask.com/agent-wallet, `MetaMask/metamask-docs#3032`, `MetaMask/agent-skills#66`, `MetaMask/agent-wallet-plugin-template#6` and `#7`, `MetaMask/metamask-extension#47534`
- Phantom: https://docs.phantom.com/phantom-mcp-server, `phantom/phantom-connect-sdk#405`, `#407`, `#408`, `#410`
- PayBox: https://paybox.sh/llms.txt, `moonpay/paybox-plugin#4`, `#6`, `#7`, `#8`

The Known issues block lists Whale's own gaps first.

## Copy claims only what the code backs

Each claim was checked against `origin/main` on 2026-11-18.

| Topic | Site copy | Why |
| --- | --- | --- |
| Verbs | "Quote, swap and transfer (dry-run during beta), plus bridge-quote ranking" | `bridge` ranks quotes the caller supplies and never broadcasts (`src/commands.ts:110`). The CLI refuses it. |
| Swap and transfer | Labelled dry-run | The local MCP forces dry-run (`src/mcp-server.ts:46`). Hosted sends stay dry-run until hosted live opens. |
| Networks | "15 networks", with a badge on each limited chain | Ethereum: opt-in. Monad: opt-in, routers shipped (`DEFAULT_ROUTERS` in `src/chains.ts`). zkSync: quotes only. Base, Optimism, Blast and Scroll: quotes only, because live mode refuses chains with an unbounded L1 data fee (`L1_DATA_FEE_CHAIN_IDS` at `src/chains.ts:287`, enforced at `src/config/guard.ts:94`). HyperCore: orders only. |
| Approval | "Trades on its own inside per-trade and daily USD caps" | On `main` since #88, the owner approval threshold defaults to none, and hosted swaps and transfers are both priced and counted against the per-trade and daily USD caps. An owner can still set a threshold, and sends above it wait for a passkey approval. The unused approval-mode module was removed in #95. |
| Hosted gateway | "Sends are dry-run during beta" | Hosted live is not open. |
| Signer | "Self-hosted signer, for EVM and Solana" | `whale-signer` does not sign HyperCore, and it is not wired to the MCP send path. |
| Install | "Copy one block into any agent that can run shell commands" | The block runs `git clone` and `pnpm`, starts the executor on port 8788 with an `EXECUTOR_AUTH_TOKEN` (the default port is 8080, and `.mcp.json` points at 8788), then registers the MCP server with the same token, so `wallet_status` can reach it. Hermes stays "planned" because it has no manifest. |
| License | "MIT License" | The `LICENSE` file landed in #94. |
| Add a network | "An entry in src/chains.ts plus its fee limits" | A new EVM chain also needs a `DEFAULT_EVM_FEE_LIMITS` entry, or it gets no Turnkey clause (`src/signing-policy/turnkey.ts:83`). |

## Authentication

The production gateway is `https://app.mywhalewallet.com`, and MCP clients connect to `https://app.mywhalewallet.com/mcp`. Each place an agent runs gets one step and its own revocable credential:

| Where the agent runs | Step | Credential |
| --- | --- | --- |
| This computer only | `npx whale init` | Executor token in a 0600 file, executor bound to loopback. No account. |
| Claude Code, Codex, Cursor, VS Code | Add the MCP URL, sign in once | OAuth 2.1, PKCE S256, loopback redirect, 1-hour access token, rotating refresh token |
| Grok | Add a custom connector with the MCP URL | Same OAuth flow, discovered from `/.well-known/oauth-protected-resource` |
| VPS, SSH, Hermes | `npx whale login`, then approve on any phone | OAuth device authorization grant (RFC 8628) |
| A bot with no human | Create an API key in Agents | `whale_<id>_<secret>`, shown once, stored as a hash, scoped to one wallet and its caps |

Owners sign in with a passkey (Google as the first-time fallback) and approve sends above their threshold with a passkey.

### Already on `main`

- MCP OAuth: protected-resource and authorization-server metadata, dynamic client registration, client ID metadata documents, PKCE S256 only, https or loopback redirects, resource-bound tokens, 1-hour access tokens, 30-day refresh tokens with reuse detection, revocation (`src/gateway/routes-oauth.ts`, `src/gateway/oauth-store.ts`).
- Consent page with wallet and limits (`web/src/pages/Connect.tsx`). Google sign-in (`web/src/pages/Login.tsx`). API keys shown once and hashed, with rotate and revoke (`src/gateway/agents.ts`, `web/src/pages/Agents.tsx`). Passkeys for step-up and approvals (`src/gateway/routes-passkeys.ts`).
- A stdio forwarder that uses `WHALE_GATEWAY_URL` and `WHALE_API_KEY` (`src/mcp-server.ts:92`).

### Designed here, not built yet

- `whale` CLI: `init`, `login`, `logout`, `status`, `doctor --gateway`, `mcp install <host>`. `package.json` has no `bin`, and `src/cli.ts` only runs wallet commands.
- Device authorization grant: endpoint, `/device` page, and polling. `grant_types_supported` lists only `authorization_code` and `refresh_token`.
- Passkey sign-in. Login offers Google only.
- A "connected" page, a CAN / CANNOT scope list on consent, and the sign-in method in the Agents table.
- Local setup: the executor listens on `0.0.0.0` (`src/executor-server.ts:246`), and its default port 8080 doesn't match the 8788 in `.mcp.json`.
- The stdio forwarder can't use OAuth or device tokens yet, only an API key.

## Logo sources

- Hosts: `@lobehub/icons-static-svg` 1.71.0 (MIT), converted to PNG.
- Ethereum, BNB Chain, Solana: `cryptocurrency-icons` 0.18.1 (CC0-1.0), converted to PNG.
- Other chains: DefiLlama chain icons (`icons.llamao.fi`).

The logos are trademarks of their owners. Check each brand's usage guidelines before launch.
