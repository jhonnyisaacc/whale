import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { encodeAbiParameters, encodeFunctionData, erc20Abi, keccak256, maxUint256, pad, parseTransaction, recoverTransactionAddress, toHex } from "viem";
import { lifiQuote, lifiUrl } from "../dist/src/aggregators.js";
import { createViemRpc } from "../dist/src/broadcast/shared.js";
import { loadConfig } from "../dist/src/config.js";
import { assertEvmFee, assertEvmSigning, DEFAULT_MAX_VALUE_WEI, swapTerms } from "../dist/src/signing-policy.js";

const RPC = process.env.RPC_URL_324 ?? "https://mainnet.era.zksync.io";
const CHAIN_ID = 324;
const DIAMOND = "0x341e94069f53234fe6dabef707ad424830525715";
const USDC = "0x1d17CBcF0D6D143135aE902365D2E5e2A16538D4";
const NATIVE = "0x0000000000000000000000000000000000000000";
const DESTINATION = "0x2222222222222222222222222222222222222222";
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

function overrides(owner, usdc) {
  const state = { [owner]: { balance: toHex(10n ** 18n) } };
  if (usdc) state[USDC] = { stateDiff: { [slot(owner, USDC_BALANCES_SLOT)]: pad(toHex(10n ** 12n)), [nestedSlot(owner, DIAMOND, USDC_ALLOWANCES_SLOT)]: pad(toHex(maxUint256)) } };
  return state;
}

