# Rocket on agent hosts

One wallet serves five hosts. The MCP server and the skills stay the same. Only the manifest differs.

| Host | Manifest | Agent definition |
| --- | --- | --- |
| Grok | `.grok-plugin/plugin.json` | Host-managed. Skills under `skills/` |
| Claude | `.claude-plugin/plugin.json` | `.claude/agents/rocket-wallet.md` in this repo. Copy kept at `agents/claude/rocket-wallet.md` |
| Codex (OpenAI) | `.codex-plugin/plugin.json` | `.codex/agents/rocket-wallet.toml` in this repo. Copy kept at `agents/codex/rocket-wallet.toml` |
| Muse (Meta) | `.muse-plugin/plugin.json` | `agents/muse/rocket-wallet.md` as the Agent Definition source. Muse plugins carry skills and MCP servers. They carry no agents capability, so the definition registers outside the manifest |
| Hermes (Nous Research) | `plugin.json` and `mcp.json` at the repo root, in the Agent Plugins v1 format | Host-managed. Skills under `skills/` |

## Shared setup

Every host manifest starts `node scripts/mcp-server.mjs` over stdio. That launcher has no dependencies, so it runs from a fresh clone. Before it starts the server, it checks two things. `node_modules` must match `pnpm-lock.yaml`. `dist/.mcp-stamp.json` must hold the hash of the current sources, lockfile, and config, and the hash of what `dist/src` holds now. When either check fails, it builds. It runs `pnpm install --frozen-lockfile` if `node_modules` is missing or stale, then `tsc --noEmitOnError`, and then writes a new stamp. A build that fails emits nothing and writes no stamp, so the launcher never starts code that failed to compile. A build you run yourself, such as `pnpm run build` or `pnpm test` on another branch, changes `dist/src` without updating the stamp, so the next start rebuilds. It finds `pnpm` on `PATH` or through Corepack. The first start takes about 10 seconds with a warm pnpm store and longer on a cold one. The build runs in its own process group under a lock in `dist/`. If a host stops the launcher before the build ends, the build still finishes and writes its stamp, and the next start lists the tools. Starts that overlap wait for the same build. Later starts take about 0.1 seconds. `pnpm run check:install` starts the server from a clean archive of `HEAD` through each host manifest and fails when any of them lists no tools.

In a checkout, start the executor with `pnpm run start:executor`, the CLI with `pnpm run start:cli`, and MCP with `pnpm run start:mcp`.

The MCP tools are `wallet_status`, `quote`, `swap`, `bridge`, `balance`, `perp`, `perp_positions`, `transfer`, `bitcoin_wallet`, and `send_bitcoin`. Set `EXECUTOR_URL` and `EXECUTOR_AUTH_TOKEN` so `wallet_status` can read `GET /status`. Leave `WHALE_BROADCAST` unset. If `LISTING_TRADER_LIVE` is set, boot throws. If `WITHDRAW_ENABLED` is set, boot throws. `POST /withdraw` is absent.

## Claude

Install this directory as a Claude plugin, or copy `agents/claude/rocket-wallet.md` into a project's `.claude/agents/`. The plugin reads the root `skills/` directory. Its manifest declares the `whale` server as `${CLAUDE_PLUGIN_ROOT}/scripts/mcp-server.mjs`, because Claude Code starts plugin servers in the project directory, not the plugin root. That entry replaces the `whale` entry in the root `.mcp.json`. The subagent definition restricts itself to shell and read tools. All money movement still goes through the MCP tools and the executor gates.

## Muse (Meta)

Install this directory as a Muse plugin. The manifest at `.muse-plugin/plugin.json` declares the `whale-wallet` skill and the `whale` MCP server, which Muse starts as `node scripts/mcp-server.mjs` from the plugin root. Register `agents/muse/rocket-wallet.md` as an Agent Definition when a dedicated wallet agent is wanted. A test keeps its rules in step with the Claude and Codex definitions.

## Codex

Install this directory as a Codex plugin, or copy `agents/codex/rocket-wallet.toml` into `.codex/agents/` at the project or user level. The plugin manifest points Codex at `./skills/` and `./.mcp.json`. The agent definition carries the same operating rules as the Claude definition. Keep both files in step when the rules change.

## Hermes (Nous Research)

