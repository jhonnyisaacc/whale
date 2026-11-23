import { createPrivateKey, createPublicKey, sign } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { PublicKey } from "@solana/web3.js";
import bs58 from "bs58";
import { encode } from "@msgpack/msgpack";
import { decodeFunctionData, encodeFunctionData, keccak256, maxUint256, pad, parseAbi } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { DEFAULT_EVM_FEE_LIMITS, signerChainTable } from "../../src/chains.ts";
import { LIFI_STEP_TARGETS } from "../../src/signing-policy/lifi-steps.ts";
import { LIFI_ABI } from "../../src/signing-policy/swap-terms.ts";
import { BRIDGE_TOKENS } from "../../src/signing-policy/bridge-tokens.ts";

const out = new URL(".", import.meta.url).pathname;
const EVM_KEY = `0x${"11".repeat(32)}`;
const SOLANA_SEED = Buffer.alloc(32, 0x22);
const own = privateKeyToAccount(EVM_KEY).address;
const ATTACKER = "0x00000000000000000000000000000000000bad00";
const DESTINATION = "0x2222222222222222222222222222222222222222";
const KYBER = "0x6131B5fae19EA4f9D964eAc0408E4408b66337b5";
const ALLOWANCE_HOLDER = "0x0000000000001fF3684f28c67538d4D072C22734";
const SETTLER = "0x5555555555555555555555555555555555555555";
const EXECUTOR = "0x7777777777777777777777777777777777777777";
const NONE = "0x0000000000000000000000000000000000000000";
const LIFI = "0x1231DEB6f5749EF6cE6943a275A1D3E7486F4EaE";
const CHAIN_ID = 1;
const USDC = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";
const WETH = "0x4200000000000000000000000000000000000006";
const ZKSYNC = 324;
const ZKSYNC_LIFI = "0x341e94069f53234fe6dabef707ad424830525715";
const ZKSYNC_USDC = "0x1d17CBcF0D6D143135aE902365D2E5e2A16538D4";
const ZKSYNC_ZK = "0x5A7d6b2F92C77FAD6CCaBd7EE0624E64907Eaf3E";

const kyberAbi = parseAbi([
  "struct SwapDescriptionV2 { address srcToken; address dstToken; address[] srcReceivers; uint256[] srcAmounts; address[] feeReceivers; uint256[] feeAmounts; address dstReceiver; uint256 amount; uint256 minReturnAmount; uint256 flags; bytes permit; }",
  "struct SwapExecutionParams { address callTarget; address approveTarget; bytes targetData; SwapDescriptionV2 desc; bytes clientData; }",
  "function swap(SwapExecutionParams execution) payable returns (uint256 returnAmount, uint256 gasUsed)",
  "function swapSimpleMode(address caller, SwapDescriptionV2 desc, bytes executorData, bytes clientData) returns (uint256 returnAmount, uint256 gasUsed)",
]);
const holderAbi = parseAbi(["function exec(address operator, address token, uint256 amount, address target, bytes data) payable returns (bytes result)"]);
const settlerAbi = parseAbi(["struct AllowedSlippage { address recipient; address buyToken; uint256 minAmountOut; }", "function execute(AllowedSlippage slippage, bytes[] actions, bytes32 zid) payable returns (bool)"]);
const lifiHead = "bytes32 _transactionId, string _integrator, string _referrer, address _receiver, uint256 _minAmountOut";
const lifiSwapData = "(address callTo, address approveTo, address sendingAssetId, address receivingAssetId, uint256 fromAmount, bytes callData, bool requiresDeposit)";
const lifiAbi = parseAbi([
  `function swapTokensSingleV3ERC20ToERC20(${lifiHead}, ${lifiSwapData} _swapData)`,
  `function swapTokensMultipleV3ERC20ToNative(${lifiHead}, ${lifiSwapData}[] _swapData)`,
  `function swapTokensMultipleV3NativeToERC20(${lifiHead}, ${lifiSwapData}[] _swapData) payable`,
]);
const erc20 = parseAbi(["function transfer(address to, uint256 amount)", "function approve(address spender, uint256 amount)"]);

const desc = (recipient, amount, overrides = {}) => ({ srcToken: USDC, dstToken: WETH, srcReceivers: [EXECUTOR], srcAmounts: [amount], feeReceivers: [], feeAmounts: [], dstReceiver: recipient, amount, minReturnAmount: 1n, flags: 0n, permit: "0x", ...overrides });
const kyberSwap = (description, execution = {}) => encodeFunctionData({ abi: kyberAbi, functionName: "swap", args: [{ callTarget: EXECUTOR, approveTarget: NONE, targetData: "0xabcdef", desc: description, clientData: "0x01", ...execution }] });
const settlerCall = (recipient) => encodeFunctionData({ abi: settlerAbi, functionName: "execute", args: [{ recipient, buyToken: WETH, minAmountOut: 1n }, ["0x1234"], `0x${"00".repeat(32)}`] });
const tx = (to, data = "0x", value = 0n, chainId = CHAIN_ID, fees = {}) => ({ chainId, nonce: 7, to, value, data, gas: 300000n, maxFeePerGas: 2_000_000_000n, maxPriorityFeePerGas: 1_000_000n, type: "eip1559", ...fees });
const job = (name, transaction) => ({ id: name, kind: "evm", chainId: transaction.chainId, tx: { nonce: String(transaction.nonce), to: transaction.to, value: String(transaction.value), data: transaction.data, gas: String(transaction.gas), maxFeePerGas: String(transaction.maxFeePerGas), maxPriorityFeePerGas: String(transaction.maxPriorityFeePerGas) } });