const work = mkdtempSync(path.join(tmpdir(), "zksync-proof-"));
try {
  execFileSync("cargo", ["build", "--release", "--locked", "--quiet"], { cwd: path.join(root, "signer"), stdio: "inherit" });
  const keystore = path.join(work, "keystore.json");
  const owner = JSON.parse(execFileSync(signerBin, ["init", "--keystore", keystore], { env: passphrase }).toString()).evmAddress;
  const config = loadConfig({ RPC_URL_324: RPC, ROUTER_ALLOWLIST_JSON: JSON.stringify({ [CHAIN_ID]: [DIAMOND] }) });
  const limit = config.evmFeeLimits[CHAIN_ID];
  const policyFile = path.join(work, "policy.json");
  writeFileSync(
    policyFile,
    JSON.stringify({
      version: 1,
      evm: {
        chains: [CHAIN_ID],
        routers: { [CHAIN_ID]: [DIAMOND] },
        destinations: [DESTINATION],
        maxValueWei: DEFAULT_MAX_VALUE_WEI.toString(),
        maxFeeWei: (limit.maxGas * limit.maxFeePerGas).toString(),
        dailyLimits: { [`${CHAIN_ID}:native`]: "10000000000000000", [`${CHAIN_ID}:${USDC}`]: "100000000" },
      },
    }),
  );
  const read = createViemRpc(CHAIN_ID, [RPC]);
  const fees = await read.fees();
  let nonce = await read.pendingNonce(owner);
  console.log(`signer ${owner}, fees ${JSON.stringify({ maxFeePerGas: fees.maxFeePerGas.toString(), maxPriorityFeePerGas: fees.maxPriorityFeePerGas.toString() })}, limit gas ${limit.maxGas} fee ${limit.maxFeePerGas}`);

  async function swap(sell, buy, amount) {
    const hop = { sellAddress: sell, buyAddress: buy, sellAmount: amount.toString(), chain: { kind: "evm", chainId: CHAIN_ID } };
    const body = await (await fetch(lifiUrl(config, hop, CHAIN_ID, owner, 100))).json();
    if (!body.transactionRequest) throw new Error(`LI.FI gave no transaction: ${body.message ?? "no message"}`);
    const quote = lifiQuote(config, body, null, CHAIN_ID);
    if (quote.signable !== true) throw new Error("the LI.FI quote is not signable");
    const request = body.transactionRequest;
    const terms = swapTerms(request.data);
    if (terms?.provider !== "lifi" || terms.recipient.toLowerCase() !== owner.toLowerCase()) throw new Error("the LI.FI calldata does not pay the signer");
    const deposit = terms.deposit;
    if (sell === NATIVE ? deposit !== null : deposit?.token.toLowerCase() !== sell.toLowerCase() || deposit.amount !== amount) throw new Error("the LI.FI calldata pulls another sell");
    return { label: `LI.FI ${sell === NATIVE ? "ETH" : "USDC"} -> ${buy === NATIVE ? "ETH" : "USDC"} (${request.data.slice(0, 10)})`, to: request.to, data: request.data, value: BigInt(request.value), gas: BigInt(request.gasLimit), purpose: "swap", usdc: sell === USDC };
  }

  const transferGas = BigInt(await rpc("eth_estimateGas", [{ from: owner, to: DESTINATION, data: "0x", value: toHex(10n ** 14n), type: "0x2" }, "latest", overrides(owner, false)]));
  const usdcTransfer = encodeFunctionData({ abi: erc20Abi, functionName: "transfer", args: [DESTINATION, 1_000_000n] });
  const usdcGas = BigInt(await rpc("eth_estimateGas", [{ from: owner, to: USDC, data: usdcTransfer, value: "0x0", type: "0x2" }, "latest", overrides(owner, true)]));
  const cases = [
    await swap(NATIVE, USDC, 10n ** 15n),
    await swap(USDC, NATIVE, 5_000_000n),
    { label: "native transfer", to: DESTINATION, data: "0x", value: 10n ** 14n, gas: transferGas, purpose: "withdraw", usdc: false },
    { label: "USDC transfer", to: USDC, data: usdcTransfer, value: 0n, gas: usdcGas, purpose: "withdraw", usdc: true },
  ];
  let failed = 0;
  for (const item of cases) {
    const tx = { chainId: CHAIN_ID, to: item.to, data: item.data, value: item.value, gas: item.gas, nonce, ...fees };
    nonce += 1;
    assertEvmFee(limit, tx);
    assertEvmSigning({ ...tx, purpose: item.purpose, routers: [DIAMOND], settlers: [], withdrawAllowlist: [DESTINATION], maxValueWei: DEFAULT_MAX_VALUE_WEI, allowHotApproval: false, owner, allowOpaqueSwap: false, nativeSell: item.value > 0n, recoveryTokens: [USDC] });
    const job = { id: item.label, kind: "evm", chainId: CHAIN_ID, tx: { nonce: String(tx.nonce), to: tx.to, value: String(tx.value), data: tx.data, gas: String(tx.gas), maxFeePerGas: String(tx.maxFeePerGas), maxPriorityFeePerGas: String(tx.maxPriorityFeePerGas) } };
    const signed = JSON.parse(execFileSync(signerBin, ["sign", "--keystore", keystore, "--policy", policyFile, "--ledger", path.join(work, "ledger.json")], { env: passphrase, input: JSON.stringify(job) }).toString());
    if (signed.decision !== "signed") throw new Error(`${item.label}: whale-signer refused: ${JSON.stringify(signed.reasons)}`);
    const raw = signed.result.signedTransaction;
    const parsed = parseTransaction(raw);
    const from = await recoverTransactionAddress({ serializedTransaction: raw });
    const call = { from, to: parsed.to, data: parsed.data ?? "0x", value: toHex(parsed.value ?? 0n), gas: toHex(parsed.gas), maxFeePerGas: toHex(parsed.maxFeePerGas), maxPriorityFeePerGas: toHex(parsed.maxPriorityFeePerGas ?? 0n), nonce: toHex(parsed.nonce ?? 0), type: "0x2" };
    const state = overrides(from, item.usdc);
    const estimate = BigInt(await rpc("eth_estimateGas", [call, "latest", state]));
    const output = await rpc("eth_call", [call, "latest", state]);
    const ok = parsed.type === "eip1559" && parsed.chainId === CHAIN_ID && from.toLowerCase() === owner.toLowerCase() && estimate <= parsed.gas;
    if (!ok) failed += 1;
    console.log(
      JSON.stringify({
        case: item.label,
        signedType: parsed.type,
        chainId: parsed.chainId,
        recoveredSigner: from,
        signedGas: parsed.gas.toString(),
        estimateGas: estimate.toString(),
        maxFeeWei: (parsed.gas * parsed.maxFeePerGas).toString(),
        ethCall: output.length > 66 ? `${output.slice(0, 66)}...` : output,
        signedTxHash: keccak256(raw),
        broadcast: false,
        pass: ok,
      }),
    );
  }
  if (failed > 0) process.exit(1);
} finally {
  rmSync(work, { recursive: true, force: true });
}
