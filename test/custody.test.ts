import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { ComputeBudgetProgram, Keypair, PublicKey, SystemProgram, TransactionInstruction, TransactionMessage, VersionedTransaction } from "@solana/web3.js";
import { encodeFunctionData, erc20Abi, maxUint256, parseAbi, parseSignature } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { configSecrets, loadConfig } from "../src/config.js";
import { readHiddenLine, writeKeystoreFile } from "../src/create-wallet.js";
import { buildLeverage } from "../src/hyperliquid.js";
import { SETTLER, kyberData, zeroExData } from "./fixtures.js";
import { loadManagedSigner, turnkeySigner, withPolicy, type TransactionSigner, type TurnkeyApi } from "../src/managed-signer.js";
import { assertEvmSigning, associatedTokenAddress, DEFAULT_MAX_VALUE_WEI, JITO_TIP_ACCOUNTS, JUPITER_PROGRAM_ID, turnkeyPolicyDocument, wrappedSolAccount } from "../src/signing-policy.js";

const tokenAuth = "0123456789abcdef";
const SYSTEM = SystemProgram.programId;
const TOKEN = new PublicKey("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA");
const ATA = new PublicKey("ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL");
const JUP = new PublicKey(JUPITER_PROGRAM_ID);

function solanaSigner(payer: PublicKey, calls: string[]): TransactionSigner {
  return {
    backend: "keystore",
    evmAddress: () => null,
    solanaAddress: () => payer.toBase58(),
    async signEvm() {
      return "0x";
    },
    async signSolana() {
      calls.push("solana");
      return new Uint8Array();
    },
    async signHyperliquid() {
      return { r: "0x01", s: "0x02", v: 27 };
    },
  };
}

function serialize(payer: PublicKey, instructions: TransactionInstruction[]): Uint8Array {
  return new VersionedTransaction(
    new TransactionMessage({ payerKey: payer, recentBlockhash: "11111111111111111111111111111111", instructions }).compileToV0Message(),
  ).serialize();
}

function raw(programId: PublicKey, keys: PublicKey[], data: Buffer, signer?: PublicKey): TransactionInstruction {
  return new TransactionInstruction({
    programId,
    keys: keys.map((pubkey) => ({ pubkey, isSigner: signer !== undefined && pubkey.equals(signer), isWritable: true })),
    data,
  });
}

function u32(value: number, rest = 0): Buffer {
  const data = Buffer.alloc(4 + rest);
  data.writeUInt32LE(value, 0);
  return data;
}

function sharedRoute(payer: PublicKey, destination: PublicKey, outMint: PublicKey, fee = JUP): TransactionInstruction {
  const filler = () => Keypair.generate().publicKey;
  return raw(
    JUP,
    [TOKEN, filler(), payer, new PublicKey(wrappedSolAccount(payer.toBase58())), filler(), filler(), destination, new PublicKey("So11111111111111111111111111111111111111112"), outMint, fee, JUP, filler(), JUP],
    Buffer.concat([Buffer.from("c1209b3341d69c81", "hex"), Buffer.alloc(24)]),
    payer,
  );
}

test("a shared-accounts jupiter route into the hot wallet's token account is signed", async () => {
  const payer = Keypair.generate().publicKey;
  const outMint = Keypair.generate().publicKey;
  const ownAta = new PublicKey(associatedTokenAddress(payer.toBase58(), outMint.toBase58(), TOKEN.toBase58()));
  const calls: string[] = [];
  const policy = withPolicy(solanaSigner(payer, calls), loadConfig({}));
  await policy.signSolana(serialize(payer, [sharedRoute(payer, ownAta, outMint)]));
  assert.deepEqual(calls, ["solana"]);
});

