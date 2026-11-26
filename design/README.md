# Whale landing page and docs design

The design source is `whale.pen`. Open it in Pencil (pen.dev). The PNGs in `exports/` are review copies of the same frames, exported before #144, so their copy is older than `whale.pen` and this file. The built site is in `../site`. See `../site/README.md`.

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

One block that a user pastes into any agent host that can run shell commands. The agent clones and builds the repo, starts the executor, registers the MCP server and skills, and then calls `wallet_status`. The local MCP is dry-run by default. The block is the `InstallBlock` component. The mobile instance overrides the text with narrower line breaks, so change both when the steps change.

## Comparison

The competitor cells come from public docs as of 2026-11-18. The Known issues block comes from public GitHub issues, each confirmed still open on 2026-11-26. Check them again before publishing.

- MetaMask: https://metamask.com/agent-wallet, `MetaMask/metamask-docs#3032`, `MetaMask/agent-skills#66`, `MetaMask/agent-wallet-plugin-template#6` and `#7`, `MetaMask/metamask-extension#47534`
- Phantom: https://docs.phantom.com/phantom-mcp-server, `phantom/phantom-connect-sdk#405`, `#407`, `#408`, `#410`
- PayBox: https://paybox.sh/llms.txt, `moonpay/paybox-plugin#4`, `#6`, `#7`, `#8`

The Known issues block lists Whale's own gaps first.

## Copy claims only what the code backs

Each claim was checked against `origin/main` on 2026-11-26 (2065cac).

