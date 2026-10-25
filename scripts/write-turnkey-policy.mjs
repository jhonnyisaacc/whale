import { writeFileSync } from "node:fs";
import { turnkeyPolicyTemplate } from "../dist/src/signing-policy.js";

writeFileSync(new URL("../policies/turnkey.json", import.meta.url), `${JSON.stringify(turnkeyPolicyTemplate(), null, 2)}\n`);
