# Whale landing page and docs design

The design source is `whale.pen`. Open it in Pencil (pen.dev). The PNGs in `exports/` are review copies of the same frames.

| File | What it shows |
| --- | --- |
| `whale.pen` | Landing page at 1440 and 390 wide, docs page at 1440, components, notes |
| `exports/landing-desktop.png` | The 9 landing sections stacked, desktop |
| `exports/landing-mobile.png` | The 9 landing sections stacked, mobile |
| `exports/docs-desktop.png` | Docs: chapter 1 Install, chapter 2 Comparison |
| `logos/` | Chain and host logos that the `.pen` file loads as image fills |

## Canvas layout

- Landing, desktop: x = 0. Sections run 01 Nav, 02 Hero, 03 Compare, 04 Networks, 05 Install, 06 Hosts, 07 Safety, 08 Contribute, 09 Footer.
- Landing, mobile: x = 1640, same order.
- Docs: x = 2700. Install comes first, then Comparison.
- Components sit above the origin: buttons, network chip, status badge, code card, `InstallBlock`, and the `WhaleBreachSketch` hero drawing.
- Notes to the right of the mobile stack hold the motion, accessibility and open-item contracts.

## Visual rules

- White background, black text, and 1px lines. No shadows.
- Geist Light display type at 96 to 132px with -0.035em tracking. Geist Mono for code.
- Card corners are 24 to 28px. Buttons and badges are pills.
- Pastel accents (lavender, violet, mint, peach, sky, butter) appear only on icons, dots and highlights.
- Every color is a variable with a light and a dark value.
- The hero is a static black-and-white graphite sketch of a southern right whale (ballena franca austral) breaching onto its back, drawn from a reference photo: callosities, bowed mouth line, mottled dark back, two raised flippers, spotted belly, splash and choppy water.

## Install

One block that a user pastes into any agent host. The agent clones the repo, builds it, and registers the MCP server and skills. `WHALE_BROADCAST` stays unset, and the agent then calls `wallet_status`. The block is the `InstallBlock` component, so its text changes in one place.

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
| Verbs | "Quote, swap and transfer (dry-run during beta), plus bridge quotes" | `bridge` ranks quotes the caller supplies. The CLI refuses it. |
| Swap and transfer | Labelled dry-run | Nothing signs live yet, in the local MCP or the hosted path. |
| Networks | "15 networks", with a badge on each limited chain | Ethereum: opt-in. Monad: opt-in, no router yet. zkSync: quotes only. Scroll: quotes only (`src/config/guard.ts:94`). HyperCore: orders only. |
| Approval | "Trades on its own inside per-trade and daily USD caps" | The approval-mode module is unused, and #95 removes it. Add "You can require approval above an amount you choose" once #88 merges. |
| Hosted gateway | "Sends are dry-run during beta" | Hosted live is not open. |
| Signer | "Self-hosted signer, for EVM and Solana" | `whale-signer` does not sign HyperCore, and it is not wired to the MCP send path. |
| Install | "Copy one block into any agent that can run shell commands" | The block runs `git clone` and `pnpm`. Hermes stays "planned" because it has no manifest. |
| License | "MIT License" | #94 adds the `LICENSE` file. Ship the site after #94 merges. |

## Logo sources

- Hosts: `@lobehub/icons-static-svg` 1.71.0 (MIT), converted to PNG.
- Ethereum, BNB Chain, Solana: `cryptocurrency-icons` 0.18.1 (CC0-1.0), converted to PNG.
- Other chains: DefiLlama chain icons (`icons.llamao.fi`).

The logos are trademarks of their owners. Check each brand's usage guidelines before launch.
