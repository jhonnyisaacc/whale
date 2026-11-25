import { createPublicClient, encodeFunctionData, erc20Abi, keccak256, type Hex } from "viem";
import { BRIDGE_ROUTE_REGISTRY, type BridgeCall } from "../aggregators/bridge.js";
import { sendersOnChain, submitEvm } from "../broadcast/evm.js";
import { evmChain, type EvmCall, type EvmCtx } from "../broadcast/shared.js";
import { addressKey, chainByKey } from "../chains.js";
import type { ChainRef, TxRecord } from "../domain.js";
import { BroadcastError } from "../executor.js";
import type { EvmSignInput } from "../managed-signer.js";
import type { BridgeProvider, BridgeRoute } from "../rebalance.js";
import { redactError } from "../redact.js";
import { readTransport } from "../rpc.js";
import { guardRpc } from "../rpc-reason.js";
import { BRIDGE_CONTRACTS, LIFI_SWAP_AND_START_SELECTOR, bridgeTerms, openAcrossDeposit, type ExecutableBridge } from "../signing-policy/bridge-terms.js";
import { bridgePair, meetsBridgeFloor } from "../signing-policy/bridge-tokens.js";
import { trackBridge, type BridgeLookup, type BridgeStatus } from "./status.js";

export type BridgeReads = {
  allowance(token: Hex, owner: Hex, spender: Hex): Promise<bigint>;
  simulate(from: Hex, calls: readonly EvmCall[]): Promise<bigint[]>;
};

export type BridgeSpend = {
  reserve(key: string, usd: number): Promise<"reserved" | "exists" | "cap">;
  release(key: string): Promise<void>;
  commit(key: string): Promise<void>;
};

export type BridgeDeps = {
  evm: EvmCtx;
  reads: BridgeReads;
  firm(provider: ExecutableBridge, route: BridgeRoute): Promise<BridgeCall | null>;
  screen(token: { chainKey: string; chain: ChainRef; contract: string }): Promise<"allow" | "deny">;
  spend: BridgeSpend;
  status(lookup: BridgeLookup): Promise<BridgeStatus>;
  broadcast: boolean;
  trackTimeoutMs: number;
};

export type BridgeOrder = { idempotencyKey: string; route: BridgeRoute; provider: BridgeProvider };

export type SignedBridgeTx = { purpose: "approve" | "bridge"; hash: Hex; nonce: number };

export type BridgeExecution =
  | { status: "skipped"; reason: string }
  | { status: "signed"; provider: ExecutableBridge; reason: string; txs: SignedBridgeTx[] }
  | { status: "sent"; provider: ExecutableBridge; reason: string; txs: TxRecord[]; transfer: BridgeStatus | null };

export const LIFI_SWAP_AND_START =
  "LI.FI quoted swapAndStartBridgeTokensViaAcrossV4, which swaps before it bridges. Its swap step can pay any address, so the signing policy refuses it. Whale bridges a token only to the same token, through startBridgeTokensViaAcrossV4 or Across";

export const RELAY_QUOTE_ONLY =
  "Relay is quote-only. Its deposit is depositErc20(depositor, token, amount, id), and the destination chain and recipient live off chain under a server-assigned id, so the signing policy cannot bind them";

const HELD = "signed and not sent, because WHALE_BROADCAST is off";

type Planned = { provider: ExecutableBridge; call: BridgeCall; spender: Hex; sell: Hex; charge: { token: string; amount: bigint }; approve: boolean };

const same = (left: string, right: string) => left.toLowerCase() === right.toLowerCase();

function executable(provider: BridgeProvider): ExecutableBridge | string {
  if (provider === "lifi" || provider === "across") return provider;
  if (provider === "relay") return RELAY_QUOTE_ONLY;
  const entry = BRIDGE_ROUTE_REGISTRY[provider];
  return entry.calls ? `${provider} has no executable bridge call` : entry.reason;
}

