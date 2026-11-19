import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { decodeEventLog, decodeFunctionData, encodeAbiParameters, encodeFunctionData, erc20Abi, parseAbi, keccak256, maxUint256, pad, parseTransaction, recoverTransactionAddress, toHex } from "viem";
import { firmBridgeCall } from "../dist/src/aggregators/bridge.js";
import { executeBridge } from "../dist/src/bridge/execute.js";
import { bridgeSpend } from "../dist/src/bridge/spend.js";
import { bridgeStatus } from "../dist/src/bridge/status.js";
import { defaultIo, evmContext } from "../dist/src/broadcast/shared.js";
import { loadConfig } from "../dist/src/config.js";
import { withPolicy } from "../dist/src/managed-signer.js";
import { screenToken } from "../dist/src/screening.js";
import { BRIDGE_CONTRACTS, DEFAULT_MAX_VALUE_WEI, bridgeTerms } from "../dist/src/signing-policy.js";

const RPC = process.env.RPC_URL_8453 ?? "https://mainnet.base.org";
const BASE = 8453;
const ARBITRUM = 42161;
const USDC = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";
const ARBITRUM_USDC = "0xaf88d065e77c8cC2239327C5EDb3A432268e5831";
const AMOUNT = 2_000_000n;
const USDC_BALANCES_SLOT = 9n;
const USDC_ALLOWANCES_SLOT = 10n;
const root = new URL("..", import.meta.url).pathname;
const signerBin = path.join(root, "signer/target/release/whale-signer");
const passphrase = { ...process.env, WHALE_SIGNER_PASSPHRASE: "proof-only-passphrase" };

async function rpc(method, params) {
  const response = await fetch(RPC, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }) });
  const body = await response.json();
  if (body.error) throw new Error(`${method}: ${body.error.message}`);
  return body.result;
}

const slot = (owner, index) => keccak256(encodeAbiParameters([{ type: "address" }, { type: "uint256" }], [owner, index]));
const nestedSlot = (owner, spender, index) => keccak256(encodeAbiParameters([{ type: "address" }, { type: "bytes32" }], [spender, slot(owner, index)]));
const funded = (owner, spender) => ({
  [owner]: { balance: toHex(10n ** 17n) },
  [USDC]: { stateDiff: { [slot(owner, USDC_BALANCES_SLOT)]: pad(toHex(AMOUNT)), ...(spender ? { [nestedSlot(owner, spender, USDC_ALLOWANCES_SLOT)]: pad(toHex(maxUint256)) } : {}) } },
});

const FUNDS_DEPOSITED = parseAbi([
  "event FundsDeposited(bytes32 inputToken, bytes32 outputToken, uint256 inputAmount, uint256 outputAmount, uint256 indexed destinationChainId, uint256 indexed depositId, uint32 quoteTimestamp, uint32 fillDeadline, uint32 exclusivityDeadline, bytes32 indexed depositor, bytes32 recipient, bytes32 exclusiveRelayer, bytes message)",
]);

function spokePoolDeposit(logs) {
  for (const log of logs) {
    if (log.address.toLowerCase() !== BRIDGE_CONTRACTS[BASE].across.toLowerCase()) continue;
    try {
      const { args } = decodeEventLog({ abi: FUNDS_DEPOSITED, data: log.data, topics: log.topics });
      return { destinationChainId: args.destinationChainId.toString(), depositor: `0x${args.depositor.slice(26)}`, recipient: `0x${args.recipient.slice(26)}`, inputAmount: args.inputAmount.toString(), outputAmount: args.outputAmount.toString() };
    } catch {
      continue;
    }
  }
  return null;
}