test("each banned solana instruction is denied before the backend signs", async () => {
  const payer = Keypair.generate().publicKey;
  const stranger = Keypair.generate().publicKey;
  const mint = Keypair.generate().publicKey;
  const ownWsol = new PublicKey(wrappedSolAccount(payer.toBase58()));
  const strangerAta = new PublicKey(associatedTokenAddress(stranger.toBase58(), mint.toBase58(), TOKEN.toBase58()));
  const closeToStranger = Buffer.from([9]);
  const approveData = Buffer.alloc(9);
  approveData.writeUInt8(4, 0);
  approveData.writeBigUInt64LE(1000n, 1);
  const approveChecked = Buffer.alloc(10);
  approveChecked.writeUInt8(13, 0);
  const setAuthority = Buffer.concat([Buffer.from([6, 2, 1]), stranger.toBuffer()]);
  const initForeign = Buffer.concat([Buffer.from([18]), stranger.toBuffer()]);
  const cases: Array<[string, TransactionInstruction, RegExp]> = [
    ["System CreateAccount", SystemProgram.createAccount({ fromPubkey: payer, newAccountPubkey: stranger, lamports: 1, space: 0, programId: SYSTEM }), /instruction is not allowed 1{32} 0/],
    ["System Assign", SystemProgram.assign({ accountPubkey: payer, programId: stranger }), /instruction is not allowed 1{32} 1/],
    ["System AdvanceNonceAccount", raw(SYSTEM, [stranger, SystemProgram.programId, payer], u32(4), payer), /instruction is not allowed 1{32} 4/],
    ["System TransferWithSeed", raw(SYSTEM, [payer, payer, stranger], u32(11, 40), payer), /instruction is not allowed 1{32} 11/],
    ["System Transfer from a foreign account", raw(SYSTEM, [stranger, payer], u32(2, 8), payer), /source is not the hot wallet/],
    ["Token Approve", raw(TOKEN, [ownWsol, stranger, payer], approveData, payer), /instruction is not allowed Tokenkeg\S+ 4/],
    ["Token ApproveChecked", raw(TOKEN, [ownWsol, mint, stranger, payer], approveChecked, payer), /instruction is not allowed Tokenkeg\S+ 13/],
    ["Token SetAuthority", raw(TOKEN, [ownWsol, payer], setAuthority, payer), /instruction is not allowed Tokenkeg\S+ 6/],
    ["Token CloseAccount to a stranger", raw(TOKEN, [ownWsol, stranger, payer], closeToStranger, payer), /close account destination/],
    ["Token InitializeAccount3 for a stranger", raw(TOKEN, [ownWsol, mint], initForeign), /owner is not the hot wallet/],
    ["Token TransferChecked to a stranger", raw(TOKEN, [ownWsol, mint, strangerAta, payer], Buffer.concat([Buffer.from([12]), Buffer.alloc(9)]), payer), /token transfer destination/],
    ["ATA legacy Create", raw(ATA, [payer, strangerAta, stranger, mint, SYSTEM, TOKEN], Buffer.alloc(0), payer), /instruction is not allowed ATokenGP\S+ empty/],
    ["ATA CreateIdempotent for a stranger", raw(ATA, [payer, strangerAta, stranger, mint, SYSTEM, TOKEN], Buffer.from([1]), payer), /owner is not allowlisted/],
    ["Jupiter route to a foreign token account", sharedRoute(payer, strangerAta, mint), /jupiter destination is not a hot wallet token account/],
    ["Jupiter route with a platform fee", sharedRoute(payer, new PublicKey(associatedTokenAddress(payer.toBase58(), mint.toBase58(), TOKEN.toBase58())), mint, strangerAta), /platform fee/],
    ["Jupiter unknown instruction", raw(JUP, [payer], Buffer.from([1, 2, 3, 4, 5, 6, 7, 8]), payer), /instruction is not allowed JUP6\S+ 0102030405060708/],
  ];
  for (const [name, instruction, reason] of cases) {
    const calls: string[] = [];
    const policy = withPolicy(solanaSigner(payer, calls), loadConfig({}));
    await assert.rejects(() => policy.signSolana(serialize(payer, [instruction])), reason, name);
    assert.deepEqual(calls, [], name);
  }
});

