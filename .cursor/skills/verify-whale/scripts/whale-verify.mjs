#!/usr/bin/env node
import { spawn, spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, openSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { connect, createServer } from "node:net";
import path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import {
  PASS,
  REFUSED,
  commandOf,
  distExecutor,
  distServer,
  envShown,
  evidenceDir,
  fail,
  finish,
  getJson,
  hostEntry,
  isSend,
  killGroup,
  loadRun,
  mcpSession,
  netFile,
  parseArgs,
  readJson,
  readNet,
  record,
  repo,
  runDir,
  say,
  spawnNode,
} from "./harness.mjs";

const MAPPED_TOOLS = ["wallet_status", "quote", "swap", "bridge", "balance", "transfer"];

async function mcpCommand(argv) {
  const run = loadRun();
  const { sets, positional, label } = parseArgs(argv);
  const [tool, rawArgs = "{}"] = positional;
  if (!tool) fail("usage: mcp <tool> ['<json arguments>'] [--set NAME=VALUE]... [--label name]");
  let args;
  try { args = JSON.parse(rawArgs); } catch { fail(`tool arguments are not JSON: ${rawArgs}`); }
  const net = netFile(run);
  const env = { ...run.env, ...sets, WHALE_VERIFY_NETLOG: net };
  const session = await mcpSession(run, hostEntry, env, { method: "tools/call", params: { name: tool, arguments: args } }, 180_000);
  const network = readNet(net);
  const text = session.reply?.result?.content?.[0]?.text;
  let result = text;
  try { result = JSON.parse(text); } catch {}
  const isError = session.reply?.result?.isError === true;
  const file = record(run, label ?? `mcp-${tool}`, {
    entry: "mcp-stdio",
    command: `node scripts/mcp-server.mjs <<< tools/call ${tool}`,
    tool,
    arguments: args,
    env: envShown(env),
    replied: session.reply !== null,
    isError,
    result: result ?? null,
    jsonRpc: session.replies,
    protocolErrors: session.protocolErrors,
    stderr: session.stderr,
    exit: session.exit,
    ms: session.ms,
    network,
    sends: network.filter(isSend),
  });
  if (session.reply === null) fail(`no tools/call reply from the MCP server in ${session.ms} ms. stderr:\n${session.stderr.slice(-2000)}\nevidence: ${file}`, 2);
  process.stdout.write(`${typeof result === "string" ? result : JSON.stringify(result)}\n`);
  say(`${isError ? "tool error" : "ok"}, ${network.length} outbound requests, ${network.filter(isSend).length} sends. evidence: ${file}`);
  process.exitCode = isError ? 3 : 0;
}

async function cliCommand(argv) {
  const run = loadRun();
  const { sets, positional, label } = parseArgs(argv);
  if (positional.length === 0) fail("usage: cli [--set NAME=VALUE]... [--label name] -- <cli args>");
  const net = netFile(run);
  const env = { ...run.env, ...sets, WHALE_VERIFY_NETLOG: net };
  const started = Date.now();
  const proc = spawnNode(run, "dist/src/cli.js", positional, env);
  proc.child.stdin.end();
  const exit = await finish(proc, 180_000);
  const network = readNet(net);
  const stdout = proc.out();
  let result = null;
  try { result = JSON.parse(stdout); } catch {}
  const file = record(run, label ?? `cli-${positional[0]}`, {
    entry: "cli",
    command: `node dist/src/cli.js ${positional.join(" ")}`,
    env: envShown(env),
    exit,
    result,
    stdout,
    stderr: proc.err(),
    ms: Date.now() - started,
    network,
    sends: network.filter(isSend),
  });
  process.stdout.write(stdout);
  process.stderr.write(proc.err());
  say(`exit ${exit}, ${network.length} outbound requests, ${network.filter(isSend).length} sends. evidence: ${file}`);
  process.exitCode = typeof exit === "number" ? exit : 2;
}

async function httpCommand(argv) {
  const run = loadRun();
  const { positional, label, auth } = parseArgs(argv);
  const [method = "GET", route = "/status", body] = positional;
  const headers = auth ? { authorization: `Bearer ${run.token}` } : {};
  if (body !== undefined) headers["content-type"] = "application/json";
  const response = await fetch(`http://127.0.0.1:${run.port}${route}`, { method, headers, body });
  const text = await response.text();
  let result = text;
  try { result = JSON.parse(text); } catch {}
  const file = record(run, label ?? `http-${method}-${route}`.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/-$/, ""), { entry: "executor-http", request: { method, route, auth, body: body ?? null }, status: response.status, result });
  process.stdout.write(`${JSON.stringify({ status: response.status, body: result })}\n`);
  say(`evidence: ${file}`);
}

