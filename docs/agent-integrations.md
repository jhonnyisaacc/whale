# Rocket on agent hosts

One wallet serves three hosts. The MCP server and the skills stay the same. Only the manifest differs.

| Host | Manifest | Agent definition |
| --- | --- | --- |
| Grok | `.grok-plugin/plugin.json` | Host-managed. Skills under `skills/` |
| Claude | `.claude-plugin/plugin.json` | `.claude/agents/rocket-wallet.md` in this repo. Copy kept at `agents/claude/rocket-wallet.md` |
| Codex (OpenAI) | `.codex-plugin/plugin.json` | `.codex/agents/rocket-wallet.toml` in this repo. Copy kept at `agents/codex/rocket-wallet.toml` |
| Muse (Meta) | `.muse-plugin/plugin.json` | `agents/muse/rocket-wallet.md` as the Agent Definition source. Muse plugins carry skills and MCP servers. They carry no agents capability, so the definition registers outside the manifest |

## Shared setup

Build the wallet. Start the executor with `npm run start:executor`, the CLI with `npm run start:cli`, and MCP with `npm run start:mcp`. The MCP entry in `.mcp.json` starts `dist/src/mcp-server.js` over stdio.

The MCP tools are `wallet_status`, `quote`, `swap`, `bridge`, `balance`, and `transfer`. Set `EXECUTOR_URL` and `EXECUTOR_AUTH_TOKEN` so `wallet_status` can read `GET /status`. Leave `WHALE_BROADCAST` unset. If `LISTING_TRADER_LIVE` is set, boot throws. If `WITHDRAW_ENABLED` is set, boot throws. `POST /withdraw` is absent.

## Claude

Install this directory as a Claude plugin, or copy `agents/claude/rocket-wallet.md` into a project's `.claude/agents/`. The plugin reads the root `.mcp.json` and the root `skills/` directory. The subagent definition restricts itself to shell and read tools. All money movement still goes through the MCP tools and the executor gates.

## Muse (Meta)

Install this directory as a Muse plugin. The manifest at `.muse-plugin/plugin.json` declares the three rocket skills and the `rocket` MCP server, which Muse starts as `node dist/src/mcp-server.js` from the plugin root. Register `agents/muse/rocket-wallet.md` as an Agent Definition when a dedicated wallet agent is wanted. A test keeps its rules in step with the Claude and Codex definitions.

## Codex

Install this directory as a Codex plugin, or copy `agents/codex/rocket-wallet.toml` into `.codex/agents/` at the project or user level. The plugin manifest points Codex at `./skills/` and `./.mcp.json`. The agent definition carries the same operating rules as the Claude definition. Keep both files in step when the rules change.

## Security

No host integration adds a money path. Every host reaches the same executor. `swap` and `transfer` stay dry-run in the MCP server. A live executor still requires `WHALE_BROADCAST` set to `true`, plus Turnkey, screening, simulation, the spend reservation, and the signing policy. No integration asks for a seed phrase or a key.