test("jito tips and compute-unit priority fees are capped by the signing policy", async () => {
  const payer = Keypair.generate().publicKey;
  const config = loadConfig({ SOLANA_MAX_PRIORITY_LAMPORTS: "1000000", JITO_TIP_LAMPORTS: "10000" });
  const tip = (lamports: number) => SystemProgram.transfer({ fromPubkey: payer, toPubkey: new PublicKey(JITO_TIP_ACCOUNTS[0]), lamports });
  const limit = (units: number) => ComputeBudgetProgram.setComputeUnitLimit({ units });
  const price = (microLamports: number) => ComputeBudgetProgram.setComputeUnitPrice({ microLamports });
  const cases: Array<[string, TransactionInstruction[], RegExp | null]> = [
    ["tip at the cap", [tip(10_000)], null],
    ["tip above the cap", [tip(10_001)], /jito tip exceeds/],
    ["priority exactly at the cap", [limit(200_000), price(5_000_000)], null],
    ["priority one lamport over", [limit(200_000), price(5_000_001)], /priority fee exceeds/],
    ["price with the default limit", [price(1_000_000)], /priority fee exceeds/],
    ["priority plus tip over the cap", [limit(200_000), price(4_990_000), tip(10_000)], /priority fee exceeds/],
  ];
  for (const [name, instructions, reason] of cases) {
    const calls: string[] = [];
    const policy = withPolicy(solanaSigner(payer, calls), config);
    if (reason) {
      await assert.rejects(() => policy.signSolana(serialize(payer, instructions)), reason, name);
      assert.deepEqual(calls, [], name);
    } else {
      await policy.signSolana(serialize(payer, instructions));
      assert.deepEqual(calls, ["solana"], name);
    }
  }
});

test("jupiter exact-out routes are denied because quotes are always exactIn", async () => {
  const payer = Keypair.generate().publicKey;
  const mint = Keypair.generate().publicKey;
  const ownAta = new PublicKey(associatedTokenAddress(payer.toBase58(), mint.toBase58(), TOKEN.toBase58()));
  const exactOut = sharedRoute(payer, ownAta, mint);
  exactOut.data = Buffer.concat([Buffer.from("b0d169a89a7d453e", "hex"), Buffer.alloc(24)]);
  const calls: string[] = [];
  await assert.rejects(() => withPolicy(solanaSigner(payer, calls), loadConfig({})).signSolana(serialize(payer, [exactOut])), /instruction is not allowed JUP6\S+ b0d169a89a7d453e/);
  assert.deepEqual(calls, []);
});

test("swap calldata must pay the hot wallet unless opaque swaps are opted in", () => {
  const owner = "0x2222222222222222222222222222222222222222";
  const router = "0x1111111111111111111111111111111111111111";
  const base = { chainId: 8453, to: router, value: 0n, purpose: "swap" as const, routers: [router], settlers: [SETTLER], withdrawAllowlist: [], maxValueWei: DEFAULT_MAX_VALUE_WEI, allowHotApproval: false, owner, allowOpaqueSwap: false };
  const terms = (recipient: string) => ({ recipient, buyToken: "0xdddddddddddddddddddddddddddddddddddddddd", minOut: 1n });
  const sold = { token: "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", amount: 1000n };
  assert.doesNotThrow(() => assertEvmSigning({ ...base, data: kyberData("0x01", terms(owner)) }));
  assert.doesNotThrow(() => assertEvmSigning({ ...base, data: zeroExData("0x01", terms(owner), sold) }));
  assert.throws(() => assertEvmSigning({ ...base, data: kyberData("0x01", terms("0x9999999999999999999999999999999999999999")) }), /recipient is not the hot wallet/);
  assert.throws(() => assertEvmSigning({ ...base, data: zeroExData("0x01", terms("0x9999999999999999999999999999999999999999"), sold) }), /recipient is not the hot wallet/);
  assert.throws(() => assertEvmSigning({ ...base, data: "0x12345678" }), /does not name a checkable recipient/);
  assert.doesNotThrow(() => assertEvmSigning({ ...base, data: "0x12345678", allowOpaqueSwap: true }));
  assert.throws(() => assertEvmSigning({ ...base, data: kyberData("0x01", terms("0x9999999999999999999999999999999999999999")), allowOpaqueSwap: true }), /recipient/);
});

