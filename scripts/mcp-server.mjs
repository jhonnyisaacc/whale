import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const server = path.join(root, "dist/src/mcp-server.js");
const stamp = path.join(root, "dist/.source-hash");
const inputs = ["package.json", "pnpm-lock.yaml", "pnpm-workspace.yaml", "tsconfig.json"];

function sourceFiles(dir) {
  return readdirSync(path.join(root, dir), { withFileTypes: true })
    .flatMap((entry) => (entry.isDirectory() ? sourceFiles(path.join(dir, entry.name)) : [path.join(dir, entry.name)]))
    .sort();
}

function sourceHash() {
  const hash = createHash("sha256");
  for (const file of [...inputs, ...sourceFiles("src")]) hash.update(`${file}\0`).update(readFileSync(path.join(root, file))).update("\0");
  return hash.digest("hex");
}

function readStamp() {
  try {
    return readFileSync(stamp, "utf8");
  } catch {
    return undefined;
  }
}

function pnpm(args) {
  for (const command of [["pnpm"], ["corepack", "pnpm"]]) {
    const result = spawnSync(command[0], [...command.slice(1), ...args], { cwd: root, stdio: ["ignore", 2, 2], env: { ...process.env, COREPACK_ENABLE_DOWNLOAD_PROMPT: "0" } });
    if (result.error?.code === "ENOENT") continue;
    if (result.status === 0) return;
    throw new Error(`pnpm ${args.join(" ")} exited with ${result.status ?? result.signal}`);
  }
  throw new Error("neither pnpm nor corepack is on PATH");
}

if (!existsSync(path.join(root, "pnpm-lock.yaml"))) {
  process.stderr.write(`whale: ${root} has no pnpm-lock.yaml, so its dependencies cannot be installed pinned. npm drops the lockfile when it installs a package. Install Whale with git clone or a host plugin install instead\n`);
  process.exit(1);
}
const hash = sourceHash();
if (readStamp() !== hash) {
  process.stderr.write(`whale: building the MCP server in ${root}\n`);
  try {
    pnpm(["install", "--frozen-lockfile"]);
    pnpm(["run", "build"]);
  } catch (error) {
    process.stderr.write(`whale: ${error.message}. Run pnpm install --frozen-lockfile && pnpm run build in ${root}\n`);
    process.exit(1);
  }
  mkdirSync(path.dirname(stamp), { recursive: true });
  writeFileSync(stamp, hash);
}
const { main } = await import(pathToFileURL(server).href);
await main();
