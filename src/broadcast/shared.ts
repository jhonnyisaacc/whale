import { PublicKey, SystemProgram, TransactionInstruction, TransactionMessage, VersionedTransaction, type Connection } from "@solana/web3.js";
import bs58 from "bs58";
import { TransactionNotFoundError, TransactionReceiptNotFoundError, createPublicClient, defineChain, encodeFunctionData, erc20Abi, keccak256, parseUnits, type Hex } from "viem";
import { z } from "zod";
import type { AppConfig } from "../config.js";
import type { Fill, RaceQuote, RouteLeg, SendResult, TxOutcome, TxRecord } from "../domain.js";
import { chainByEvmId, chainByKey } from "../chains.js";
import { allowanceCovers, rememberApproval } from "../approvals.js";
import { firmJupiter, firmKyber, firmLifi, firmZeroEx, jupiterQuote, jupiterSwap, kyberFromRoute } from "../aggregators.js";
import { BroadcastError, type SendRequest } from "../executor.js";
import { nextHyperliquidNonce, readExchangeResponse } from "../hyperliquid.js";
import type { EvmSignInput, TransactionSigner } from "../managed-signer.js";
import { evmNonces, isNonceRejection, type NonceManager } from "../nonce.js";
import { readLifi, readZeroEx } from "../quotes.js";
import { redactError } from "../redact.js";
import { anyOk, firstOk, readTransport, solanaConnection } from "../rpc.js";
import { sellBaseUnits } from "../routing.js";
import { isSolanaAddress } from "../signer.js";
import { JUPITER_PROGRAM_ID, WSOL_MINT } from "../signing-policy.js";

export const NATIVE_ADDRESS = "0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee";
export const NATIVE_SELL = new Set([NATIVE_ADDRESS, "0x0000000000000000000000000000000000000000"]);

export const allowanceSchema = z
  .object({
    issues: z.object({ allowance: z.object({ spender: z.string(), actual: z.string() }).nullish() }).optional(),
  })
  .passthrough();

export const lifiApprovalSchema = z.object({ estimate: z.object({ approvalAddress: z.string().min(1) }) }).passthrough();

export type EvmCall = { from: Hex; to: Hex; data: Hex; value: bigint };

export type EvmReceipt = { status: "success" | "reverted"; gasUsed: bigint; effectiveGasPrice: bigint };

export type EvmRpc = {
  fees(): Promise<{ maxFeePerGas: bigint; maxPriorityFeePerGas: bigint }>;
  pendingNonce(address: Hex): Promise<number>;
  confirmedNonce(address: Hex, depth: number): Promise<number>;
  estimateGas(call: EvmCall): Promise<bigint>;
  simulate(call: EvmCall): Promise<void>;
  sendRaw(signed: Hex): Promise<void>;
  receipt(hash: Hex): Promise<EvmReceipt | null>;
  seen(hash: Hex): Promise<boolean>;
  balance(token: string, owner: Hex): Promise<bigint>;
};

export type SolanaStatus = { err: unknown; confirmationStatus?: string | null } | null;

export type SolanaRpc = {
  simulate(tx: VersionedTransaction): Promise<unknown>;
  sendRaw(signed: Uint8Array): Promise<void>;
  latestBlockhash(): Promise<{ blockhash: string; lastValidBlockHeight: number }>;
  blockHeight(): Promise<number>;
  status(signature: string, searchHistory?: boolean): Promise<SolanaStatus>;
  received(signature: string, owner: string, mint: string): Promise<bigint | null>;
  lamports(owner: string): Promise<bigint>;
  tokenAccount(owner: string, mint: string): Promise<{ source: string; program: string } | null>;
};

export type SendIo = {
  evm(chainId: number, rpcs: readonly string[]): EvmRpc;
  solana(rpcs: readonly string[]): SolanaRpc;
  nonces: NonceManager;
  sleep(ms: number): Promise<void>;
  now(): number;
  confirmTimeoutMs: number;
  pollMs: number;
};

export type SendHooks = { io?: SendIo; onTx?: (tx: TxRecord) => Promise<void> };

