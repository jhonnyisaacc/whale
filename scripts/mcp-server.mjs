import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, linkSync, mkdirSync, openSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const dist = path.join(root, "dist");
const server = path.join(dist, "src/mcp-server.js");
const stampFile = path.join(dist, ".mcp-stamp.json");
const lockFile = path.join(dist, ".mcp-build.lock");
const logFile = path.join(dist, ".mcp-build.log");
const lockfile = path.join(root, "pnpm-lock.yaml");
const installedLockfile = path.join(root, "node_modules/.pnpm/lock.yaml");
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

function pnpm(args, log) {
  for (const command of [["pnpm"], ["corepack", "pnpm"]]) {
    const result = spawnSync(command[0], [...command.slice(1), ...args], { cwd: root, stdio: ["ignore", log, log], env: { ...process.env, COREPACK_ENABLE_DOWNLOAD_PROMPT: "0" } });
    if (result.error?.code === "ENOENT") continue;
    if (result.status === 0) return;
    throw new Error(`pnpm ${args.join(" ")} exited with ${result.status ?? result.signal}`);
  }
  throw new Error("neither pnpm nor corepack is on PATH");
}

function alive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code === "EPERM";
  }
}

function lockHolder() {
  try {
    return Number(readFileSync(lockFile, "utf8"));
  } catch (error) {
    if (error.code === "ENOENT") return undefined;
    throw error;
  }
}

function takeLock() {
  const mine = `${lockFile}.${process.pid}`;
  writeFileSync(mine, String(process.pid));
  try {
    for (;;) {
      try {
        linkSync(mine, lockFile);
        return;
      } catch (error) {
        if (error.code !== "EEXIST") throw error;
      }
      const holder = lockHolder();
      if (holder === undefined) continue;
      if (alive(holder)) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 250);
      else rmSync(lockFile, { force: true });
    }
  } finally {
    rmSync(mine, { force: true });
  }
}

function build() {
  mkdirSync(dist, { recursive: true });
  takeLock();
  try {
    if (depsReady() && buildReady()) return;
    const log = openSync(logFile, "w");
    if (!depsReady()) pnpm(["install", "--frozen-lockfile"], log);
    if (!buildReady()) {
      const before = inputHash();
      pnpm(["exec", "tsc", "-p", "tsconfig.json", "--noEmitOnError"], log);
      writeFileSync(`${stampFile}.tmp`, JSON.stringify({ inputs: before, output: outputHash() }));
      renameSync(`${stampFile}.tmp`, stampFile);
    }
  } finally {
    rmSync(lockFile, { force: true });
  }
}

function runBuilder() {
  const child = spawn(process.execPath, [fileURLToPath(import.meta.url), "--build"], { cwd: root, detached: true, stdio: "ignore" });
  return new Promise((resolve) => child.on("exit", (code) => resolve(code === 0)));
}

if (process.argv[2] === "--build") {
  try {
    build();
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
