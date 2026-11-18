import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";

type Json = Record<string, unknown>;
type SkillSource = { kind: "dir"; path: string } | { kind: "file"; path: string };
type McpSource = { kind: "config"; path: string } | { kind: "inline"; id: string; command: unknown };
type HostRefs = { skills: SkillSource[]; mcp: McpSource[]; errors: string[] };

const hosts: Record<string, (manifest: Json) => HostRefs> = {
  ".claude-plugin/plugin.json": (manifest) => pointerHost(manifest, { skills: "./skills/", mcpServers: "./.mcp.json" }),
  ".codex-plugin/plugin.json": (manifest) => pointerHost(manifest, {}),
  ".grok-plugin/plugin.json": () => ({ skills: [{ kind: "dir", path: "skills" }], mcp: [], errors: [] }),
  ".muse-plugin/plugin.json": museHost,
};

export function validateHostManifests(root: string): string[] {
  const packageVersion = (readJson(path.join(root, "package.json")) as Json).version;
  const errors: string[] = [];
  for (const [file, readRefs] of Object.entries(hosts)) {
    const manifest = readJson(path.join(root, file));
    if (typeof manifest !== "object" || manifest === null) {
      errors.push(`${file}: does not parse as a JSON object`);
      continue;
    }
    const json = manifest as Json;
    const problems: string[] = [];
    if (typeof json.name !== "string" || json.name === "") problems.push("name must be a non-empty string");
    if (json.version !== packageVersion) problems.push(`version ${String(json.version)} does not match package.json ${String(packageVersion)}`);
    const refs = readRefs(json);
    problems.push(...refs.errors);
    for (const skill of refs.skills) problems.push(...checkSkills(root, skill));
    for (const mcp of refs.mcp) problems.push(...checkMcp(root, mcp));
    errors.push(...problems.map((problem) => `${file}: ${problem}`));
  }
  return errors;
}

function pointerHost(manifest: Json, defaults: { skills?: string; mcpServers?: string }): HostRefs {
  const errors: string[] = [];
  const pointer = (field: "skills" | "mcpServers"): string | undefined => {
    const value = manifest[field] ?? defaults[field];
    if (typeof value === "string") return value;
    errors.push(`${field} must be a path string`);
    return undefined;
  };
  const skills = pointer("skills");
  const mcpServers = pointer("mcpServers");
  return {
    skills: skills === undefined ? [] : [{ kind: "dir", path: skills }],
    mcp: mcpServers === undefined ? [] : [{ kind: "config", path: mcpServers }],
    errors,
  };
}

function museHost(manifest: Json): HostRefs {
  const errors: string[] = [];
  if (manifest.schemaVersion !== 1) errors.push("schemaVersion must be 1");
  const capabilities = (manifest.capabilities ?? {}) as Json;
  const skills = Array.isArray(capabilities.skills) ? (capabilities.skills as Json[]) : [];
  const servers = Array.isArray(capabilities.mcpServers) ? (capabilities.mcpServers as Json[]) : [];
  if (skills.length === 0) errors.push("capabilities.skills declares no skill");
  if (servers.length === 0) errors.push("capabilities.mcpServers declares no MCP server");
  for (const skill of skills) {
    if (typeof skill.id !== "string" || typeof skill.path !== "string") errors.push("each capabilities.skills entry needs a string id and path");
  }
  for (const server of servers) {
    if (typeof server.id !== "string" || server.transport !== "stdio") errors.push("each capabilities.mcpServers entry needs a string id and the stdio transport");
  }
  return {
    skills: skills.filter((skill) => typeof skill.path === "string").map((skill) => ({ kind: "file", path: skill.path as string })),
    mcp: servers.map((server) => ({ kind: "inline", id: String(server.id), command: server.command })),
    errors,
  };
}

function checkSkills(root: string, source: SkillSource): string[] {
  const rel = inside(source.path);
  if (rel === undefined) return [`skills ${source.path} points outside the plugin root`];
  if (source.kind === "file") return checkSkillFile(root, rel);
  const dir = path.join(root, rel);
  if (!existsSync(dir) || !statSync(dir).isDirectory()) return [`skills ${source.path} is not a directory`];
  const entries = readdirSync(dir).filter((name) => statSync(path.join(dir, name)).isDirectory());
  if (entries.length === 0) return [`skills ${source.path} holds no skill directory`];
  return entries.flatMap((name) => checkSkillFile(root, path.posix.join(rel, name, "SKILL.md")));
}

function checkSkillFile(root: string, rel: string): string[] {
  const full = path.join(root, rel);
  if (!existsSync(full)) return [`${rel}: missing`];
  const match = /^---\r?\n([\s\S]*?)\r?\n---(\r?\n|$)/.exec(readFileSync(full, "utf8"));
  if (match === null) return [`${rel}: no frontmatter`];
  const fields = new Map(match[1].split(/\r?\n/).map((line) => /^([a-z-]+):\s*(.*)$/.exec(line)).filter((m) => m !== null).map((m) => [m[1], m[2].trim()]));
  const errors: string[] = [];
  for (const key of ["name", "description"]) if (!fields.get(key)) errors.push(`${rel}: frontmatter lacks ${key}`);
  const dirName = path.posix.basename(path.posix.dirname(rel));
  if (fields.get("name") && fields.get("name") !== dirName) errors.push(`${rel}: frontmatter name ${fields.get("name")} does not match its directory ${dirName}`);
  return errors;
}

function checkMcp(root: string, source: McpSource): string[] {
  if (source.kind === "inline") return checkCommand(root, source.id, source.command);
  const rel = inside(source.path);
  if (rel === undefined) return [`mcpServers ${source.path} points outside the plugin root`];
  if (!existsSync(path.join(root, rel))) return [`mcpServers ${source.path} does not exist`];
  const config = readJson(path.join(root, rel)) as Json | undefined;
  const servers = config?.mcpServers;
  if (typeof servers !== "object" || servers === null || Object.keys(servers).length === 0) return [`${rel} declares no MCP server`];
  return Object.entries(servers as Record<string, Json>).flatMap(([id, server]) => {
    const args = Array.isArray(server.args) ? server.args : [];
    return checkCommand(root, id, [server.command, ...args]);
  });
}

function checkCommand(root: string, id: string, command: unknown): string[] {
  if (!Array.isArray(command) || command[0] !== "node" || typeof command[1] !== "string") return [`MCP server ${id} must run node with a script path`];
  const rel = inside(command[1]);
  if (rel === undefined) return [`MCP server ${id} runs ${command[1]}, which is outside the plugin root`];
  const errors: string[] = [];
  if (!existsSync(path.join(root, rel))) errors.push(`MCP server ${id} runs ${rel}, which does not exist`);
  const built = /^dist\/(.+)\.js$/.exec(rel);
  if (built !== null && !existsSync(path.join(root, `${built[1]}.ts`))) errors.push(`MCP server ${id} runs ${rel}, built from ${built[1]}.ts, which does not exist`);
  return errors;
}

function inside(target: string): string | undefined {
  const rel = path.posix.normalize(target).replace(/\/$/, "");
  return path.posix.isAbsolute(rel) || rel === ".." || rel.startsWith("../") ? undefined : rel;
}

function readJson(file: string): unknown {
  try {
    return JSON.parse(readFileSync(file, "utf8"));
  } catch {
    return undefined;
  }
}