test("a 0x exec must lend the allowance to a pinned Settler and call it", () => {
  const owner = "0x2222222222222222222222222222222222222222";
  const holder = "0x1111111111111111111111111111111111111111";
  const attacker = "0x9999999999999999999999999999999999999999";
  const base = { chainId: 8453, to: holder, value: 0n, purpose: "swap" as const, routers: [holder], settlers: [SETTLER], withdrawAllowlist: [], maxValueWei: DEFAULT_MAX_VALUE_WEI, allowHotApproval: false, owner, allowOpaqueSwap: true };
  const terms = { recipient: owner, buyToken: "0xdddddddddddddddddddddddddddddddddddddddd", minOut: 1n };
  const token = "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
  assert.throws(() => assertEvmSigning({ ...base, data: zeroExData("0x01", terms, { token, amount: 2n ** 255n, operator: attacker, target: attacker }) }), /not a pinned Settler/);
  assert.throws(() => assertEvmSigning({ ...base, data: zeroExData("0x01", terms, { token, amount: 1000n, operator: attacker }) }), /operator is not its target/);
  assert.throws(() => assertEvmSigning({ ...base, settlers: [], data: zeroExData("0x01", terms, { token, amount: 1000n }) }), /not a pinned Settler/);
  const opaque = encodeFunctionData({
    abi: parseAbi(["function exec(address operator, address token, uint256 amount, address target, bytes data) payable returns (bytes result)"]),
    functionName: "exec",
    args: [attacker, token, 2n ** 255n, attacker, "0x12345678"],
  });
  assert.throws(() => assertEvmSigning({ ...base, data: opaque }), /does not call a Settler/);
  assert.doesNotThrow(() => assertEvmSigning({ ...base, data: zeroExData("0x01", terms, { token, amount: 1000n }) }));
});

test("an approval must be exact, carry no value, target the sold token, and pay an allowlisted router", () => {
  const router = "0x1111111111111111111111111111111111111111" as const;
  const token = "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
  const approve = (amount: bigint, spender: `0x${string}` = router) => encodeFunctionData({ abi: erc20Abi, functionName: "approve", args: [spender, amount] });
  const base = {
    chainId: 8453,
    to: token,
    data: approve(1000n),
    value: 0n,
    purpose: "approve" as const,
    routers: [router],
    settlers: [],
    withdrawAllowlist: [],
    maxValueWei: DEFAULT_MAX_VALUE_WEI,
    allowHotApproval: true,
    owner: "0x2222222222222222222222222222222222222222",
    allowOpaqueSwap: false,
    approval: { token, amount: 1000n },
  };
  assert.doesNotThrow(() => assertEvmSigning(base));
  assert.throws(() => assertEvmSigning({ ...base, data: approve(maxUint256), approval: { token, amount: maxUint256 } }), /exact sell amount/);
  assert.throws(() => assertEvmSigning({ ...base, data: approve(2n ** 255n), approval: { token, amount: 2n ** 255n } }), /exact sell amount/);
  assert.throws(() => assertEvmSigning({ ...base, data: approve(1001n) }), /exact sell amount/);
  assert.throws(() => assertEvmSigning({ ...base, value: 1n }), /must not attach native value/);
  assert.throws(() => assertEvmSigning({ ...base, to: "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb" }), /not the sold token/);
  assert.throws(() => assertEvmSigning({ ...base, approval: undefined }), /not the sold token/);
  assert.throws(() => assertEvmSigning({ ...base, data: approve(1000n, "0x3333333333333333333333333333333333333333") }), /spender is not an allowlisted router/);
  assert.throws(() => assertEvmSigning({ ...base, allowHotApproval: false }), /approval is not cached/);
  assert.doesNotThrow(() => assertEvmSigning({ ...base, purpose: "revoke", data: approve(0n), allowHotApproval: false }));
  assert.throws(() => assertEvmSigning({ ...base, purpose: "revoke", data: approve(1n) }), /revoke amount is not zero/);
});

