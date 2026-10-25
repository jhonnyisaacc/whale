import { TransactionReceiptNotFoundError, createPublicClient, type Hex } from "viem";
import { encodeFunctionData, erc20Abi, keccak256, parseUnits } from "viem";
import type { RouteLeg, TxRecord } from "../domain.js";
import type { EvmSignInput } from "../managed-signer.js";
import { firmJupiter, firmKyber, firmLifi, firmZeroEx, jupiterQuote, jupiterSwap, kyberFromRoute } from "../aggregators.js";
import { chainByEvmId } from "../chains.js";
import { isDefiniteRejection } from "../nonce.js";
import type { RaceQuote, TxOutcome } from "../domain.js";
import { BroadcastError } from "../executor.js";
import { allowanceCovers, rememberApproval } from "../approvals.js";
import { readLifi, readZeroEx } from "../quotes.js";
import { redactError } from "../redact.js";
import { sellBaseUnits } from "../routing.js";
import { routersForChain, swapTerms } from "../signing-policy.js";
import { approvalSpender, asHex, assertMinOut, executionSlippageBps, journal, onAnyRpc, ourMinOut, referenceFor, rememberIfFunded, reusableQuote, reuseOrFirm, type Confirmed, type Ctx, type EvmCtx, type EvmReceipt, type EvmRpc, type EvmTx, type PreparedLeg, type Submitted, NATIVE_SELL, digits, overCap } from "./shared.js";

export function evmRecord(ctx: EvmCtx, signed: Hex, tx: { to: Hex; value: bigint; nonce: number }): TxRecord {
  return { chainKey: ctx.chainKey, txHash: keccak256(signed), from: ctx.owner, to: tx.to, value: tx.value.toString(), outcome: "pending", nonce: tx.nonce };
}

export async function sendOnce(rpc: EvmRpc, signed: Hex): Promise<void> {
  try {
    await rpc.sendRaw(signed);
  } catch (error) {
    if (/already known/i.test(error instanceof Error ? error.message : String(error))) return;
    throw error;
  }
}

// Only a rejection every sender gave before its mempool proves the transaction is nowhere; a timeout or
// 5xx from any of them leaves it possibly broadcast, so the spend stays reserved for reconcile. A provider
// that retried internally can report "nonce too low" for a transaction it accepted, so the hash is looked up too.
// A private relay's mempool is invisible to the public reads, so its rejections are never taken as definite.
export async function broadcastEvm(ctx: EvmCtx, signed: Hex): Promise<void> {
  try {
    await Promise.any(ctx.senders.map((rpc) => sendOnce(rpc, signed)));
  } catch (error) {
    const reasons: unknown[] = error instanceof AggregateError ? error.errors : [error];
    const messages = reasons.map((reason) => redactError(reason, ctx.secrets));
    const definite = !ctx.privateSend && messages.every(isDefiniteRejection) && !(await seenAnywhere(ctx, keccak256(signed)));
    throw new BroadcastError(messages[0] ?? "no rpc is configured", !definite);
  }
}

async function seenAnywhere(ctx: EvmCtx, hash: Hex): Promise<boolean> {
  try {
    return (await onAnyRpc(ctx.reads, async (rpc) => ((await rpc.seen(hash)) ? true : null))) === true;
  } catch {
    return true;
  }
}

export function bumpFee(fee: bigint): bigint {
  const step = (fee * 125n + 999n) / 1000n;
  return fee + (step > 0n ? step : 1n);
}

export async function pollReceipts(ctx: EvmCtx, hashes: readonly string[], deadline: number): Promise<{ hash: string; receipt: EvmReceipt } | null> {
  for (;;) {
    for (const hash of hashes) {
      const receipt = await ctx.read.receipt(hash as Hex).catch(() => null);
      if (receipt) return { hash, receipt };
    }
    if (ctx.io.now() >= deadline) return null;
    await ctx.io.sleep(ctx.io.pollMs);
  }
}