const ZKSYNC_SUSHI = LIFI_STEP_TARGETS[ZKSYNC].targets[1];
const lifiStep = (sell, buy, amount, requiresDeposit = false) => ({ callTo: ZKSYNC_SUSHI, approveTo: ZKSYNC_SUSHI, sendingAssetId: sell, receivingAssetId: buy, fromAmount: amount, callData: "0xabcdef", requiresDeposit });
const lifiSwap = (functionName, recipient, swaps) => encodeFunctionData({ abi: lifiAbi, functionName, args: [`0x${"00".repeat(32)}`, "whale", "", recipient, 1n, functionName.startsWith("swapTokensSingle") ? swaps[0] : swaps] });
const zkFees = { gas: 4_415_200n, maxFeePerGas: 54_300_000n, maxPriorityFeePerGas: 0n };
const zk = (to, data = "0x", value = 0n) => tx(to, data, value, ZKSYNC, zkFees);
const usdcToNative = (recipient, swaps = [lifiStep(ZKSYNC_USDC, ZKSYNC_USDC, 5_000_000n, true), lifiStep(ZKSYNC_USDC, NONE, 4_990_000n)]) => lifiSwap("swapTokensMultipleV3ERC20ToNative", recipient, swaps);
const BASE = 8453;
const ARBITRUM = 42161;
const LISTED_BRIDGE_DESTINATION = "0x1111111111111111111111111111111111111111";
const captured = (name) => JSON.parse(readFileSync(new URL(`../../test/fixtures/bridge/${name}.json`, import.meta.url), "utf8"));
const lifiBridge = captured("lifi-start-base-arbitrum");
const lifiSwapAndStart = captured("lifi-swap-and-start-base-arbitrum");
const acrossBridge = captured("across-base-arbitrum");
const relayDeposit = captured("relay-base-arbitrum").steps.find((step) => step.id === "deposit").txs[0];
const BRIDGE_DATA = "(bytes32 transactionId, string bridge, string integrator, address referrer, address sendingAssetId, address receiver, uint256 minAmount, uint256 destinationChainId, bool hasSourceSwaps, bool hasDestinationCall)";
const ACROSS_V4_DATA = "(bytes32 receiverAddress, bytes32 refundAddress, bytes32 sendingAssetId, bytes32 receivingAssetId, uint256 outputAmount, uint128 outputAmountMultiplier, bytes32 exclusiveRelayer, uint32 quoteTimestamp, uint32 fillDeadline, uint32 exclusivityParameter, bytes message)";
const lifiAcrossAbi = parseAbi([`function startBridgeTokensViaAcrossV4(${BRIDGE_DATA} _bridgeData, ${ACROSS_V4_DATA} _acrossData) payable`]);
const lifiSwapAndStartAbi = parseAbi([`function swapAndStartBridgeTokensViaAcrossV4(${BRIDGE_DATA} _bridgeData, ${lifiSwapData}[] _swapData, ${ACROSS_V4_DATA} _acrossData) payable`, "function forwardERC20Fees(address token, (address recipient, uint256 amount)[] fees)"]);
const FEE_FORWARDER = "0xDe2b920506EE931a6A2ABDF566526220214FBbAE";
const feeForwarderLeak = (() => {
  const [bridge, swaps, data] = decodeFunctionData({ abi: lifiSwapAndStartAbi, data: lifiSwapAndStart.tx.data }).args;
  const forward = encodeFunctionData({ abi: lifiSwapAndStartAbi, functionName: "forwardERC20Fees", args: [USDC, [{ recipient: ATTACKER, amount: 1_999_999n }]] });
  const step = { ...swaps[0], callTo: FEE_FORWARDER, approveTo: FEE_FORWARDER, fromAmount: 2_000_000n, callData: forward };
  return encodeFunctionData({ abi: lifiSwapAndStartAbi, functionName: "swapAndStartBridgeTokensViaAcrossV4", args: [{ ...bridge, minAmount: 1n }, [step], { ...data, outputAmountMultiplier: 2_000_000n * 10n ** 18n }] });
})();
const spokePoolAbi = parseAbi(["function deposit(bytes32 depositor, bytes32 recipient, bytes32 inputToken, bytes32 outputToken, uint256 inputAmount, uint256 outputAmount, uint256 destinationChainId, bytes32 exclusiveRelayer, uint32 quoteTimestamp, uint32 fillDeadline, uint32 exclusivityParameter, bytes message) payable"]);
const word = (address) => pad(address.toLowerCase(), { size: 32 });
const lifiBridgeWith = (edit) => {
  const [bridge, data] = decodeFunctionData({ abi: lifiAcrossAbi, data: lifiBridge.tx.data }).args;
  const next = { bridge: { ...bridge }, data: { ...data } };
  edit(next.bridge, next.data);
  return encodeFunctionData({ abi: lifiAcrossAbi, functionName: "startBridgeTokensViaAcrossV4", args: [next.bridge, next.data] });
};
const NO_RELAYER = pad("0x", { size: 32 });
const acrossDepositWith = (data, edit) => {
  const args = [...decodeFunctionData({ abi: spokePoolAbi, data }).args];
  args[7] = NO_RELAYER;
  args[10] = 0;
  edit(args);
  return encodeFunctionData({ abi: spokePoolAbi, functionName: "deposit", args });
};
const acrossBridgeWith = (edit) => acrossDepositWith(acrossBridge.tx.data, edit);
const YEAR = 4_000_000_000;
const ARBITRUM_WETH = "0x82aF49447D8a07e3bd95BD0d56f35241523fBab1";
const LIFI_DIAMOND = lifiBridge.tx.to;
const BASE_SPOKE_POOL = acrossBridge.tx.to;
const onBase = (to, data, value = 0n) => tx(to, data, value, BASE);
const bridgeSpent = (transaction) => ({ [`${BASE}:native`]: String(transaction.gas * transaction.maxFeePerGas + DEFAULT_EVM_FEE_LIMITS[BASE].l1.maxFeeWei), [`${BASE}:${USDC.toLowerCase()}`]: "2000000" });
const realLifiBridge = onBase(LIFI_DIAMOND, lifiBridge.tx.data);
const realAcrossBridge = onBase(BASE_SPOKE_POOL, acrossBridgeWith(() => undefined));
const bridgeCases = [
  ["a real LI.FI AcrossV4 bridge from Base to this wallet on Arbitrum", realLifiBridge, "signed", null, null, bridgeSpent(realLifiBridge)],
  ["a real Across SpokePool deposit from Base to this wallet on Arbitrum", realAcrossBridge, "signed", null, null, bridgeSpent(realAcrossBridge)],
  ["a real LI.FI bridge to a listed destination", onBase(LIFI_DIAMOND, captured("lifi-start-base-arbitrum-destination").tx.data), "signed"],
  ["a real Across deposit to a listed destination", onBase(BASE_SPOKE_POOL, acrossDepositWith(captured("across-base-arbitrum-destination").tx.data, () => undefined)), "signed"],
  ["a real Across quote that keeps its exclusive relayer", onBase(BASE_SPOKE_POOL, acrossBridge.tx.data), "refused", "names an exclusive relayer"],
  ["an Across deposit of 1 wei out to an exclusive attacker relayer", onBase(BASE_SPOKE_POOL, acrossBridgeWith((args) => ((args[5] = 1n), (args[7] = word(ATTACKER)), (args[10] = YEAR)))), "refused", "names an exclusive relayer"],
  ["an Across deposit of 1 wei out", onBase(BASE_SPOKE_POOL, acrossBridgeWith((args) => (args[5] = 1n))), "refused", "delivers at least 1 USDC for 2000000, under the 100 bps bridge fee cap"],
  ["an Across deposit of nothing out", onBase(BASE_SPOKE_POOL, acrossBridgeWith((args) => (args[5] = 0n))), "refused", "under the 100 bps bridge fee cap"],
  ["an Across deposit delivering an attacker token", onBase(BASE_SPOKE_POOL, acrossBridgeWith((args) => ((args[3] = word(ATTACKER)), (args[5] = 2_000_000n)))), "refused", "a pair the bridge token table does not list"],
  ["an Across deposit delivering WETH for USDC", onBase(BASE_SPOKE_POOL, acrossBridgeWith((args) => (args[3] = word(ARBITRUM_WETH)))), "refused", "a pair the bridge token table does not list"],
  ["an Across deposit with exclusivity and no relayer", onBase(BASE_SPOKE_POOL, acrossBridgeWith((args) => (args[10] = 3))), "refused", "names an exclusive relayer"],
  ["a LI.FI bridge of 1 wei out to an exclusive attacker relayer", onBase(LIFI_DIAMOND, lifiBridgeWith((_, data) => ((data.outputAmount = 1n), (data.exclusiveRelayer = word(ATTACKER)), (data.exclusivityParameter = YEAR)))), "refused", "names an exclusive relayer"],
  ["a LI.FI bridge of nothing out", onBase(LIFI_DIAMOND, lifiBridgeWith((_, data) => (data.outputAmount = 0n))), "refused", "delivers at least 0 USDC for 2000000"],
  ["a LI.FI bridge 2% under par", onBase(LIFI_DIAMOND, lifiBridgeWith((_, data) => (data.outputAmount = 1_960_000n))), "refused", "under the 100 bps bridge fee cap"],
  ["a LI.FI bridge with its output multiplier at par", onBase(LIFI_DIAMOND, lifiBridgeWith((_, data) => (data.outputAmountMultiplier = 10n ** 18n))), "signed"],
  ["a LI.FI bridge with its output multiplier 1 above par", onBase(LIFI_DIAMOND, lifiBridgeWith((_, data) => (data.outputAmountMultiplier = 10n ** 18n + 1n))), "refused", "output multiplier 1000000000000000001 is above par for USDC"],
  ["a LI.FI bridge with an inflated output multiplier", onBase(LIFI_DIAMOND, lifiBridgeWith((_, data) => (data.outputAmountMultiplier = 2_000_000n * 10n ** 18n))), "refused", "output multiplier 2000000000000000000000000 is above par for USDC"],
  ["a real LI.FI swap then bridge quote", onBase(LIFI_DIAMOND, lifiSwapAndStart.tx.data), "refused", "not one the signer can read"],
  ["a LI.FI swap then bridge that forwards the charge to an attacker", onBase(LIFI_DIAMOND, feeForwarderLeak), "refused", "not one the signer can read"],
  ["a LI.FI bridge delivering an attacker token", onBase(LIFI_DIAMOND, lifiBridgeWith((_, data) => (data.receivingAssetId = word(ATTACKER)))), "refused", "a pair the bridge token table does not list"],
  ["a LI.FI bridge naming an exclusive relayer", onBase(LIFI_DIAMOND, lifiBridgeWith((_, data) => (data.exclusiveRelayer = word(ATTACKER)))), "refused", "names an exclusive relayer"],
  ["a LI.FI bridge paying an attacker", onBase(LIFI_DIAMOND, lifiBridgeWith((bridge, data) => ((bridge.receiver = ATTACKER), (data.receiverAddress = word(ATTACKER))))), "refused", "not this wallet or a listed destination"],
  ["a LI.FI bridge whose two receivers disagree", onBase(LIFI_DIAMOND, lifiBridgeWith((_, data) => (data.receiverAddress = word(ATTACKER)))), "refused", "not one the signer can read"],
  ["a LI.FI bridge refunding an attacker", onBase(LIFI_DIAMOND, lifiBridgeWith((_, data) => (data.refundAddress = word(ATTACKER)))), "refused", "refunds 0x00000000000000000000000000000000000bad00"],
  ["a LI.FI bridge to a chain outside the policy", onBase(LIFI_DIAMOND, lifiBridgeWith((bridge) => (bridge.destinationChainId = 31337n))), "refused", "lands on chain 31337, which is not another chain in the policy"],
  ["a LI.FI bridge back to its own chain", onBase(LIFI_DIAMOND, lifiBridgeWith((bridge) => (bridge.destinationChainId = BigInt(BASE)))), "refused", "lands on chain 8453, which is not another chain in the policy"],
  ["a LI.FI bridge with a destination call", onBase(LIFI_DIAMOND, lifiBridgeWith((bridge, data) => ((bridge.hasDestinationCall = true), (data.message = "0x1234")))), "refused", "runs a destination call"],
  ["an Across deposit paying an attacker", onBase(BASE_SPOKE_POOL, acrossBridgeWith((args) => (args[1] = word(ATTACKER)))), "refused", "not this wallet or a listed destination"],
  ["an Across deposit refunding an attacker", onBase(BASE_SPOKE_POOL, acrossBridgeWith((args) => (args[0] = word(ATTACKER)))), "refused", "refunds 0x00000000000000000000000000000000000bad00"],
  ["an Across deposit to a chain outside the policy", onBase(BASE_SPOKE_POOL, acrossBridgeWith((args) => (args[6] = 31337n))), "refused", "lands on chain 31337"],
  ["an Across deposit with a destination message", onBase(BASE_SPOKE_POOL, acrossBridgeWith((args) => (args[11] = "0xabcd"))), "refused", "runs a destination call"],
  ["an Across deposit to a non-EVM recipient", onBase(BASE_SPOKE_POOL, acrossBridgeWith((args) => (args[1] = `0x${"ab".repeat(32)}`))), "refused", "not one the signer can read"],
  ["an Across deposit above the daily token limit", onBase(BASE_SPOKE_POOL, acrossBridgeWith((args) => (args[4] = 20_000_000n))), "refused", "above its whole 10000000 daily limit"],
  ["an Across deposit sent to the LI.FI diamond", onBase(LIFI_DIAMOND, acrossBridge.tx.data), "refused", "not the listed across bridge contract"],
  ["a LI.FI bridge sent to the SpokePool", onBase(BASE_SPOKE_POOL, lifiBridge.tx.data), "refused", "not the listed lifi bridge contract"],
  ["a bridge on a chain with no listed bridge contract", tx(BASE_SPOKE_POOL, acrossBridge.tx.data), "refused", "not the listed across bridge contract"],
  ["an Across deposit that also sends native value", onBase(BASE_SPOKE_POOL, acrossBridge.tx.data, 1n), "refused", "must send no native value"],
  ["a real Relay deposit, which names no destination", onBase(relayDeposit.to, relayDeposit.data), "refused", "not one the signer can read"],
  ["an exact approval to the listed SpokePool", onBase(USDC, encodeFunctionData({ abi: erc20, functionName: "approve", args: [BASE_SPOKE_POOL, 2_000_000n] })), "signed"],
];
const ARBITRUM_USDC = "0xaf88d065e77c8cC2239327C5EDb3A432268e5831";
const capturedSwaps = JSON.parse(readFileSync(new URL("./lifi-quotes.json", import.meta.url), "utf8"));
if (capturedSwaps.own !== own) throw new Error("lifi-quotes.json was captured for another wallet; rerun node signer/vectors/lifi-capture.mjs");
const quote = (name) => capturedSwaps.quotes.find((item) => item.name === name);
const real = (name) => { const item = quote(name); return tx(item.to, item.data, BigInt(item.value), item.chainId, item.chainId === ZKSYNC ? zkFees : {}); };
const feeAbi = parseAbi(["function forwardERC20Fees(address _token, (address recipient, uint256 amount)[] _distributions)", "function forwardERC20FeesShares(address _token, (address recipient, uint256 share)[] _distributions)"]);
const nativeFeeAbi = parseAbi(["function forwardNativeFees((address recipient, uint256 amount)[] _distributions) payable"]);
const mutate = (name, edit) => {
  const item = quote(name);
  const call = decodeFunctionData({ abi: LIFI_ABI, data: item.data });
  const steps = call.args[5].map((step) => ({ ...step }));
  const head = edit(steps, call.args.slice(0, 5));
  return tx(item.to, encodeFunctionData({ abi: LIFI_ABI, functionName: call.functionName, args: [...head, steps] }), BigInt(item.value), item.chainId, item.chainId === ZKSYNC ? zkFees : {});
};
const zkUsdcToEth = "zkSync USDC to ETH";
const attacked = mutate(zkUsdcToEth, (steps, args) => { steps[1].callTo = ATTACKER; steps[1].approveTo = ATTACKER; return [...args.slice(0, 4), 1n]; });
const BASE_L1 = DEFAULT_EVM_FEE_LIMITS[BASE].l1;
const baseSwap = tx(KYBER, encodeFunctionData({ abi: kyberAbi, functionName: "swapSimpleMode", args: [EXECUTOR, desc(own, 5_000_000n), "0x", "0x"] }), 0n, BASE);

