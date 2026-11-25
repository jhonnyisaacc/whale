import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
export const repo = path.resolve(here, "../../../..");
const home = process.env.WHALE_VERIFY_HOME || path.join(homedir(), ".local/state/whale-verify");
const netlog = path.join(here, "netlog.mjs");
export const hostEntry = path.join(repo, "scripts/mcp-server.mjs");
export const distServer = path.join(repo, "dist/src/mcp-server.js");
export const distExecutor = path.join(repo, "dist/src/executor-server.js");

export const PASS = /^(PATH|HOME|LANG|TZ|ZEROX_API_KEY|JUPITER_API_KEY|LIFI_API_KEY|LIFI_INTEGRATOR|ONEINCH_API_KEY|OKX_API_(KEY|SECRET|PASSPHRASE)|KYBERSWAP_CLIENT_ID|ACROSS_API_KEY|ACROSS_INTEGRATOR_ID|RELAY_API_KEY|COINGECKO_API_KEY|HYPERLIQUID_API_URL|HYPERLIQUID_ACCOUNT_ADDRESS|SOLANA_RPC_URLS?|RPC_URLS?_\d+)$/;
export const REFUSED = /^(WHALE_BROADCAST|WHALE_SIGNER_\w+|KEYSTORE_\w+|TURNKEY_API_\w+|TURNKEY_ORGANIZATION_ID|TURNKEY_(PARENT|DELEGATE)_\w+|DATABASE_URL|WHALE_GATEWAY_URL|WHALE_API_KEY|HOSTED_\w+|EXECUTOR_\w+|AUTH_TOKEN|ADMIN_TOKEN|NODE_OPTIONS)$/;
const PUBLIC = /^(EXECUTOR_URL|OWNER_WITHDRAW_ADDRESSES|TURNKEY_(EVM|SOLANA)_ADDRESS|HYPERLIQUID_ACCOUNT_ADDRESS|ENABLED_CHAINS|DISABLED_CHAINS|KILL_SWITCH|MAX_\w+|DAILY_\w+|\w+_TIMEOUT_MS|QUOTE_DEADLINE_MS)$/;
const SEND_RPC = /^(eth_sendRawTransaction|eth_sendTransaction|eth_sendBundle|sendTransaction|sendBundle)$/;

export function fail(message, code = 1) {
  process.stderr.write(`whale-verify: ${message}\n`);
  process.exit(code);
}

export const say = (message) => process.stderr.write(`whale-verify: ${message}\n`);
export const readJson = (file) => JSON.parse(readFileSync(file, "utf8"));
export const runDir = (id) => path.join(home, "runs", id);
export const evidenceDir = (id) => path.join(home, "evidence", id);
const origin = (value) => value.split(",").map((url) => { try { return new URL(url).origin; } catch { return "<unparsed>"; } }).join(",");
const shown = (name, value) => (PUBLIC.test(name) ? value : /RPC_URL/.test(name) ? origin(value) : "<set>");

export const envShown = (env) =>
  Object.fromEntries(Object.entries(env).filter(([name]) => !/^(PATH|HOME|LANG|TZ|COREPACK_ENABLE_DOWNLOAD_PROMPT|WHALE_VERIFY_NETLOG)$/.test(name)).map(([name, value]) => [name, shown(name, value)]));

export function parseArgs(argv) {
  const sets = {};
  const positional = [];
  let label = null;
  let auth = true;
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--") { positional.push(...argv.slice(i + 1)); break; }
    if (arg === "--set") {
      const pair = argv[++i] ?? "";
      const eq = pair.indexOf("=");
      if (eq < 1) fail(`--set needs NAME=VALUE, got ${pair}`);
      const name = pair.slice(0, eq);
      if (REFUSED.test(name)) fail(`${name} is refused: verification stays dry-run with no signer, gateway, or database`);
      sets[name] = pair.slice(eq + 1);
    } else if (arg === "--label") label = (argv[++i] ?? "").toLowerCase().replace(/[^a-z0-9-]+/g, "-");
    else if (arg === "--no-auth") auth = false;
    else positional.push(arg);
  }
  return { sets, positional, label, auth };
}

export function loadRun() {
  const id = process.env.WHALE_VERIFY_RUN;
  if (!id) fail("set WHALE_VERIFY_RUN to the id that launch printed");
  const dir = runDir(id);
  if (!existsSync(path.join(dir, "run.json"))) fail(`no run ${id} at ${dir}. launch one, or check WHALE_VERIFY_RUN`);
  return { ...readJson(path.join(dir, "run.json")), dir, evidence: evidenceDir(id), token: readFileSync(path.join(dir, "executor.token"), "utf8").trim(), env: readJson(path.join(dir, "env.json")) };
}

