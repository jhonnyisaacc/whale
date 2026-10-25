import { createRequire } from "node:module";
import { readFileSync, writeFileSync } from "node:fs";

const require = createRequire(import.meta.url);
require.resolve("stream-json/streamers/stream-values.js");
require.resolve("stream-json/utils/verifier.js");

const next = `const streamValuesModule = require('stream-json/streamers/stream-values.js');
const streamValues = streamValuesModule.default || streamValuesModule;
const StreamValues = { withParser: (options) => streamValues.withParserAsStream(options) };
const verifierModule = require('stream-json/utils/verifier.js');
const verifierFactory = verifierModule.default || verifierModule;
function Verifier(options) { return verifierFactory.asStream(options); }`;

const utilsPath = require.resolve("jayson/lib/utils.js");
let source = readFileSync(utilsPath, "utf8");
if (source.includes("withParserAsStream")) process.exit(0);
const previous = [
  `const StreamValues = require('stream-json/streamers/StreamValues');
const Verifier = require('stream-json/utils/Verifier');`,
  `const streamValuesModule = require('stream-json/streamers/stream-values.js');
const StreamValues = streamValuesModule.default || streamValuesModule;
const verifierModule = require('stream-json/utils/verifier.js');
const verifierFactory = verifierModule.default || verifierModule;
function Verifier(options) { return verifierFactory(options); }`,
];
let patched = false;
for (const block of previous) {
  if (!source.includes(block)) continue;
  writeFileSync(utilsPath, source.replace(block, next));
  patched = true;
  break;
}
if (!patched) {
  console.error("jayson utils.js did not contain the stream-json require");
  process.exit(1);
}
