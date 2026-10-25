# Rocket as a Grok plugin

The wallet ships as a Grok plugin named `rocket`. The manifest sits in `.grok-plugin/plugin.json`. The MCP entry sits in `.mcp.json`. Three skills sit under `skills/`.

## What the plugin adds

An MCP server runs from `dist/src/mcp-server.js` over stdio. It wraps the executor and resolver HTTP routes. It holds no keys and signs nothing itself.

| Tool | Route | Money |
| --- | --- | --- |
| `wallet_status` | Executor and resolver `/status` | None |
| `resolve_alert` | Resolver `/alert` | None in live mode |
| `request_swap` | Executor `/execute` | None. The route always runs dry_run |
| `request_listing` | Executor `/listing` | Live only under an `autonomous` grant with executor token screening on |
| `plan_rebalance` | Executor `/rebalance` | None. It returns `would_send` |

## Install

Build the wallet. Start the resolver and the executor. Then point the host at this directory as a plugin.

```bash
npm run build
npm run start:resolver
npm run start:executor
```

Set `EXECUTOR_URL`, `RESOLVER_URL`, and `AUTH_TOKEN` for the MCP process. Set `WALLET_APPROVAL_MODE` to change the human step. The default is `always_approve`.

## Security

The plugin adds no new money path. A live listing still passes screening, simulation, the spend reservation, and the Turnkey signing policy inside the executor. Under `iframe` or `always_approve`, the MCP tool returns `pending_approval` and sends nothing. The agent then waits for the human. It never asks for a seed phrase or a key.
