import { createCipheriv, createDecipheriv, hkdfSync, randomBytes } from "node:crypto";

export type Sealer = {
  seal(value: unknown, ttlMs: number, now?: number): string;
  open(token: string, now?: number): unknown;
};

// One secret serves several purposes. HKDF gives each purpose its own key, and the purpose is also the AAD,
// so a value sealed for one purpose never opens as another.
export function sealer(secret: Buffer, purpose: string): Sealer {
  const key = Buffer.from(hkdfSync("sha256", secret, Buffer.alloc(0), `whale:${purpose}`, 32));
  const aad = Buffer.from(purpose);
  return {
    seal(value, ttlMs, now = Date.now()) {
      const iv = randomBytes(12);
      const cipher = createCipheriv("aes-256-gcm", key, iv);
      cipher.setAAD(aad);
      const body = Buffer.concat([cipher.update(JSON.stringify({ v: value, exp: now + ttlMs }), "utf8"), cipher.final()]);
      return Buffer.concat([iv, cipher.getAuthTag(), body]).toString("base64url");
    },
    open(token, now = Date.now()) {
      const raw = Buffer.from(token, "base64url");
      if (raw.byteLength < 29) return null;
      try {
        const decipher = createDecipheriv("aes-256-gcm", key, raw.subarray(0, 12));
        decipher.setAAD(aad);
        decipher.setAuthTag(raw.subarray(12, 28));
        const text = Buffer.concat([decipher.update(raw.subarray(28)), decipher.final()]).toString("utf8");
        const parsed: unknown = JSON.parse(text);
        if (typeof parsed !== "object" || parsed === null || !("exp" in parsed) || typeof parsed.exp !== "number") return null;
        return parsed.exp > now && "v" in parsed ? parsed.v : null;
      } catch {
        return null;
      }
    },
  };
}
