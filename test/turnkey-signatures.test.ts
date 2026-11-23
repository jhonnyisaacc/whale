import assert from "node:assert/strict";
import { createPrivateKey, sign } from "node:crypto";
import test from "node:test";
import { Keypair, PublicKey, SystemProgram, TransactionMessage, VersionedTransaction } from "@solana/web3.js";
import { parseTransaction, serializeTransaction, toHex, type Hex } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { submitEvm, submitSolana, type EvmCtx, type EvmRpc, type SendIo, type SolanaCtx, type SolanaRpc } from "../src/broadcast.js";
import { loadConfig } from "../src/config.js";
import type { TxRecord } from "../src/domain.js";
import { BroadcastError } from "../src/executor.js";
import { buildLeverage } from "../src/hyperliquid.js";
import { turnkeySigner, type EvmSignInput, type TurnkeyApi } from "../src/managed-signer.js";
import { createNonceManager } from "../src/nonce.js";

const wallet = privateKeyToAccount(generatePrivateKey());
const stranger = privateKeyToAccount(generatePrivateKey());
const attacker = "0x9999999999999999999999999999999999999999";
const ZERO_WORD = `0x${"00".repeat(32)}` as Hex;
const SECP256K1_N = 0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141n;

const evmInput: EvmSignInput = {
  chainId: 8453,
  to: "0x4444444444444444444444444444444444444444",
  data: "0x",
  value: 5n,
  gas: 21_000n,
  nonce: 3,
  maxFeePerGas: 1_000n,
  maxPriorityFeePerGas: 100n,
  purpose: "withdraw",
};

type EvmForge = (unsigned: Hex) => Promise<Hex>;

const evmForgeries: Record<string, { forge: EvmForge; failure: RegExp }> = {
  "returns the unsigned bytes": { forge: async (unsigned) => unsigned, failure: /evm chain 8453: .*not signed/ },
  "signs with a different key": { forge: async (unsigned) => stranger.signTransaction(parseTransaction(unsigned)), failure: /evm chain 8453: .*does not recover to the wallet/ },
  "returns a zero signature": {
    forge: async (unsigned) => serializeTransaction(parseTransaction(unsigned) as never, { r: ZERO_WORD, s: ZERO_WORD, yParity: 0 }),
    failure: /evm chain 8453: .*zero/,
  },
  "returns a high-s signature": {
    forge: async (unsigned) => {
      const signed = parseTransaction(await wallet.signTransaction(parseTransaction(unsigned)));
      const s = toHex(SECP256K1_N - BigInt(signed.s ?? "0x0"), { size: 32 });
      return serializeTransaction({ ...(signed as object), r: undefined, s: undefined, v: undefined, yParity: undefined } as never, { r: signed.r ?? ZERO_WORD, s, yParity: signed.yParity === 0 ? 1 : 0 });
    },
    failure: /evm chain 8453: .*not canonical/,
  },
  "signs a different transaction": {
    forge: async (unsigned) => wallet.signTransaction({ ...(parseTransaction(unsigned) as object), to: attacker } as never),
    failure: /evm chain 8453: .*not the requested transaction/,
  },
};

function evmApi(forge: EvmForge): TurnkeyApi {
  return {
    signEvm: (unsigned) => forge(unsigned),
    signSolana: async () => {
      throw new Error("solana is not under test");
    },
    signEip712: async () => {
      throw new Error("eip712 is not under test");
    },
  };
}

test("a Turnkey EVM signature that is valid for the wallet and the request is accepted", async () => {
  const signer = turnkeySigner(evmApi(async (unsigned) => wallet.signTransaction(parseTransaction(unsigned))), { evm: wallet.address, solana: null, hyperliquid: null });
  const signed = await signer.signEvm(evmInput);
  const parsed = parseTransaction(signed);
  assert.equal(parsed.to, evmInput.to);
  assert.equal(parsed.nonce, evmInput.nonce);
});