export type Confirmed = { records: TxRecord[]; received: bigint | null };
export type Submitted = { record: TxRecord; confirm(): Promise<Confirmed> };
export type PreparedLeg = { impact: number; minOut: bigint; quotedOut: bigint; submit(): Promise<Submitted> };
export type PrepareLeg = (leg: RouteLeg, slippageBps: number, next: RouteLeg | undefined) => Promise<PreparedLeg>;

export type Ctx = {
  config: AppConfig;
  signer: TransactionSigner;
  io: SendIo;
  onTx: (tx: TxRecord) => Promise<void>;
  fetchImpl: typeof fetch;
  secrets: readonly string[];
};

export function evmChain(chainId: number, rpcs: readonly string[]) {
  const spec = chainByEvmId(chainId);
  return defineChain({
    id: chainId,
    name: spec?.key ?? String(chainId),
    nativeCurrency: { name: spec?.nativeSymbol ?? "ETH", symbol: spec?.nativeSymbol ?? "ETH", decimals: 18 },
    rpcUrls: { default: { http: [...rpcs] } },
  });
}

const evmRpcs = new Map<string, EvmRpc>();

export function resetSendClients(): void {
  evmRpcs.clear();
}

export function viemRpc(chainId: number, rpcs: readonly string[]): EvmRpc {
  const key = `${chainId}:${rpcs.join(",")}`;
  const existing = evmRpcs.get(key);
  if (existing) return existing;
  const created = createViemRpc(chainId, rpcs);
  evmRpcs.set(key, created);
  return created;
}

export function createViemRpc(chainId: number, rpcs: readonly string[]): EvmRpc {
  const client = createPublicClient({ chain: evmChain(chainId, rpcs), transport: readTransport(rpcs) });
  return {
    async fees() {
      const fees = await client.estimateFeesPerGas();
      return { maxFeePerGas: fees.maxFeePerGas, maxPriorityFeePerGas: fees.maxPriorityFeePerGas };
    },
    pendingNonce: (address) => client.getTransactionCount({ address, blockTag: "pending" }),
    async confirmedNonce(address, depth) {
      const head = await client.getBlockNumber({ cacheTime: 0 });
      const span = BigInt(depth);
      return client.getTransactionCount({ address, blockNumber: head > span ? head - span : 0n });
    },
    estimateGas: (call) => client.estimateGas({ account: call.from, to: call.to, data: call.data, value: call.value }),
    async simulate(call) {
      if (typeof client.simulateCalls === "function") {
        const simulated = await client.simulateCalls({ account: call.from, calls: [{ to: call.to, data: call.data, value: call.value }] });
        if (simulated.results.some((result) => result.status !== "success")) throw new Error("simulation reverted");
        return;
      }
      await client.call({ account: call.from, to: call.to, data: call.data, value: call.value });
    },
    async sendRaw(signed) {
      await client.sendRawTransaction({ serializedTransaction: signed });
    },
    async receipt(hash) {
      try {
        const receipt = await client.getTransactionReceipt({ hash });
        return { status: receipt.status, gasUsed: receipt.gasUsed, effectiveGasPrice: receipt.effectiveGasPrice };
      } catch (error) {
        if (error instanceof TransactionReceiptNotFoundError) return null;
        throw error;
      }
    },
    async seen(hash) {
      try {
        await client.getTransaction({ hash });
        return true;
      } catch (error) {
        if (error instanceof TransactionNotFoundError) return false;
        throw error;
      }
    },
    balance(token, owner) {
      if (NATIVE_SELL.has(token.toLowerCase())) return client.getBalance({ address: owner });
      return client.readContract({ address: token as Hex, abi: erc20Abi, functionName: "balanceOf", args: [owner] });
    },
  };
}

export type TxMeta = {
  fee: number;
  preBalances: number[];
  postBalances: number[];
  preTokenBalances?: Array<{ mint: string; owner?: string; uiTokenAmount: { amount: string } }> | null;
  postTokenBalances?: Array<{ mint: string; owner?: string; uiTokenAmount: { amount: string } }> | null;
};