async function plan(deps: BridgeDeps, order: BridgeOrder): Promise<Planned | string> {
  const { route } = order;
  const provider = executable(order.provider);
  if (provider !== "lifi" && provider !== "across") return provider;
  const source = chainByKey(route.source.chainKey);
  const destination = chainByKey(route.destination.chainKey);
  if (source?.chain.kind !== "evm" || destination?.chain.kind !== "evm") return "bridge execution moves between EVM chains only";
  if (source.chain.chainId !== deps.evm.chainId || !same(route.source.address, deps.evm.owner)) return "the route's source is not this signer's wallet";
  for (const [chainKey, chain, contract] of [[source.key, source.chain, route.sell.address], [destination.key, destination.chain, route.buy.address]] as const) {
    if ((await deps.screen({ chainKey, chain, contract })) !== "allow") return `screening denied ${contract} on ${chainKey}`;
  }
  const quoted = await deps.firm(provider, route);
  if (!quoted) return `${provider} returned no bridge transaction`;
  const call = provider === "across" ? { ...quoted, data: openAcrossDeposit(quoted.data) ?? quoted.data } : quoted;
  const contract = BRIDGE_CONTRACTS[source.chain.chainId]?.[provider];
  if (!contract || !same(call.to, contract)) return `${provider} sent the bridge to ${call.to}, not its verified contract on ${source.key}`;
  if (call.value !== 0n) return `${provider} attached native value to a token bridge`;
  if (provider === "lifi" && call.data.slice(0, 10).toLowerCase() === LIFI_SWAP_AND_START_SELECTOR) return LIFI_SWAP_AND_START;
  const terms = bridgeTerms(call.data);
  if (!terms || terms.provider !== provider) return `${provider} calldata does not decode as a bridge the policy reads`;
  if (!same(terms.charge.token, route.sell.address) || terms.charge.amount !== BigInt(route.amount)) return `${provider} calldata pulls ${terms.charge.amount} of ${terms.charge.token}, not the route's amount`;
  if (terms.destinationChainId !== BigInt(destination.chain.chainId)) return `${provider} calldata lands on chain ${terms.destinationChainId}, not ${destination.key}`;
  if (addressKey(destination.key, terms.recipient) !== addressKey(destination.key, route.destination.address)) return `${provider} calldata pays ${terms.recipient}, not the route's destination`;
  if (!same(terms.outputToken, route.buy.address)) return `${provider} calldata delivers ${terms.outputToken}, not ${route.buy.symbol}`;
  const pair = bridgePair(source.chain.chainId, terms.inputToken, destination.chain.chainId, terms.outputToken);
  if (!pair) return `${provider} bridges ${route.sell.symbol} to ${route.buy.symbol}, a pair the bridge token table does not list`;
  const { maxBridgeFeeBps } = deps.evm.config;
  if (!meetsBridgeFloor(pair, terms.charge.amount, terms.minOutput, maxBridgeFeeBps)) return `${provider} minimum output is under the ${maxBridgeFeeBps} bps bridge fee cap`;
  const approve = (await deps.reads.allowance(route.sell.address as Hex, deps.evm.owner, call.to)) < terms.charge.amount;
  if (approve && !deps.evm.config.allowHotApproval) return `${call.to} has no ${route.sell.symbol} allowance and ALLOW_HOT_APPROVAL is off. Approve the exact amount in the root-quorum ceremony first`;
  return { provider, call, spender: call.to, sell: route.sell.address as Hex, charge: terms.charge, approve };
}

function approveCall(planned: Planned): Hex {
  return encodeFunctionData({ abi: erc20Abi, functionName: "approve", args: [planned.spender, planned.charge.amount] });
}

