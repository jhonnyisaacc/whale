import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";

const root = path.join(process.cwd(), "src");
const rules = [
  { from: /^(domain|chains|limits|quote-hop)\.ts$/, ban: /from "\.\/(executor|broadcast|aggregators|config|.*-server)/, why: "domain and chain tables import no service or engine module" },
  { from: /^(config|aggregators|broadcast|executor)\//, ban: /-server\.js"/, why: "engines import no HTTP server module" },
  { from: /^config\//, ban: /from "\.\.\/(broadcast|executor|managed-signer)/, why: "config imports no signing or sending module" },
];

function files(dir, base = "") {
  const out = [];
  for (const name of readdirSync(dir)) {
    const full = path.join(dir, name);
    const rel = base ? `${base}/${name}` : name;
    if (statSync(full).isDirectory()) out.push(...files(full, rel));
    else if (name.endsWith(".ts")) out.push({ full, rel });
  }
  return out;
}

const hits = [];
for (const { full, rel } of files(root)) {
  const text = readFileSync(full, "utf8");
  for (const rule of rules) {
    if (rule.from.test(rel) && rule.ban.test(text)) hits.push(`${rel}: ${rule.why}`);
  }
}
if (hits.length > 0) {
  console.error(hits.join("\n"));
  process.exit(1);
}
console.log("boundaries ok: domain, config, and engine layers keep their import rules");
