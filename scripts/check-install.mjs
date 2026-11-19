import { execFileSync, spawn, spawnSync } from "node:child_process";
import { appendFileSync, chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
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

const env = { PATH: process.env.PATH, HOME: process.env.HOME };
const read = (file) => JSON.parse(readFileSync(path.join(root, file), "utf8"));
const expand = (arg) => arg.replaceAll("${CLAUDE_PLUGIN_ROOT}", root).replaceAll("${PLUGIN_ROOT}", root);
const fromConfig = (server) => [server.command, ...(server.args ?? [])];
const hosts = [
  { host: "Claude plugin", cwd: elsewhere, argv: fromConfig({ ...read(".mcp.json").mcpServers, ...read(".claude-plugin/plugin.json").mcpServers }.whale) },
  { host: "Codex .mcp.json", cwd: root, argv: fromConfig(read(".mcp.json").mcpServers.whale) },
  { host: "Hermes mcp.json", cwd: root, argv: fromConfig(read("mcp.json").mcpServers.whale) },
  { host: "Muse plugin", cwd: root, argv: read(".muse-plugin/plugin.json").capabilities.mcpServers[0].command },
];
const codex = hosts[1];

function listTools(entry, timeoutMs) {
  const { cwd, argv } = entry;
  return new Promise((resolve) => {
    const child = spawn(argv[0], argv.slice(1).map(expand), { cwd, stdio: ["pipe", "pipe", "pipe"], env: entry.env ?? env, detached: true });
    let out = "";
    let err = "";
    let done = false;
    const finish = (result) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      try {
        process.kill(-child.pid, "SIGTERM");
      } catch (error) {
        if (error.code !== "ESRCH") throw error;
      }
      resolve({ ...result, stderr: err });
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

const tail = (text) => text.trim().split("\n").slice(-5).join("\n");
const failures = [];
const seen = new Set();
const server = path.join(root, "src/mcp-server.ts");
const original = readFileSync(server, "utf8");

async function expectTools(label, entry, timeoutMs, { without } = {}) {
  const started = Date.now();
  const result = await listTools(entry, timeoutMs);
  const names = result.tools.join(",");
  console.log(`${label}: ${result.tools.length} tools in ${Date.now() - started} ms${names ? ` (${names})` : ""}`);
  if (result.tools.length === 0) failures.push(`${label} listed no tools: ${result.why}\n${tail(result.stderr)}`);
  else if (without && result.stderr.includes(without)) failures.push(`${label} ran a build that printed "${without}", which is not in the source`);
  return result;
}

async function expectNoTools(label, entry) {
  const result = await listTools(entry, 600000);
  console.log(`${label}: ${result.tools.length} tools (${result.why ?? "replied"})`);
  if (result.tools.length > 0) failures.push(`${label} listed tools from a source that does not compile`);
}

async function withSource(extra, run) {
  appendFileSync(server, extra);
  try {
    await run();
  } finally {
    writeFileSync(server, original);
  }
}

async function interruptedFirstStarts() {
  const killed = await listTools(codex, 2000);
  console.log(`first start stopped with its process group after 2000 ms: ${killed.tools.length} tools`);
  const deadline = Date.now() + 600000;
  for (let attempt = 1; Date.now() < deadline; attempt += 1) {
    const result = await listTools(codex, 2000);
    if (result.tools.length > 0) {
      console.log(`a 2000 ms start listed ${result.tools.length} tools on attempt ${attempt}`);
      return;
    }
  }
  failures.push("no 2000 ms start listed tools after the first start was stopped mid-build");
}

const shimDir = path.join(scratch, "bin");
const pnpmRuns = path.join(scratch, "pnpm-runs");
const realPnpm = spawnSync("sh", ["-c", "command -v pnpm"], { encoding: "utf8" }).stdout.trim();
mkdirSync(shimDir);
writeFileSync(path.join(shimDir, "pnpm"), `#!/bin/sh\necho "$*" >> '${pnpmRuns}'\nexec ${realPnpm ? `'${realPnpm}'` : "corepack pnpm"} "$@"\n`);
chmodSync(path.join(shimDir, "pnpm"), 0o755);
const counted = { ...codex, env: { ...env, PATH: `${shimDir}:${env.PATH}` } };

function countRuns() {
  const runs = existsSync(pnpmRuns) ? readFileSync(pnpmRuns, "utf8").trim().split("\n").filter(Boolean) : [];
  return { installs: runs.filter((run) => run.startsWith("install")).length, builds: runs.filter((run) => run.startsWith("exec tsc")).length };
}

function plantCrashedLock(pid, ageMs) {
  writeFileSync(path.join(root, "dist/.mcp-build.lock"), String(pid));
  const dir = path.join(root, "dist/.mcp-build-lock");
  mkdirSync(dir, { recursive: true });
  const lock = path.join(dir, String(Math.max(-1, ...readdirSync(dir).map(Number)) + 1));
  writeFileSync(lock, String(pid));
  const at = (Date.now() - ageMs) / 1000;
  utimesSync(lock, at, at);
}

function deadPid() {
  return spawnSync("sh", ["-c", "sh -c 'echo $$'"], { encoding: "utf8" }).stdout.trim();
}

async function crashedBuilderWithReusedPid() {
  const marker = "whale-check: built past a crashed lock";
  await withSource(`\nprocess.stderr.write("${marker}\\n");\n`, async () => {
    plantCrashedLock(1, 0);
    const result = await expectTools("with a crashed builder's lock whose pid 1 is alive", codex, 60000);
    if (result.tools.length > 0 && !result.stderr.includes(marker)) failures.push("the start past a crashed builder's lock did not rebuild the edited source");
  });
}

async function racingStartsPastADeadLock(trial) {
  const installsWanted = trial === 0 ? 1 : 0;
  if (installsWanted) rmSync(path.join(root, "node_modules"), { recursive: true, force: true });
  rmSync(pnpmRuns, { force: true });
  await withSource(`\nexport const touched = ${trial + 2};\n`, async () => {
    plantCrashedLock(deadPid(), 60000);
    const results = await Promise.all(Array.from({ length: 12 }, () => listTools(counted, 600000)));
    const listed = results.filter((result) => result.tools.length > 0).length;
    const { installs, builds } = countRuns();
    console.log(`12 starts past a dead lock, trial ${trial + 1}: ${listed} listed tools, ${installs} pnpm install, ${builds} tsc`);
    if (listed < 12) failures.push(`trial ${trial + 1}: only ${listed} of 12 racing starts listed tools\n${tail(results.find((result) => result.tools.length === 0).stderr)}`);
    if (installs !== installsWanted || builds !== 1) failures.push(`trial ${trial + 1}: 12 racing starts ran pnpm install ${installs} times and tsc ${builds} times, not ${installsWanted} and 1`);
  });
}

function manualBuild() {
  execFileSync("sh", ["-c", "pnpm run build || corepack pnpm run build"], { cwd: root, env, stdio: ["ignore", "ignore", "ignore"] });
}

try {
  await interruptedFirstStarts();
  for (const entry of hosts) {
    const result = await expectTools(entry.host, entry, 600000);
    if (result.tools.length > 0) seen.add(result.tools.join(","));
  }
  if (seen.size > 1) failures.push(`hosts disagree on the tool list: ${[...seen].join(" | ")}`);

  const edited = "whale-check: edited source";
  await withSource(`\nprocess.stderr.write("${edited}\\n");\n`, async () => {
    const result = await expectTools("after a src edit", codex, 600000);
    if (!result.stderr.includes(edited)) failures.push("after a src edit the server did not run the edited source");
  });
  await expectTools("after the src edit is reverted", codex, 600000, { without: edited });

  await withSource("\nexport const broken = ;\n", () => expectNoTools("with a syntax error", codex));
  await expectTools("after the syntax error is reverted", codex, 600000);

  const typeError = "whale-check: type error build";
  await withSource(`\nprocess.stderr.write("${typeError}\\n");\nexport const broken: number = "x";\n`, () => expectNoTools("with a type error", codex));
  await expectTools("after the type error is reverted", codex, 600000, { without: typeError });

  const manual = "whale-check: manual build";
  await withSource(`\nprocess.stderr.write("${manual}\\n");\n`, async () => manualBuild());
  await expectTools("after a manual build of other source", codex, 600000, { without: manual });

  rmSync(path.join(root, "node_modules"), { recursive: true, force: true });
  await expectTools("after node_modules is deleted", codex, 600000);

  await crashedBuilderWithReusedPid();
  for (let trial = 0; trial < 8; trial += 1) await racingStartsPastADeadLock(trial);
} finally {
  writeFileSync(server, original);
  rmSync(scratch, { recursive: true, force: true });
}
if (failures.length > 0) {
  console.error(failures.join("\n"));
  process.exit(1);
}
console.log(`install ok: every host manifest starts the MCP server from ${given ? root : "a clean archive of HEAD"} and lists its tools, and the build recovers from a stopped start, a failed build, a manual build, a deleted node_modules, a crashed builder's lock and 12 racing starts`);