for (const [name, { forge, failure }] of Object.entries(evmForgeries)) {
  test(`a Turnkey EVM signer that ${name} is refused before anything is journaled or broadcast`, async () => {
    const signer = turnkeySigner(evmApi(forge), { evm: wallet.address, solana: null, hyperliquid: null });
    const journaled: TxRecord[] = [];
    const sent: Hex[] = [];
    const outcome = await submitEvm(evmCtx(signer, journaled, sent), { to: evmInput.to, data: evmInput.data, value: evmInput.value, gas: evmInput.gas, purpose: "withdraw" }, null).then(
      () => null,
      (error: unknown) => error,
    );
    assert.deepEqual(journaled, []);
    assert.deepEqual(sent, []);
    assert.ok(outcome instanceof BroadcastError && !outcome.broadcast, "the send fails as never broadcast");
    assert.match(outcome.message, failure);
    await assert.rejects(() => signer.signEvm(evmInput), failure);
  });
}

const payer = Keypair.generate();
const other = Keypair.generate();

function solanaTx(to: PublicKey): VersionedTransaction {
  return new VersionedTransaction(
    new TransactionMessage({
      payerKey: payer.publicKey,
      recentBlockhash: "11111111111111111111111111111111",
      instructions: [SystemProgram.transfer({ fromPubkey: payer.publicKey, toPubkey: to, lamports: 5 })],
    }).compileToV0Message(),
  );
}

const solanaDest = Keypair.generate().publicKey;

function ed25519(secretKey: Uint8Array, message: Uint8Array): Uint8Array {
  const key = createPrivateKey({ key: Buffer.concat([Buffer.from("302e020100300506032b657004220420", "hex"), Buffer.from(secretKey.subarray(0, 32))]), format: "der", type: "pkcs8" });
  return sign(null, message, key);
}

type SolanaForge = (unsigned: VersionedTransaction) => VersionedTransaction;

const solanaForgeries: Record<string, { forge: SolanaForge; failure: RegExp }> = {
  "returns the unsigned bytes": { forge: (unsigned) => unsigned, failure: /solana: .*zero/ },
  "signs with a different key": {
    forge: (unsigned) => {
      unsigned.signatures[0] = ed25519(other.secretKey, unsigned.message.serialize());
      return unsigned;
    },
    failure: /solana: .*does not verify against the wallet key/,
  },
  "returns a zero signature": {
    forge: (unsigned) => {
      unsigned.signatures[0] = new Uint8Array(64);
      return unsigned;
    },
    failure: /solana: .*zero/,
  },
  "signs a different transaction": {
    forge: () => {
      const swapped = solanaTx(Keypair.generate().publicKey);
      swapped.sign([payer]);
      return swapped;
    },
    failure: /solana: .*not the requested message/,
  },
};

function solanaApi(forge: SolanaForge): TurnkeyApi {
  return {
    signEvm: async () => {
      throw new Error("evm is not under test");
    },
    signSolana: async (unsignedBase64) => Buffer.from(forge(VersionedTransaction.deserialize(Buffer.from(unsignedBase64, "base64"))).serialize()).toString("base64"),
    signEip712: async () => {
      throw new Error("eip712 is not under test");
    },
  };
}

const solanaAddresses = { evm: null, solana: payer.publicKey.toBase58(), hyperliquid: null };

test("a Turnkey Solana signature that is valid for the wallet and the request is accepted", async () => {
  const signer = turnkeySigner(
    solanaApi((unsigned) => {
      unsigned.sign([payer]);
      return unsigned;
    }),
    solanaAddresses,
  );
  const unsigned = solanaTx(solanaDest);
  const signed = VersionedTransaction.deserialize(await signer.signSolana(unsigned.serialize()));
  assert.deepEqual(Buffer.from(signed.message.serialize()), Buffer.from(unsigned.message.serialize()));
});

for (const [name, { forge, failure }] of Object.entries(solanaForgeries)) {
  test(`a Turnkey Solana signer that ${name} is refused before anything is journaled or broadcast`, async () => {
    const signer = turnkeySigner(solanaApi(forge), solanaAddresses);
    const journaled: TxRecord[] = [];
    const sent: Uint8Array[] = [];
    const outcome = await submitSolana(solanaCtx(signer, journaled, sent), solanaTx(solanaDest), 100, { to: solanaDest.toBase58(), value: "5", buyToken: null, jitoUrl: null }).then(
      () => null,
      (error: unknown) => error,
    );
    assert.deepEqual(journaled, []);
    assert.deepEqual(sent, []);
    assert.ok(outcome instanceof BroadcastError && !outcome.broadcast, "the send fails as never broadcast");
    assert.match(outcome.message, failure);
    await assert.rejects(() => signer.signSolana(solanaTx(solanaDest).serialize()), failure);
  });
}