export function receivedFromMeta(meta: TxMeta, owner: string, mint: string): bigint {
  const sum = (rows: TxMeta["preTokenBalances"]) =>
    (rows ?? []).filter((row) => row.owner === owner && row.mint === mint).reduce((total, row) => total + BigInt(row.uiTokenAmount.amount), 0n);
  let received = sum(meta.postTokenBalances) - sum(meta.preTokenBalances);
  if (mint === WSOL_MINT) received += BigInt(meta.postBalances[0] ?? 0) - BigInt(meta.preBalances[0] ?? 0) + BigInt(meta.fee);
  return received;
}

export const TOKEN_PROGRAM = new PublicKey("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA");
export const TOKEN_2022_PROGRAM = new PublicKey("TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb");
export const ATA_PROGRAM = new PublicKey("ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL");

type SolanaConnection = Pick<
  Connection,
  "simulateTransaction" | "sendRawTransaction" | "getLatestBlockhash" | "getBlockHeight" | "getSignatureStatuses" | "getTransaction" | "getBalance" | "getParsedTokenAccountsByOwner"
>;

function historyStatus(connections: readonly SolanaConnection[], signature: string): Promise<SolanaStatus> {
  return onAnyRpc(connections, async (connection) => (await connection.getSignatureStatuses([signature], { searchTransactionHistory: true })).value[0] ?? null);
}

export function solanaRpcOver(connections: readonly SolanaConnection[]): SolanaRpc {
  const read = <T>(call: (connection: SolanaConnection) => Promise<T>) => firstOk(connections.map((connection) => () => call(connection)));
  return {
    simulate: (tx) => read(async (connection) => (await connection.simulateTransaction(tx, { sigVerify: false, replaceRecentBlockhash: true })).value.err),
    async sendRaw(signed) {
      await anyOk(connections.map((connection) => async () => void (await connection.sendRawTransaction(signed))));
    },
    latestBlockhash: () => read((connection) => connection.getLatestBlockhash()),
    blockHeight: () => read((connection) => connection.getBlockHeight()),
    status: (signature, searchHistory = false) =>
      searchHistory ? historyStatus(connections, signature) : read(async (connection) => (await connection.getSignatureStatuses([signature])).value[0] ?? null),
    received: (signature, owner, mint) =>
      read(async (connection) => {
        const tx = await connection.getTransaction(signature, { commitment: "confirmed", maxSupportedTransactionVersion: 0 });
        return tx?.meta ? receivedFromMeta(tx.meta, owner, mint) : null;
      }),
    lamports: (owner) => read(async (connection) => BigInt(await connection.getBalance(new PublicKey(owner)))),
    tokenAccount: (owner, mint) =>
      read(async (connection) => {
        for (const program of [TOKEN_PROGRAM, TOKEN_2022_PROGRAM]) {
          const accounts = await connection.getParsedTokenAccountsByOwner(new PublicKey(owner), { mint: new PublicKey(mint), programId: program });
          const source = accounts.value[0]?.pubkey;
          if (source) return { source: source.toBase58(), program: program.toBase58() };
        }
        return null;
      }),
  };
}

export function defaultIo(config: AppConfig): SendIo {
  return {
    evm: viemRpc,
    solana: (rpcs) => solanaRpcOver(rpcs.map(solanaConnection)),
    nonces: evmNonces,
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    now: Date.now,
    confirmTimeoutMs: config.confirmTimeoutMs,
    pollMs: 500,
  };
}

export function digits(value: unknown): bigint | null {
  return typeof value === "string" && /^\d+$/.test(value) ? BigInt(value) : null;
}

export function overCap(impact: number | null, capPct: number): boolean {
  return impact === null || impact > capPct;
}

export function executionSlippageBps(leg: RouteLeg, capBps: number): number {
  return Math.max(0, capBps - Math.ceil((leg.impactPct ?? 0) * 100));
}

