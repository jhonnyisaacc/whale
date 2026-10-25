import { existsSync, readFileSync } from "node:fs";

const manifests = [".grok-plugin/plugin.json", ".claude-plugin/plugin.json", ".codex-plugin/plugin.json", ".muse-plugin/plugin.json", ".mcp.json"];
for (const file of manifests) {
  JSON.parse(readFileSync(new URL(`../${file}`, import.meta.url), "utf8"));
}
const muse = JSON.parse(readFileSync(new URL("../.muse-plugin/plugin.json", import.meta.url), "utf8"));
for (const skill of muse.capabilities.skills) {
  if (!existsSync(new URL(`../${skill.path}`, import.meta.url))) throw new Error(`muse skill path missing: ${skill.path}`);
}
const [command, entry] = muse.capabilities.mcpServers[0].command;
if (command !== "node" || !entry.endsWith("mcp-server.js")) throw new Error("muse MCP command must run the built MCP server");
for (const file of [".codex/agents/rocket-wallet.toml", "agents/codex/rocket-wallet.toml"]) {
  const text = readFileSync(new URL(`../${file}`, import.meta.url), "utf8");
  if (!text.includes('name = "whale-wallet"')) throw new Error(`${file} lost the whale-wallet name`);
}
console.log("agent manifests ok: Grok, Claude, Codex, and Muse manifests parse and point at real files");
