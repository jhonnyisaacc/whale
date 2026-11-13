import { createPrivateKey, createPublicKey, sign } from "node:crypto";
import { writeFileSync } from "node:fs";
import { PublicKey } from "@solana/web3.js";
import bs58 from "bs58";
import { encodeFunctionData, maxUint256, parseAbi } from "viem";
import { privateKeyToAccount } from "viem/accounts";

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
const USDC = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";
const WETH = "0x4200000000000000000000000000000000000006";

const kyberAbi = parseAbi([
  "struct SwapDescriptionV2 { address srcToken; address dstToken; address[] srcReceivers; uint256[] srcAmounts; address[] feeReceivers; uint256[] feeAmounts; address dstReceiver; uint256 amount; uint256 minReturnAmount; uint256 flags; bytes permit; }",
  "struct SwapExecutionParams { address callTarget; address approveTarget; bytes targetData; SwapDescriptionV2 desc; bytes clientData; }",
  "function swap(SwapExecutionParams execution) payable returns (uint256 returnAmount, uint256 gasUsed)",
  "function swapSimpleMode(address caller, SwapDescriptionV2 desc, bytes executorData, bytes clientData) returns (uint256 returnAmount, uint256 gasUsed)",
]);
const holderAbi = parseAbi(["function exec(address operator, address token, uint256 amount, address target, bytes data) payable returns (bytes result)"]);
const settlerAbi = parseAbi(["struct AllowedSlippage { address recipient; address buyToken; uint256 minAmountOut; }", "function execute(AllowedSlippage slippage, bytes[] actions, bytes32 zid) payable returns (bool)"]);
const erc20 = parseAbi(["function transfer(address to, uint256 amount)", "function approve(address spender, uint256 amount)"]);

const desc = (recipient, amount, overrides = {}) => ({ srcToken: USDC, dstToken: WETH, srcReceivers: [EXECUTOR], srcAmounts: [amount], feeReceivers: [], feeAmounts: [], dstReceiver: recipient, amount, minReturnAmount: 1n, flags: 0n, permit: "0x", ...overrides });
const kyberSwap = (description, execution = {}) => encodeFunctionData({ abi: kyberAbi, functionName: "swap", args: [{ callTarget: EXECUTOR, approveTarget: NONE, targetData: "0xabcdef", desc: description, clientData: "0x01", ...execution }] });
const settlerCall = (recipient) => encodeFunctionData({ abi: settlerAbi, functionName: "execute", args: [{ recipient, buyToken: WETH, minAmountOut: 1n }, ["0x1234"], `0x${"00".repeat(32)}`] });
const tx = (to, data = "0x", value = 0n, chainId = 8453, fees = {}) => ({ chainId, nonce: 7, to, value, data, gas: 300000n, maxFeePerGas: 2_000_000_000n, maxPriorityFeePerGas: 1_000_000n, type: "eip1559", ...fees });
const job = (name, transaction) => ({ id: name, kind: "evm", chainId: transaction.chainId, tx: { nonce: String(transaction.nonce), to: transaction.to, value: String(transaction.value), data: transaction.data, gas: String(transaction.gas), maxFeePerGas: String(transaction.maxFeePerGas), maxPriorityFeePerGas: String(transaction.maxPriorityFeePerGas) } });

const evmCases = [
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
  ["0x exec above the daily token limit", tx(ALLOWANCE_HOLDER, encodeFunctionData({ abi: holderAbi, functionName: "exec", args: [SETTLER, USDC, 30_000_000n, SETTLER, settlerCall(own)] })), "refused", "above the 10000000 limit", own],
  ["usdc transfer to a listed destination", tx(USDC, encodeFunctionData({ abi: erc20, functionName: "transfer", args: [DESTINATION, 1_000_000n] })), "signed"],
  ["usdc transfer to anyone else", tx(USDC, encodeFunctionData({ abi: erc20, functionName: "transfer", args: [ATTACKER, 1_000_000n] })), "refused", "listed destination"],
  ["bounded approval to a listed router", tx(USDC, encodeFunctionData({ abi: erc20, functionName: "approve", args: [ALLOWANCE_HOLDER, 5_000_000n] })), "signed"],
  ["unlimited approval", tx(USDC, encodeFunctionData({ abi: erc20, functionName: "approve", args: [ALLOWANCE_HOLDER, maxUint256] })), "refused", "not one the signer can read"],
  ["approval to an unlisted spender", tx(USDC, encodeFunctionData({ abi: erc20, functionName: "approve", args: [ATTACKER, 5_000_000n] })), "refused", "listed router"],
  ["native transfer to a listed destination", tx(DESTINATION, "0x", 1_000_000_000_000_000n), "signed"],
  ["a usdc transfer whose fee would burn the balance", tx(USDC, encodeFunctionData({ abi: erc20, functionName: "transfer", args: [DESTINATION, 1n] }), 0n, 8453, { maxFeePerGas: 10n ** 18n, maxPriorityFeePerGas: 10n ** 18n }), "refused", "above the 1000000000000000 wei fee cap"],
  ["a priority fee above the max fee", tx(DESTINATION, "0x", 1n, 8453, { maxFeePerGas: 1_000_000n, maxPriorityFeePerGas: 2_000_000n }), "refused", "maxPriorityFeePerGas is above maxFeePerGas"],
  ["a native transfer whose fee crosses the native day", tx(DESTINATION, "0x", 4_500_000_000_000_000n), "refused", "above the 5000000000000000 limit"],
  ["native transfer to anyone else", tx(ATTACKER, "0x", 1n), "refused", "listed destination"],
  ["an undecoded router call", tx(LIFI, "0x12345678"), "refused", "not one the signer can read"],
  ["a chain outside the policy", tx(KYBER, encodeFunctionData({ abi: kyberAbi, functionName: "swapSimpleMode", args: [EXECUTOR, desc(own, 1n), "0x", "0x"] }), 0n, 1), "refused", "chain 1 is not in the policy"],
  ["a swap with native value above the cap", tx(KYBER, encodeFunctionData({ abi: kyberAbi, functionName: "swapSimpleMode", args: [EXECUTOR, desc(own, 1n), "0x", "0x"] }), 10n ** 18n), "refused", "above the"],
];