const work = mkdtempSync(path.join(tmpdir(), "bridge-proof-"));
try {
  execFileSync("cargo", ["build", "--release", "--locked", "--quiet"], { cwd: path.join(root, "signer"), stdio: "inherit" });
  const keystore = path.join(work, "keystore.json");
  const owner = JSON.parse(execFileSync(signerBin, ["init", "--keystore", keystore], { env: passphrase }).toString()).evmAddress;
  const config = loadConfig({ RPC_URL_8453: RPC, ENABLED_CHAINS: "base,arbitrum", ALLOW_HOT_APPROVAL: "true", TOKEN_SCREENING: "true", LIVE_LOOKUP_TIMEOUT_MS: "5000", BRIDGE_QUOTE_TIMEOUT_MS: "15000", MAX_BRIDGE_FEE_BPS: process.env.MAX_BRIDGE_FEE_BPS ?? "100" });
  const limit = config.evmFeeLimits[BASE];
  const policyFile = path.join(work, "policy.json");
  writeFileSync(
    policyFile,
    JSON.stringify({
      version: 1,
      evm: {
        chains: [BASE, ARBITRUM],
        bridges: { [BASE]: BRIDGE_CONTRACTS[BASE] },
        maxValueWei: DEFAULT_MAX_VALUE_WEI.toString(),
        maxFeeWei: (limit.maxGas * limit.maxFeePerGas + limit.l1.maxFeeWei).toString(),
        dailyLimits: { [`${BASE}:native`]: "100000000000000000", [`${BASE}:${USDC}`]: "100000000" },
      },
    }),
  );
  const raw = [];
  let jobs = 0;
  const whaleSigner = {
    backend: "keystore",
    evmAddress: () => owner,
    solanaAddress: () => null,
    async signEvm(input) {
      const job = { id: `proof-${(jobs += 1)}-${input.purpose}`, kind: "evm", chainId: input.chainId, tx: { nonce: String(input.nonce), to: input.to, value: String(input.value), data: input.data, gas: String(input.gas), maxFeePerGas: String(input.maxFeePerGas), maxPriorityFeePerGas: String(input.maxPriorityFeePerGas) } };
      let output;
      try {
        output = execFileSync(signerBin, ["sign", "--keystore", keystore, "--policy", policyFile, "--ledger", path.join(work, "ledger.json")], { env: passphrase, input: JSON.stringify(job) });
      } catch (error) {
        output = error.stdout;
      }
      const answer = JSON.parse(output.toString());
      if (answer.decision !== "signed") throw new Error(`whale-signer refused ${job.id}: ${JSON.stringify(answer.reasons)}`);
      raw.push(answer.result.signedTransaction);
      return answer.result.signedTransaction;
    },
    signSolana: async () => {
      throw new Error("no solana");
    },
    signHyperliquid: async () => {
      throw new Error("no hyperliquid");
    },
  };
  const signer = withPolicy(whaleSigner, config);
  const evm = evmContext({ config, signer, io: defaultIo(config), onTx: async () => undefined, fetchImpl: fetch, secrets: [] }, "base", [RPC]);
  const reads = {
    allowance: async (token, holder, spender) => BigInt(await rpc("eth_call", [{ to: token, data: encodeFunctionData({ abi: erc20Abi, functionName: "allowance", args: [holder, spender] }) }, "latest"])),
    async simulate(from, calls) {
      const [block] = await rpc("eth_simulateV1", [{ blockStateCalls: [{ stateOverrides: funded(from, null), calls: calls.map(({ to, data, value }) => ({ from, to, data, value: toHex(value) })) }], validation: false }, "latest"]);
      if (block.calls.some((call) => call.status !== "0x1")) throw new Error(`simulation reverted: ${JSON.stringify(block.calls.map((call) => call.error ?? call.status))}`);
      return block.calls.map((call) => BigInt(call.gasUsed));
    },
  };
  const route = {
    source: { chainKey: "base", address: owner },
    destination: { chainKey: "arbitrum", address: owner },
    sell: { symbol: "USDC", address: USDC, decimals: 6 },
    buy: { symbol: "USDC", address: ARBITRUM_USDC, decimals: 6 },
    amount: AMOUNT.toString(),
    amountInUsd: 2,
  };
  const deps = {
    evm,
    reads,
    firm: (provider, item) => firmBridgeCall(config, provider, item),
    screen: (token) => screenToken(config, token),
    spend: bridgeSpend(config),
    status: (lookup) => bridgeStatus(config, lookup),
    broadcast: false,
    maxFeeBps: config.maxBridgeFeeBps,
    trackTimeoutMs: 0,
  };
  console.log(`signer ${owner} on Base, WHALE_BROADCAST unset, broadcast false`);
  let failed = 0;
  for (const provider of ["lifi", "across", "relay"]) {
    raw.length = 0;
    const result = await executeBridge(deps, { idempotencyKey: `proof-${provider}`, route, provider });
    if (provider === "relay") {
      const ok = result.status === "skipped";
      failed += ok ? 0 : 1;
      console.log(JSON.stringify({ provider, status: result.status, reason: result.reason, pass: ok }));
      continue;
    }
    if (result.status !== "signed") {
      failed += 1;
      console.log(JSON.stringify({ provider, status: result.status, reason: result.reason, pass: false }));
      continue;
    }
    const signedTxs = await Promise.all(raw.map(async (serialized) => ({ serialized, parsed: parseTransaction(serialized), from: await recoverTransactionAddress({ serializedTransaction: serialized }) })));
    const bridge = signedTxs[signedTxs.length - 1];
    const call = { from: bridge.from, to: bridge.parsed.to, data: bridge.parsed.data, value: toHex(bridge.parsed.value ?? 0n), gas: toHex(bridge.parsed.gas), maxFeePerGas: toHex(bridge.parsed.maxFeePerGas), maxPriorityFeePerGas: toHex(bridge.parsed.maxPriorityFeePerGas), nonce: toHex(bridge.parsed.nonce), type: "0x2" };
    const ethCall = await rpc("eth_call", [call, "latest", funded(bridge.from, bridge.parsed.to)]);
    const [block] = await rpc("eth_simulateV1", [{ blockStateCalls: [{ stateOverrides: { [bridge.from]: funded(bridge.from, null)[bridge.from], [USDC]: funded(bridge.from, null)[USDC] }, calls: signedTxs.map(({ from, parsed }) => ({ from, to: parsed.to, data: parsed.data, value: toHex(parsed.value ?? 0n), gas: toHex(parsed.gas), maxFeePerGas: toHex(parsed.maxFeePerGas), maxPriorityFeePerGas: toHex(parsed.maxPriorityFeePerGas), nonce: toHex(parsed.nonce) })) }], validation: true }, "latest"]);
    const terms = bridgeTerms(bridge.parsed.data);
    const approval = signedTxs.length === 2 ? decodeFunctionData({ abi: erc20Abi, data: signedTxs[0].parsed.data }).args : null;
    const onChain = await rpc("eth_getTransactionByHash", [keccak256(bridge.serialized)]);
    const status = await bridgeStatus(config, { provider, fromChainId: BASE, txHash: keccak256(bridge.serialized) }).catch((error) => ({ state: `error: ${error.message}` }));
    const deposited = spokePoolDeposit(block.calls[block.calls.length - 1].logs);
    const ok =
      deposited?.destinationChainId === String(ARBITRUM) &&
      deposited.recipient.toLowerCase() === owner.toLowerCase() &&
      bridge.from.toLowerCase() === owner.toLowerCase() &&
      bridge.parsed.chainId === BASE &&
      terms?.recipient.toLowerCase() === owner.toLowerCase() &&
      terms?.destinationChainId === BigInt(ARBITRUM) &&
      terms?.charge.amount === AMOUNT &&
      block.calls.every((item) => item.status === "0x1") &&
      onChain === null;
    failed += ok ? 0 : 1;
    console.log(
      JSON.stringify({
        provider,
        status: result.status,
        reason: result.reason,
        txs: result.txs,
        to: bridge.parsed.to,
        selector: bridge.parsed.data.slice(0, 10),
        recoveredSigner: bridge.from,
        approval: approval && { spender: approval[0], amount: approval[1].toString() },
        decoded: terms && { destinationChainId: terms.destinationChainId.toString(), recipient: terms.recipient, refund: terms.refund, charge: terms.charge.amount.toString(), minOutput: terms.minOutput.toString() },
        ethCall: ethCall.length > 66 ? `${ethCall.slice(0, 66)}...` : ethCall,
        spokePoolFundsDeposited: deposited,
        signedBundleSimulation: block.calls.map((item) => ({ status: item.status, gasUsed: BigInt(item.gasUsed).toString(), logs: item.logs.length })),
        onChain,
        providerStatus: status.state,
        broadcast: false,
        pass: ok,
      }),
    );
  }
  if (failed > 0) process.exit(1);
} finally {
  rmSync(work, { recursive: true, force: true });
}