function freePort() {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      server.close(() => resolve(port));
    });
  });
}

function pnpm(args, logFile) {
  const log = openSync(logFile, "a");
  for (const command of [["pnpm"], ["corepack", "pnpm"]]) {
    const result = spawnSync(command[0], [...command.slice(1), ...args], { cwd: repo, stdio: ["ignore", log, log], env: { ...process.env, COREPACK_ENABLE_DOWNLOAD_PROMPT: "0" } });
    if (result.error?.code === "ENOENT") continue;
    return result.status === 0;
  }
  fail("neither pnpm nor corepack is on PATH");
}

const depsReady = () => {
  try { return readFileSync(path.join(repo, "node_modules/.pnpm/lock.yaml")).equals(readFileSync(path.join(repo, "pnpm-lock.yaml"))); } catch { return false; }
};

async function launch() {
  const [major, minor] = process.versions.node.split(".").map(Number);
  if (major < 22 || (major === 22 && minor < 12)) fail(`node ${process.versions.node} is older than the 22.12 package.json needs`);
  const id = `${new Date().toISOString().replace(/[-:]/g, "").replace(/\.\d+Z$/, "Z")}-${randomBytes(2).toString("hex")}`;
  const dir = runDir(id);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  mkdirSync(evidenceDir(id), { recursive: true });
  const retry = `run WHALE_VERIFY_RUN=${id} ${process.argv[1]} cleanup before retrying`;
  say(`run ${id}: scratch ${dir}, evidence ${evidenceDir(id)}`);
  const installLog = path.join(dir, "install.log");
  if (!depsReady()) {
    say("installing dependencies with pnpm install --frozen-lockfile");
    if (!pnpm(["install", "--frozen-lockfile"], installLog)) fail(`pnpm install failed. log: ${installLog}. ${retry}`);
  }
  const port = await freePort();
  const token = randomBytes(32).toString("base64url");
  writeFileSync(path.join(dir, "executor.token"), token, { mode: 0o600 });
  const env = Object.fromEntries(Object.entries(process.env).filter(([name]) => PASS.test(name)));
  Object.assign(env, { COREPACK_ENABLE_DOWNLOAD_PROMPT: "0", EXECUTOR_URL: `http://127.0.0.1:${port}`, EXECUTOR_AUTH_TOKEN: token });
  writeFileSync(path.join(dir, "env.json"), JSON.stringify(env), { mode: 0o600 });
  const run = { id, dir, evidence: evidenceDir(id), port, token, env };
  say("starting the MCP server through its host entry, which builds dist/ when src changed (the first build takes up to a minute)");
  const warm = await mcpSession(run, hostEntry, { ...env, WHALE_VERIFY_NETLOG: "" }, { method: "tools/list" }, 600_000);
  const tools = (warm.reply?.result?.tools ?? []).map((tool) => tool.name);
  writeFileSync(path.join(dir, "warm.log"), warm.stderr);
  if (tools.length === 0) fail(`the MCP host entry listed no tools. stderr:\n${warm.stderr.slice(-2000)}\n${retry}`);
  const log = openSync(path.join(dir, "executor.log"), "a");
  const executor = spawn(process.execPath, [distExecutor], { cwd: repo, env: { ...env, PORT: String(port) }, detached: true, stdio: ["ignore", log, log] });
  let executorExit = null;
  executor.once("exit", (code, signal) => { executorExit = code ?? signal; });
  executor.unref();
  const distBuiltAt = statSync(distExecutor).mtimeMs;
  writeFileSync(path.join(dir, "run.json"), JSON.stringify({ id, port, repo, executorPid: executor.pid, distBuiltAt }));
  let status = null;
  for (let attempt = 0; attempt < 100 && executorExit === null && status?.body?.live !== false; attempt += 1) {
    await sleep(300);
    status = await getJson(`http://127.0.0.1:${port}/status`, token).catch(() => null);
  }
  if (status?.body?.live !== false) fail(`the executor did not report live:false on port ${port}${executorExit === null ? "" : ` (it exited with ${executorExit})`}. log: ${path.join(dir, "executor.log")}. ${retry}`);
  const git = (args) => spawnSync("git", args, { cwd: repo, encoding: "utf8" }).stdout.trim();
  const file = record(run, "launch", { entry: "launch", gitHead: git(["rev-parse", "HEAD"]), gitDirty: git(["status", "--porcelain", "--", "src", "scripts"]) !== "", node: process.versions.node, port, executorPid: executor.pid, tools, status: status.body, env: envShown(env) });
  say(`ready: executor pid ${executor.pid} on 127.0.0.1:${port}, ${tools.length} MCP tools. evidence: ${file}`);
  process.stdout.write(`export WHALE_VERIFY_RUN=${id}\nexport WHALE_VERIFY_EVIDENCE=${evidenceDir(id)}\n`);
}