export function ourMinOut(leg: RouteLeg, capBps: number): bigint {
  if (leg.priceUsd === null || leg.decimals === null || !(leg.priceUsd > 0) || !(leg.spentUsd > 0)) {
    throw new BroadcastError("no reference price for the minimum output", false);
  }
  const human = (leg.spentUsd / leg.priceUsd) * (1 - Math.min(Math.max(capBps, 0), 10_000) / 10_000);
  const scaled = Math.floor(human * 10 ** leg.decimals);
  if (!Number.isFinite(scaled) || scaled <= 0) throw new BroadcastError("no reference price for the minimum output", false);
  return BigInt(scaled);
}

export function assertMinOut(provider: bigint | null, ours: bigint): bigint {
  if (provider === null) throw new BroadcastError("provider gave no checkable minimum output", false);
  if (provider < ours) throw new BroadcastError("provider minimum output is below ours", false);
  return provider;
}

export function reusableQuote(config: AppConfig, leg: RouteLeg, taker: string): RaceQuote | null {
  const quote = leg.quote;
  if (!quote || quote.sellAmount !== leg.sellAmount) return null;
  if ((config.now?.() ?? Date.now()) - quote.quotedAtMs >= config.quoteTtlMs) return null;
  if ((quote.provider === "zeroex" || quote.provider === "lifi") && quote.taker?.toLowerCase() !== taker.toLowerCase()) return null;
  return quote;
}

export async function reuseOrFirm<T>(reuse: RaceQuote | null, build: (reuse: RaceQuote | null) => Promise<T>): Promise<T> {
  if (!reuse) return build(null);
  try {
    return await build(reuse);
  } catch (error) {
    if (!(error instanceof BroadcastError) || error.broadcast) throw error;
    return build(null);
  }
}

export function referenceFor(leg: RouteLeg): { spentUsd: number; priceUsd: number; decimals: number } | null {
  if (leg.priceUsd === null || leg.decimals === null) return null;
  return { spentUsd: leg.spentUsd, priceUsd: leg.priceUsd, decimals: leg.decimals };
}

export function asHex(value: string): Hex {
  if (!/^0x[0-9a-fA-F]*$/.test(value)) throw new BroadcastError("firm quote has no transaction", false);
  return value as Hex;
}

export function approvalSpender(provider: string, raw: unknown, to: string): string {
  if (provider !== "lifi") return to;
  const parsed = lifiApprovalSchema.safeParse(raw);
  return parsed.success ? parsed.data.estimate.approvalAddress : to;
}

export function rememberIfFunded(provider: string, raw: unknown, chainId: number, token: string, owner: string, needed: bigint, to: string): void {
  if (NATIVE_SELL.has(token.toLowerCase())) return;
  const spender = approvalSpender(provider, raw, to);
  const key = { chainId, token, spender, owner };
  if (provider === "zeroex") {
    const parsed = allowanceSchema.safeParse(raw);
    const issues = parsed.success ? parsed.data.issues : undefined;
    const allowance = issues?.allowance;
    if (issues && allowance === null) {
      if (!allowanceCovers(key, needed)) rememberApproval(key, needed);
      return;
    }
    if (allowance?.spender && /^\d+$/.test(allowance.actual)) {
      const actual = BigInt(allowance.actual);
      const reported = { ...key, spender: allowance.spender };
      if (actual >= needed) {
        rememberApproval(reported, actual);
        return;
      }
      if (allowanceCovers(reported, needed)) return;
    }
  }
  if (allowanceCovers(key, needed)) return;
  throw new BroadcastError("approval is not cached", false);
}

export async function journal(ctx: Ctx, record: TxRecord): Promise<void> {
  try {
    await ctx.onTx(record);
  } catch (error) {
    throw new BroadcastError(`tx journal failed: ${redactError(error, ctx.secrets)}`, false);
  }
}