export async function replaceEvm(ctx: EvmCtx, input: EvmSignInput): Promise<TxRecord | null> {
  const current = await ctx.read.fees().catch(() => null);
  const maxPriorityFeePerGas = [bumpFee(input.maxPriorityFeePerGas), current?.maxPriorityFeePerGas ?? 0n].reduce((a, b) => (a > b ? a : b));
  const maxFeePerGas = [bumpFee(input.maxFeePerGas), current?.maxFeePerGas ?? 0n, maxPriorityFeePerGas].reduce((a, b) => (a > b ? a : b));
  let signed: Hex;
  try {
    signed = await ctx.signer.signEvm({ ...input, maxFeePerGas, maxPriorityFeePerGas });
  } catch {
    return null;
  }
  const record = evmRecord(ctx, signed, input);
  try {
    await journal(ctx, record);
    await broadcastEvm(ctx, signed);
  } catch (error) {
    if (error instanceof BroadcastError && !error.broadcast) {
      await ctx.onTx({ ...record, outcome: "expired" }).catch(() => undefined);
      return null;
    }
    return record;
  }
  return record;
}

export async function confirmEvm(ctx: EvmCtx, input: EvmSignInput, first: TxRecord, before: bigint | null, buyToken: string | null): Promise<Confirmed> {
  const records = [first];
  let found = await pollReceipts(ctx, [first.txHash], ctx.io.now() + ctx.io.confirmTimeoutMs);
  if (!found) {
    const replacement = await replaceEvm(ctx, input);
    if (replacement) records.push(replacement);
    found = await pollReceipts(ctx, records.map((record) => record.txHash), ctx.io.now() + ctx.io.confirmTimeoutMs);
  }
  if (!found) {
    ctx.io.nonces.resync(ctx.chainId, ctx.owner);
    return { records: records.map((record) => ({ ...record, outcome: "pending" })), received: null };
  }
  const outcome: TxOutcome = found.receipt.status === "success" ? "landed" : "reverted";
  const losers = records.filter((record) => record.txHash !== found.hash).map((record) => ({ ...record, outcome: "expired" as const }));
  const won = records.find((record) => record.txHash === found.hash) ?? first;
  let received: bigint | null = null;
  if (outcome === "landed" && buyToken && before !== null) {
    const gasCost = NATIVE_SELL.has(buyToken.toLowerCase()) ? found.receipt.gasUsed * found.receipt.effectiveGasPrice : 0n;
    received = await ctx.read
      .balance(buyToken, ctx.owner)
      .then((after) => after - before + gasCost)
      .catch(() => null);
  }
  return { records: [...losers, { ...won, outcome }], received };
}

export async function submitEvm(ctx: EvmCtx, tx: EvmTx, buyToken: string | null): Promise<Submitted> {
  const call = { from: ctx.owner, to: tx.to, data: tx.data, value: tx.value };
  let fees: { maxFeePerGas: bigint; maxPriorityFeePerGas: bigint };
  let gas: bigint;
  let before: bigint | null;
  try {
    [fees, gas, before] = await Promise.all([
      ctx.read.fees(),
      tx.gas ?? ctx.read.estimateGas(call),
      buyToken ? ctx.read.balance(buyToken, ctx.owner).catch(() => null) : Promise.resolve(null),
    ]);
  } catch (error) {
    throw new BroadcastError(redactError(error, ctx.secrets), false);
  }
  try {
    await ctx.read.simulate(call);
  } catch {
    throw new BroadcastError("simulation rejected the transaction", false);
  }
  const sent = await ctx.io.nonces.use(ctx.chainId, ctx.owner, () => ctx.read.pendingNonce(ctx.owner), async (nonce) => {
    const input: EvmSignInput = {
      chainId: ctx.chainId,
      to: tx.to,
      data: tx.data,
      value: tx.value,
      purpose: tx.purpose,
      nativeSell: tx.nativeSell,
      gas,
      nonce,
      ...fees,
    };
    let signed: Hex;
    try {
      signed = await ctx.signer.signEvm(input);
    } catch (error) {
      throw new BroadcastError(redactError(error, ctx.secrets), false);
    }
    const record = evmRecord(ctx, signed, { ...tx, nonce });
    await journal(ctx, record);
    await broadcastEvm(ctx, signed);
    return { input, record };
  });
  return { record: sent.record, confirm: () => confirmEvm(ctx, sent.input, sent.record, before, buyToken) };
}

