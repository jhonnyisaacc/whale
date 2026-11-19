import { execFileSync, spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const given = process.argv[2];
const scratch = mkdtempSync(path.join(tmpdir(), "whale-install-"));
const root = given ? path.resolve(given) : path.join(scratch, "clone");
const elsewhere = path.join(scratch, "project");
mkdirSync(elsewhere);
if (!given) {
  mkdirSync(root);
  execFileSync("sh", ["-c", 'git archive HEAD | tar -x -C "$1"', "sh", root], { stdio: ["ignore", "ignore", "inherit"] });
}

const read = (file) => JSON.parse(readFileSync(path.join(root, file), "utf8"));
const expand = (arg) => arg.replaceAll("${CLAUDE_PLUGIN_ROOT}", root).replaceAll("${PLUGIN_ROOT}", root);
const fromConfig = (server) => [server.command, ...(server.args ?? [])];
const hosts = [
  { host: "Claude plugin", cwd: elsewhere, argv: fromConfig({ ...read(".mcp.json").mcpServers, ...read(".claude-plugin/plugin.json").mcpServers }.whale) },
  { host: "Codex .mcp.json", cwd: root, argv: fromConfig(read(".mcp.json").mcpServers.whale) },
  { host: "Hermes mcp.json", cwd: root, argv: fromConfig(read("mcp.json").mcpServers.whale) },
  { host: "Muse plugin", cwd: root, argv: read(".muse-plugin/plugin.json").capabilities.mcpServers[0].command },
];

function listTools({ cwd, argv }, timeoutMs) {
  return new Promise((resolve) => {
    const child = spawn(argv[0], argv.slice(1).map(expand), { cwd, stdio: ["pipe", "pipe", "pipe"], env: { PATH: process.env.PATH, HOME: process.env.HOME } });
    let out = "";
    let err = "";
    const finish = (result) => {
      clearTimeout(timer);
      child.kill();
      resolve({ ...result, stderr: err.trim().split("\n").slice(-5).join("\n") });
    };
    const timer = setTimeout(() => finish({ tools: [], why: `no tools/list reply in ${timeoutMs} ms` }), timeoutMs);
    child.on("error", (error) => finish({ tools: [], why: error.message }));
    child.on("exit", (code) => finish({ tools: [], why: `exited with ${code}` }));
    child.stderr.on("data", (chunk) => { err += chunk; });
    child.stdout.on("data", (chunk) => {
      out += chunk;
      const lines = out.split("\n");
      out = lines.pop();
      for (const line of lines) {
        let message;
        try {
          message = JSON.parse(line);
        } catch {
          finish({ tools: [], why: `wrote a non-JSON line to stdout: ${line.slice(0, 120)}` });
          return;
        }
        if (message.id === 2) finish({ tools: (message.result?.tools ?? []).map((tool) => tool.name) });
      }
    });
    const send = (message) => child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", ...message })}\n`);
    send({ id: 1, method: "initialize", params: { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "check-install", version: "0" } } });
    send({ method: "notifications/initialized" });
    send({ id: 2, method: "tools/list" });
  });
}

const failures = [];
const seen = new Set();
try {
  for (const [index, entry] of hosts.entries()) {
    const started = Date.now();
    const result = await listTools(entry, index === 0 ? 600000 : 60000);
    const names = result.tools.join(",");
    console.log(`${entry.host}: ${result.tools.length} tools in ${Date.now() - started} ms${names ? ` (${names})` : ""}`);
    if (result.tools.length === 0) failures.push(`${entry.host} listed no tools: ${result.why}\n${result.stderr}`);
    else seen.add(names);
  }
  if (seen.size > 1) failures.push(`hosts disagree on the tool list: ${[...seen].join(" | ")}`);
} finally {
  rmSync(scratch, { recursive: true, force: true });
}
if (failures.length > 0) {
  console.error(failures.join("\n"));
  process.exit(1);
}
console.log(`install ok: every host manifest starts the MCP server from ${given ? root : "a clean archive of HEAD"} and lists its tools`);