function newestMtime(dir) {
  let newest = 0;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    newest = Math.max(newest, entry.isDirectory() ? newestMtime(full) : statSync(full).mtimeMs);
  }
  return newest;
}

async function doctor() {
  const run = loadRun();
  const checks = [];
  const check = (name, ok, detail) => checks.push({ name, ok: Boolean(ok), detail });
  const command = commandOf(run.executorPid);
  check("executor-process", command?.includes(distExecutor), command ? `pid ${run.executorPid}: ${command}` : `pid ${run.executorPid} is not running`);
  const health = await getJson(`http://127.0.0.1:${run.port}/health`).catch((error) => ({ status: 0, body: error.message }));
  check("executor-health", health.body?.ok === true, health);
  const status = await getJson(`http://127.0.0.1:${run.port}/status`, run.token).catch((error) => ({ status: 0, body: error.message }));
  check("executor-ours-and-dry-run", status.status === 200 && status.body?.service === "executor" && status.body?.live === false && status.body?.killSwitch === false, { status: status.status, live: status.body?.live, killSwitch: status.body?.killSwitch, enabledChainKeys: status.body?.enabledChainKeys });
  const anonymous = await getJson(`http://127.0.0.1:${run.port}/status`).catch((error) => ({ status: 0, body: error.message }));
  check("executor-auth", anonymous.status === 401, `GET /status without the run token answered ${anonymous.status}`);
  const stamp = path.join(repo, "dist/.mcp-stamp.json");
  const stampFresh = existsSync(stamp) && statSync(stamp).mtimeMs >= newestMtime(path.join(repo, "src"));
  const executorFresh = existsSync(distExecutor) && statSync(distExecutor).mtimeMs === run.distBuiltAt;
  check("build-current", stampFresh && executorFresh, { mcpStampNewerThanSrc: stampFresh, executorStartedFromCurrentDist: executorFresh, fix: "if false: cleanup, then launch again" });
  const liveNames = Object.keys(run.env).filter((name) => REFUSED.test(name) && !/^EXECUTOR_(URL|AUTH_TOKEN)$/.test(name));
  check("env-dry-run", liveNames.length === 0 && run.env.EXECUTOR_URL === `http://127.0.0.1:${run.port}`, liveNames.length ? `live or signer settings present: ${liveNames.join(",")}` : "no broadcast, signer, gateway, or database setting");
  const session = existsSync(distServer) ? await mcpSession(null, distServer, { ...run.env, WHALE_VERIFY_NETLOG: "" }, { method: "tools/list" }, 30_000) : null;
  const tools = (session?.reply?.result?.tools ?? []).map((tool) => tool.name);
  const missing = MAPPED_TOOLS.filter((name) => !tools.includes(name));
  check("mcp-tools", session && missing.length === 0 && session.protocolErrors.length === 0, { tools, missing, protocolErrors: session?.protocolErrors ?? ["dist/src/mcp-server.js is missing"] });
  const ok = checks.every((item) => item.ok);
  process.stdout.write(`${JSON.stringify({ ok, runId: run.id, port: run.port, checks }, null, 2).replaceAll(run.token, "<executor-token>")}\n`);
  process.exitCode = ok ? 0 : 1;
}