test("live boot refuses raw key env even next to Turnkey, and dev scrubs raw keys after load", () => {
  const live = loadConfig({ WHALE_BROADCAST: "true", EXECUTOR_AUTH_TOKEN: tokenAuth, RESOLVER_AUTH_TOKEN: "resolver-token-123456" });
  const turnkey = { TURNKEY_ORGANIZATION_ID: "org", TURNKEY_API_PUBLIC_KEY: "pub", TURNKEY_API_PRIVATE_KEY: "priv", TURNKEY_EVM_ADDRESS: "0x2222222222222222222222222222222222222222" };
  for (const name of ["EVM_PRIVATE_KEY", "SOLANA_SECRET_KEY", "HYPERLIQUID_AGENT_KEY", "KEYSTORE_PATH", "KEYSTORE_PASSPHRASE"]) {
    const env: NodeJS.ProcessEnv = { ...turnkey, [name]: "value" };
    assert.throws(() => loadManagedSigner(env, live), new RegExp(`refuses raw key material in ${name}`));
    assert.equal(env[name], undefined);
  }
  assert.notEqual(loadManagedSigner({ ...turnkey }, live).signer, null);
  const key = generatePrivateKey();
  const env: NodeJS.ProcessEnv = { EVM_PRIVATE_KEY: key };
  const loaded = loadManagedSigner(env, loadConfig({}));
  assert.equal(loaded.signer?.evmAddress(), privateKeyToAccount(key).address);
  assert.equal(env.EVM_PRIVATE_KEY, undefined);
  assert.ok(loaded.secrets.includes(key));
});

test("config api keys, tokens, and the notifier url are redaction secrets", () => {
  const config = loadConfig({
    ZEROX_API_KEY: "zeroex-secret-key",
    ONEINCH_API_KEY: "oneinch-secret-key",
    OKX_API_KEY: "okx-api-secret-key",
    BLOCKAID_API_KEY: "blockaid-secret-key",
    GOPLUS_API_KEY: "goplus-secret-key",
    LIFI_API_KEY: "lifi-secret-key",
    EXECUTOR_AUTH_TOKEN: tokenAuth, RESOLVER_AUTH_TOKEN: "resolver-token-123456",
    ADMIN_TOKEN: "admin-token-value",
    NOTIFIER_WEBHOOK_URL: "https://hooks.example.com/secret-path",
    KYBERSWAP_CLIENT_ID: "listing-trader",
  });
  const secrets = configSecrets(config);
  for (const value of ["zeroex-secret-key", "oneinch-secret-key", "okx-api-secret-key", "blockaid-secret-key", "goplus-secret-key", "lifi-secret-key", tokenAuth, "admin-token-value", "https://hooks.example.com/secret-path"]) {
    assert.ok(secrets.includes(value), value);
  }
  assert.equal(secrets.includes("listing-trader"), false);
});

test("create-wallet refuses to overwrite a keystore and Ctrl-C restores the terminal", async () => {
  const dir = mkdtempSync(join(tmpdir(), "keystore-"));
  const path = join(dir, "wallet.keystore.json");
  writeFileSync(path, "original");
  assert.throws(() => writeKeystoreFile(path, "replacement"), /EEXIST/);
  assert.equal(readFileSync(path, "utf8"), "original");
  writeKeystoreFile(join(dir, "fresh.json"), "new");
  const modes: boolean[] = [];
  const listeners = new Set<(chunk: Buffer) => void>();
  const stdin = {
    isRaw: false,
    setRawMode(mode: boolean) {
      modes.push(mode);
    },
    resume() {},
    pause() {},
    on(_event: "data", listener: (chunk: Buffer) => void) {
      listeners.add(listener);
    },
    off(_event: "data", listener: (chunk: Buffer) => void) {
      listeners.delete(listener);
    },
  };
  const pending = readHiddenLine(stdin, { write() {} });
  for (const listener of [...listeners]) listener(Buffer.from("abc\u0003"));
  await assert.rejects(pending, /cancelled/);
  assert.deepEqual(modes, [true, false]);
  assert.equal(listeners.size, 0);
});

