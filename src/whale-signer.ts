import { readFileSync } from "node:fs";
import path from "node:path";
import { VersionedTransaction } from "@solana/web3.js";
import bs58 from "bs58";
import { keccak256 } from "viem";
import { z } from "zod";
import type { TransactionSigner } from "./managed-signer.js";
import { verifiedEvmTransaction, verifiedSolanaTransaction } from "./signatures.js";
import type { SignerAnswer, SignerJob, SignerQueue } from "./signer-queue.js";

export type SignerJobRecord = { id: string; kind: SignerJob["kind"]; decision: SignerAnswer["decision"]; reasons?: string[]; hash?: string };

export class SignerRefusal extends Error {
  constructor(
    readonly jobId: string,
    readonly reasons: readonly string[],
  ) {
    super(`whale-signer refused job ${jobId}: ${reasons.join("; ") || "no reason given"}`);
  }
}

const keystoreAddresses = z.object({ evmAddress: z.string().regex(/^0x[0-9a-fA-F]{40}$/), solanaAddress: z.string().min(32).max(44) }).loose();

export type WhaleSignerSetup = { evmAddress: string; solanaAddress: string; token: string; port: number; answerTimeoutMs: number };

export function whaleSignerSetup(env: NodeJS.ProcessEnv): WhaleSignerSetup | null {
  const keystore = env.WHALE_SIGNER_KEYSTORE?.trim();
  if (!keystore) return null;
  const addresses = keystoreAddresses.safeParse(JSON.parse(readFileSync(keystore, "utf8")));
  if (!addresses.success) throw new Error("WHALE_SIGNER_KEYSTORE is not a whale-signer keystore");
  const parsed = path.parse(keystore);
  const tokenFile = path.join(parsed.dir, `${parsed.name}.token`);
  const token = readFileSync(tokenFile, "utf8").trim();
  if (token.length < 32) throw new Error(`${tokenFile} must hold a token of at least 32 characters`);
  const port = Number(env.WHALE_SIGNER_PORT ?? "8790");
  if (!Number.isInteger(port) || port < 1 || port > 65_535) throw new Error("WHALE_SIGNER_PORT must be a TCP port");
  const answerTimeoutMs = Number(env.WHALE_SIGNER_TIMEOUT_MS ?? "45000");
  if (!Number.isInteger(answerTimeoutMs) || answerTimeoutMs < 1_000) throw new Error("WHALE_SIGNER_TIMEOUT_MS must be at least 1000");
  return { evmAddress: addresses.data.evmAddress, solanaAddress: addresses.data.solanaAddress, token, port, answerTimeoutMs };
}

const evmResult = z.object({ signedTransaction: z.string() });
const solanaResult = z.object({ signature: z.string().max(90) });

export function whaleSigner(queue: SignerQueue, addresses: { evm: string; solana: string }, jobs: SignerJobRecord[]): TransactionSigner {
  const ask = async (job: SignerJob) => {
    const { id, answer } = await queue.submit(job);
    if (answer.decision === "refused") {
      jobs.push({ id, kind: job.kind, decision: "refused", reasons: answer.reasons });
      throw new SignerRefusal(id, answer.reasons);
    }
    return { id, result: answer.result };
  };
  return {
    backend: "whale-signer",
    evmAddress: () => addresses.evm,
    solanaAddress: () => addresses.solana,
    async signEvm(input) {
      const request = { chainId: input.chainId, to: input.to, data: input.data, value: input.value, gas: input.gas, nonce: input.nonce, maxFeePerGas: input.maxFeePerGas, maxPriorityFeePerGas: input.maxPriorityFeePerGas };
      const tx = { nonce: String(input.nonce), to: input.to, value: input.value.toString(), data: input.data, gas: input.gas.toString(), maxFeePerGas: input.maxFeePerGas.toString(), maxPriorityFeePerGas: input.maxPriorityFeePerGas.toString() };
      const { id, result } = await ask({ kind: "evm", payload: { chainId: input.chainId, tx } });
      const parsed = evmResult.safeParse(result);
      if (!parsed.success) throw new Error(`whale-signer answered job ${id} without a signed transaction`);
      const signed = await verifiedEvmTransaction(parsed.data.signedTransaction, request, addresses.evm);
      jobs.push({ id, kind: "evm", decision: "signed", hash: keccak256(signed) });
      return signed;
    },
    async signSolana(serialized, context) {
      const tx = VersionedTransaction.deserialize(serialized);
      const message = Buffer.from(tx.message.serialize()).toString("base64");
      const buyMint = context?.buyMint ?? null;
      const { id, result } = await ask({ kind: "solana", payload: { message, ...(buyMint ? { buyMint } : {}) } });
      const parsed = solanaResult.safeParse(result);
      if (!parsed.success) throw new Error(`whale-signer answered job ${id} without a signature`);
      tx.signatures[0] = bs58.decode(parsed.data.signature);
      const signed = verifiedSolanaTransaction(tx.serialize(), serialized, addresses.solana);
      jobs.push({ id, kind: "solana", decision: "signed", hash: parsed.data.signature });
      return signed;
    },
    async signHyperliquid() {
      throw new Error("whale-signer does not sign HyperCore actions");
    },
  };
}