export function record(run, label, body) {
  mkdirSync(run.evidence, { recursive: true });
  const n = readdirSync(run.evidence).filter((name) => /^\d{2,}-/.test(name)).length + 1;
  const file = path.join(run.evidence, `${String(n).padStart(2, "0")}-${label}.json`);
  const text = JSON.stringify({ runId: run.id, at: new Date().toISOString(), ...body }, null, 2).replaceAll(run.token, "<executor-token>");
  writeFileSync(file, `${text}\n`);
  return file;
}

export const netFile = (run) => path.join(run.dir, `net-${process.pid}-${Date.now()}.jsonl`);

export function readNet(file) {
  if (!existsSync(file)) return [];
  const entries = readFileSync(file, "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line));
  rmSync(file, { force: true });
  return entries;
}

export const isSend = (entry) =>
  (entry.rpc ?? []).some((method) => SEND_RPC.test(method)) ||
  (/hyperliquid/.test(entry.origin) && entry.path === "/exchange") ||
  /block-engine/.test(entry.origin) ||
  (entry.method === "POST" && /\/tx$/.test(entry.path));

export function commandOf(pid) {
  const result = spawnSync("ps", ["-o", "command=", "-p", String(pid)], { encoding: "utf8" });
  return result.status === 0 ? result.stdout.trim() : null;
}

export function killGroup(pid, signal) {
  try { process.kill(-pid, signal); return true; } catch (error) { if (error.code === "ESRCH") return false; throw error; }
}

function track(run, child, script) {
  const dir = path.join(run.dir, "children");
  mkdirSync(dir, { recursive: true });
  const file = path.join(dir, String(child.pid));
  writeFileSync(file, script);
  child.once("exit", () => rmSync(file, { force: true }));
}

// Spawned in its own process group so cleanup can stop it and anything it started.
export function spawnNode(run, script, args, env) {
  const child = spawn(process.execPath, ["--import", netlog, script, ...args], { cwd: repo, env, detached: true, stdio: ["pipe", "pipe", "pipe"] });
  if (run) track(run, child, script);
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk) => { stdout += chunk; });
  child.stderr.on("data", (chunk) => { stderr += chunk; });
  const exited = new Promise((resolve) => child.once("close", (code, signal) => resolve(code ?? signal)));
  return { child, exited, out: () => stdout, err: () => stderr };
}

export async function finish(proc, graceMs) {
  const code = await Promise.race([proc.exited, sleep(graceMs, undefined, { ref: false }).then(() => undefined)]);
  if (code !== undefined) return code;
  killGroup(proc.child.pid, "SIGTERM");
  return (await proc.exited) ?? "SIGTERM";
}

export async function mcpSession(run, entry, env, last, timeoutMs) {
  const started = Date.now();
  const proc = spawnNode(run, entry, [], env);
  const send = (message) => proc.child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", ...message })}\n`);
  const replies = [];
  const protocolErrors = [];
  let buffered = "";
  const done = new Promise((resolve) => {
    proc.child.stdout.on("data", (chunk) => {
      buffered += chunk;
      const lines = buffered.split("\n");
      buffered = lines.pop();
      for (const line of lines.filter((item) => item.trim())) {
        let message;
        try { message = JSON.parse(line); } catch { protocolErrors.push(`non-JSON stdout line: ${line.slice(0, 200)}`); continue; }
        replies.push(message);
        if (message.id === 1) { send({ method: "notifications/initialized" }); send({ id: 2, ...last }); }
        if (message.id === 2) resolve(message);
      }
    });
    proc.exited.then(() => resolve(null));
    setTimeout(() => resolve(null), timeoutMs).unref();
  });
  send({ id: 1, method: "initialize", params: { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "whale-verify", version: "1" } } });
  const reply = await done;
  proc.child.stdin.end();
  const exit = await finish(proc, 10_000);
  return { reply, replies, protocolErrors, stderr: proc.err(), exit, ms: Date.now() - started };
}

export async function getJson(url, token) {
  const response = await fetch(url, { headers: token ? { authorization: `Bearer ${token}` } : {}, signal: AbortSignal.timeout(3000) });
  const text = await response.text();
  try { return { status: response.status, body: JSON.parse(text) }; } catch { return { status: response.status, body: text }; }
}