test("a Turnkey hyperliquid signature must recover to the agent address", async () => {
  const agent = privateKeyToAccount(generatePrivateKey());
  const other = privateKeyToAccount(generatePrivateKey());
  const api = (signer: typeof agent): TurnkeyApi => ({
    async signEvm() {
      return "0x";
    },
    async signSolana() {
      return "";
    },
    async signEip712(payload) {
      const typed = JSON.parse(payload) as Parameters<typeof agent.signTypedData>[0];
      const parsed = parseSignature(await signer.signTypedData(typed));
      return { r: parsed.r.slice(2), s: parsed.s.slice(2), v: `0${parsed.yParity}` };
    },
  });
  const action = buildLeverage(3, 1);
  const good = await turnkeySigner(api(agent), { evm: null, solana: null, hyperliquid: agent.address }).signHyperliquid(action, 1, true);
  assert.match(good.r, /^0x[0-9a-f]{64}$/);
  assert.ok(good.v === 27 || good.v === 28);
  await assert.rejects(
    () => turnkeySigner(api(other), { evm: null, solana: null, hyperliquid: agent.address }).signHyperliquid(action, 1, true),
    /does not recover to the agent/,
  );
});

test("the Turnkey policy is scoped to each wallet and uses the passed native cap and selectors", () => {
  const solanaAddress = Keypair.generate().publicKey.toBase58();
  const wallets = { evm: "0b5d7e2c-1a3f-4e6b-8c9d-7f2a1b3c4d5e", solana: "1c6e8f3d-2b4a-4f7c-9d0e-8a3b2c4d5e6f", hyperliquid: "2d7f9a4e-3c5b-4a8d-8e1f-9b4c3d5e6f70" };
  const doc = turnkeyPolicyDocument({
    userId: "6f1c2a9e-4b7d-4c1e-9a3f-2d8e5b7c1a40",
    wallets,
    solanaAddress,
    routers: { 8453: ["0x1111111111111111111111111111111111111111"] },
    selectors: ["0x12345678"],
    maxValueWei: 777n,
  }) as Array<{ condition: string }>;
  const [evm, solana, hyper] = doc.map((item) => item.condition);
  assert.match(evm ?? "", new RegExp(`^activity\\.action == 'SIGN' && wallet\\.id == '${wallets.evm}' && `));
  assert.match(evm ?? "", /eth\.tx\.value <= 777 && \(eth\.tx\.data\[0\.\.10\] == '0x12345678'\)$/);
  assert.equal((evm ?? "").includes("2000000000000000"), false);
  assert.match(solana ?? "", new RegExp(`wallet\\.id == '${wallets.solana}'`));
  assert.match(solana ?? "", new RegExp(`solana\\.tx\\.transfers\\.all\\(t, t\\.to == '${solanaAddress}' \\|\\| t\\.to == '${wrappedSolAccount(solanaAddress)}'`));
  assert.match(solana ?? "", /solana\.tx\.spl_transfers\.count\(\) == 0$/);
  assert.match(hyper ?? "", new RegExp(`wallet\\.id == '${wallets.hyperliquid}'`));
  const noHyper = turnkeyPolicyDocument({ userId: "6f1c2a9e-4b7d-4c1e-9a3f-2d8e5b7c1a40", wallets: { ...wallets, hyperliquid: null }, solanaAddress, routers: {}, maxValueWei: 1n });
  assert.equal(noHyper.length, 2);
  assert.throws(() => turnkeyPolicyDocument({ userId: "6f1c2a9e-4b7d-4c1e-9a3f-2d8e5b7c1a40", wallets, solanaAddress, routers: {}, selectors: ["0x1234"], maxValueWei: 1n }), /selector/);
});

