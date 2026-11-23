import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { CHAINS } from "../src/chains.js";
import { QUOTE_KEY_NAMES } from "../src/command-callers.js";
import { rpcListEnv } from "../src/config/load.js";

type Json = Record<string, unknown>;
type SkillSource = { kind: "dir"; path: string } | { kind: "file"; path: string };
type McpSource = { kind: "config"; path: string } | { kind: "agent-plugins"; path: string } | { kind: "inline"; id: string; command: unknown } | { kind: "claude"; servers: Record<string, Json> };
type HostRefs = { skills: SkillSource[]; mcp: McpSource[]; errors: string[] };

const agentPluginSchema = "https://agent-plugins.org/schemas/1.0.0/plugin.schema.json";
const agentMcpSchema = "https://agent-plugins.org/schemas/1.0.0/mcp.schema.json";
const agentStdioFields = ["type", "command", "args", "env", "cwd"];
const retiredEnv = ["AUTH_TOKEN"];

const hosts: Record<string, (manifest: Json) => HostRefs> = {
  ".claude-plugin/plugin.json": claudeHost,
  ".codex-plugin/plugin.json": pointerHost,
  ".grok-plugin/plugin.json": () => ({ skills: [{ kind: "dir", path: "skills" }], mcp: [], errors: [] }),
  ".muse-plugin/plugin.json": museHost,
  "plugin.json": hermesHost,
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

function pointerHost(manifest: Json): HostRefs {
  const errors: string[] = [];
  const pointer = (field: "skills" | "mcpServers"): string | undefined => {
    const value = manifest[field];
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

function claudeHost(manifest: Json): HostRefs {
  const skills: SkillSource[] = [{ kind: "dir", path: "./skills/" }];
  const inline = manifest.mcpServers ?? {};
  if (typeof inline !== "object" || inline === null || Array.isArray(inline)) return { skills, mcp: [], errors: ["mcpServers must be an inline server map"] };
  return { skills, mcp: [{ kind: "claude", servers: inline as Record<string, Json> }], errors: [] };
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

function hermesHost(manifest: Json): HostRefs {
  const errors: string[] = [];
  if (manifest.$schema !== agentPluginSchema) errors.push(`$schema must be ${agentPluginSchema}`);
  if (typeof manifest.name === "string" && !/^(?!.*(?:--|\.\.))[a-z0-9](?:[a-z0-9.-]{0,62}[a-z0-9])?$/.test(manifest.name)) errors.push(`name ${manifest.name} breaks the Agent Plugins v1 name rule`);
  return { skills: [{ kind: "dir", path: "skills" }], mcp: [{ kind: "agent-plugins", path: "mcp.json" }], errors };
}

function checkSkills(root: string, source: SkillSource): string[] {
  const rel = inside(source.path);
  if (rel === undefined) return [`skills ${source.path} points outside the plugin root`];
  if (source.kind === "file") return checkSkillFile(root, rel);
  let entries: string[];
  try {
    entries = readdirSync(path.join(root, rel), { withFileTypes: true }).filter((entry) => entry.isDirectory()).map((entry) => entry.name);
  } catch {
    return [`skills ${source.path} is not a directory`];
  }
  if (entries.length === 0) return [`skills ${source.path} holds no skill directory`];
  return entries.flatMap((name) => checkSkillFile(root, path.posix.join(rel, name, "SKILL.md")));
}

function checkSkillFile(root: string, rel: string): string[] {
  let text: string;
  try {
    text = readFileSync(path.join(root, rel), "utf8");
  } catch (error) {
    return [`${rel}: ${(error as NodeJS.ErrnoException).code === "EISDIR" ? "not a file" : "missing"}`];
  }
  const match = /^\uFEFF?---\r?\n([\s\S]*?)\r?\n---(\r?\n|$)/.exec(text);
  if (match === null) return [`${rel}: no frontmatter`];
  const fields = new Map(match[1].split(/\r?\n/).map((line) => /^([a-z-]+):\s*(.*)$/.exec(line)).filter((m) => m !== null).map((m) => [m[1], m[2].trim()]));
  const errors: string[] = [];
  const values = new Map<string, string>();
  for (const key of ["name", "description"]) {
    const raw = fields.get(key) ?? "";
    const quoted = /^(["'])(.*)\1$/.exec(raw);
    if (quoted === null && raw.includes(": ")) errors.push(`${rel}: frontmatter ${key} needs quotes because it contains ": "`);
    const value = quoted === null ? raw : quoted[2];
    if (value === "") errors.push(`${rel}: frontmatter lacks ${key}`);
    values.set(key, value);
  }
  const dirName = path.posix.basename(path.posix.dirname(rel));
  const name = values.get("name");
  if (name && name !== dirName) errors.push(`${rel}: frontmatter name ${name} does not match its directory ${dirName}`);
  return errors;
}

function checkMcp(root: string, source: McpSource): string[] {
  if (source.kind === "inline") return checkCommand(root, source.id, source.command);
  if (source.kind === "agent-plugins") return checkAgentPluginMcp(root, source.path);
  if (source.kind === "claude") return checkClaudeMcp(root, source.servers);
  const rel = inside(source.path);
  if (rel === undefined) return [`mcpServers ${source.path} points outside the plugin root`];
  const config = readJson(path.join(root, rel)) as Json | undefined;
  if (config === undefined) return [`mcpServers ${source.path} does not exist or is not JSON`];
  const servers = config.mcpServers;
  if (typeof servers !== "object" || servers === null || Object.keys(servers).length === 0) return [`${rel} declares no MCP server`];
  return Object.entries(servers as Record<string, Json>).flatMap(([id, server]) => {
    const args = Array.isArray(server.args) ? server.args : [];
    return checkCommand(root, id, [server.command, ...args]);
  });
}

function checkClaudeMcp(root: string, inline: Record<string, Json>): string[] {
  const rootConfig = readJson(path.join(root, ".mcp.json")) as Json | undefined;
  const servers = { ...((rootConfig?.mcpServers ?? {}) as Record<string, Json>), ...inline };
  if (Object.keys(servers).length === 0) return ["declares no MCP server in .mcp.json or mcpServers"];
  return Object.entries(servers).flatMap(([id, server]) => {
    const args = Array.isArray(server.args) ? server.args : [];
    const script = args.find((arg) => typeof arg !== "string" || !arg.startsWith("-"));
    if (typeof script === "string" && !script.startsWith("${CLAUDE_PLUGIN_ROOT}/")) return [`MCP server ${id} runs ${script} from the project directory, where Claude Code starts plugin servers. Prefix it with \${CLAUDE_PLUGIN_ROOT}/`];
    return checkCommand(root, id, [server.command, ...args]);
  });
}

function checkAgentPluginMcp(root: string, file: string): string[] {
  const config = readJson(path.join(root, file));
  if (typeof config !== "object" || config === null) return [`${file} does not exist or is not JSON`];
  const json = config as Json;
  if (Object.keys(json).sort().join() !== "$schema,mcpServers" || json.$schema !== agentMcpSchema) return [`${file} must hold only $schema ${agentMcpSchema} and mcpServers`];
  const servers = json.mcpServers;
  if (typeof servers !== "object" || servers === null || Object.keys(servers).length === 0) return [`${file} declares no MCP server`];
  const read = forwardedEnv(root);
  return Object.entries(servers as Record<string, Json>).flatMap(([id, server]) => {
    if (server.type !== "stdio") return [`MCP server ${id} must use the stdio transport`];
    const errors = Object.keys(server).filter((key) => !agentStdioFields.includes(key)).map((key) => `MCP server ${id} has ${key}, which is not an Agent Plugins v1 stdio field`);
    const cwd = server.cwd;
    if (cwd !== undefined && (typeof cwd !== "string" || !/^(\.\/|\$\{PLUGIN_(ROOT|DATA)\}(\/|$))/.test(cwd))) errors.push(`MCP server ${id} cwd ${String(cwd)} must start with ./, \${PLUGIN_ROOT}, or \${PLUGIN_DATA}`);
    const args = Array.isArray(server.args) ? server.args : [];
    errors.push(...checkCommand(root, id, [server.command, ...args], "PLUGIN_ROOT"));
    const env = typeof server.env === "object" && server.env !== null ? (server.env as Json) : {};
    for (const [name, value] of Object.entries(env)) {
      if (retiredEnv.includes(name)) errors.push(`MCP server ${id} forwards ${name}, which Whale retired`);
      else if (!read.includes(name)) errors.push(`MCP server ${id} forwards ${name}, which Whale does not read`);
      else if (value !== `\${${name}}`) errors.push(`MCP server ${id} must pass ${name} through as \${${name}}, not a value`);
    }
    for (const name of read) if (!Object.hasOwn(env, name)) errors.push(`MCP server ${id} does not forward ${name}, which Whale reads`);
    return errors;
  });
}

function forwardedEnv(root: string): string[] {
  const rpc = CHAINS.flatMap((chain) => [chain.rpcEnv, rpcListEnv(chain.rpcEnv) ?? []].flat());
  return [...new Set([...mcpServerEnv(root).filter((name) => !retiredEnv.includes(name)), ...rpc, ...QUOTE_KEY_NAMES, "HYPERLIQUID_ACCOUNT_ADDRESS"])];
}

function mcpServerEnv(root: string): string[] {
  let text: string;
  try {
    text = readFileSync(path.join(root, "src/mcp-server.ts"), "utf8");
  } catch {
    return [];
  }
  return [...new Set([...text.matchAll(/process\.env\.([A-Z][A-Z0-9_]*)/g)].map((match) => match[1]))];
}

function checkCommand(root: string, id: string, command: unknown, rootVar = "CLAUDE_PLUGIN_ROOT"): string[] {
  const script = Array.isArray(command) && command[0] === "node" ? command.slice(1).find((arg) => typeof arg !== "string" || !arg.startsWith("-")) : undefined;
  if (typeof script !== "string") return [`MCP server ${id} must run node with a script path`];
  const prefix = "${" + rootVar + "}/";
  const rel = inside(script.startsWith(prefix) ? script.slice(prefix.length) : script);
  if (rel === undefined) return [`MCP server ${id} runs ${script}, which is outside the plugin root`];
  const ignored = ignoredDirs(root).find((dir) => rel === dir || rel.startsWith(`${dir}/`));
  if (ignored !== undefined) return [`MCP server ${id} runs ${rel}, which a clone lacks because .gitignore ignores ${ignored}/`];
  if (!existsSync(path.join(root, rel))) return [`MCP server ${id} runs ${rel}, which does not exist`];
  return [];
}

function ignoredDirs(root: string): string[] {
  let text: string;
  try {
    text = readFileSync(path.join(root, ".gitignore"), "utf8");
  } catch {
    return [];
  }
  return text.split(/\r?\n/).map((line) => line.trim()).filter((line) => /^[^#!*]+\/$/.test(line)).map((line) => line.replace(/^\//, "").replace(/\/$/, ""));
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