const evmCases = [
  ["a zkSync LI.FI swap selling native to this wallet", zk(ZKSYNC_LIFI, lifiSwap("swapTokensMultipleV3NativeToERC20", own, [lifiStep(NONE, NONE, 1_000_000_000_000_000n), lifiStep(NONE, ZKSYNC_USDC, 997_000_000_000_000n)]), 1_000_000_000_000_000n), "signed", null, own],
  ["a zkSync LI.FI token swap to this wallet", zk(ZKSYNC_LIFI, usdcToNative(own)), "signed", null, own],
  ["a zkSync LI.FI single token swap to this wallet", zk(ZKSYNC_LIFI, lifiSwap("swapTokensSingleV3ERC20ToERC20", own, [lifiStep(ZKSYNC_USDC, ZKSYNC_ZK, 5_000_000n)])), "signed", null, own],
  ["a zkSync LI.FI swap paying an attacker", zk(ZKSYNC_LIFI, usdcToNative(ATTACKER)), "refused", "not this wallet", ATTACKER],
  ["a zkSync LI.FI swap that also pulls a second token", zk(ZKSYNC_LIFI, usdcToNative(own, [lifiStep(ZKSYNC_USDC, ZKSYNC_USDC, 5_000_000n, true), lifiStep(ZKSYNC_ZK, NONE, 1n, true)])), "refused", "not one the signer can read"],
  ["a zkSync LI.FI swap whose deposits cross the daily token limit", zk(ZKSYNC_LIFI, usdcToNative(own, [lifiStep(ZKSYNC_USDC, ZKSYNC_USDC, 6_000_000n, true), lifiStep(ZKSYNC_USDC, NONE, 6_000_000n, true)])), "refused", "above its whole 10000000 daily limit", own],
  ["a zkSync LI.FI swap sent to a diamond not listed for zkSync", zk(LIFI, usdcToNative(own)), "refused", "not listed for this chain", own],
  ["a real zkSync LI.FI USDC to ETH swap", real(zkUsdcToEth), "signed", null, own],
  ["a real zkSync LI.FI ETH to USDC swap", real("zkSync ETH to USDC"), "signed", null, own],
  ["a real Base LI.FI USDC to WETH swap", real("Base USDC to WETH"), "signed", null, own],
  ["a real Arbitrum LI.FI USDC to WETH swap", real("Arbitrum USDC to WETH"), "signed", null, own],
  ["a real zkSync LI.FI swap whose swap step calls and approves an attacker with minAmountOut 1", attacked, "refused", `the LI.FI swap step calls 0x${ATTACKER.slice(2)}, which is not a listed LI.FI step target`, own],
  ["a real zkSync LI.FI swap whose swap step approves an attacker", mutate(zkUsdcToEth, (steps, args) => { steps[1].approveTo = ATTACKER; return args; }), "refused", `the LI.FI swap step approves 0x${ATTACKER.slice(2)}, which is not a listed LI.FI step target`, own],
  ["a real zkSync LI.FI swap whose fee step forwards the whole sale to an attacker", mutate(zkUsdcToEth, (steps, args) => { steps[0].callData = encodeFunctionData({ abi: feeAbi, functionName: "forwardERC20Fees", args: [ZKSYNC_USDC, [{ recipient: ATTACKER, amount: 5_000_000n }]] }); return args; }), "refused", "the LI.FI fee steps forward 5000000, above 50 bps of the 5000000 the swap deposits", own],
  ["a real zkSync LI.FI swap whose fee step forwards one unit over 50 bps", mutate(zkUsdcToEth, (steps, args) => { steps[0].callData = encodeFunctionData({ abi: feeAbi, functionName: "forwardERC20Fees", args: [ZKSYNC_USDC, [{ recipient: ATTACKER, amount: 25_001n }]] }); return args; }), "refused", "the LI.FI fee steps forward 25001, above 50 bps of the 5000000 the swap deposits", own],
  ["a real zkSync LI.FI swap whose fee step forwards exactly 50 bps", mutate(zkUsdcToEth, (steps, args) => { steps[0].callData = encodeFunctionData({ abi: feeAbi, functionName: "forwardERC20Fees", args: [ZKSYNC_USDC, [{ recipient: ATTACKER, amount: 25_000n }]] }); return args; }), "signed", null, own],
  ["a real zkSync LI.FI swap whose fee step forwards balance shares", mutate(zkUsdcToEth, (steps, args) => { steps[0].callData = encodeFunctionData({ abi: feeAbi, functionName: "forwardERC20FeesShares", args: [ZKSYNC_USDC, [{ recipient: ATTACKER, share: 10n ** 18n }]] }); return args; }), "refused", "the LI.FI fee step is not a forwardERC20Fees or forwardNativeFees of the token the swap deposits", own],
  ["a real zkSync LI.FI swap whose fee step forwards another token", mutate(zkUsdcToEth, (steps, args) => { steps[0].callData = encodeFunctionData({ abi: feeAbi, functionName: "forwardERC20Fees", args: [ZKSYNC_ZK, [{ recipient: ATTACKER, amount: 1n }]] }); return args; }), "refused", "the LI.FI fee step is not a forwardERC20Fees or forwardNativeFees of the token the swap deposits", own],
  ["a real zkSync LI.FI swap whose second fee step claims an inflated fromAmount", mutate(zkUsdcToEth, (steps, args) => { steps[1] = { ...steps[0], requiresDeposit: false, fromAmount: 1_000_000_000n, callData: encodeFunctionData({ abi: feeAbi, functionName: "forwardERC20Fees", args: [ZKSYNC_USDC, [{ recipient: ATTACKER, amount: 4_987_500n }]] }) }; return [...args.slice(0, 4), 0n]; }), "refused", "the LI.FI fee steps forward 5000000, above 50 bps of the 5000000 the swap deposits", own],
  ["a real zkSync LI.FI native swap with a second native fee step", mutate("zkSync ETH to USDC", (steps, args) => { steps.splice(1, 0, { ...steps[0], callData: encodeFunctionData({ abi: nativeFeeAbi, functionName: "forwardNativeFees", args: [[{ recipient: ATTACKER, amount: 2_500_000_000_001n }]] }) }); return args; }), "refused", "the LI.FI fee steps forward 5000000000001, above 50 bps of the 1000000000000000 the swap deposits", own],
  ["a real Base LI.FI swap replayed on Optimism, which lists no LI.FI step targets", { ...real("Base USDC to WETH"), chainId: 10 }, "refused", "chain 10 lists no LI.FI swap step targets", own],
  ["a zkSync native transfer to a listed destination", zk(DESTINATION, "0x", 1_000_000_000_000_000n), "signed"],
  ["kyber simple swap to this wallet", tx(KYBER, encodeFunctionData({ abi: kyberAbi, functionName: "swapSimpleMode", args: [EXECUTOR, desc(own, 5_000_000n), "0x", "0x"] })), "signed", null, own],
  ["kyber swap paying an attacker", tx(KYBER, kyberSwap(desc(ATTACKER, 5_000_000n))), "refused", "not this wallet", ATTACKER],
  ["kyber swap to this wallet", tx(KYBER, kyberSwap(desc(own, 2_000_000n))), "signed", null, own],
  ["kyber swap sending the sold tokens to an attacker", tx(KYBER, kyberSwap(desc(own, 2_000_000n, { srcReceivers: [ATTACKER] }))), "refused", "listed Kyber executor", own],
  ["kyber swap whose executor is an attacker", tx(KYBER, kyberSwap(desc(own, 2_000_000n), { callTarget: ATTACKER })), "refused", "listed Kyber executor", own],
  ["kyber swap approving an attacker", tx(KYBER, kyberSwap(desc(own, 2_000_000n), { approveTarget: ATTACKER })), "refused", "listed Kyber executor", own],
  ["kyber swap paying a fee to an attacker", tx(KYBER, kyberSwap(desc(own, 2_000_000n, { feeReceivers: [ATTACKER], feeAmounts: [1_000_000n] }))), "refused", "listed Kyber executor", own],
  ["kyber simple swap through an attacker executor", tx(KYBER, encodeFunctionData({ abi: kyberAbi, functionName: "swapSimpleMode", args: [ATTACKER, desc(own, 5_000_000n), "0x", "0x"] })), "refused", "listed Kyber executor", own],
  ["kyber swap whose source amounts exceed the sold amount", tx(KYBER, kyberSwap(desc(own, 2_000_000n, { srcAmounts: [9_000_000n] }))), "refused", "not one the signer can read", own],
  ["0x exec into settler for this wallet", tx(ALLOWANCE_HOLDER, encodeFunctionData({ abi: holderAbi, functionName: "exec", args: [SETTLER, USDC, 3_000_000n, SETTLER, settlerCall(own)] })), "signed", null, own],
  ["0x exec into settler paying an attacker", tx(ALLOWANCE_HOLDER, encodeFunctionData({ abi: holderAbi, functionName: "exec", args: [SETTLER, USDC, 3_000_000n, SETTLER, settlerCall(ATTACKER)] })), "refused", "not this wallet", ATTACKER],
  ["0x exec whose operator and target are an attacker", tx(ALLOWANCE_HOLDER, encodeFunctionData({ abi: holderAbi, functionName: "exec", args: [ATTACKER, USDC, 3_000_000n, ATTACKER, settlerCall(own)] })), "refused", "pinned Settler", own],
  ["0x exec whose operator is not its target", tx(ALLOWANCE_HOLDER, encodeFunctionData({ abi: holderAbi, functionName: "exec", args: [ATTACKER, USDC, 3_000_000n, SETTLER, settlerCall(own)] })), "refused", "operator is not its target", own],
  ["settler execute sent to a contract that is not a pinned Settler", tx(KYBER, settlerCall(own)), "refused", "pinned Settler", own],
  ["direct settler execute with an unreadable sold amount", tx(SETTLER, settlerCall(own), 1n), "refused", "sold amount is not readable", own],
  ["0x exec above the daily token limit", tx(ALLOWANCE_HOLDER, encodeFunctionData({ abi: holderAbi, functionName: "exec", args: [SETTLER, USDC, 30_000_000n, SETTLER, settlerCall(own)] })), "refused", "above its whole 10000000 daily limit", own],
  ["usdc transfer to a listed destination", tx(USDC, encodeFunctionData({ abi: erc20, functionName: "transfer", args: [DESTINATION, 1_000_000n] })), "signed"],
  ["a usdc transfer that would wrap the daily total", tx(USDC, encodeFunctionData({ abi: erc20, functionName: "transfer", args: [DESTINATION, 2n ** 128n - 3_000_000n] })), "refused", "above its whole 10000000 daily limit"],
  ["usdc transfer to anyone else", tx(USDC, encodeFunctionData({ abi: erc20, functionName: "transfer", args: [ATTACKER, 1_000_000n] })), "refused", "listed destination"],
  ["bounded approval to a listed router", tx(USDC, encodeFunctionData({ abi: erc20, functionName: "approve", args: [ALLOWANCE_HOLDER, 5_000_000n] })), "signed"],
  ["unlimited approval", tx(USDC, encodeFunctionData({ abi: erc20, functionName: "approve", args: [ALLOWANCE_HOLDER, maxUint256] })), "refused", "not one the signer can read"],
  ["approval to an unlisted spender", tx(USDC, encodeFunctionData({ abi: erc20, functionName: "approve", args: [ATTACKER, 5_000_000n] })), "refused", "listed router"],
  ["native transfer to a listed destination", tx(DESTINATION, "0x", 1_000_000_000_000_000n), "signed"],
  ["a usdc transfer whose fee would burn the balance", tx(USDC, encodeFunctionData({ abi: erc20, functionName: "transfer", args: [DESTINATION, 1n] }), 0n, CHAIN_ID, { maxFeePerGas: 10n ** 18n, maxPriorityFeePerGas: 10n ** 18n }), "refused", "above the 1000000000000000 wei fee cap"],
  ["a priority fee above the max fee", tx(DESTINATION, "0x", 1n, CHAIN_ID, { maxFeePerGas: 1_000_000n, maxPriorityFeePerGas: 2_000_000n }), "refused", "maxPriorityFeePerGas is above maxFeePerGas"],
  ["a native transfer whose fee crosses the native day", tx(DESTINATION, "0x", 4_500_000_000_000_000n), "refused", "above the 5000000000000000 limit"],
  ["a native transfer that would wrap the daily total", tx(DESTINATION, "0x", 2n ** 128n - 1n), "refused", "above its whole 5000000000000000 daily limit"],
  ["native transfer to anyone else", tx(ATTACKER, "0x", 1n), "refused", "listed destination"],
  ["an undecoded router call", tx(LIFI, "0x12345678"), "refused", "not one the signer can read"],
  ["a chain outside the policy", tx(KYBER, encodeFunctionData({ abi: kyberAbi, functionName: "swapSimpleMode", args: [EXECUTOR, desc(own, 1n), "0x", "0x"] }), 0n, 137), "refused", "chain 137 is not in the policy"],
  ["a Base kyber swap charged its gas plus the L1 fee budget", baseSwap, "signed", null, own, { [`${BASE}:native`]: String(baseSwap.gas * baseSwap.maxFeePerGas + BASE_L1.maxFeeWei), [`${BASE}:${USDC.toLowerCase()}`]: "5000000" }],
  ["a Base swap whose calldata is above the L1 fee budget cap", tx(KYBER, kyberSwap(desc(own, 1n), { targetData: `0x${"ab".repeat(BASE_L1.maxDataBytes)}` }), 0n, BASE), "refused", `above the ${BASE_L1.maxDataBytes}-byte cap the L1 fee budget covers`, own],
  ["a Scroll swap whose L1 fee budget lifts the fee over the cap", tx(KYBER, encodeFunctionData({ abi: kyberAbi, functionName: "swapSimpleMode", args: [EXECUTOR, desc(own, 1n), "0x", "0x"] }), 0n, 534352), "refused", "above the 1000000000000000 wei fee cap"],
  ["a Blast transaction whose L1 data fee has no budget", tx(KYBER, encodeFunctionData({ abi: kyberAbi, functionName: "swapSimpleMode", args: [EXECUTOR, desc(own, 1n), "0x", "0x"] }), 0n, 81457), "refused", "separate L1 data fee"],
  ["a swap with native value above the cap", tx(KYBER, encodeFunctionData({ abi: kyberAbi, functionName: "swapSimpleMode", args: [EXECUTOR, desc(own, 1n), "0x", "0x"] }), 10n ** 18n), "refused", "above the"],
  ["a usdc transfer that sends native value", tx(USDC, encodeFunctionData({ abi: erc20, functionName: "transfer", args: [DESTINATION, 1_000_000n] }), 1n), "refused", "must send no native value"],
  ["an approval naming a pinned Settler", tx(USDC, encodeFunctionData({ abi: erc20, functionName: "approve", args: [SETTLER, 5_000_000n] })), "refused", "a pinned Settler, whose actions can spend it"],
  ["a kyber swap sent to an unlisted router", tx(DESTINATION, encodeFunctionData({ abi: kyberAbi, functionName: "swapSimpleMode", args: [EXECUTOR, desc(own, 1n), "0x", "0x"] })), "refused", "not listed for this chain"],
  ["an approval of a token with no daily limit", tx(WETH, encodeFunctionData({ abi: erc20, functionName: "approve", args: [ALLOWANCE_HOLDER, 1n] })), "refused", "no daily limit is set for"],
];