function eip712Api(sign: (payload: string) => Promise<{ r: string; s: string; v: string }>): TurnkeyApi {
  return {
    signEvm: async () => {
      throw new Error("evm is not under test");
    },
    signSolana: async () => {
      throw new Error("solana is not under test");
    },
    signEip712: (payload) => sign(payload),
  };
}

async function typedSignature(account: typeof wallet, payload: string): Promise<{ r: string; s: string; v: string }> {
  const signature = await account.signTypedData(JSON.parse(payload));
  return { r: signature.slice(0, 66), s: `0x${signature.slice(66, 130)}`, v: signature.slice(130) };
}

const eip712Forgeries: Record<string, { sign: (payload: string) => Promise<{ r: string; s: string; v: string }>; failure: RegExp }> = {
  "signs with a different key": { sign: (payload) => typedSignature(stranger, payload), failure: /hyperliquid: .*does not recover to the agent/ },
  "returns a zero signature": { sign: async () => ({ r: ZERO_WORD, s: ZERO_WORD, v: "1b" }), failure: /hyperliquid: .*zero/ },
  "signs a different message": {
    sign: (payload) => {
      const typed = JSON.parse(payload);
      return typedSignature(wallet, JSON.stringify({ ...typed, message: { ...typed.message, source: "b" } }));
    },
    failure: /hyperliquid: .*does not recover to the agent/,
  },
};

for (const [name, { sign: forge, failure }] of Object.entries(eip712Forgeries)) {
  test(`a Turnkey EIP-712 signer that ${name} is refused`, async () => {
    const signer = turnkeySigner(eip712Api(forge), { evm: null, solana: null, hyperliquid: wallet.address });
    await assert.rejects(() => signer.signHyperliquid(buildLeverage(3, 1), 1, true), failure);
  });
}

function io(): SendIo {
  return {
    evm: () => {
      throw new Error("no evm rpc");
    },
    solana: () => {
      throw new Error("no solana rpc");
    },
    nonces: createNonceManager(),
    sleep: async () => undefined,
    now: () => 0,
    confirmTimeoutMs: 1_000,
    pollMs: 100,
  };
}

function evmCtx(signer: ReturnType<typeof turnkeySigner>, journaled: TxRecord[], sent: Hex[]): EvmCtx {
  const rpc: EvmRpc = {
    fees: async () => ({ maxFeePerGas: evmInput.maxFeePerGas, maxPriorityFeePerGas: evmInput.maxPriorityFeePerGas }),
    pendingNonce: async () => evmInput.nonce,
    confirmedNonce: async () => evmInput.nonce,
    estimateGas: async () => evmInput.gas,
    simulate: async () => undefined,
    sendRaw: async (signed) => {
      sent.push(signed);
    },
    receipt: async () => null,
    seen: async () => false,
    balance: async () => 0n,
    checkChain: async () => undefined,
  };
  return {
    config: loadConfig({}),
    signer,
    io: io(),
    onTx: async (record) => {
      journaled.push(record);
    },
    fetchImpl: fetch,
    secrets: [],
    chainId: evmInput.chainId,
    chainKey: "base",
    owner: wallet.address,
    read: rpc,
    reads: [rpc],
    senders: [rpc],
    privateSend: false,
  };
}

function solanaCtx(signer: ReturnType<typeof turnkeySigner>, journaled: TxRecord[], sent: Uint8Array[]): SolanaCtx {
  const rpc: SolanaRpc = {
    simulate: async () => undefined,
    sendRaw: async (signed) => {
      sent.push(signed);
    },
    latestBlockhash: async () => ({ blockhash: "11111111111111111111111111111111", lastValidBlockHeight: 100 }),
    blockHeight: async () => 1,
    status: async () => null,
    received: async () => null,
    lamports: async () => 0n,
    tokenAccount: async () => null,
  };
  return {
    config: loadConfig({}),
    signer,
    io: io(),
    onTx: async (record) => {
      journaled.push(record);
    },
    fetchImpl: fetch,
    secrets: [],
    rpc,
    owner: payer.publicKey.toBase58(),
  };
}