Hermes installs this repo as a portable Agent Plugins v1 package. It reads the root `plugin.json`, the root `mcp.json`, and the `skills/` directory. See [Portable Agent Plugins v1 packages](https://github.com/NousResearch/hermes-agent/blob/main/website/docs/developer-guide/plugins/index.md#portable-agent-plugins-v1-packages) in the Hermes developer guide.

1. Install the package with `hermes plugins install jhonnyisaacc/whale --no-enable`.
2. Enable it with `hermes plugins enable whale`.

Hermes starts the `whale` server as `node scripts/mcp-server.mjs` from the package root. The first start builds the package, and a start after `hermes plugins update` rebuilds it. See [Shared setup](#shared-setup). A stdio server gets only the variables that its entry lists, plus a safe baseline. `mcp.json` forwards these variables from your shell or profile `.env`:

- `EXECUTOR_URL`, `EXECUTOR_AUTH_TOKEN`, `WHALE_GATEWAY_URL`, and `WHALE_API_KEY`.
- Each chain's RPC variable and its list form, such as `SOLANA_RPC_URL` and `RPC_URL_8453` or `RPC_URLS_8453`. `balance` needs the RPC variable of the chain it reads.
- `HYPERLIQUID_API_URL` and `HYPERLIQUID_ACCOUNT_ADDRESS`. `perp_positions` reads that account.
- The quote provider keys `ZEROX_API_KEY`, `JUPITER_API_KEY`, `LIFI_API_KEY`, `ONEINCH_API_KEY`, and `OKX_API_KEY`. `quote` needs at least one.

Each entry is written as `${NAME}`, so the file holds no value, and Hermes drops a variable that is unset. A test fails when the server reads one of these variables and `mcp.json` does not forward it. The retired `AUTH_TOKEN` is not forwarded. Use `EXECUTOR_AUTH_TOKEN`.

Any other setting, such as `ENABLED_CHAINS`, needs its own entry. Define the server in `~/.hermes/config.yaml` under `mcp_servers.whale`. That entry replaces the package's server, so list every variable the server needs:

```yaml
mcp_servers:
  whale:
    command: "node"
    args: ["${HOME}/.hermes/plugins/whale/scripts/mcp-server.mjs"]
    env:
      EXECUTOR_URL: "http://127.0.0.1:8788"
      EXECUTOR_AUTH_TOKEN: "<executor token>"
      ENABLED_CHAINS: "<chain keys>"
```

To use the hosted gateway without a checkout, add a remote entry to `~/.hermes/config.yaml` instead. Then run `hermes mcp login whale` from a new terminal to sign in:

```yaml
mcp_servers:
  whale:
    url: "https://app.mywhalewallet.com/mcp"
    auth: oauth
```

To use an agent API key instead of OAuth, replace `auth: oauth` with `headers: { Authorization: "Bearer whale_..." }`. The Hermes reference for both forms is [MCP](https://hermes-agent.nousresearch.com/docs/user-guide/features/mcp).

## Security

No host integration adds a money path. Every host reaches the same executor. `swap` and `transfer` stay dry-run in the MCP server. A live executor still requires `WHALE_BROADCAST` set to `true`, plus Turnkey, screening, simulation, the spend reservation, and the signing policy. No integration asks for a seed phrase or a key.

## Hosted gateway

A hosted Whale exposes one MCP endpoint, `https://<gateway>/mcp`. A client that supports MCP OAuth needs only the URL: on first use it opens the consent page, the user signs in with Google, picks a wallet and the agent's limits, and the client gets its own tokens. A client without OAuth uses an agent API key from the dashboard (`Authorization: Bearer whale_...`).

| Client | Configuration |
| --- | --- |
| Claude Code | `claude mcp add --transport http whale https://<gateway>/mcp`. Add `--header "Authorization: Bearer whale_..."` to use a key instead of OAuth. |
| Cursor | `~/.cursor/mcp.json`: `{ "mcpServers": { "whale": { "url": "https://<gateway>/mcp" } } }`, plus `"headers"` for a key |
| Hermes | `~/.hermes/config.yaml`: `mcp_servers: { whale: { url: "https://<gateway>/mcp", auth: oauth } }`, or `headers` for a key. See [Hermes](#hermes-nous-research) |
| VS Code | `.vscode/mcp.json`: `{ "servers": { "whale": { "type": "http", "url": "https://<gateway>/mcp" } } }` |
| OpenAI Agents SDK | `MCPServerStreamableHttp(params={"url": "https://<gateway>/mcp", "headers": {"Authorization": "Bearer whale_..."}})` |
| Stdio-only clients | Run `node scripts/mcp-server.mjs` with `WHALE_GATEWAY_URL` and `WHALE_API_KEY` set. The local server then forwards every message to the gateway instead of using local tools |
| A bot written in TypeScript | `createHostedClient({ gatewayUrl, apiKey })` from this package: `walletStatus`, `depositAddress`, `balance`, `quote`, `swap`, `transfer`, or `call(tool, args)`. It has no dependencies |

Every path reaches the same tools under the same agent limits, wallet policy, approvals, and audit trail. Hosted sends are dry-run until hosted live opens.
