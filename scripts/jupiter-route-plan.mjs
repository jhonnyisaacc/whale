import { writeFileSync } from "node:fs";
import { inflateSync } from "node:zlib";
import { PublicKey } from "@solana/web3.js";

const PROGRAM = new PublicKey("JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4");
const OUT = "src/signing-policy/jupiter-route-plan-types.ts";
const rpc = process.argv[2] ?? "https://api.mainnet-beta.solana.com";

const [base] = PublicKey.findProgramAddressSync([], PROGRAM);
const address = await PublicKey.createWithSeed(base, "anchor:idl", PROGRAM);
const response = await fetch(rpc, {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "getAccountInfo", params: [address.toBase58(), { encoding: "base64" }] }),
});
const account = Buffer.from((await response.json()).result.value.data[0], "base64");
const idl = JSON.parse(inflateSync(account.subarray(44, 44 + account.readUInt32LE(40))).toString());
const defined = new Map(idl.types.map((entry) => [entry.name, entry.type]));
const primitives = new Set(["bool", "u8", "u16", "u32", "u64", "u128", "i8", "i16", "i32", "i64", "i128", "pubkey", "bytes"]);
const table = {};

function compact(type) {
  if (typeof type === "string") {
    if (!primitives.has(type)) throw new Error(`unsupported primitive ${type}`);
    return type;
  }
  if (type.vec) return ["vec", compact(type.vec)];
  if (type.option) return ["option", compact(type.option)];
  if (type.array) return ["array", compact(type.array[0]), type.array[1]];
  if (type.defined) {
    visit(type.defined.name);
    return { defined: type.defined.name };
  }
  throw new Error(`unsupported type ${JSON.stringify(type)}`);
}

function fields(list = []) {
  return list.map((field) => compact(typeof field === "object" && "type" in field ? field.type : field));
}

function visit(name) {
  if (name in table) return;
  const type = defined.get(name);
  if (!type) throw new Error(`missing type ${name}`);
  table[name] = null;
  table[name] = type.kind === "enum" ? { variants: type.variants.map((variant) => fields(variant.fields)) } : { fields: fields(type.fields) };
}

for (const name of ["route", "shared_accounts_route"]) {
  const instruction = idl.instructions.find((entry) => entry.name === name);
  const args = instruction.args.map((arg) => JSON.stringify(arg.type)).join(",");
  const expected = name === "route" ? '{"vec":{"defined":{"name":"RoutePlanStep"}}},"u64","u64","u16","u8"' : '"u8",{"vec":{"defined":{"name":"RoutePlanStep"}}},"u64","u64","u16","u8"';
  if (args !== expected) throw new Error(`${name} arguments changed: ${args}`);
}
visit("RoutePlanStep");
writeFileSync(
  OUT,
  `import type { BorshTypes } from "./jupiter-route-plan.js";\n\nexport const ROUTE_PLAN_TYPES: BorshTypes = ${JSON.stringify(table)};\n`,
);
console.log(`wrote ${OUT} from the on-chain IDL at ${address.toBase58()}: ${table.Swap.variants.length} Swap variants`);