export async function runLegs(prepare: PrepareLeg, legs: readonly RouteLeg[], capBps: number, ctx: Ctx): Promise<SendResult> {
  const txs: TxRecord[] = [];
  let sellAmount = legs[0]?.sellAmount ?? "0";
  for (const [index, base] of legs.entries()) {
    const leg = { ...base, sellAmount };
    const held = index > 0 ? { token: leg.sellAddress, amount: sellAmount } : null;
    let prepared: PreparedLeg;
    let sent: Submitted;
    try {
      prepared = await prepare(leg, executionSlippageBps(leg, capBps), legs[index + 1]);
      sent = await prepared.submit();
    } catch (error) {
      const broadcast = error instanceof BroadcastError && error.broadcast;
      const message = error instanceof BroadcastError ? error.message : redactError(error, ctx.secrets);
      if (held && !broadcast) return { venue: "chain", outcome: "landed", txs, held, shortfall: false, note: message };
      throw new BroadcastError(message, broadcast || txs.length > 0);
    }
    let confirmed: Confirmed;
    try {
      confirmed = await sent.confirm();
    } catch (error) {
      throw new BroadcastError(redactError(error, ctx.secrets), true);
    }
    const last = index === legs.length - 1;
    const records = [...confirmed.records];
    const winner = records[records.length - 1] ?? { ...sent.record, outcome: "pending" as const };
    const shortfall = last && winner.outcome === "landed" && confirmed.received !== null && confirmed.received < prepared.minOut;
    if (shortfall) records[records.length - 1] = { ...winner, note: `received ${confirmed.received} below minimum ${prepared.minOut}` };
    for (const record of records) await ctx.onTx(record).catch(() => undefined);
    txs.push(...records);
    if (winner.outcome !== "landed") return { venue: "chain", outcome: winner.outcome, txs, held, shortfall: false };
    if (last) return { venue: "chain", outcome: "landed", txs, held: null, shortfall };
    if (confirmed.received === null || confirmed.received <= 0n) {
      return { venue: "chain", outcome: "landed", txs, held: { token: leg.buyAddress, amount: "unknown" }, shortfall: false, note: "intermediate balance was not read" };
    }
    sellAmount = (confirmed.received < prepared.quotedOut ? confirmed.received : prepared.quotedOut).toString();
  }
  throw new BroadcastError("route has no signable leg", false);
}


export type EvmCtx = Ctx & { chainId: number; chainKey: string; owner: Hex; read: EvmRpc; reads: EvmRpc[]; senders: EvmRpc[]; privateSend: boolean };
export type EvmTx = { to: Hex; data: Hex; value: bigint; gas: bigint | null; purpose: EvmSignInput["purpose"]; nativeSell?: boolean };

// A lookup that must prove absence asks every RPC: one lagging node must not hide a transaction another has.
export async function onAnyRpc<R, T>(rpcs: readonly R[], read: (rpc: R) => Promise<T | null>): Promise<T | null> {
  const settled = await Promise.allSettled(rpcs.map(read));
  const found = settled.find((result) => result.status === "fulfilled" && result.value !== null);
  if (found?.status === "fulfilled") return found.value;
  const failed = settled.find((result) => result.status === "rejected");
  if (failed?.status === "rejected") throw failed.reason;
  return null;
}

export function evmContext(ctx: Ctx, chainKey: string, rpcs: readonly string[]): EvmCtx {
  const spec = chainByKey(chainKey);
  if (!spec || spec.chain.kind !== "evm") throw new BroadcastError("evm chain missing", false);
  const owner = ctx.signer.evmAddress();
  if (!owner) throw new BroadcastError("evm signer is not loaded", false);
  const chainId = spec.chain.chainId;
  const mev = ctx.config.mevRpcByChainId[chainId];
  const reads = rpcs.map((rpc) => ctx.io.evm(chainId, [rpc]));
  return { ...ctx, chainId, chainKey, owner: owner as Hex, read: ctx.io.evm(chainId, rpcs), reads, senders: mev ? [ctx.io.evm(chainId, [mev])] : reads, privateSend: Boolean(mev) };
}

export function solanaContext(ctx: Ctx, rpcs: readonly string[]): SolanaCtx {
  const owner = ctx.signer.solanaAddress();
  if (!owner) throw new BroadcastError("solana signer is not loaded", false);
  return { ...ctx, rpc: ctx.io.solana(rpcs), owner };
}

export function rpcsFor(config: AppConfig, chainKey: string): readonly string[] {
  return config.rpcUrlsByChainKey[chainKey] ?? [];
}
export type SolanaCtx = Ctx & { rpc: SolanaRpc; owner: string };
