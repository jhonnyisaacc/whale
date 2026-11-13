import { createHash, generateKeyPairSync, randomBytes, sign, type KeyObject } from "node:crypto";

type Cbor = number | Buffer | string | Cbor[] | Map<number | string, Cbor> | boolean | null;

function head(major: number, value: number): Buffer {
  if (value < 24) return Buffer.from([(major << 5) | value]);
  if (value < 256) return Buffer.from([(major << 5) | 24, value]);
  if (value < 65_536) return Buffer.concat([Buffer.from([(major << 5) | 25]), Buffer.from([value >> 8, value & 0xff])]);
  const out = Buffer.alloc(5);
  out[0] = (major << 5) | 26;
  out.writeUInt32BE(value, 1);
  return out;
}

export function encodeCbor(value: Cbor): Buffer {
  if (value === false) return Buffer.from([0xf4]);
  if (value === true) return Buffer.from([0xf5]);
  if (value === null) return Buffer.from([0xf6]);
  if (typeof value === "number") return value >= 0 ? head(0, value) : head(1, -1 - value);
  if (Buffer.isBuffer(value)) return Buffer.concat([head(2, value.byteLength), value]);
  if (typeof value === "string") {
    const bytes = Buffer.from(value, "utf8");
    return Buffer.concat([head(3, bytes.byteLength), bytes]);
  }
  if (Array.isArray(value)) return Buffer.concat([head(4, value.length), ...value.map(encodeCbor)]);
  return Buffer.concat([head(5, value.size), ...[...value.entries()].flatMap(([key, item]) => [encodeCbor(key), encodeCbor(item)])]);
}

export type SoftAuthenticator = {
  credentialId: Buffer;
  privateKey: KeyObject;
  counter: number;
  register(challenge: string, options?: { origin?: string; rpId?: string; flags?: number; type?: string }): { id: string; type: "public-key"; response: { clientDataJSON: string; attestationObject: string } };
  assert(challenge: string, options?: { origin?: string; rpId?: string; flags?: number; counter?: number; key?: KeyObject }): { id: string; type: "public-key"; response: { clientDataJSON: string; authenticatorData: string; signature: string } };
};

export function softAuthenticator(rp: { rpId: string; origin: string }, signCounting = true): SoftAuthenticator {
  const { publicKey, privateKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
  const jwk = publicKey.export({ format: "jwk" });
  const cose = encodeCbor(new Map<number, Cbor>([[1, 2], [3, -7], [-1, 1], [-2, Buffer.from(jwk.x as string, "base64url")], [-3, Buffer.from(jwk.y as string, "base64url")]]));
  const credentialId = randomBytes(32);
  const clientData = (type: string, challenge: string, origin: string) => Buffer.from(JSON.stringify({ type, challenge, origin, crossOrigin: false }));
  const rpHash = (rpId: string) => createHash("sha256").update(rpId).digest();
  const counterBytes = (value: number) => {
    const out = Buffer.alloc(4);
    out.writeUInt32BE(value);
    return out;
  };
  const self: SoftAuthenticator = {
    credentialId,
    privateKey,
    counter: 0,
    register(challenge, options = {}) {
      const authData = Buffer.concat([rpHash(options.rpId ?? rp.rpId), Buffer.from([options.flags ?? 0x45]), counterBytes(0), Buffer.alloc(16), Buffer.from([0, credentialId.byteLength]), credentialId, cose]);
      const attestationObject = encodeCbor(new Map<string, Cbor>([["fmt", "none"], ["attStmt", new Map()], ["authData", authData]]));
      return {
        id: credentialId.toString("base64url"),
        type: "public-key",
        response: { clientDataJSON: clientData(options.type ?? "webauthn.create", challenge, options.origin ?? rp.origin).toString("base64url"), attestationObject: attestationObject.toString("base64url") },
      };
    },
    assert(challenge, options = {}) {
      if (signCounting && options.counter === undefined) self.counter += 1;
      const counter = options.counter ?? (signCounting ? self.counter : 0);
      const authData = Buffer.concat([rpHash(options.rpId ?? rp.rpId), Buffer.from([options.flags ?? 0x05]), counterBytes(counter)]);
      const data = clientData("webauthn.get", challenge, options.origin ?? rp.origin);
      const signature = sign("sha256", Buffer.concat([authData, createHash("sha256").update(data).digest()]), options.key ?? privateKey);
      return {
        id: credentialId.toString("base64url"),
        type: "public-key",
        response: { clientDataJSON: data.toString("base64url"), authenticatorData: authData.toString("base64url"), signature: signature.toString("base64url") },
      };
    },
  };
  return self;
}
