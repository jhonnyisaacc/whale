import { PublicKey, SystemProgram, TransactionInstruction, TransactionMessage, VersionedTransaction } from "@solana/web3.js";
import { encodeFunctionData, erc20Abi, parseUnits, type Hex } from "viem";
import { chainByKey } from "../chains.js";
import { BroadcastError } from "../executor.js";
import { sellBaseUnits } from "../routing.js";
import { isSolanaAddress } from "../signer.js";
import type { AppConfig } from "../config.js";
import type { TransactionSigner } from "../managed-signer.js";
import type { TxRecord } from "../domain.js";
import { ATA_PROGRAM, NATIVE_ADDRESS, defaultIo, evmContext, rpcsFor, solanaContext, type Ctx, type SendHooks, type Submitted } from "./shared.js";
import { submitEvm } from "./evm.js";
import { submitSolana } from "./solana.js";

type TransferInput = {
  config: AppConfig;
  signer: TransactionSigner;
  chainKey: string;
  to: string;
  amount: number;
  secrets?: readonly string[];
} & SendHooks;

function transferContext(input: TransferInput): Ctx {
  return {
    config: input.config,
    signer: input.signer,
    io: input.io ?? defaultIo(input.config),
    onTx: input.onTx ?? (async () => undefined),
    fetchImpl: fetch,
    secrets: input.secrets ?? [],
  };
}

async function finalRecord(submitted: Submitted, ctx: Ctx): Promise<TxRecord> {
  const confirmed = await submitted.confirm();
  for (const record of confirmed.records) await ctx.onTx(record).catch(() => undefined);
  return confirmed.records[confirmed.records.length - 1] ?? submitted.record;
}

export async function withdrawNative(input: TransferInput): Promise<TxRecord> {
  const spec = chainByKey(input.chainKey);
  if (!spec) throw new Error("unknown chain");
  const rpcs = rpcsFor(input.config, input.chainKey);
  if (rpcs.length === 0) throw new Error("rpc is not configured");
  const ctx = transferContext(input);
  if (spec.chain.kind === "solana") {
    if (!isSolanaAddress(input.to)) throw new Error("destination is not a solana address");
    const solana = solanaContext(ctx, rpcs);
    const lamports = BigInt(sellBaseUnits(input.amount, 9));
    const reserve = BigInt(sellBaseUnits(spec.minNativeReserve, 9));
    if (lamports <= 0n || (await solana.rpc.lamports(solana.owner)) - lamports < reserve) throw new Error("withdraw would spend the native reserve");
    const { blockhash, lastValidBlockHeight } = await solana.rpc.latestBlockhash();
    const message = new TransactionMessage({
      payerKey: new PublicKey(solana.owner),
      recentBlockhash: blockhash,
      instructions: [SystemProgram.transfer({ fromPubkey: new PublicKey(solana.owner), toPubkey: new PublicKey(input.to), lamports: Number(lamports) })],
    }).compileToV0Message();
    const submitted = await submitSolana(solana, new VersionedTransaction(message), lastValidBlockHeight, { to: input.to, value: lamports.toString(), buyToken: null, jitoUrl: null });
    return finalRecord(submitted, ctx);
  }
  if (spec.chain.kind !== "evm") throw new Error("withdraw is not available on this venue");
  if (!/^0x[0-9a-fA-F]{40}$/.test(input.to)) throw new Error("destination is not an evm address");
  const evm = evmContext(ctx, input.chainKey, rpcs);
  const value = BigInt(sellBaseUnits(input.amount, 18));
  const reserve = BigInt(sellBaseUnits(spec.minNativeReserve, 18));
  if (value <= 0n || (await evm.read.balance(NATIVE_ADDRESS, evm.owner)) - value < reserve) throw new Error("withdraw would spend the native reserve");
  const submitted = await submitEvm(evm, { to: input.to as Hex, data: "0x", value, gas: null, purpose: "withdraw" }, null);
  return finalRecord(submitted, ctx);
}