| Topic | Site copy | Why |
| --- | --- | --- |
| Verbs | "Quote, swap and transfer, trade Hyperliquid perps, and hold and send native BTC (dry-run by default; self-hosted live, hosted pending), plus bridge-quote ranking" | The local MCP lists `perp` and `perp_positions` (`src/mcp-server.ts:34-35`) and `bitcoin_wallet` and `send_bitcoin` (`src/mcp-server.ts:37-38`) next to `quote`, `swap` and `transfer`. The hosted gateway lists none of the four. `bridge` ranks quotes and never broadcasts (`src/commands.ts:143`). `executeBridge` from #134 (`src/bridge/execute.ts:157`) has no MCP tool or CLI command yet, so the Known issues block reads "Bridge execution has no MCP or CLI tool yet". Since #182 both signers sign a live LI.FI `swapAndStartBridgeTokensViaAcrossV4` bridge (`src/signing-policy/bridge-terms.ts:25`), so the gap is the missing tool, not the signer. |
| Swap and transfer | Dry-run by default, self-hosted live | Since #133 the local MCP sends live swaps and transfers through whale-signer when the caller asks for live. Hosted sends stay dry-run until gate #80 (`src/gateway/mcp-tools.ts:113`). |
| Networks | "16 networks", with a badge on each limited chain | The chain table has 15 entries, and native Bitcoin from #155 is the 16th. Ethereum: opt-in. Monad: opt-in, routers shipped (`src/chains.ts:296`), and its support tier defaults to disabled (`src/support.ts:6`). zkSync: opt-in, because its support tier defaults to dry_run (`src/support.ts:6`) and hosted wallets exclude it (`src/chains.ts:309`). Base, Optimism and Scroll: live, because they have L1 fee budgets (`src/chains.ts:283-285`). The hosted Turnkey policy renders their L2 gas clause (`src/signing-policy/turnkey.ts:83`), so an enclave wallet reaches them after its owner re-runs delegation. Blast: quotes only, because it has no L1 fee budget (`src/chains.ts:307`). HyperCore: orders only, because no route calls the withdraw path (`src/broadcast/hypercore.ts:17`). Bitcoin: hold + send, because `send_bitcoin` sends only to `BITCOIN_WITHDRAW_ADDRESSES` (`src/bitcoin/send.ts:88`) and no tool trades BTC. |
| Approval | "Trades on its own inside per-trade and daily USD caps" | On `main` since #88, the owner approval threshold defaults to none, and hosted swaps and transfers are both priced and counted against the per-trade and daily USD caps. An owner can still set a threshold, and sends above it wait for a passkey approval. The unused approval-mode module was removed in #95. |
| Hosted gateway | "Sends are dry-run during beta" | Hosted live is not open. |
| Signer | "Self-hosted signer, for EVM, Solana, HyperCore, BTC" | `whale-signer` signs EVM, Solana, HyperCore and Bitcoin jobs (`signer/src/lib.rs:42`, `:59`, `:94`, `:110`). Since #133 the local MCP swaps and transfers sign through it, the local `perp` tool signs HyperCore orders through it (`src/mcp-server.ts:34`), and `send_bitcoin` signs through it (`src/mcp-server.ts:38`). |
| Install | "Copy one block into any agent that can run shell commands" | The block runs `git clone` and `pnpm`, starts the executor on port 8788 with an `EXECUTOR_AUTH_TOKEN` (the default port is 8080, and `.mcp.json` points at 8788), then registers the MCP server with the same token, so `wallet_status` can reach it. Hermes installs the package with `hermes plugins install jhonnyisaacc/whale` (#197). |
| License | "MIT License" | The `LICENSE` file landed in #94. |
| Perps safety | "Every perp action passes the signing policy before any is sent. Leverage stops at 3x unless you raise MAX_PERP_LEVERAGE." | Every action is checked before any is signed (`src/broadcast.ts:32`, #190). The policy refuses leverage above the limit (`src/signing-policy/hypercore.ts:85`), and the limit defaults to 3 (`src/config/load.ts:87`, #143). A key that trades for another account must be its approved agent (`src/hyperliquid.ts:133`, #195). |
| Outside text | "RPC failures and Hyperliquid rejections reach the agent in Whale's own words" | RPC errors pass through `rpcReason` (`src/rpc-reason.ts:60`, #193). A Hyperliquid rejection in an unknown form becomes a fixed string (`src/hyperliquid.ts:352`, #178). Esplora errors are not claimed. |
| Support tiers | "SUPPORT_TIERS refuses a chain name it doesn't know, and local live sends obey each chain's tier" | Unknown keys throw at load (`src/support.ts:20`, #189). Local live sends check the tier (`src/local-sends.ts:94`, #177). |
| Spend counting (docs only) | "A sent BTC spend keeps counting" | A failed journal commit leaves the row reserved with its txid (`src/bitcoin/send.ts:50`, #173, #192). The spend_journal cap has a TLA+ model (`.cursor/skills/spend-cap-model/SpendCap.tla`, #199). |
| Hosted caps (docs only) | "Hosted wallet_status reports remainingTodayUsd" | `src/gateway/mcp-tools.ts:115` (#149). |
| Enclave L2 chains (docs only) | "The hosted Turnkey policy renders their L2 gas clause" | `src/signing-policy/turnkey.ts:83` (#194). Blast still has no L1 budget, so it gets no clause. |
| Checks (docs only) | "verify-whale" and "a test keeps every tracked file clear of the Hermes install scan" | `.cursor/skills/verify-whale/SKILL.md` (#198), `test/host-manifests.test.ts:201` (#200). |
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
- A stdio forwarder that uses `WHALE_GATEWAY_URL` and `WHALE_API_KEY` (`src/mcp-server.ts:119`).

### Designed here, not built yet

- `whale` CLI: `init`, `login`, `logout`, `status`, `doctor --gateway`, `mcp install <host>`. `package.json` has no `bin`, and `src/cli.ts` only runs wallet commands.
- Device authorization grant: endpoint, `/device` page, and polling. `grant_types_supported` lists only `authorization_code` and `refresh_token`.
- Passkey sign-in. Login offers Google only.
- A "connected" page, a CAN / CANNOT scope list on consent, and the sign-in method in the Agents table.
- Local setup: the executor listens on `0.0.0.0` (`src/executor-server.ts:254`), and its default port 8080 doesn't match the 8788 in `.mcp.json`.
- The stdio forwarder can't use OAuth or device tokens yet, only an API key.

## Logo sources

- Hosts: `@lobehub/icons-static-svg` 1.71.0 (MIT), converted to PNG.
- Ethereum, BNB Chain, Solana: `cryptocurrency-icons` 0.18.1 (CC0-1.0), converted to PNG.
- Other chains: DefiLlama chain icons (`icons.llamao.fi`).

The logos are trademarks of their owners. Check each brand's usage guidelines before launch.