const account = privateKeyToAccount(EVM_KEY);
const evm = [];
for (const [name, transaction, expect, reason, recipient, spent] of [...evmCases, ...bridgeCases]) {
  const entry = { name, job: job(name, transaction), expect, ...(reason ? { reason } : {}), ...(recipient ? { recipient } : {}), ...(spent ? { spent } : {}) };
  if (expect === "signed") entry.signedTransaction = await account.signTransaction(transaction);
  evm.push(entry);
}

const pkcs8 = Buffer.concat([Buffer.from("302e020100300506032b657004220420", "hex"), SOLANA_SEED]);
const solanaKey = createPrivateKey({ key: pkcs8, format: "der", type: "pkcs8" });
const solanaOwn = createPublicKey(solanaKey).export({ format: "der", type: "spki" }).subarray(12);
const SYSTEM = Buffer.alloc(32);
const COMPUTE = Buffer.from(bs58.decode("ComputeBudget111111111111111111111111111111"));
const JUPITER = Buffer.from(bs58.decode("JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4"));
const SOL_DEST = Buffer.alloc(32, 0x33);
const STRANGER = Buffer.alloc(32, 0x44);
const short = (value) => Buffer.from([value]);
const u32 = (value) => { const out = Buffer.alloc(4); out.writeUInt32LE(value); return out; };
const u64 = (value) => { const out = Buffer.alloc(8); out.writeBigUInt64LE(BigInt(value)); return out; };
const ix = (program, accounts, data) => Buffer.concat([short(program), short(accounts.length), Buffer.from(accounts), short(data.length), data]);
const message = ({ signers = 1, keys, instructions, version = null, lookups = [] }) => {
  const parts = [];
  if (version !== null) parts.push(Buffer.from([0x80 | version]));
  parts.push(Buffer.from([signers, 0, keys.length - signers]), short(keys.length), ...keys, Buffer.alloc(32, 9), short(instructions.length), ...instructions);
  if (version !== null) parts.push(short(lookups.length), ...lookups.map((table) => Buffer.concat([table.key, short(table.writable.length), Buffer.from(table.writable), short(0)])));
  return Buffer.concat(parts);
};
const transfer = (system, to, lamports) => ix(system, [0, to], Buffer.concat([u32(2), u64(lamports)]));
const price = (compute, micro) => ix(compute, [], Buffer.concat([Buffer.from([3]), u64(micro)]));
const limit = (compute, units) => ix(compute, [], Buffer.concat([Buffer.from([2]), u32(units)]));
const ATA_PROGRAM = new PublicKey("ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL");
const TOKEN_PROGRAM = new PublicKey("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA");
const WSOL_MINT = new PublicKey("So11111111111111111111111111111111111111112");
const WRAPPED_SOL = PublicKey.findProgramAddressSync([solanaOwn, TOKEN_PROGRAM.toBuffer(), WSOL_MINT.toBuffer()], ATA_PROGRAM)[0].toBuffer();
const keys = [solanaOwn, SOL_DEST, SYSTEM, COMPUTE];
const USDC_MINT = new PublicKey("EPjFWdd5AufqSSqeM2qN1xzZBapC6G4wPGxDyEbo1BnD").toBuffer();
const DEST_USDC = PublicKey.findProgramAddressSync([SOL_DEST, TOKEN_PROGRAM.toBuffer(), USDC_MINT], ATA_PROGRAM)[0].toBuffer();
const createAta = message({ keys: [solanaOwn, DEST_USDC, SOL_DEST, USDC_MINT, SYSTEM, TOKEN_PROGRAM.toBuffer(), ATA_PROGRAM.toBuffer()], instructions: [ix(6, [0, 1, 2, 3, 4, 5], Buffer.from([1]))] });
const OWN_USDC = PublicKey.findProgramAddressSync([solanaOwn, TOKEN_PROGRAM.toBuffer(), USDC_MINT], ATA_PROGRAM)[0].toBuffer();
const createOwnAta = message({ keys: [solanaOwn, OWN_USDC, USDC_MINT, SYSTEM, TOKEN_PROGRAM.toBuffer(), ATA_PROGRAM.toBuffer()], instructions: [ix(5, [0, 1, 0, 2, 3, 4], Buffer.from([1]))] });
const solanaCases = [
  ["sol transfer to a listed destination", message({ keys, instructions: [limit(3, 200_000), price(3, 1_000), transfer(2, 1, 1_000_000)] }), "signed"],
  ["sol transfer into this wallet's wrapped SOL account", message({ keys: [solanaOwn, WRAPPED_SOL, SYSTEM, COMPUTE], instructions: [transfer(2, 1, 5_000_000_000)] }), "signed"],
  ["an associated token account for a listed destination", createAta, "signed"],
  ["an associated token account for this wallet", createOwnAta, "signed"],
  ["sol transfer to a stranger", message({ keys: [solanaOwn, STRANGER, SYSTEM, COMPUTE], instructions: [transfer(2, 1, 1)] }), "refused", "listed destination"],
  ["a second required signer", message({ signers: 2, keys: [solanaOwn, STRANGER, SYSTEM, COMPUTE], instructions: [transfer(2, 1, 1)] }), "refused", "only signer"],
  ["a program the policy does not list", message({ keys: [solanaOwn, STRANGER], instructions: [ix(1, [0], Buffer.from([1]))] }), "refused", "does not list"],
  ["priority a fraction of a lamport above the cap", message({ keys, instructions: [limit(3, 200_000), price(3, 500_001)] }), "refused", "100001 lamports"],
  ["priority above the cap", message({ keys, instructions: [limit(3, 1_400_000), price(3, 10_000_000)] }), "refused", "priority fees"],
  ["a jupiter v0 swap with a lookup table", message({ version: 0, keys: [solanaOwn, JUPITER, COMPUTE], instructions: [limit(2, 300_000), price(2, 100), ix(1, [0, 3, 4], Buffer.from("e517cb977ae3ad2a", "hex"))], lookups: [{ key: Buffer.alloc(32, 7), writable: [1, 2] }] }), "refused", "only Jupiter shared_accounts_route is signed, not route"],
  ["a v0 sol transfer with a lookup table", message({ version: 0, keys, instructions: [limit(3, 200_000), price(3, 100), transfer(2, 1, 1_000)], lookups: [{ key: Buffer.alloc(32, 7), writable: [1] }] }), "signed"],
  ["a transfer whose destination comes from a lookup table", message({ version: 0, keys: [solanaOwn, SYSTEM], instructions: [ix(1, [0, 2], Buffer.concat([u32(2), u64(5)]))], lookups: [{ key: Buffer.alloc(32, 7), writable: [1] }] }), "refused", "lookup table"],
  ["an instruction whose program comes from a lookup table", message({ version: 0, keys: [solanaOwn, SYSTEM], instructions: [ix(2, [0], Buffer.from([1]))], lookups: [{ key: Buffer.alloc(32, 7), writable: [1] }] }), "refused", "names its program through a lookup table"],
  ["a System instruction other than a SOL transfer", message({ keys, instructions: [ix(2, [0, 1], u32(0))] }), "refused", "only a SOL transfer from this wallet"],
  ["an unknown compute budget instruction", message({ keys, instructions: [ix(3, [], Buffer.from([9]))] }), "refused", "unknown compute budget instruction"],
  ["a token transfer to an unlisted token account", message({ keys: [solanaOwn, STRANGER, USDC_MINT, TOKEN_PROGRAM.toBuffer()], instructions: [ix(3, [0, 2, 1, 0], Buffer.concat([Buffer.from([12]), u64(1), Buffer.from([6])]))] }), "refused", "may only pay a listed token account"],
  ["a token approve", message({ keys: [solanaOwn, STRANGER, TOKEN_PROGRAM.toBuffer()], instructions: [ix(2, [0, 1, 0], Buffer.concat([Buffer.from([4]), u64(1)]))] }), "refused", "this token instruction is not allowed"],
  ["an associated token account funded by a stranger", message({ keys: [solanaOwn, DEST_USDC, SOL_DEST, USDC_MINT, SYSTEM, TOKEN_PROGRAM.toBuffer(), ATA_PROGRAM.toBuffer(), STRANGER], instructions: [ix(6, [7, 1, 2, 3, 4, 5], Buffer.from([1]))] }), "refused", "must be funded by this wallet"],
];
const solana = solanaCases.map(([name, bytes, expect, reason]) => ({
  name,
  job: { id: name, kind: "solana", message: bytes.toString("base64") },
  expect,
  ...(reason ? { reason } : {}),
  ...(expect === "signed" ? { signature: bs58.encode(sign(null, bytes, solanaKey)) } : {}),
}));

