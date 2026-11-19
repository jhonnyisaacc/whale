import assert from "node:assert/strict";
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { validateHostManifests } from "./host-manifests.js";

const repo = fileURLToPath(new URL("../../", import.meta.url));
const copied = [".claude-plugin", ".codex-plugin", ".grok-plugin", ".muse-plugin", ".mcp.json", "plugin.json", "mcp.json", "package.json", "skills", "src/mcp-server.ts", "scripts/mcp-server.mjs", ".gitignore"];

function fixture(): string {
  const dir = mkdtempSync(path.join(tmpdir(), "whale-manifests-"));
  for (const entry of copied) cpSync(path.join(repo, entry), path.join(dir, entry), { recursive: true });
  return dir;
}

function editJson(dir: string, file: string, edit: (value: Record<string, unknown>) => void): void {
  const full = path.join(dir, file);
  const value = JSON.parse(readFileSync(full, "utf8")) as Record<string, unknown>;
  edit(value);
  writeFileSync(full, JSON.stringify(value));
}

function rejects(break_: (dir: string) => void, expected: RegExp): void {
  const dir = fixture();
  try {
    assert.deepEqual(validateHostManifests(dir), [], "the untouched fixture passes");
    break_(dir);
    const errors = validateHostManifests(dir);
    assert.ok(errors.some((error) => expected.test(error)), `expected ${expected} in ${JSON.stringify(errors)}`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test("the repo's five host manifests pass validation", () => {
  assert.deepEqual(validateHostManifests(repo), []);
});

test("a missing .mcp.json fails the Codex manifest", () => {
  rejects((dir) => rmSync(path.join(dir, ".mcp.json")), /^\.codex-plugin\/plugin\.json: .*\.mcp\.json/);
});

test("a missing skills directory fails every host that loads skills", () => {
  for (const manifest of [".claude-plugin", ".codex-plugin", ".grok-plugin", ".muse-plugin"]) {
    rejects((dir) => rmSync(path.join(dir, "skills"), { recursive: true }), new RegExp(`^\\${manifest}/plugin\\.json: .*skills`));
  }
  rejects((dir) => rmSync(path.join(dir, "skills"), { recursive: true }), /^plugin\.json: .*skills/);
});

test("a manifest version that drifts from package.json fails", () => {
  for (const manifest of [".claude-plugin", ".codex-plugin", ".grok-plugin", ".muse-plugin"]) {
    rejects((dir) => editJson(dir, `${manifest}/plugin.json`, (value) => { value.version = "9.9.9"; }), new RegExp(`^\\${manifest}/plugin\\.json: version 9\\.9\\.9`));
  }
});

test("a skill directory without SKILL.md frontmatter fails", () => {
  rejects((dir) => writeFileSync(path.join(dir, "skills/whale-wallet/SKILL.md"), "# Whale wallet\n"), /skills\/whale-wallet\/SKILL\.md: no frontmatter/);
  rejects((dir) => writeFileSync(path.join(dir, "skills/whale-wallet/SKILL.md"), "---\nname: whale-wallet\n---\n"), /skills\/whale-wallet\/SKILL\.md: frontmatter lacks description/);
  rejects((dir) => rmSync(path.join(dir, "skills/whale-wallet/SKILL.md")), /skills\/whale-wallet\/SKILL\.md: missing/);
});

test("an MCP server whose entry file is gone fails", () => {
  for (const manifest of [".claude-plugin", ".codex-plugin", ".muse-plugin"]) {
    rejects((dir) => rmSync(path.join(dir, "scripts/mcp-server.mjs")), new RegExp(`^\\${manifest}/plugin\\.json: MCP server whale runs scripts/mcp-server\\.mjs, which does not exist`));
  }
  rejects((dir) => editJson(dir, ".mcp.json", (value) => { value.mcpServers = {}; }), /^\.codex-plugin\/plugin\.json: .*declares no MCP server/);
});

test("a manifest that breaks its host's schema fails", () => {
  rejects((dir) => editJson(dir, ".claude-plugin/plugin.json", (value) => { delete value.name; }), /^\.claude-plugin\/plugin\.json: name/);
  rejects((dir) => editJson(dir, ".codex-plugin/plugin.json", (value) => { value.skills = "./missing/"; }), /^\.codex-plugin\/plugin\.json: skills .*missing/);
  rejects((dir) => editJson(dir, ".codex-plugin/plugin.json", (value) => { value.mcpServers = "../outside.json"; }), /^\.codex-plugin\/plugin\.json: mcpServers .*outside the plugin root/);
  rejects((dir) => editJson(dir, ".muse-plugin/plugin.json", (value) => { delete value.schemaVersion; }), /^\.muse-plugin\/plugin\.json: schemaVersion/);
  rejects((dir) => editJson(dir, ".muse-plugin/plugin.json", (value) => { (value.capabilities as { skills: { path: string }[] }).skills[0].path = "skills/gone/SKILL.md"; }), /^\.muse-plugin\/plugin\.json: .*skills\/gone\/SKILL\.md/);
});

function accepts(change: (dir: string) => void): void {
  const dir = fixture();
  try {
    change(dir);
    assert.deepEqual(validateHostManifests(dir), []);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function editSkill(dir: string, edit: (text: string) => string): void {
  const file = path.join(dir, "skills/whale-wallet/SKILL.md");
  writeFileSync(file, edit(readFileSync(file, "utf8")));
}

test("valid SKILL.md frontmatter forms pass", () => {
  accepts((dir) => editSkill(dir, (text) => text.replace("name: whale-wallet", 'name: "whale-wallet"')));
  accepts((dir) => editSkill(dir, (text) => text.replace("name: whale-wallet", "name: 'whale-wallet'")));
  accepts((dir) => editSkill(dir, (text) => `﻿${text}`));
});

test("SKILL.md frontmatter a YAML loader would drop fails", () => {
  rejects((dir) => editSkill(dir, (text) => text.replace(/^description: .*$/m, 'description: ""')), /skills\/whale-wallet\/SKILL\.md: frontmatter lacks description/);
  rejects((dir) => editSkill(dir, (text) => text.replace(/^description: .*$/m, "description: Use when: anything")), /skills\/whale-wallet\/SKILL\.md: frontmatter description needs quotes/);
});

test("an MCP command under the plugin root variable or after node flags passes", () => {
  accepts((dir) => editJson(dir, ".mcp.json", (value) => { (value.mcpServers as Record<string, { args: string[] }>).whale.args = ["${CLAUDE_PLUGIN_ROOT}/scripts/mcp-server.mjs"]; }));
  accepts((dir) => editJson(dir, ".mcp.json", (value) => { (value.mcpServers as Record<string, { args: string[] }>).whale.args = ["--enable-source-maps", "scripts/mcp-server.mjs"]; }));
});

test("an MCP entry that a clone of the repo lacks fails every host that starts one", () => {
  const built = ["dist/src/mcp-server.js"];
  rejects((dir) => editJson(dir, ".mcp.json", (value) => { (value.mcpServers as Record<string, { args: string[] }>).whale.args = built; }), /^\.codex-plugin\/plugin\.json: MCP server whale runs dist\/src\/mcp-server\.js, which a clone lacks because \.gitignore ignores dist\//);
  rejects((dir) => editJson(dir, ".muse-plugin/plugin.json", (value) => { (value.capabilities as { mcpServers: { command: string[] }[] }).mcpServers[0].command = ["node", ...built]; }), /^\.muse-plugin\/plugin\.json: .*which a clone lacks/);
  rejects((dir) => editJson(dir, "mcp.json", (value) => { (value.mcpServers as Record<string, { args: string[] }>).whale.args = built; }), /^plugin\.json: .*which a clone lacks/);
  rejects((dir) => editJson(dir, ".claude-plugin/plugin.json", (value) => { (value.mcpServers as Record<string, { args: string[] }>).whale.args = ["${CLAUDE_PLUGIN_ROOT}/dist/src/mcp-server.js"]; }), /^\.claude-plugin\/plugin\.json: .*which a clone lacks/);
});

test("a Claude plugin server outside the plugin root variable fails, because Claude Code starts it in the project directory", () => {
  rejects((dir) => editJson(dir, ".claude-plugin/plugin.json", (value) => { (value.mcpServers as Record<string, { args: string[] }>).whale.args = ["scripts/mcp-server.mjs"]; }), /^\.claude-plugin\/plugin\.json: MCP server whale runs scripts\/mcp-server\.mjs from the project directory/);
  rejects((dir) => editJson(dir, ".claude-plugin/plugin.json", (value) => { delete value.mcpServers; }), /^\.claude-plugin\/plugin\.json: MCP server whale runs scripts\/mcp-server\.mjs from the project directory/);
  rejects((dir) => editJson(dir, ".claude-plugin/plugin.json", (value) => { value.mcpServers = "./.mcp.json"; }), /^\.claude-plugin\/plugin\.json: mcpServers must be an inline server map/);
});

test("a Muse skill path that names a directory fails with a manifest error", () => {
  rejects((dir) => editJson(dir, ".muse-plugin/plugin.json", (value) => { (value.capabilities as { skills: { path: string }[] }).skills[0].path = "skills/whale-wallet"; }), /^\.muse-plugin\/plugin\.json: skills\/whale-wallet: not a file/);
});

type HermesServer = { type: string; command: string; args: string[]; env: Record<string, string> };

function editHermesServer(dir: string, edit: (server: HermesServer) => void): void {
  editJson(dir, "mcp.json", (value) => edit((value.mcpServers as Record<string, HermesServer>).whale));
}

test("a Hermes plugin.json without the Agent Plugins v1 schema or a valid name fails", () => {
  rejects((dir) => editJson(dir, "plugin.json", (value) => { delete value.$schema; }), /^plugin\.json: \$schema must be https:\/\/agent-plugins\.org\/schemas\/1\.0\.0\/plugin\.schema\.json/);
  rejects((dir) => editJson(dir, "plugin.json", (value) => { value.name = "Whale Wallet"; }), /^plugin\.json: name Whale Wallet/);
  rejects((dir) => editJson(dir, "plugin.json", (value) => { value.version = "9.9.9"; }), /^plugin\.json: version 9\.9\.9/);
});

test("a Hermes mcp.json that leaves the Agent Plugins v1 shape fails", () => {
  rejects((dir) => rmSync(path.join(dir, "mcp.json")), /^plugin\.json: mcp\.json does not exist/);
  rejects((dir) => editJson(dir, "mcp.json", (value) => { delete value.$schema; }), /^plugin\.json: mcp\.json must hold only/);
  rejects((dir) => editJson(dir, "mcp.json", (value) => { value.extra = {}; }), /^plugin\.json: mcp\.json must hold only/);
  rejects((dir) => editJson(dir, "mcp.json", (value) => { value.mcpServers = {}; }), /^plugin\.json: mcp\.json declares no MCP server/);
  rejects((dir) => editHermesServer(dir, (server) => { server.type = "sse"; }), /^plugin\.json: MCP server whale must use the stdio transport/);
});

test("a Hermes stdio server whose script is gone fails", () => {
  rejects((dir) => rmSync(path.join(dir, "scripts/mcp-server.mjs")), /^plugin\.json: MCP server whale runs scripts\/mcp-server\.mjs, which does not exist/);
  rejects((dir) => editHermesServer(dir, (server) => { server.args = ["scripts/gone.mjs"]; }), /^plugin\.json: MCP server whale runs scripts\/gone\.mjs/);
});

test("a Hermes server env that drifts from what Whale reads fails", () => {
  rejects((dir) => editHermesServer(dir, (server) => { server.env.WHALE_TYPO = "${WHALE_TYPO}"; }), /^plugin\.json: MCP server whale forwards WHALE_TYPO, which Whale does not read/);
  rejects((dir) => editHermesServer(dir, (server) => { delete server.env.EXECUTOR_AUTH_TOKEN; }), /^plugin\.json: MCP server whale does not forward EXECUTOR_AUTH_TOKEN/);
  rejects((dir) => editHermesServer(dir, (server) => { delete server.env.SOLANA_RPC_URL; }), /^plugin\.json: MCP server whale does not forward SOLANA_RPC_URL/);
  rejects((dir) => editHermesServer(dir, (server) => { delete server.env.RPC_URLS_8453; }), /^plugin\.json: MCP server whale does not forward RPC_URLS_8453/);
  rejects((dir) => editHermesServer(dir, (server) => { delete server.env.ZEROX_API_KEY; }), /^plugin\.json: MCP server whale does not forward ZEROX_API_KEY/);
  rejects((dir) => editHermesServer(dir, (server) => { server.env.EXECUTOR_URL = "http://127.0.0.1:8788"; }), /^plugin\.json: MCP server whale must pass EXECUTOR_URL through as \$\{EXECUTOR_URL\}/);
  rejects((dir) => writeFileSync(path.join(dir, "src/mcp-server.ts"), `${readFileSync(path.join(dir, "src/mcp-server.ts"), "utf8")}\nprocess.env.WHALE_NEW;\n`), /^plugin\.json: MCP server whale does not forward WHALE_NEW/);
});

test("a Hermes server that forwards the retired AUTH_TOKEN fails", () => {
  rejects((dir) => editHermesServer(dir, (server) => { server.env.AUTH_TOKEN = "${AUTH_TOKEN}"; }), /^plugin\.json: MCP server whale forwards AUTH_TOKEN, which Whale retired/);
});

test("a Hermes stdio entry the Hermes loader would skip fails", () => {
  rejects((dir) => editHermesServer(dir, (server) => { (server as unknown as Record<string, unknown>).timeout = 30; }), /^plugin\.json: MCP server whale has timeout, which is not an Agent Plugins v1 stdio field/);
  rejects((dir) => editHermesServer(dir, (server) => { (server as unknown as Record<string, unknown>).cwd = "dist"; }), /^plugin\.json: MCP server whale cwd dist must start with/);
  rejects((dir) => editHermesServer(dir, (server) => { server.args = ["${CLAUDE_PLUGIN_ROOT}/scripts/mcp-server.mjs"]; }), /^plugin\.json: MCP server whale runs \$\{CLAUDE_PLUGIN_ROOT\}/);
});

test("a Hermes server path under the Hermes plugin root variable passes", () => {
  accepts((dir) => editHermesServer(dir, (server) => { server.args = ["${PLUGIN_ROOT}/scripts/mcp-server.mjs"]; }));
  accepts((dir) => editHermesServer(dir, (server) => { (server as unknown as Record<string, unknown>).cwd = "./"; }));
});
