import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, openSync, readdirSync, readFileSync, renameSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const dist = path.join(root, "dist");
const server = path.join(dist, "src/mcp-server.js");
const stampFile = path.join(dist, ".mcp-stamp.json");
const lockDir = path.join(dist, ".mcp-build-lock");
const logFile = path.join(dist, ".mcp-build.log");
const lockfile = path.join(root, "pnpm-lock.yaml");
const installedLockfile = path.join(root, "node_modules/.pnpm/lock.yaml");
const heartbeatMs = 1000;
const staleMs = 15000;
const waitMs = 600000;
const inputs = ["package.json", "pnpm-lock.yaml", "pnpm-workspace.yaml", "tsconfig.json", "src"];

function walk(entry) {
  const full = path.join(root, entry);
  try {
    return readdirSync(full, { withFileTypes: true })
      .sort((a, b) => (a.name < b.name ? -1 : 1))
      .flatMap((child) => walk(path.join(entry, child.name)));
  } catch (error) {
    if (error.code === "ENOTDIR") return [entry];
    if (error.code === "ENOENT") return [];
    throw error;
  }
}

function treeHash(entries) {
  const hash = createHash("sha256");
  for (const file of entries.flatMap(walk)) hash.update(`${file}\0`).update(readFileSync(path.join(root, file))).update("\0");
  return hash.digest("hex");
}

const inputHash = () => treeHash(inputs);
const outputHash = () => treeHash([path.relative(root, path.join(dist, "src"))]);

function readStamp() {
  try {
    return JSON.parse(readFileSync(stampFile, "utf8"));
  } catch {
    return {};
  }
}

function depsReady() {
  try {
    return readFileSync(installedLockfile).equals(readFileSync(lockfile));
  } catch {
    return false;
  }
}

function buildReady() {
  const stamp = readStamp();
  return existsSync(server) && stamp.inputs === inputHash() && stamp.output === outputHash();
}

async function pnpm(args, log, signal) {
  for (const command of [["pnpm"], ["corepack", "pnpm"]]) {
    const child = spawn(command[0], [...command.slice(1), ...args], { cwd: root, stdio: ["ignore", log, log], env: { ...process.env, COREPACK_ENABLE_DOWNLOAD_PROMPT: "0" }, signal });
    const outcome = await new Promise((resolve) => {
      child.once("error", (error) => resolve({ error }));
      child.once("exit", (code, exitSignal) => resolve({ code, exitSignal }));
    });
    if (outcome.error?.code === "ENOENT") continue;
    if (signal.aborted) throw signal.reason;
    if (outcome.error) throw outcome.error;
    if (outcome.code === 0) return;
    throw new Error(`pnpm ${args.join(" ")} exited with ${outcome.code ?? outcome.exitSignal}`);
  }
  throw new Error("neither pnpm nor corepack is on PATH");
}

const generationFile = (generation) => path.join(lockDir, String(generation));

function topGeneration() {
  return Math.max(-1, ...readdirSync(lockDir).filter((name) => /^\d+$/.test(name)).map(Number));
}

function lastBeat(generation) {
  if (generation < 0) return 0;
  try {
    return statSync(generationFile(generation)).mtimeMs;
  } catch (error) {
    if (error.code === "ENOENT") return undefined;
    throw error;
  }
}

function claim(generation) {
  try {
    writeFileSync(generationFile(generation), String(process.pid), { flag: "wx" });
    return true;
  } catch (error) {
    if (error.code === "EEXIST") return false;
    throw error;
  }
}

async function takeLock() {
  mkdirSync(lockDir, { recursive: true });
  const deadline = Date.now() + waitMs;
  for (;;) {
    const top = topGeneration();
    const beat = lastBeat(top);
    if (beat === undefined) continue;
    if (Date.now() - beat > staleMs) {
      if (!claim(top + 1)) continue;
      if (topGeneration() === top + 1) {
        for (const name of readdirSync(lockDir)) if (Number(name) <= top) rmSync(path.join(lockDir, name), { force: true });
        return top + 1;
      }
      rmSync(generationFile(top + 1), { force: true });
      continue;
    }
    if (Date.now() > deadline) {
      const holder = readFileSync(generationFile(top), "utf8");
      throw new Error(`whale: gave up after ${waitMs / 1000} s waiting for the build lock ${generationFile(top)}, which pid ${holder} still renews. Stop that process, or delete ${lockDir} if no build is running`);
    }
    await sleep(250);
  }
}

function hold(generation, lost) {
  const file = generationFile(generation);
  const renew = setInterval(() => {
    try {
      if (topGeneration() !== generation) throw new Error(`whale: another builder took over the build lock ${file} after it went ${staleMs / 1000} s without a heartbeat`);
      const now = Date.now() / 1000;
      utimesSync(file, now, now);
    } catch (error) {
      clearInterval(renew);
      lost.abort(error);
    }
  }, heartbeatMs);
  return () => {
    clearInterval(renew);
    try {
      utimesSync(file, 0, 0);
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
  };
}

async function build() {
  const generation = await takeLock();
  const lost = new AbortController();
  const release = hold(generation, lost);
  try {
    if (depsReady() && buildReady()) return;
    const log = openSync(logFile, "w");
    if (!depsReady()) await pnpm(["install", "--frozen-lockfile"], log, lost.signal);
    if (!buildReady()) {
      const before = inputHash();
      await pnpm(["exec", "tsc", "-p", "tsconfig.json", "--noEmitOnError"], log, lost.signal);
      lost.signal.throwIfAborted();
      writeFileSync(`${stampFile}.tmp`, JSON.stringify({ inputs: before, output: outputHash() }));
      renameSync(`${stampFile}.tmp`, stampFile);
    }
  } finally {
    release();
  }
}

function runBuilder() {
  const child = spawn(process.execPath, [fileURLToPath(import.meta.url), "--build"], { cwd: root, detached: true, stdio: "ignore" });
  return new Promise((resolve) => child.on("exit", (code) => resolve(code === 0)));
}

if (process.argv[2] === "--build") {
  try {
    await build();
  } catch (error) {
    writeFileSync(logFile, `${error.message}\n`, { flag: "a" });
    process.exit(1);
  }
  process.exit(0);
}

if (!existsSync(lockfile)) {
  process.stderr.write(`whale: ${root} has no pnpm-lock.yaml, so its dependencies cannot be installed pinned. npm drops the lockfile when it installs a package. Install Whale with git clone or a host plugin install instead\n`);
  process.exit(1);
}
if (!depsReady() || !buildReady()) {
  process.stderr.write(`whale: building the MCP server in ${root}. The build finishes even if this process stops. Log: ${logFile}\n`);
  const built = await runBuilder();
  const log = existsSync(logFile) ? readFileSync(logFile, "utf8") : "";
  process.stderr.write(log);
  if (!built) {
    process.stderr.write(`whale: the build failed. Fix the errors above, or run pnpm install --frozen-lockfile && pnpm run build in ${root}\n`);
    process.exit(1);
  }
}
const { main } = await import(pathToFileURL(server).href);
await main();
