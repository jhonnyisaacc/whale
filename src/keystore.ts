import { randomBytes, scryptSync, createCipheriv, createDecipheriv } from "node:crypto";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { Keypair } from "@solana/web3.js";
import bs58 from "bs58";
import { Secret } from "./redact.js";

export type KeystoreFile = {
  version: 1;
  kdf: "scrypt";
  n: number;
  r: number;
  p: number;
  salt: string;
  iv: string;
  ciphertext: string;
  addresses: { evm: string; solana: string };
};

export type WalletMaterial = {
  evmPrivateKey: Secret;
  evmAddress: string;
  solanaSecretKey: Secret;
  solanaAddress: string;
};

const N = 131072;
const R = 8;
const P = 1;
const SCRYPT_MAXMEM = 256 * 1024 * 1024;

function scryptOptions(n: number, r: number, p: number): { N: number; r: number; p: number; maxmem: number } {
  if (!Number.isInteger(n) || n < 16384 || n > 1_048_576 || (n & (n - 1)) !== 0) throw new Error("scrypt n is outside the allowed bounds");
  if (!Number.isInteger(r) || r < 1 || r > 32) throw new Error("scrypt r is outside the allowed bounds");
  if (!Number.isInteger(p) || p < 1 || p > 8) throw new Error("scrypt p is outside the allowed bounds");
  return { N: n, r, p, maxmem: SCRYPT_MAXMEM };
}

function keyFromPassphrase(passphrase: string, salt: Buffer, n: number, r: number, p: number): Buffer {
  return scryptSync(passphrase, salt, 32, scryptOptions(n, r, p));
}

function headerAad(file: Pick<KeystoreFile, "version" | "kdf" | "n" | "r" | "p" | "addresses">): Buffer {
  return Buffer.from(JSON.stringify({ version: file.version, kdf: file.kdf, n: file.n, r: file.r, p: file.p, addresses: file.addresses }));
}

export function createWalletMaterial(): WalletMaterial {
  const evmPrivateKey = generatePrivateKey();
  const account = privateKeyToAccount(evmPrivateKey);
  const solana = Keypair.generate();
  return {
    evmPrivateKey: new Secret(evmPrivateKey),
    evmAddress: account.address,
    solanaSecretKey: new Secret(bs58.encode(solana.secretKey)),
    solanaAddress: solana.publicKey.toBase58(),
  };
}

export function encryptWallet(material: WalletMaterial, passphrase: string): KeystoreFile {
  if (passphrase.length < 12) throw new Error("passphrase must be at least 12 characters");
  const salt = randomBytes(16);
  const iv = randomBytes(12);
  const key = keyFromPassphrase(passphrase, salt, N, R, P);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const fileHeader = { version: 1 as const, kdf: "scrypt" as const, n: N, r: R, p: P, addresses: { evm: material.evmAddress, solana: material.solanaAddress } };
  cipher.setAAD(headerAad(fileHeader));
  const payload = JSON.stringify({
    evmPrivateKey: material.evmPrivateKey.reveal(),
    solanaSecretKey: material.solanaSecretKey.reveal(),
  });
  const ciphertext = Buffer.concat([cipher.update(payload, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return {
    ...fileHeader,
    salt: salt.toString("hex"),
    iv: iv.toString("hex"),
    ciphertext: Buffer.concat([ciphertext, tag]).toString("hex"),
  };
}

export function decryptWallet(file: KeystoreFile, passphrase: string): WalletMaterial {
  const salt = Buffer.from(file.salt, "hex");
  const iv = Buffer.from(file.iv, "hex");
  const blob = Buffer.from(file.ciphertext, "hex");
  const tag = blob.subarray(blob.length - 16);
  const data = blob.subarray(0, blob.length - 16);
  const key = keyFromPassphrase(passphrase, salt, file.n, file.r, file.p);
  const decipher = createDecipheriv("aes-256-gcm", key, iv, { authTagLength: 16 });
  decipher.setAAD(headerAad(file));
  decipher.setAuthTag(tag);
  let json: string;
  try {
    json = Buffer.concat([decipher.update(data), decipher.final()]).toString("utf8");
  } catch {
    throw new Error("keystore did not decrypt");
  }
  const parsed = JSON.parse(json) as { evmPrivateKey: string; solanaSecretKey: string };
  const account = privateKeyToAccount(parsed.evmPrivateKey as `0x${string}`);
  if (account.address.toLowerCase() !== file.addresses.evm.toLowerCase()) throw new Error("keystore address does not match");
  const solanaAddress = Keypair.fromSecretKey(bs58.decode(parsed.solanaSecretKey)).publicKey.toBase58();
  if (solanaAddress !== file.addresses.solana) throw new Error("keystore address does not match");
  return {
    evmPrivateKey: new Secret(parsed.evmPrivateKey),
    evmAddress: account.address,
    solanaSecretKey: new Secret(parsed.solanaSecretKey),
    solanaAddress,
  };
}

export function keystoreContainsSecret(file: KeystoreFile, material: WalletMaterial): boolean {
  const serialized = JSON.stringify(file);
  return serialized.includes(material.evmPrivateKey.reveal()) || serialized.includes(material.solanaSecretKey.reveal());
}
