import { readFileSync } from "node:fs";
import { Keypair, PublicKey } from "@solana/web3.js";
import bs58 from "bs58";
import { privateKeyToAccount } from "viem/accounts";
import type { Hex } from "viem";
import { decryptWallet, type KeystoreFile } from "./keystore.js";
import { Secret, trackSecret } from "./redact.js";

export type SignerMaterial = {
  evm: Secret | null;
  solana: Secret | null;
  hyperliquid: Secret | null;
  evmAddress: string | null;
  solanaAddress: string | null;
};

function evmAccount(secret: Secret): string {
  const raw = secret.reveal();
  const hex = (raw.startsWith("0x") ? raw : `0x${raw}`) as Hex;
  return privateKeyToAccount(hex).address;
}

function solanaKeypair(secret: Secret): Keypair {
  return Keypair.fromSecretKey(bs58.decode(secret.reveal()));
}

export function loadSigner(env: NodeJS.ProcessEnv = process.env): SignerMaterial | null {
  try {
    const hyper = env.HYPERLIQUID_AGENT_KEY ? trackSecret(new Secret(env.HYPERLIQUID_AGENT_KEY)) : null;
    if (env.KEYSTORE_PATH && env.KEYSTORE_PASSPHRASE) {
      const file = JSON.parse(readFileSync(env.KEYSTORE_PATH, "utf8")) as KeystoreFile;
      const wallet = decryptWallet(file, env.KEYSTORE_PASSPHRASE);
      return {
        evm: trackSecret(wallet.evmPrivateKey),
        solana: trackSecret(wallet.solanaSecretKey),
        hyperliquid: hyper,
        evmAddress: wallet.evmAddress,
        solanaAddress: wallet.solanaAddress,
      };
    }
    if (!env.EVM_PRIVATE_KEY && !env.SOLANA_SECRET_KEY && !hyper) return null;
    const evm = env.EVM_PRIVATE_KEY ? trackSecret(new Secret(env.EVM_PRIVATE_KEY)) : null;
    const solana = env.SOLANA_SECRET_KEY ? trackSecret(new Secret(env.SOLANA_SECRET_KEY)) : null;
    return {
      evm,
      solana,
      hyperliquid: hyper,
      evmAddress: evm ? evmAccount(evm) : null,
      solanaAddress: solana ? solanaKeypair(solana).publicKey.toBase58() : null,
    };
  } catch {
    throw new Error("signer material is invalid");
  }
}

export function signerSecrets(material: SignerMaterial | null): string[] {
  if (!material) return [];
  return [material.evm, material.solana, material.hyperliquid].flatMap((secret) => (secret ? [secret.reveal()] : []));
}

export function evmSigner(material: SignerMaterial): Hex {
  if (!material.evm || !material.evmAddress) throw new Error("evm signer is not loaded");
  const raw = material.evm.reveal();
  return (raw.startsWith("0x") ? raw : `0x${raw}`) as Hex;
}

export function solanaSigner(material: SignerMaterial): Keypair {
  if (!material.solana) throw new Error("solana signer is not loaded");
  return solanaKeypair(material.solana);
}

export function hyperliquidSigner(material: SignerMaterial): Secret {
  if (!material.hyperliquid) throw new Error("hyperliquid agent key is not loaded");
  return material.hyperliquid;
}

export function isSolanaAddress(value: string): boolean {
  try {
    new PublicKey(value);
    return true;
  } catch {
    return false;
  }
}
