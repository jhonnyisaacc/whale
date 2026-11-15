import { ROUTE_PLAN_TYPES } from "./jupiter-route-plan-types.js";

type Primitive = "bool" | "u8" | "u16" | "u32" | "u64" | "u128" | "i8" | "i16" | "i32" | "i64" | "i128" | "pubkey" | "bytes";
export type BorshType = Primitive | readonly ["vec", BorshType] | readonly ["option", BorshType] | readonly ["array", BorshType, number] | { readonly defined: string };
export type BorshTypes = Readonly<Record<string, { readonly variants: readonly (readonly BorshType[])[] } | { readonly fields: readonly BorshType[] }>>;

const SIZES: Readonly<Record<string, number>> = { u8: 1, i8: 1, u16: 2, i16: 2, u32: 4, i32: 4, u64: 8, i64: 8, u128: 16, i128: 16, pubkey: 32 };

class Reader {
  offset: number;
  constructor(
    readonly data: Buffer,
    start: number,
  ) {
    this.offset = start;
  }
  take(length: number): number {
    if (length > this.data.length - this.offset) throw new Error("jupiter route arguments are truncated");
    const at = this.offset;
    this.offset += length;
    return at;
  }
  byte(): number {
    return this.data[this.take(1)] as number;
  }
  length(): number {
    return this.data.readUInt32LE(this.take(4));
  }
}

function skip(reader: Reader, type: BorshType): void {
  if (typeof type === "string") {
    if (type === "bool") {
      if (reader.byte() > 1) throw new Error("jupiter route plan has an invalid bool");
    } else if (type === "bytes") reader.take(reader.length());
    else reader.take(SIZES[type] as number);
    return;
  }
  if ("defined" in type) {
    const definition = ROUTE_PLAN_TYPES[type.defined];
    if (!definition) throw new Error("jupiter route plan uses an unknown type");
    if ("fields" in definition) {
      for (const field of definition.fields) skip(reader, field);
      return;
    }
    const variant = definition.variants[reader.byte()];
    if (!variant) throw new Error("jupiter route plan uses an unknown swap variant");
    for (const field of variant) skip(reader, field);
    return;
  }
  if (type[0] === "option") {
    const tag = reader.byte();
    if (tag > 1) throw new Error("jupiter route plan has an invalid option");
    if (tag === 1) skip(reader, type[1]);
    return;
  }
  const count = type[0] === "vec" ? reader.length() : type[2];
  if (count > reader.data.length - reader.offset) throw new Error("jupiter route arguments are truncated");
  for (let index = 0; index < count; index++) skip(reader, type[1]);
}

export type RouteArguments = { inAmount: bigint; quotedOut: bigint; slippageBps: number; platformFeeBps: number };

export function routeArguments(data: Buffer, start: number): RouteArguments {
  const reader = new Reader(data, start);
  skip(reader, ["vec", { defined: "RoutePlanStep" }]);
  const at = reader.take(19);
  if (reader.offset !== data.length) throw new Error("jupiter route arguments have trailing bytes");
  return { inAmount: data.readBigUInt64LE(at), quotedOut: data.readBigUInt64LE(at + 8), slippageBps: data.readUInt16LE(at + 16), platformFeeBps: data[at + 18] as number };
}
