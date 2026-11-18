import assert from "node:assert/strict";
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { validateHostManifests } from "./host-manifests.js";

const repo = fileURLToPath(new URL("../../", import.meta.url));
const copied = [".claude-plugin", ".codex-plugin", ".grok-plugin", ".muse-plugin", ".mcp.json", "package.json", "skills", "src/mcp-server.ts", "dist/src/mcp-server.js"];

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

test("the repo's four host manifests pass validation", () => {
  assert.deepEqual(validateHostManifests(repo), []);
});

test("a missing .mcp.json fails the Codex and Claude manifests", () => {
  rejects((dir) => rmSync(path.join(dir, ".mcp.json")), /^\.codex-plugin\/plugin\.json: .*\.mcp\.json/);
  rejects((dir) => rmSync(path.join(dir, ".mcp.json")), /^\.claude-plugin\/plugin\.json: .*\.mcp\.json/);
});

test("a missing skills directory fails every host that loads skills", () => {
  for (const manifest of [".claude-plugin", ".codex-plugin", ".grok-plugin", ".muse-plugin"]) {
    rejects((dir) => rmSync(path.join(dir, "skills"), { recursive: true }), new RegExp(`^\\${manifest}/plugin\\.json: .*skills`));
  }
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
  rejects((dir) => rmSync(path.join(dir, "dist/src/mcp-server.js")), /^\.codex-plugin\/plugin\.json: .*dist\/src\/mcp-server\.js/);
  rejects((dir) => rmSync(path.join(dir, "src/mcp-server.ts")), /^\.muse-plugin\/plugin\.json: .*src\/mcp-server\.ts/);
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
  accepts((dir) => editJson(dir, ".mcp.json", (value) => { (value.mcpServers as Record<string, { args: string[] }>).whale.args = ["${CLAUDE_PLUGIN_ROOT}/dist/src/mcp-server.js"]; }));
  accepts((dir) => editJson(dir, ".mcp.json", (value) => { (value.mcpServers as Record<string, { args: string[] }>).whale.args = ["--enable-source-maps", "dist/src/mcp-server.js"]; }));
});

test("a Muse skill path that names a directory fails with a manifest error", () => {
  rejects((dir) => editJson(dir, ".muse-plugin/plugin.json", (value) => { (value.capabilities as { skills: { path: string }[] }).skills[0].path = "skills/whale-wallet"; }), /^\.muse-plugin\/plugin\.json: skills\/whale-wallet: not a file/);
});
