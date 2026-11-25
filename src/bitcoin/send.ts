import { z } from "zod";
import type { WalletCommand } from "../commands.js";
import type { AppConfig, BitcoinConfig } from "../config.js";
import type { SignerQueue } from "../signer-queue.js";
import { assertBitcoinSigning, type BitcoinSpend } from "../signing-policy/bitcoin.js";
import type { SpendJournal } from "../spend.js";
import { SignerRefusal, type KeystorePublic, type SignerJobRecord } from "../whale-signer.js";
import { BroadcastRefused, esploraIndexer, transactionId, type BitcoinIndexer } from "./esplora.js";
import { selectCoins, unsignedTransaction } from "./plan.js";
import { btcUsd, satsUsd } from "./read.js";
import { verifiedBitcoinTransaction } from "./verify.js";
import { BITCOIN_KEY, bitcoinWallet, destinationScript, sameScript, type BitcoinWallet } from "./wallet.js";

export type SendBitcoin = Extract<WalletCommand, { kind: "send_bitcoin" }>;
export type BitcoinPlanView = { inputs: number; feeSats: string; feeRate: number; spentSats: string; usd: number };
export type BitcoinSendResult = {
  kind: "send_bitcoin";
  status: "planned" | "signed" | "sent" | "skipped";
  reason: string;
  jobs: SignerJobRecord[];
  plan?: BitcoinPlanView;
  txid?: string;
  signedTransaction?: string;
};
export type BitcoinPolicy = typeof assertBitcoinSigning;
export type BitcoinOverrides = { readonly bitcoinIndexer?: BitcoinIndexer; readonly bitcoinPolicy?: BitcoinPolicy };

export type BitcoinSendDeps = {
  readonly bitcoin: BitcoinConfig;
  readonly caps: { readonly maxUsdPerTrade: number; readonly dailyUsdCap: number };
  readonly wallet: BitcoinWallet;
  readonly indexer: BitcoinIndexer;
  readonly queue: SignerQueue;
  readonly spend: SpendJournal;
  readonly btcUsd: () => Promise<number | null>;
  readonly hold: boolean;
  readonly policy: BitcoinPolicy;
};

export const HELD = "signed by whale-signer and not sent, because WHALE_BROADCAST is off";

const signedAnswer = z.object({ signedTransaction: z.string().max(400_000) });
const hex = (bytes: Uint8Array) => Buffer.from(bytes).toString("hex");

function skipped(reason: string, plan?: BitcoinPlanView): BitcoinSendResult {
  return { kind: "send_bitcoin", status: "skipped", reason, jobs: [], ...(plan ? { plan } : {}) };
}

async function signBitcoin(deps: BitcoinSendDeps, unsigned: Uint8Array, previous: readonly Uint8Array[], spent: BitcoinSpend, jobs: SignerJobRecord[]): Promise<Uint8Array> {
  const { id, answer } = await deps.queue.submit({ kind: "bitcoin", payload: { transaction: hex(unsigned), previous: previous.map(hex) } });
  if (answer.decision === "refused") {
    jobs.push({ id, kind: "bitcoin", decision: "refused", reasons: answer.reasons });
    throw new SignerRefusal(id, answer.reasons);
  }
  const parsed = signedAnswer.safeParse(answer.result);
  if (!parsed.success) throw new Error(`whale-signer answered job ${id} without a signed transaction`);
  const signed = verifiedBitcoinTransaction(parsed.data.signedTransaction, unsigned, spent.prevouts, deps.wallet);
  jobs.push({ id, kind: "bitcoin", decision: "signed", hash: transactionId(signed) });
  return signed;
}

async function signAndRecord(deps: BitcoinSendDeps, command: SendBitcoin, unsigned: Uint8Array, previous: readonly Uint8Array[], spent: BitcoinSpend, jobs: SignerJobRecord[]) {
  const signed = await signBitcoin(deps, unsigned, previous, spent, jobs);
  const txid = transactionId(signed);
  await deps.spend.record(command.idempotencyKey, { chainKey: BITCOIN_KEY, txHash: txid, from: deps.wallet.address, to: command.to, value: command.sats, outcome: "signed" });
  return { signed, txid };
}