function sameToken(left: string, right: string): boolean {
  const a = left.toLowerCase();
  const b = right.toLowerCase();
  return a === b || (NATIVE_SELL.has(a) && NATIVE_SELL.has(b));
}

// The calldata, not the API's summary of it, decides who receives the output and the minimum it may be.
function decodedMinOut(data: Hex, provider: "kyberswap" | "zeroex", owner: string, leg: RouteLeg): bigint {
  const terms = swapTerms(data);
  if (!terms || terms.provider !== provider) throw new BroadcastError("swap calldata is not decodable", false);
  if (terms.recipient.toLowerCase() !== owner.toLowerCase()) throw new BroadcastError("swap recipient is not the hot wallet", false);
  if (!sameToken(terms.buyToken, leg.buyAddress)) throw new BroadcastError("swap calldata buys a different token", false);
  if (terms.provider === "zeroex" && terms.exec && (!sameToken(terms.exec.token, leg.sellAddress) || terms.exec.amount !== BigInt(leg.sellAmount))) {
    throw new BroadcastError("0x exec does not spend the leg's sell amount", false);
  }
  return terms.minOut;
}

type BuiltEvm = { provider: string; to: Hex; data: Hex; value: bigint; gas: bigint | null; impact: number; raw: unknown; minOut: bigint | null; quotedOut: bigint };

export async function evmTransaction(ctx: EvmCtx, leg: RouteLeg, capPct: number, slippageBps: number, selected: string, stored: RaceQuote | null): Promise<BuiltEvm> {
  const { config, chainId, owner: taker, fetchImpl } = ctx;
  const hop = { sellAddress: leg.sellAddress, buyAddress: leg.buyAddress, sellAmount: leg.sellAmount, chain: { kind: "evm" as const, chainId } };
  const reference = referenceFor(leg);
  if (selected === "kyberswap") {
    const quoted = stored
      ? await kyberFromRoute(config, stored.raw, chainId, taker, reference, fetchImpl, slippageBps)
      : await firmKyber(config, hop, chainId, taker, reference, fetchImpl, slippageBps);
    if (overCap(quoted.priceImpactPct, capPct) || !quoted.prepared?.to || !quoted.prepared.data) {
      throw new BroadcastError("firm quote outside the slippage cap", false);
    }
    const data = asHex(quoted.prepared.data);
    return {
      provider: selected,
      to: asHex(quoted.prepared.to),
      data,
      value: BigInt(quoted.prepared.value || "0"),
      gas: null,
      impact: quoted.priceImpactPct ?? capPct + 1,
      raw: quoted.raw,
      minOut: decodedMinOut(data, "kyberswap", taker, leg),
      quotedOut: BigInt(quoted.buyAmount),
    };
  }
  if (selected === "lifi") {
    if (!config.lifiLive) throw new BroadcastError("LI.FI swaps are not signable without LIFI_LIVE=true", false);
    const quoted = stored ? { raw: stored.raw } : await firmLifi(config, hop, chainId, taker, reference, fetchImpl, slippageBps);
    if (quoted.raw === undefined) throw new BroadcastError("firm quote outside the slippage cap", false);
    const parsed = readLifi(quoted.raw as Parameters<typeof readLifi>[0], reference, chainId);
    if (!parsed.sameChain || overCap(parsed.priceImpactPct, capPct) || parsed.priceImpactPct === null) {
      throw new BroadcastError("firm quote outside the slippage cap", false);
    }
    const raw = quoted.raw as { transactionRequest?: { to?: string; data?: string; value?: string; gasLimit?: string }; estimate?: { toAmountMin?: unknown } };
    const request = raw.transactionRequest;
    if (!request?.to || !request.data) throw new BroadcastError("firm quote has no transaction", false);
    return {
      provider: selected,
      to: asHex(request.to),
      data: asHex(request.data),
      value: BigInt(request.value ?? "0"),
      gas: request.gasLimit ? BigInt(request.gasLimit) : null,
      impact: parsed.priceImpactPct,
      raw: quoted.raw,
      minOut: digits(raw.estimate?.toAmountMin),
      quotedOut: BigInt(parsed.buyAmount),
    };
  }
  if (selected !== "zeroex") throw new BroadcastError("provider is not signable", false);
  const quoted = stored ? { raw: stored.raw } : await firmZeroEx(config, hop, chainId, taker, reference, fetchImpl, slippageBps);
  if (quoted.raw === undefined) throw new BroadcastError("firm quote outside the slippage cap", false);
  const parsed = readZeroEx(quoted.raw as Parameters<typeof readZeroEx>[0], reference);
  if (overCap(parsed.priceImpactPct, capPct) || parsed.priceImpactPct === null || !parsed.to || !parsed.data) {
    throw new BroadcastError("firm quote outside the slippage cap", false);
  }
  const raw = quoted.raw as { transaction?: { gas?: string } };
  const data = asHex(parsed.data);
  return {
    provider: selected,
    to: asHex(parsed.to),
    data,
    value: BigInt(parsed.value || "0"),
    gas: raw.transaction?.gas ? BigInt(raw.transaction.gas) : null,
    impact: parsed.priceImpactPct,
    raw: quoted.raw,
    minOut: decodedMinOut(data, "zeroex", taker, leg),
    quotedOut: BigInt(parsed.buyAmount),
  };
}

