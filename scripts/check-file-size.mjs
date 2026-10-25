import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";

const LIMIT_TOKENS = 5000;
const root = path.join(process.cwd(), "src");

function files(dir) {
  const out = [];
  for (const name of readdirSync(dir)) {
    const full = path.join(dir, name);
    if (statSync(full).isDirectory()) out.push(...files(full));
    else if (name.endsWith(".ts")) out.push(full);
  }
  return out;
}

const over = [];
for (const file of files(root)) {
  const tokens = Math.ceil(readFileSync(file).byteLength / 4);
  if (tokens > LIMIT_TOKENS) over.push(`${path.relative(process.cwd(), file)}: ${tokens} tokens over ${LIMIT_TOKENS}. Split it by feature and keep the old path as a barrel that re-exports the new modules.`);
}
if (over.length > 0) {
  console.error(over.join("\n"));
  process.exit(1);
}
console.log(`file-size ok: every src file is at most ${LIMIT_TOKENS} tokens`);