const account = privateKeyToAccount(EVM_KEY);
const evm = [];
for (const [name, transaction, expect, reason, recipient] of evmCases) {
  const entry = { name, job: job(name, transaction), expect, ...(reason ? { reason } : {}), ...(recipient ? { recipient } : {}) };
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
const solanaCases = [
  ["sol transfer to a listed destination", message({ keys, instructions: [limit(3, 200_000), price(3, 1_000), transfer(2, 1, 1_000_000)] }), "signed"],
  ["sol transfer into this wallet's wrapped SOL account", message({ keys: [solanaOwn, WRAPPED_SOL, SYSTEM, COMPUTE], instructions: [transfer(2, 1, 5_000_000_000)] }), "signed"],
  ["sol transfer to a stranger", message({ keys: [solanaOwn, STRANGER, SYSTEM, COMPUTE], instructions: [transfer(2, 1, 1)] }), "refused", "listed destination"],
  ["a second required signer", message({ signers: 2, keys: [solanaOwn, STRANGER, SYSTEM, COMPUTE], instructions: [transfer(2, 1, 1)] }), "refused", "only signer"],
  ["a program the policy does not list", message({ keys: [solanaOwn, STRANGER], instructions: [ix(1, [0], Buffer.from([1]))] }), "refused", "does not list"],
  ["priority a fraction of a lamport above the cap", message({ keys, instructions: [limit(3, 200_000), price(3, 500_001)] }), "refused", "100001 lamports"],
  ["priority above the cap", message({ keys, instructions: [limit(3, 1_400_000), price(3, 10_000_000)] }), "refused", "priority fees"],
  ["a jupiter v0 swap with a lookup table", message({ version: 0, keys: [solanaOwn, JUPITER, COMPUTE], instructions: [limit(2, 300_000), price(2, 100), ix(1, [0, 3, 4], Buffer.from("e517cb977ae3ad2a", "hex"))], lookups: [{ key: Buffer.alloc(32, 7), writable: [1, 2] }] }), "refused", "no instruction rule"],
  ["a v0 sol transfer with a lookup table", message({ version: 0, keys, instructions: [limit(3, 200_000), price(3, 100), transfer(2, 1, 1_000)], lookups: [{ key: Buffer.alloc(32, 7), writable: [1] }] }), "signed"],
  ["a transfer whose destination comes from a lookup table", message({ version: 0, keys: [solanaOwn, SYSTEM], instructions: [ix(1, [0, 2], Buffer.concat([u32(2), u64(5)]))], lookups: [{ key: Buffer.alloc(32, 7), writable: [1] }] }), "refused", "lookup table"],
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
    chains: [8453],
    routers: { 8453: [KYBER, ALLOWANCE_HOLDER] },
    settlers: { 8453: [SETTLER] },
    kyberExecutors: { 8453: [EXECUTOR] },
    destinations: [DESTINATION],
    maxValueWei: "2000000000000000",
    maxFeeWei: "1000000000000000",
    dailyLimits: { [`8453:${USDC}`]: "10000000", "8453:native": "5000000000000000" },
  },
  solana: {
    programs: ["JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4"],
    destinations: [bs58.encode(SOL_DEST)],
    maxPriorityLamports: "100000",
    dailyLimits: { "solana:native": "2000000000" },
  },
};
writeFileSync(`${out}policy.json`, `${JSON.stringify(policy, null, 2)}\n`);
writeFileSync(`${out}evm.json`, `${JSON.stringify({ evmKey: EVM_KEY, own, cases: evm }, null, 2)}\n`);
writeFileSync(`${out}solana.json`, `${JSON.stringify({ seed: SOLANA_SEED.toString("hex"), own: bs58.encode(solanaOwn), cases: solana }, null, 2)}\n`);
console.log(`wrote ${evm.length} evm and ${solana.length} solana vectors for ${own} and ${bs58.encode(solanaOwn)}`);