function portOpen(port) {
  return new Promise((resolve) => {
    const socket = connect({ port, host: "127.0.0.1" });
    socket.once("connect", () => { socket.destroy(); resolve(true); });
    socket.once("error", () => resolve(false));
  });
}

async function stop(pid, expected) {
  const command = commandOf(pid);
  if (!command) return "not running";
  if (!command.includes(expected)) return `left alone: pid ${pid} now runs ${command}`;
  killGroup(pid, "SIGTERM");
  for (let waited = 0; waited < 25_000 && commandOf(pid); waited += 250) await sleep(250);
  if (commandOf(pid)) killGroup(pid, "SIGKILL");
  return "stopped";
}

async function cleanup() {
  const id = process.env.WHALE_VERIFY_RUN;
  if (!id) fail("set WHALE_VERIFY_RUN to the run to clean up");
  const dir = runDir(id);
  const evidence = evidenceDir(id);
  if (!existsSync(dir)) {
    say(`run ${id} has no scratch state left. evidence: ${evidence}`);
    return;
  }
  const meta = existsSync(path.join(dir, "run.json")) ? readJson(path.join(dir, "run.json")) : {};
  const token = existsSync(path.join(dir, "executor.token")) ? readFileSync(path.join(dir, "executor.token"), "utf8").trim() : null;
  const stopped = {};
  const children = path.join(dir, "children");
  for (const pid of existsSync(children) ? readdirSync(children) : []) stopped[pid] = await stop(Number(pid), readFileSync(path.join(children, pid), "utf8"));
  if (meta.executorPid) stopped[meta.executorPid] = await stop(meta.executorPid, distExecutor);
  mkdirSync(evidence, { recursive: true });
  for (const name of ["executor.log", "warm.log", "install.log"]) {
    const source = path.join(dir, name);
    if (!existsSync(source)) continue;
    const text = readFileSync(source, "utf8");
    writeFileSync(path.join(evidence, name), token ? text.replaceAll(token, "<executor-token>") : text);
  }
  const portStillOpen = meta.port ? await portOpen(meta.port) : false;
  rmSync(dir, { recursive: true, force: true });
  process.stdout.write(`${JSON.stringify({ runId: id, stopped, portStillOpen, scratchRemoved: !existsSync(dir), evidence, files: readdirSync(evidence).sort() }, null, 2)}\n`);
  process.exitCode = portStillOpen ? 1 : 0;
}

const [subcommand, ...rest] = process.argv.slice(2);
const commands = { launch, doctor, cleanup, mcp: () => mcpCommand(rest), cli: () => cliCommand(rest), http: () => httpCommand(rest) };
if (!commands[subcommand]) fail("usage: whale-verify launch | doctor | mcp <tool> [json] | cli -- <args> | http <METHOD> <route> [json] | cleanup");
await commands[subcommand]();
