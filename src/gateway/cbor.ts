// A strict CBOR reader for the WebAuthn structures Whale reads: attestation objects and COSE keys. Definite lengths
// only, no tags, no floats, bounded depth. Anything else throws, so an odd authenticator fails closed.
export type CborValue = number | Buffer | string | boolean | null | CborValue[] | Map<CborValue, CborValue>;

const MAX_DEPTH = 6;
const MAX_ITEMS = 64;

export function decodeCbor(input: Buffer, offset = 0): { value: CborValue; end: number } {
  let position = offset;

  function take(length: number): Buffer {
    if (length < 0 || position + length > input.byteLength) throw new Error("cbor: truncated");
    const slice = input.subarray(position, position + length);
    position += length;
    return slice;
  }

  function argument(info: number): number {
    if (info < 24) return info;
    if (info === 24) return take(1).readUInt8(0);
    if (info === 25) return take(2).readUInt16BE(0);
    if (info === 26) return take(4).readUInt32BE(0);
    if (info === 27) {
      const big = take(8).readBigUInt64BE(0);
      if (big > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error("cbor: integer too large");
      return Number(big);
    }
    throw new Error("cbor: indefinite or reserved length");
  }

  function item(depth: number): CborValue {
    if (depth > MAX_DEPTH) throw new Error("cbor: too deep");
    const head = take(1).readUInt8(0);
    const major = head >> 5;
    const info = head & 0x1f;
    if (major === 7) {
      if (info === 20) return false;
      if (info === 21) return true;
      if (info === 22) return null;
      throw new Error("cbor: unsupported simple value");
    }
    const value = argument(info);
    if (major === 0) return value;
    if (major === 1) return -1 - value;
    if (major === 2) return Buffer.from(take(value));
    if (major === 3) return take(value).toString("utf8");
    if (value > MAX_ITEMS) throw new Error("cbor: too many items");
    if (major === 4) return Array.from({ length: value }, () => item(depth + 1));
    if (major === 5) {
      const map = new Map<CborValue, CborValue>();
      for (let index = 0; index < value; index += 1) {
        const key = item(depth + 1);
        if (typeof key !== "number" && typeof key !== "string") throw new Error("cbor: map keys must be integers or text");
        if (map.has(key)) throw new Error("cbor: duplicate map key");
        map.set(key, item(depth + 1));
      }
      return map;
    }
    throw new Error("cbor: tags are not supported");
  }

  const value = item(0);
  return { value, end: position };
}
