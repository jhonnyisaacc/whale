import { PublicKey, TransactionMessage, VersionedTransaction } from "@solana/web3.js";
import bs58 from "bs58";
import type { RouteLeg, TxRecord } from "../domain.js";
import { firmJupiter, jupiterQuote, jupiterSwap } from "../aggregators.js";
import { BroadcastError } from "../executor.js";
import { isSolanaAddress } from "../signer.js";
import { JUPITER_PROGRAM_ID, WSOL_MINT } from "../signing-policy.js";
import { z } from "zod";
import type { TxOutcome } from "../domain.js";
import { redactError } from "../redact.js";
import { readVendorText, vendorResponse } from "../vendor-fetch.js";
import { assertMinOut, digits, executionSlippageBps, journal, ourMinOut, overCap, referenceFor, reusableQuote, reuseOrFirm, type Confirmed, type Ctx, type PreparedLeg, type SendIo, type SolanaCtx, type SolanaRpc, type SolanaStatus, type Submitted } from "./shared.js";

export function solanaSignature(signed: Uint8Array): string {
  const signature = VersionedTransaction.deserialize(signed).signatures[0];
  if (!signature) throw new BroadcastError("signed transaction has no signature", false);
  return bs58.encode(signature);
}

export async function sendJito(fetchImpl: typeof fetch, url: string, signed: Uint8Array): Promise<void> {
  const response = await vendorResponse(fetchImpl, url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "sendTransaction", params: [Buffer.from(signed).toString("base64"), { encoding: "base64" }] }),
  }, false);
  if (!response.ok) throw new Error("jito send failed");
  const body = z.object({ error: z.unknown().optional() }).passthrough().parse(JSON.parse(await readVendorText(response)));
  if (body.error) throw new Error("jito send failed");
}

export function landedStatus(status: SolanaStatus | undefined): "landed" | "reverted" | null {
  if (!status || (status.confirmationStatus !== "confirmed" && status.confirmationStatus !== "finalized")) return null;
  return status.err ? "reverted" : "landed";
}

export async function confirmSolana(rpc: SolanaRpc, signature: string, lastValidBlockHeight: number, io: SendIo): Promise<TxOutcome> {
  // Blockhash expiry normally decides first; the wall clock only stops a dead RPC from hanging the send.
  const deadline = io.now() + io.confirmTimeoutMs * 3;
  for (;;) {
    const status = await rpc.status(signature).catch(() => undefined);
    const landed = landedStatus(status);
    if (landed) return landed;
    const height = await rpc.blockHeight().catch(() => null);
    if (height !== null && height > lastValidBlockHeight) {
      const final = await rpc.status(signature, true).catch(() => undefined);
      if (final === null) return "expired";
      return landedStatus(final) ?? "pending";
    }
    if (io.now() >= deadline) return "pending";
    await io.sleep(io.pollMs);
  }
}


export async function submitSolana(
  ctx: SolanaCtx,
  tx: VersionedTransaction,
  lastValid: number | null,
  shape: { to: string; value: string; buyToken: string | null; jitoUrl: string | null },
): Promise<Submitted> {
  let signed: Uint8Array;
  let expiry: number;
  try {
    signed = await ctx.signer.signSolana(tx.serialize());
    expiry = lastValid ?? (await ctx.rpc.blockHeight()) + 150;
  } catch (error) {
    throw new BroadcastError(redactError(error, ctx.secrets), false);
  }
  const record: TxRecord = { chainKey: "solana", txHash: solanaSignature(signed), from: ctx.owner, to: shape.to, value: shape.value, outcome: "pending" };
  await journal(ctx, record);
  try {
    if (shape.jitoUrl) await sendJito(ctx.fetchImpl, shape.jitoUrl, signed);
    else await ctx.rpc.sendRaw(signed);
  } catch (error) {
    throw new BroadcastError(redactError(error, ctx.secrets), true);
  }
  return {
    record,
    async confirm() {
      const outcome = await confirmSolana(ctx.rpc, record.txHash, expiry, ctx.io);
      const received = outcome === "landed" && shape.buyToken ? await ctx.rpc.received(record.txHash, ctx.owner, shape.buyToken).catch(() => null) : null;
      return { records: [{ ...record, outcome }], received };
    },
  };
}

export async function prepareSolanaLeg(ctx: SolanaCtx, leg: RouteLeg, slippageBps: number, capBps: number): Promise<PreparedLeg> {
  const { config, fetchImpl } = ctx;
  const reuse = reusableQuote(config, leg, ctx.owner);
  const { quoted, minOut } = await reuseOrFirm(reuse?.provider === "jupiter" ? reuse : null, async (stored) => {
    const quoted = stored
      ? jupiterQuote(config, stored.raw)
      : await firmJupiter(
          config,
          { sellAddress: leg.sellAddress, buyAddress: leg.buyAddress, sellAmount: leg.sellAmount, chain: { kind: "solana" } },
          slippageBps,
          referenceFor(leg),
          fetchImpl,
        );
    if (quoted.signable === false || overCap(quoted.priceImpactPct, capBps / 100) || quoted.raw === undefined) {
      throw new BroadcastError("firm quote outside the slippage cap", false);
    }
    return { quoted, minOut: assertMinOut(digits((quoted.raw as { otherAmountThreshold?: unknown }).otherAmountThreshold), ourMinOut(leg, capBps)) };
  });
  const built = await jupiterSwap(config, quoted.raw, ctx.owner, fetchImpl);
  if (!built) throw new BroadcastError("jupiter swap build failed", false);
  const tx = VersionedTransaction.deserialize(Buffer.from(built.swapTransaction, "base64"));
  const simulated = await ctx.rpc.simulate(tx).catch(() => "unavailable");
  if (simulated) throw new BroadcastError("simulation rejected the transaction", false);
  return {
    impact: quoted.priceImpactPct ?? capBps,
    minOut,
    quotedOut: BigInt(quoted.buyAmount),
    submit: () => submitSolana(ctx, tx, built.lastValidBlockHeight ?? null, { to: JUPITER_PROGRAM_ID, value: "0", buyToken: leg.buyAddress, jitoUrl: config.jitoUrl }),
  };
}
