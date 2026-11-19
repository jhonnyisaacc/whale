import { randomBytes } from "node:crypto";
import { createPublicClient, decodeFunctionResult, encodeFunctionData, http, pad, parseAbi, serializeTransaction, toHex } from "viem";
import { CHAINS, DEFAULT_EVM_FEE_LIMITS } from "../src/chains.ts";

const GWEI = 10n ** 9n;
const STRESS = { l1BaseFee: 20n * GWEI, blobBaseFee: 2n * GWEI };
const OP_STACK = { oracle: "0x420000000000000000000000000000000000000F", store: "0x4200000000000000000000000000000000000015", base: "l1BaseFee", blob: "blobBaseFee" };
const ORACLES = {
  10: { rpc: "https://mainnet.optimism.io", ...OP_STACK },
  8453: { rpc: "https://mainnet.base.org", ...OP_STACK },
  534352: { rpc: "https://rpc.scroll.io", oracle: "0x5300000000000000000000000000000000000002", store: "0x5300000000000000000000000000000000000002", base: "l1BaseFee", blob: "l1BlobBaseFee" },
};
const abi = parseAbi(["function getL1Fee(bytes) view returns (uint256)", "function l1BaseFee() view returns (uint256)", "function blobBaseFee() view returns (uint256)", "function l1BlobBaseFee() view returns (uint256)"]);

function worstTransaction(chainId, limit) {
  const max = (bits) => 2n ** BigInt(bits) - 1n;
  return serializeTransaction(
    { type: "eip1559", chainId, nonce: Number.MAX_SAFE_INTEGER, gas: limit.maxGas, maxFeePerGas: limit.maxFeePerGas, maxPriorityFeePerGas: limit.maxFeePerGas, to: `0x${"ff".repeat(20)}`, value: max(128), data: toHex(randomBytes(limit.l1.maxDataBytes)) },
    { r: `0x${"ff".repeat(32)}`, s: `0x${"7f".repeat(32)}`, yParity: 1 },
  );
}

async function slotOf(client, blockNumber, store, value) {
  for (let slot = 0; slot < 16; slot++) {
    const word = await client.getStorageAt({ address: store, slot: pad(toHex(slot)), blockNumber });
    if (word && BigInt(word) === value) return pad(toHex(slot));
  }
  throw new Error(`no storage slot of ${store} holds ${value}`);
}

async function measure(chainId, oracle, limit) {
  const client = createPublicClient({ transport: http(process.env[`RPC_URL_${chainId}`]?.split(",")[0] || oracle.rpc, { retryCount: 3 }) });
  const blockNumber = await client.getBlockNumber();
  const read = async (functionName, args = [], stateOverride) =>
    decodeFunctionResult({ abi, functionName, data: (await client.call({ to: oracle.oracle, data: encodeFunctionData({ abi, functionName, args }), blockNumber, stateOverride })).data });
  const now = { l1BaseFee: await read(oracle.base), blobBaseFee: await read(oracle.blob) };
  const stateDiff = [
    { slot: await slotOf(client, blockNumber, oracle.store, now.l1BaseFee), value: pad(toHex(STRESS.l1BaseFee)) },
    { slot: await slotOf(client, blockNumber, oracle.store, now.blobBaseFee), value: pad(toHex(STRESS.blobBaseFee)) },
  ];
  const stressed = [{ address: oracle.store, stateDiff }];
  if ((await read(oracle.base, [], stressed)) !== STRESS.l1BaseFee || (await read(oracle.blob, [], stressed)) !== STRESS.blobBaseFee) throw new Error(`chain ${chainId}: the stress override did not reach the oracle`);
  const tx = worstTransaction(chainId, limit);
  return { blockNumber, now, bytes: (tx.length - 2) / 2, feeNow: await read("getL1Fee", [tx]), feeStressed: await read("getL1Fee", [tx], stressed) };
}

const gwei = (wei) => (Number(wei) / 1e9).toFixed(3);
let failed = false;
for (const [id, limit] of Object.entries(DEFAULT_EVM_FEE_LIMITS)) {
  if (!limit.l1) continue;
  const oracle = ORACLES[id];
  const key = CHAINS.find(({ chain }) => chain.kind === "evm" && chain.chainId === Number(id))?.key;
  if (!oracle) {
    console.log(`${key}: no oracle is listed for an L1 fee budget`);
    failed = true;
    continue;
  }
  const m = await measure(Number(id), oracle, limit);
  const ok = m.feeStressed <= limit.l1.maxFeeWei;
  failed ||= !ok;
  console.log(
    `${ok ? "ok  " : "FAIL"} ${key} (${id}) at block ${m.blockNumber}: a ${m.bytes}-byte signed tx with ${limit.l1.maxDataBytes} random calldata bytes pays ${m.feeNow} wei at L1 ${gwei(m.now.l1BaseFee)} / blob ${gwei(m.now.blobBaseFee)} gwei and ${m.feeStressed} wei at L1 ${gwei(STRESS.l1BaseFee)} / blob ${gwei(STRESS.blobBaseFee)} gwei. Budget ${limit.l1.maxFeeWei} wei, ${Number((limit.l1.maxFeeWei * 100n) / m.feeNow) / 100}x today's fee`,
  );
}
process.exit(failed ? 1 : 0);