async function signHeld(deps: BridgeDeps, planned: Planned): Promise<SignedBridgeTx[]> {
  const { evm } = deps;
  const owner = evm.owner;
  const bridge = { to: planned.call.to, data: planned.call.data, value: 0n };
  const calls: (EvmCall & { purpose: "approve" | "bridge" })[] = planned.approve
    ? [{ from: owner, to: planned.sell, data: approveCall(planned), value: 0n, purpose: "approve" }, { from: owner, ...bridge, purpose: "bridge" }]
    : [{ from: owner, ...bridge, purpose: "bridge" }];
  await sendersOnChain(evm);
  let used: bigint[];
  try {
    used = await deps.reads.simulate(owner, calls);
  } catch (error) {
    throw new BroadcastError(`simulation rejected the bridge: ${redactError(error, evm.secrets)}`, false);
  }
  const [fees, first] = await Promise.all([evm.read.fees(), evm.read.pendingNonce(owner)]);
  const signed: SignedBridgeTx[] = [];
  for (const [index, call] of calls.entries()) {
    const estimate = ((used[index] ?? 0n) * 13n) / 10n;
    const gas = call.purpose === "bridge" && planned.call.gas !== null && planned.call.gas > estimate ? planned.call.gas : estimate;
    const input: EvmSignInput = { chainId: evm.chainId, to: call.to, data: call.data, value: 0n, gas, nonce: first + index, ...fees, purpose: call.purpose };
    const raw = await evm.signer.signEvm(call.purpose === "approve" ? { ...input, approval: planned.charge } : { ...input, charge: planned.charge });
    signed.push({ purpose: call.purpose, hash: keccak256(raw), nonce: input.nonce });
  }
  return signed;
}

async function landed(submitted: Awaited<ReturnType<typeof submitEvm>>): Promise<TxRecord[]> {
  const { records } = await submitted.confirm();
  if (!records.some((record) => record.outcome === "landed")) throw new BroadcastError(`transaction ${submitted.record.txHash} did not land`, records.some((record) => record.outcome === "pending"));
  return records;
}

async function sendLive(deps: BridgeDeps, planned: Planned): Promise<{ txs: TxRecord[]; transfer: BridgeStatus }> {
  const { evm } = deps;
  const txs: TxRecord[] = [];
  if (planned.approve) {
    txs.push(...(await landed(await submitEvm(evm, { to: planned.sell, data: approveCall(planned), value: 0n, gas: null, purpose: "approve", approval: planned.charge }, null))));
  }
  const bridge = await submitEvm(evm, { to: planned.call.to, data: planned.call.data, value: 0n, gas: planned.call.gas, purpose: "bridge", charge: planned.charge }, null);
  txs.push(...(await landed(bridge)));
  const lookup = { provider: planned.provider, fromChainId: evm.chainId, txHash: bridge.record.txHash };
  return { txs, transfer: await trackBridge(lookup, deps.status, evm.io, evm.io.now() + deps.trackTimeoutMs) };
}

export async function executeBridge(deps: BridgeDeps, order: BridgeOrder): Promise<BridgeExecution> {
  const planned = await plan(deps, order);
  if (typeof planned === "string") return { status: "skipped", reason: planned };
  const key = `bridge:${order.idempotencyKey}`;
  const reserved = await deps.spend.reserve(key, order.route.amountInUsd);
  if (reserved !== "reserved") return { status: "skipped", reason: reserved === "cap" ? "bridge daily cap" : "duplicate bridge" };
  try {
    if (!deps.broadcast) {
      const txs = await signHeld(deps, planned);
      await deps.spend.release(key);
      return { status: "signed", provider: planned.provider, reason: HELD, txs };
    }
    const { txs, transfer } = await sendLive(deps, planned);
    const committed = await deps.spend.commit(key).then(
      () => "",
      (error: unknown) => `, and its spend stays reserved because the commit failed: ${redactError(error, deps.evm.secrets)}`,
    );
    return { status: "sent", provider: planned.provider, reason: `bridge ${transfer.state}${committed}`, txs, transfer };
  } catch (error) {
    const maybeSent = error instanceof BroadcastError && error.broadcast;
    if (!maybeSent) await deps.spend.release(key).catch(() => undefined);
    return { status: "skipped", reason: redactError(error, deps.evm.secrets) };
  }
}

export function viemBridgeReads(chainId: number, rpcs: readonly string[]): BridgeReads {
  const client = createPublicClient({ chain: evmChain(chainId, rpcs), transport: readTransport(chainId, rpcs) });
  return guardRpc<BridgeReads>({
    allowance: (token, owner, spender) => client.readContract({ address: token, abi: erc20Abi, functionName: "allowance", args: [owner, spender] }),
    async simulate(from, calls) {
      const { results } = await client.simulateCalls({ account: from, calls: calls.map(({ to, data, value }) => ({ to, data, value })) });
      if (results.some((result) => result.status !== "success")) throw new Error("a simulated call reverted");
      return results.map((result) => result.gasUsed);
    },
  });
}