const policy = {
  version: 1,
  evm: {
    chains: [CHAIN_ID, 10, BASE, 81457, 534352, ZKSYNC, ARBITRUM],
    routers: { [CHAIN_ID]: [KYBER, ALLOWANCE_HOLDER], 10: [LIFI], [BASE]: [KYBER, LIFI], [ZKSYNC]: [ZKSYNC_LIFI], [ARBITRUM]: [LIFI] },
    settlers: { [CHAIN_ID]: [SETTLER] },
    kyberExecutors: { [CHAIN_ID]: [EXECUTOR], [BASE]: [EXECUTOR] },
    bridges: { [BASE]: { lifi: LIFI_DIAMOND, across: BASE_SPOKE_POOL } },
    maxBridgeFeeBps: 100,
    destinations: [DESTINATION, LISTED_BRIDGE_DESTINATION],
    maxValueWei: "2000000000000000",
    maxFeeWei: "1000000000000000",
    dailyLimits: { [`${CHAIN_ID}:${USDC}`]: "10000000", [`${CHAIN_ID}:native`]: "5000000000000000", [`${BASE}:${USDC}`]: "10000000", [`${BASE}:native`]: "5000000000000000", [`${ZKSYNC}:${ZKSYNC_USDC}`]: "10000000", [`${ZKSYNC}:native`]: "5000000000000000", [`${ARBITRUM}:${ARBITRUM_USDC}`]: "200000000", [`${ARBITRUM}:native`]: "5000000000000000" },
  },
  solana: {
    programs: ["JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4"],
    destinations: [bs58.encode(SOL_DEST)],
    maxPriorityLamports: "100000",
    dailyLimits: { "solana:native": "2000000000" },
  },
  hypercore: {
    network: "testnet",
    maxLeverage: 1,
    dailyLimits: { "hypercore:usdc": "50000000", "hypercore:spot:10107": "20000000", "hypercore:perp:4:sold": "50000000000" },
  },
};
const HL_NONCE = 1_793_664_000_000;
const zero = "0x0000000000000000000000000000000000000000";
const splitSig = (hex) => ({ r: `0x${hex.slice(2, 66)}`, s: `0x${hex.slice(66, 130)}`, v: Number.parseInt(hex.slice(130, 132), 16) });
const l1Signature = async (action, nonce) => {
  const tail = Buffer.alloc(9);
  tail.writeBigUInt64BE(BigInt(nonce));
  const connectionId = keccak256(Buffer.concat([Buffer.from(encode(action)), tail]));
  return splitSig(await account.signTypedData({ domain: { name: "Exchange", version: "1", chainId: 1337, verifyingContract: zero }, types: { Agent: [{ name: "source", type: "string" }, { name: "connectionId", type: "bytes32" }] }, primaryType: "Agent", message: { source: "b", connectionId } }));
};
const withdrawSignature = async (action) =>
  splitSig(
    await account.signTypedData({
      domain: { name: "HyperliquidSignTransaction", version: "1", chainId: 0x66eee, verifyingContract: zero },
      types: { "HyperliquidTransaction:Withdraw": [{ name: "hyperliquidChain", type: "string" }, { name: "destination", type: "string" }, { name: "amount", type: "string" }, { name: "time", type: "uint64" }] },
      primaryType: "HyperliquidTransaction:Withdraw",
      message: { hyperliquidChain: action.hyperliquidChain, destination: action.destination, amount: action.amount, time: BigInt(action.time) },
    }),
  );