export function associatedTokenAccount(owner: PublicKey, mint: PublicKey, program: PublicKey): PublicKey {
  return PublicKey.findProgramAddressSync([owner.toBuffer(), program.toBuffer(), mint.toBuffer()], ATA_PROGRAM)[0];
}

export function tokenRecoveryInstructions(input: {
  payer: PublicKey;
  destinationOwner: PublicKey;
  mint: PublicKey;
  source: PublicKey;
  program: PublicKey;
  amount: bigint;
  decimals: number;
}): TransactionInstruction[] {
  const ata = associatedTokenAccount(input.destinationOwner, input.mint, input.program);
  const data = Buffer.alloc(10);
  data.writeUInt8(12, 0);
  data.writeBigUInt64LE(input.amount, 1);
  data.writeUInt8(input.decimals, 9);
  return [
    new TransactionInstruction({
      programId: ATA_PROGRAM,
      data: Buffer.from([1]),
      keys: [
        { pubkey: input.payer, isSigner: true, isWritable: true },
        { pubkey: ata, isSigner: false, isWritable: true },
        { pubkey: input.destinationOwner, isSigner: false, isWritable: false },
        { pubkey: input.mint, isSigner: false, isWritable: false },
        { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
        { pubkey: input.program, isSigner: false, isWritable: false },
      ],
    }),
    new TransactionInstruction({
      programId: input.program,
      keys: [
        { pubkey: input.source, isSigner: false, isWritable: true },
        { pubkey: input.mint, isSigner: false, isWritable: false },
        { pubkey: ata, isSigner: false, isWritable: true },
        { pubkey: input.payer, isSigner: true, isWritable: false },
      ],
      data,
    }),
  ];
}

export async function recoverToken(input: TransferInput & { mint: string; decimals: number }): Promise<TxRecord> {
  const spec = chainByKey(input.chainKey);
  if (!spec) throw new Error("unknown chain");
  const rpcs = rpcsFor(input.config, input.chainKey);
  if (rpcs.length === 0) throw new Error("rpc is not configured");
  const ctx = transferContext(input);
  if (spec.chain.kind === "evm") {
    if (!/^0x[0-9a-fA-F]{40}$/.test(input.to) || !/^0x[0-9a-fA-F]{40}$/.test(input.mint)) throw new Error("destination is not an evm address");
    const evm = evmContext(ctx, input.chainKey, rpcs);
    const data = encodeFunctionData({ abi: erc20Abi, functionName: "transfer", args: [input.to as Hex, parseUnits(String(input.amount), input.decimals)] });
    const submitted = await submitEvm(evm, { to: input.mint as Hex, data, value: 0n, gas: null, purpose: "withdraw", nativeSell: false }, null);
    return finalRecord(submitted, ctx);
  }
  if (spec.chain.kind !== "solana" || !input.signer.solanaAddress() || !isSolanaAddress(input.to) || !isSolanaAddress(input.mint)) {
    throw new Error("destination is not a solana address");
  }
  const solana = solanaContext(ctx, rpcs);
  const found = await solana.rpc.tokenAccount(solana.owner, input.mint);
  if (!found) throw new Error("token account was not found");
  const ownerKey = new PublicKey(solana.owner);
  const instructions = tokenRecoveryInstructions({
    payer: ownerKey,
    destinationOwner: new PublicKey(input.to),
    mint: new PublicKey(input.mint),
    source: new PublicKey(found.source),
    program: new PublicKey(found.program),
    amount: BigInt(sellBaseUnits(input.amount, input.decimals)),
    decimals: input.decimals,
  });
  const { blockhash, lastValidBlockHeight } = await solana.rpc.latestBlockhash();
  const message = new TransactionMessage({ payerKey: ownerKey, recentBlockhash: blockhash, instructions }).compileToV0Message();
  const submitted = await submitSolana(solana, new VersionedTransaction(message), lastValidBlockHeight, { to: input.to, value: "0", buyToken: null, jitoUrl: null });
  return finalRecord(submitted, ctx);
}