function selectedProvider(chainId: number, leg: RouteLeg, provider: string | undefined): string {
  return leg.quote?.provider ?? provider ?? (chainByEvmId(chainId)?.aggregator === "lifi" ? "lifi" : "zeroex");
}

// Leg 2 is firmed only after leg 1 lands, so its spender is known now only when it uses leg 1's provider.
// Otherwise any allowlisted router with a cached allowance can be the one it picks.
function nextLegSpenders(ctx: EvmCtx, next: RouteLeg, provider: string | undefined, built: BuiltEvm): readonly string[] {
  if (selectedProvider(ctx.chainId, next, provider) === built.provider) return [approvalSpender(built.provider, built.raw, built.to)];
  return routersForChain(ctx.config.routerAllowlist, ctx.chainId);
}

export async function prepareEvmLeg(ctx: EvmCtx, leg: RouteLeg, slippageBps: number, next: RouteLeg | undefined, capBps: number, provider: string | undefined): Promise<PreparedLeg> {
  const reuse = reusableQuote(ctx.config, leg, ctx.owner);
  const selected = selectedProvider(ctx.chainId, leg, provider);
  const { built, minOut } = await reuseOrFirm(reuse, async (stored) => {
    const built = await evmTransaction(ctx, leg, capBps / 100, slippageBps, selected, stored);
    return { built, minOut: assertMinOut(built.minOut, ourMinOut(leg, capBps)) };
  });
  rememberIfFunded(built.provider, built.raw, ctx.chainId, leg.sellAddress, ctx.owner, BigInt(leg.sellAmount), built.to);
  if (next && !NATIVE_SELL.has(next.sellAddress.toLowerCase())) {
    const covered = nextLegSpenders(ctx, next, provider, built).some((spender) =>
      allowanceCovers({ chainId: ctx.chainId, token: next.sellAddress, spender, owner: ctx.owner }, built.quotedOut),
    );
    if (!covered) throw new BroadcastError("approval is not cached", false);
  }
  return {
    impact: built.impact,
    minOut,
    quotedOut: built.quotedOut,
    submit: () =>
      submitEvm(
        ctx,
        { to: built.to, data: built.data, value: built.value, gas: built.gas, purpose: "swap", nativeSell: NATIVE_SELL.has(leg.sellAddress.toLowerCase()) },
        leg.buyAddress,
      ),
  };
}