const hlOrder = (a, p, sz, tif = "Ioc") => ({ type: "order", orders: [{ a, b: true, p, s: sz, r: false, t: { limit: { tif } } }], grouping: "na" });
const hlWithdraw = (destination, amount) => ({ type: "withdraw3", hyperliquidChain: "Testnet", signatureChainId: "0x66eee", destination, amount, time: HL_NONCE });
const hypercoreCases = [
  ["isolated leverage 1", { type: "updateLeverage", asset: 4, isCross: false, leverage: 1 }, "signed"],
  ["a perp ioc order", hlOrder(4, "1670.1", "0.0147"), "signed"],
  ["a spot ioc order", hlOrder(10107, "12.5", "1"), "signed"],
  ["a cancel with a large order id", { type: "cancel", cancels: [{ a: 4, o: 91_000_000_000 }, { a: 300, o: 70_000 }] }, "signed"],
  ["a withdrawal to this wallet", hlWithdraw(own.toLowerCase(), "10"), "signed"],
  ["a withdrawal to a listed destination", hlWithdraw(DESTINATION, "1.5"), "signed"],
  ["a withdrawal to an attacker", hlWithdraw(ATTACKER, "1"), "refused", "may only pay this wallet or a listed destination"],
  ["a resting order", hlOrder(4, "1", "1", "Gtc"), "refused", "only immediate-or-cancel"],
  ["a reduce-only perp sell", { type: "order", orders: [{ a: 4, b: false, p: "0.995", s: "5", r: true, t: { limit: { tif: "Ioc" } } }], grouping: "na" }, "signed"],
  ["a perp short", { type: "order", orders: [{ a: 4, b: false, p: "0.2", s: "250", r: false, t: { limit: { tif: "Ioc" } } }], grouping: "na" }, "signed"],
  ["a perp short with no size limit", { type: "order", orders: [{ a: 5, b: false, p: "0.2", s: "250", r: false, t: { limit: { tif: "Ioc" } } }], grouping: "na" }, "refused", "no daily limit is set for hypercore:perp:5:sold"],
  ["a reduce-only perp dump at a near-zero price", { type: "order", orders: [{ a: 4, b: false, p: "0.00000001", s: "99999999999", r: true, t: { limit: { tif: "Ioc" } } }], grouping: "na" }, "refused", "above its whole 50000000000 daily limit"],
];
const hypercore = [];
for (const [name, action, expect, reason] of hypercoreCases) {
  const signature = expect !== "signed" ? null : action.type === "withdraw3" ? await withdrawSignature(action) : await l1Signature(action, HL_NONCE);
  hypercore.push({ name, job: { id: name, kind: "hypercore", network: "testnet", nonce: HL_NONCE, action }, expect, ...(reason ? { reason } : {}), ...(signature ? { signature } : {}) });
}
writeFileSync(`${out}chains.json`, `${JSON.stringify(signerChainTable(), null, 2)}\n`);
const bridgeTokens = Object.entries(BRIDGE_TOKENS).flatMap(([symbol, byChain]) => Object.entries(byChain).map(([chainId, token]) => ({ symbol, chainId: Number(chainId), address: token.address.toLowerCase(), decimals: token.decimals })));
writeFileSync(`${out}bridge-tokens.json`, `${JSON.stringify(bridgeTokens, null, 2)}\n`);
writeFileSync(`${out}lifi-steps.json`, `${JSON.stringify(LIFI_STEP_TARGETS, null, 2)}\n`);
writeFileSync(`${out}policy.json`, `${JSON.stringify(policy, null, 2)}\n`);
const registration = "Whale signer registration\nwallet:8f0c1a52-3f0e-4c7e-9a0b-0d9c1f6a2b31\ncode:wreg_example";
const personalSign = { message: registration, signature: await account.signMessage({ message: registration }) };
writeFileSync(`${out}evm.json`, `${JSON.stringify({ evmKey: EVM_KEY, own, personalSign, cases: evm }, null, 2)}\n`);
writeFileSync(`${out}solana.json`, `${JSON.stringify({ seed: SOLANA_SEED.toString("hex"), own: bs58.encode(solanaOwn), cases: solana }, null, 2)}\n`);
writeFileSync(`${out}hypercore.json`, `${JSON.stringify({ cases: hypercore }, null, 2)}\n`);
console.log(`wrote ${evm.length} evm, ${solana.length} solana and ${hypercore.length} hypercore vectors for ${own} and ${bs58.encode(solanaOwn)}`);
