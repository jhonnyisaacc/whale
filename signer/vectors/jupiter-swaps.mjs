import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { inflateSync } from "node:zlib";
import { PublicKey } from "@solana/web3.js";

const PROGRAM = new PublicKey("JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4");
const RPC = process.env.SOLANA_RPC ?? "https://api.mainnet-beta.solana.com";
const target = new URL("../src/jupiter_swaps.rs", import.meta.url).pathname;

async function onChainIdl() {
  const [base] = PublicKey.findProgramAddressSync([], PROGRAM);
  const account = await PublicKey.createWithSeed(base, "anchor:idl", PROGRAM);
  const response = await fetch(RPC, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "getAccountInfo", params: [account.toBase58(), { encoding: "base64" }] }),
  });
  const { result } = await response.json();
  const data = Buffer.from(result.value.data[0], "base64");
  const length = data.readUInt32LE(40);
  return { bytes: inflateSync(data.subarray(44, 44 + length)), source: `account ${account.toBase58()} at slot ${result.context.slot}` };
}

const { bytes, source } = process.argv[2] ? { bytes: readFileSync(process.argv[2]), source: process.argv[2] } : await onChainIdl();
const idl = JSON.parse(bytes.toString("utf8"));
const types = new Map(idl.types.map((entry) => [entry.name, entry.type]));
const SIZES = { bool: 1, u8: 1, i8: 1, u16: 2, i16: 2, u32: 4, i32: 4, u64: 8, i64: 8, u128: 16, i128: 16, pubkey: 32, publicKey: 32 };

const fixedSize = (parts) => (parts && parts.every((part) => "fixed" in part) ? parts.reduce((sum, part) => sum + part.fixed, 0) : null);
const merge = (parts) => {
  const out = [];
  for (const part of parts) {
    if ("fixed" in part && out.length > 0 && "fixed" in out[out.length - 1]) out[out.length - 1] = { fixed: out[out.length - 1].fixed + part.fixed };
    else out.push(part);
  }
  return out.filter((part) => !("fixed" in part) || part.fixed > 0);
};
const fields = (list) => {
  const out = [];
  for (const field of list ?? []) {
    const inner = layout(field.type);
    if (!inner) return null;
    out.push(...inner);
  }
  return merge(out);
};
function layout(type) {
  if (typeof type === "string") {
    if (type in SIZES) return [{ fixed: SIZES[type] }];
    if (type === "bytes" || type === "string") return [{ list: [{ fixed: 1 }] }];
    return null;
  }
  if (type.array) {
    const size = fixedSize(layout(type.array[0]));
    return size === null ? null : [{ fixed: size * type.array[1] }];
  }
  if (type.option) {
    const inner = layout(type.option);
    return inner ? [{ option: inner }] : null;
  }
  if (type.vec) {
    const inner = layout(type.vec);
    return inner && inner.length > 0 ? [{ list: inner }] : null;
  }
  if (type.defined) {
    const definition = types.get(type.defined.name ?? type.defined);
    if (definition?.kind === "struct") return fields(definition.fields);
    if (definition?.kind === "enum" && definition.variants.every((variant) => !variant.fields)) return [{ fixed: 1 }];
    return null;
  }
  return null;
}

const rust = (parts) => `&[${parts.map((part) => ("fixed" in part ? `Fixed(${part.fixed})` : "option" in part ? `Optional(${rust(part.option)})` : `List(${rust(part.list)})`)).join(", ")}]`;
const variants = types.get("Swap").variants;
const rows = variants.map((variant) => {
  const parts = fields(variant.fields);
  return `    ("${variant.name}", ${parts ? `Some(${rust(parts)})` : "None"}),`;
});
const sha = createHash("sha256").update(bytes).digest("hex");
writeFileSync(target, `use crate::jupiter::Part::{self, Fixed, List, Optional};\n\npub const SWAPS: [(&str, Option<&[Part]>); ${rows.length}] = [\n${rows.join("\n")}\n];\n`);
execFileSync("rustfmt", ["--edition", "2024", target]);
console.log(`wrote ${rows.length} Swap variants, ${rows.filter((row) => row.endsWith("None),")).length} unsized, from ${source}, sha256 ${sha}`);
