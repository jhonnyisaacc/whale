# What Rocket takes from PayBox

Facts are from the public PayBox plugin on 2026-10-21. The plugin is `moonpay/paybox-plugin`. It ships a Grok manifest, an MCP server, and three skills.

## Taken

- **Per-credential grants with approval modes.** PayBox grants stay per credential and revocable. Its modes are `autonomous`, `iframe`, and `always_approve`. The same three names live in `src/approval-modes.ts`. The parsed default is `always_approve`. The MCP server does not call `approvalGate`, so the mode does not widen a cap.
- **Granted is not owned.** A credential that exists but holds no grant stays invisible. Rocket applies the same rule. A chain outside `ENABLED_CHAINS` and a router outside the Turnkey policy cannot sign, and `wallet_status` says so.
- **The plugin shape.** A `.grok-plugin/plugin.json`, a `.mcp.json`, and small skills that carry judgement the manifest cannot. Rocket follows that shape. The MCP tools are `wallet_status`, `quote`, `swap`, `bridge`, `balance`, and `transfer`. `npm run start:mcp` starts them. There is no resolver process in this tree. No second money path exists.
- **Units and pre-spend checks.** Amounts stay in the smallest unit. A balance read comes before a spend. The recipient gets read back before a human signs. Rocket already converted amounts once at the send boundary. The skills now state the rule where an agent reads it.
- **Cost before an x402 spend.** The skill states it before the wallet grows an x402 route, so the first route inherits the rule.
- **Never ask for a seed phrase.** PayBox never asks. Rocket never asks. The Turnkey policy and the keystore already enforce it in code. The skills state it for the agent.

## Not taken

- **A hosted signing window as the only signer.** PayBox signs in its window. Rocket signs through Turnkey under a checked-in policy. The window model maps to the approval gate. It does not replace the signer.
- **Virtual cards and prediction markets.** They sit outside a listing wallet. No route, no skill behaviour beyond naming them out of scope.
- **The PayBox chain set.** PayBox lists Solana, Ethereum, Base, and Robinhood Chain. Rocket keeps its own chain table, which adds the EVM L2 set and Monad. The table stays in `src/chains.ts` as the single source.
- **No spend cap in the product.** PayBox caps size in calling code. Rocket caps it in the executor, in the spend reservation and the strategy caps. A calling agent cannot raise it.

## Source

The PayBox plugin manifest, its three skills, and its README were read from the public repo. No PayBox code was copied. The skill text in `skills/` is new and names Rocket behaviour only.
