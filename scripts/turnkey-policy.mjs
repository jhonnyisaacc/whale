import { readFileSync, writeFileSync } from "node:fs";
import { parseDeploymentManifest, manifestPolicyDocument, verifyTurnkeyPolicies } from "../dist/src/deployment-manifest.js";

const args = process.argv.slice(2);
const manifestPath = args[args.indexOf("--manifest") + 1];
if (!manifestPath) { console.error("usage: turnkey-policy.mjs --manifest <file> [--out <file>] [--check]"); process.exit(2); }
const manifest = parseDeploymentManifest(JSON.parse(readFileSync(manifestPath, "utf8")));
const document = manifestPolicyDocument(manifest);
const out = args.includes("--out") ? args[args.indexOf("--out") + 1] : null;
if (args.includes("--check")) {
  if (!out) { console.error("--check needs --out <checked-in-file>"); process.exit(2); }
  const existing = JSON.parse(readFileSync(out, "utf8"));
  const result = verifyTurnkeyPolicies(document, existing);
  if (!result.ok) { console.error(JSON.stringify(result)); process.exit(1); }
  console.log("turnkey policy ok: the checked file matches the manifest");
} else if (out) {
  writeFileSync(out, `${JSON.stringify(document, null, 2)}\n`);
  console.log(`wrote ${out} from the manifest. Import it in the Turnkey console, then verify the deployed policies before live mode.`);
} else {
  console.log(JSON.stringify(document, null, 2));
}