async function sendOnce(deps: BitcoinSendDeps, command: SendBitcoin): Promise<BitcoinSendResult> {
  const { bitcoin, wallet, indexer } = deps;
  if (!/^[1-9]\d{0,15}$/.test(command.sats)) return skipped("sats is a positive integer number of satoshis");
  const to = destinationScript(command.to, bitcoin.network);
  if (!to) return skipped(`${command.to} is not a ${bitcoin.network} bitcoin address`);
  if (!bitcoin.destinations.some((script) => sameScript(script, to))) return skipped("destination is not in BITCOIN_WITHDRAW_ADDRESSES");
  const feeRate = await indexer.feeRate();
  if (feeRate > bitcoin.maxFeeRate) return skipped(`the fee market is at ${feeRate} sat/vB, above BITCOIN_MAX_FEE_RATE ${bitcoin.maxFeeRate}`);
  const selection = selectCoins(await indexer.utxos(wallet.address), to, BigInt(command.sats), wallet.script, feeRate, bitcoin);
  if (selection.kind === "refused") return skipped(selection.reason);
  const unsigned = unsignedTransaction(selection.plan, wallet.script);
  const previous = await Promise.all(selection.plan.inputs.map((input) => indexer.transaction(input.txid)));
  const spent = deps.policy(unsigned, previous, { own: wallet.script, destinations: bitcoin.destinations, maxFeeSats: bitcoin.maxFeeSats, maxInputs: bitcoin.maxInputs, network: bitcoin.network });
  const unit = await deps.btcUsd();
  if (unit === null) return skipped("no USD price for BTC, so the caps cannot be checked");
  const plan = { inputs: selection.plan.inputs.length, feeSats: String(spent.feeSats), feeRate, spentSats: String(spent.spentSats), usd: satsUsd(spent.spentSats, unit) };
  if (!(plan.usd <= deps.caps.maxUsdPerTrade)) return skipped(`notional exceeds ${deps.caps.maxUsdPerTrade} USD`, plan);
  if (command.mode === "dry_run") return { kind: "send_bitcoin", status: "planned", reason: "dry-run: nothing was signed", jobs: [], plan };
  const reserved = await deps.spend.reserve(command.idempotencyKey, plan.usd);
  if (reserved === "cap") return skipped(`daily cap ${deps.caps.dailyUsdCap} USD`, plan);
  if (reserved === "exists") return skipped("duplicate spend", plan);
  const release = () => deps.spend.release(command.idempotencyKey).catch(() => undefined);
  const jobs: SignerJobRecord[] = [];
  const { signed, txid } = await signAndRecord(deps, command, unsigned, previous, spent, jobs).catch(async (error: unknown) => {
    await release();
    throw error;
  });
  if (deps.hold) {
    await deps.spend.commit(command.idempotencyKey).catch(() => undefined);
    return { kind: "send_bitcoin", status: "signed", reason: HELD, jobs, plan, txid, signedTransaction: hex(signed) };
  }
  await indexer.simulate(signed).catch(async (error: unknown) => {
    await release();
    throw error;
  });
  await indexer.broadcast(signed).catch(async (error: unknown) => {
    if (error instanceof BroadcastRefused) await release();
    else await deps.spend.commit(command.idempotencyKey).catch(() => undefined);
    throw error;
  });
  await deps.spend.commit(command.idempotencyKey).catch(() => undefined);
  return { kind: "send_bitcoin", status: "sent", reason: `broadcast ${txid}`, jobs, plan, txid };
}

export function bitcoinSender(deps: BitcoinSendDeps): (command: SendBitcoin) => Promise<BitcoinSendResult> {
  let tail: Promise<unknown> = Promise.resolve();
  return (command) => {
    const result = tail.then(() => sendOnce(deps, command));
    tail = result.catch(() => undefined);
    return result;
  };
}

export function configuredBitcoinSender(config: AppConfig, keystore: KeystorePublic, queue: SignerQueue, spend: SpendJournal, overrides: BitcoinOverrides = {}): (command: SendBitcoin) => Promise<BitcoinSendResult> {
  const bitcoin = config.bitcoin;
  if (!bitcoin) return async () => skipped("BITCOIN_NETWORK is unset, so Bitcoin is off");
  if (!keystore.bitcoinPublicKey) return async () => skipped("the whale-signer keystore has no bitcoinPublicKey");
  return bitcoinSender({
    bitcoin,
    caps: config,
    wallet: bitcoinWallet(keystore.bitcoinPublicKey, keystore.evmAddress, bitcoin.network),
    indexer: overrides.bitcoinIndexer ?? esploraIndexer(bitcoin.esploraUrl),
    queue,
    spend,
    btcUsd: () => btcUsd(config),
    hold: !config.live,
    policy: overrides.bitcoinPolicy ?? assertBitcoinSigning,
  });
}
