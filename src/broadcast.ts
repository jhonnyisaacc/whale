import type { AppConfig } from "./config.js";
import type { SendRequest } from "./executor.js";
import { BroadcastError } from "./executor.js";
import type { TransactionSigner } from "./managed-signer.js";
import type { Fill, SendResult, TxOutcome, TxRecord } from "./domain.js";
import { chainByEvmId, chainByKey, reorgDepth } from "./chains.js";
import type { Hex } from "viem";
import { landedStatus } from "./broadcast/solana.js";
import { nextHyperliquidNonce, readExchangeResponse } from "./hyperliquid.js";
import { redactError } from "./redact.js";
import type { AgedTx } from "./spend.js";
import { defaultIo, evmContext, journal, onAnyRpc, rpcsFor, runLegs, solanaContext, type Ctx, type PreparedLeg, type SendHooks, type SendIo } from "./broadcast/shared.js";
import { prepareEvmLeg } from "./broadcast/evm.js";
import { prepareSolanaLeg } from "./broadcast/solana.js";
import { readVendorText, vendorResponse } from "./vendor-fetch.js";
export * from "./broadcast/shared.js";
export * from "./broadcast/evm.js";
export * from "./broadcast/solana.js";
export * from "./broadcast/transfers.js";

async function sendHypercore(ctx: Ctx, request: SendRequest): Promise<SendResult> {
  const { config, signer, fetchImpl, secrets } = ctx;
  if (request.hyperliquidActions.length === 0) throw new BroadcastError("hyperliquid action missing", false);
  const txs: TxRecord[] = [];
  let fill: Fill | null = null;
  let note: string | undefined;
  for (const action of request.hyperliquidActions) {
    const order = action.type === "order";
    const nonce = nextHyperliquidNonce();
    let signature;
    try {
      signature = await signer.signHyperliquid(action, nonce, !config.hyperliquidUrl.includes("testnet"));
    } catch (error) {
      throw new BroadcastError(redactError(error, secrets), false);
    }
    const record: TxRecord = { chainKey: "hypercore", txHash: `hl:${nonce}`, from: config.hyperliquidAccount ?? "", to: action.type, value: "0", outcome: "pending" };
    await journal(ctx, record);
    let body: unknown;
    try {
      const response = await vendorResponse(
        fetchImpl,
        `${config.hyperliquidUrl.replace(/\/$/, "")}/exchange`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ action, nonce, signature, vaultAddress: null }),
        },
        false,
      );
      if (!response.ok) throw new Error(`hyperliquid exchange returned ${response.status}`);
      body = JSON.parse(await readVendorText(response)) as unknown;
    } catch (error) {
      throw new BroadcastError(redactError(error, secrets), order);
    }
    const parsed = readExchangeResponse(body);
    if (parsed.status === "err") {
      await ctx.onTx({ ...record, outcome: "reverted", note: parsed.error }).catch(() => undefined);
      throw new BroadcastError(`hyperliquid rejected the action: ${parsed.error}`, false);
    }
    if (!order) {
      txs.push({ ...record, outcome: "landed" });
      continue;
    }
    if (parsed.statuses.some((status) => status.resting !== undefined)) {
      await ctx.onTx({ ...record, note: "ioc order is resting" }).catch(() => undefined);
      throw new BroadcastError("hyperliquid ioc order is resting", true);
    }
    const filled = parsed.statuses.find((status) => status.filled)?.filled;
    if (filled && Number(filled.totalSz) > 0) {
      fill = filled;
      txs.push({ ...record, outcome: "landed", note: `filled ${filled.totalSz} at ${filled.avgPx}` });
    } else {
      note = parsed.statuses.find((status) => status.error)?.error ?? "order not filled";
      txs.push({ ...record, outcome: "reverted", note });
    }
  }
  for (const record of txs) await ctx.onTx(record).catch(() => undefined);
  return { venue: "hypercore", txs, fill, note };
}


export async function broadcastRoute(
  config: AppConfig,
  signer: TransactionSigner | null,
  request: SendRequest,
  capPct: number,
  fetchImpl: typeof fetch = fetch,
  secrets: readonly string[] = [],
  hooks: SendHooks = {},
): Promise<SendResult> {
  if (!signer) throw new BroadcastError("signer is not loaded", false);
  const ctx: Ctx = { config, signer, io: hooks.io ?? defaultIo(config), onTx: hooks.onTx ?? (async () => undefined), fetchImpl, secrets };
  if (request.kind === "hypercore") return sendHypercore(ctx, request);
  if (request.legs.length === 0) throw new BroadcastError("route has no signable leg", false);
  const capBps = Math.round(capPct * 100);
  if (request.kind === "solana") {
    const rpcs = rpcsFor(config, "solana");
    if (rpcs.length === 0) throw new BroadcastError("solana rpc is not configured", false);
    const solana = solanaContext(ctx, rpcs);
    return runLegs((leg, slippageBps) => prepareSolanaLeg(solana, leg, slippageBps, capBps), request.legs, capBps, ctx);
  }
  if (request.chain.kind !== "evm") throw new BroadcastError("evm chain missing", false);
  const spec = chainByEvmId(request.chain.chainId);
  const rpcs = spec ? rpcsFor(config, spec.key) : [];
  if (!spec || rpcs.length === 0) throw new BroadcastError("evm rpc is not configured", false);
  if (spec.liveSend === "disabled") throw new BroadcastError(spec.gap ?? "live send disabled", false);
  const evm = evmContext(ctx, spec.key, rpcs);
  return runLegs((leg, slippageBps, next) => prepareEvmLeg(evm, leg, slippageBps, next, capBps, request.provider), request.legs, capBps, ctx);
}

// An EVM hash with no receipt on any RPC is dead once the account's nonce, read REORG_DEPTH blocks below
// the head, has passed its nonce: another transaction consumed it, so this one can never be included.
// Without a recorded nonce it stays pending.
export async function lookupAgedTx(config: AppConfig, tx: AgedTx, io: SendIo = defaultIo(config)): Promise<TxOutcome | null> {
  const spec = chainByKey(tx.chainKey);
  const rpcs = rpcsFor(config, tx.chainKey);
  if (!spec || rpcs.length === 0) return null;
  if (spec.chain.kind === "evm") {
    const chainId = spec.chain.chainId;
    const depth = reorgDepth(chainId, config.reorgDepthByChainId);
    const mined = tx.from && tx.nonce !== null ? await io.evm(chainId, rpcs).confirmedNonce(tx.from as Hex, depth) : null;
    const receipt = await onAnyRpc(
      rpcs.map((rpc) => io.evm(chainId, [rpc])),
      (rpc) => rpc.receipt(tx.txHash as Hex),
    );
    if (receipt) return receipt.status === "success" ? "landed" : "reverted";
    return mined !== null && tx.nonce !== null && mined > tx.nonce ? "expired" : "pending";
  }
  if (spec.chain.kind === "solana") {
    const status = await io.solana(rpcs).status(tx.txHash, true);
    if (status === null) return "expired";
    return landedStatus(status) ?? "pending";
  }
  return null;
}
