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
- The hero is a static pencil sketch of a southern right whale (ballena franca austral) breaching onto its back.

## Install

One block that a user pastes into any agent host. The agent clones the repo, builds it, and registers the MCP server and skills. `WHALE_BROADCAST` stays unset, and the agent then calls `wallet_status`. The block is the `InstallBlock` component, so its text changes in one place.

## Comparison

The competitor cells and the Known issues block come from public docs and public GitHub issues as of 2026-11-18. Check them again before publishing.

- MetaMask: https://metamask.com/agent-wallet, `MetaMask/metamask-docs#3032`, `MetaMask/agent-skills#66`, `MetaMask/agent-wallet-plugin-template#6` and `#7`, `MetaMask/metamask-extension#47534`
- Phantom: https://docs.phantom.com/phantom-mcp-server, `phantom/phantom-connect-sdk#405`, `#407`, `#408`, `#410`
- PayBox: https://paybox.sh/llms.txt, `moonpay/paybox-plugin#4`, `#6`, `#7`, `#8`

The Known issues block lists Whale's own gaps first.

## Claims the code does not back yet

The site copy is the target. As of this commit the repo differs as follows.

| Site says | Repo today |
| --- | --- |
| Quote, swap, bridge, balance, transfer | `bridge` ranks quotes the caller supplies. It fetches nothing and executes nothing. The CLI refuses `bridge`. |
| Swap and transfer | The MCP `swap` and `transfer` tools are dry-run only. Live transfer is skipped because local signing is not wired. |
| 15 networks | Ethereum and Monad are off until `ENABLED_CHAINS` names them, and Monad ships no router. zkSync and Scroll have no live send (`src/config/guard.ts`). HyperCore signs orders only. |
| Approval modes: autonomous / ask / always approve | The modes are `autonomous`, `iframe` and `always_approve`. The MCP server does not call `approvalGate`. |
| Hosted gateway | Hosted sends stay dry-run until hosted live opens. |
| Self-hosted signer | `whale-signer` signs EVM and Solana, not HyperCore. It is not connected to the MCP transfer path. |
| Hermes host | No Hermes manifest yet. The design marks it "planned". |
| Open source, MIT | The manifests say MIT. The repo has no `LICENSE` file. |

## Logo sources

- Hosts: `@lobehub/icons-static-svg` 1.71.0 (MIT), converted to PNG.
- Ethereum, BNB Chain, Solana: `cryptocurrency-icons` 0.18.1 (CC0-1.0), converted to PNG.
- Other chains: DefiLlama chain icons (`icons.llamao.fi`).

The logos are trademarks of their owners. Check each brand's usage guidelines before launch.
