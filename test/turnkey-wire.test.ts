import assert from "node:assert/strict";
import { createECDH } from "node:crypto";
import http from "node:http";
import type { AddressInfo } from "node:net";
import test from "node:test";
import { Keypair, SystemProgram, TransactionMessage, VersionedTransaction } from "@solana/web3.js";
import { parseTransaction, type Hex } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { turnkeyApiFromEnv, turnkeySigner } from "../src/managed-signer.js";

const wallet = privateKeyToAccount(generatePrivateKey());
const payer = Keypair.generate();

async function turnkeyLike(): Promise<{ base: string; close: () => Promise<void> }> {
  const server = http.createServer((request, response) => {
    let raw = "";
    request.on("data", (chunk) => (raw += chunk));
    request.on("end", async () => {
      const { parameters } = JSON.parse(raw) as { parameters: { type: string; unsignedTransaction: string } };
      const unsigned = parameters.type === "TRANSACTION_TYPE_ETHEREUM" ? parameters.unsignedTransaction.replace(/^0x/, "") : parameters.unsignedTransaction;
      let signed: string;
      if (!/^([0-9a-f]{2})+$/.test(unsigned)) {
        response.writeHead(400, { "content-type": "application/json" });
        response.end(JSON.stringify({ code: 3, message: "unsignedTransaction must be hex" }));
        return;
      }
      if (parameters.type === "TRANSACTION_TYPE_ETHEREUM") {
        signed = (await wallet.signTransaction(parseTransaction(`0x${unsigned}`) as never)).slice(2);
      } else {
        const tx = VersionedTransaction.deserialize(Buffer.from(unsigned, "hex"));
        tx.sign([payer]);
        signed = Buffer.from(tx.serialize()).toString("hex");
      }
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ activity: { id: "act-1", status: "ACTIVITY_STATUS_COMPLETED", result: { signTransactionResult: { signedTransaction: signed } } } }));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return { base, close: () => new Promise<void>((resolve) => server.close(() => resolve())) };
}

function signerAt(base: string) {
  const ecdh = createECDH("prime256v1");
  ecdh.generateKeys();
  const api = turnkeyApiFromEnv({
    TURNKEY_ORGANIZATION_ID: "org",
    TURNKEY_API_PUBLIC_KEY: ecdh.getPublicKey("hex", "compressed"),
    TURNKEY_API_PRIVATE_KEY: ecdh.getPrivateKey("hex"),
    TURNKEY_API_BASE: base,
  });
  assert.ok(api);
  return turnkeySigner(api, { evm: wallet.address, solana: payer.publicKey.toBase58(), hyperliquid: null });
}

test("a Turnkey EVM signature in Turnkey's unprefixed hex is accepted and returned as 0x hex", async () => {
  const fake = await turnkeyLike();
  try {
    const input = { chainId: 8453, to: "0x4444444444444444444444444444444444444444" as Hex, data: "0x" as Hex, value: 5n, gas: 21_000n, nonce: 3, maxFeePerGas: 1_000n, maxPriorityFeePerGas: 100n, purpose: "withdraw" as const };
    const signed = await signerAt(fake.base).signEvm(input);
    assert.match(signed, /^0x02/);
    assert.equal(parseTransaction(signed).nonce, 3);
  } finally {
    await fake.close();
  }
});

test("a Turnkey Solana signature sent and returned as hex is accepted", async () => {
  const fake = await turnkeyLike();
  try {
    const unsigned = new VersionedTransaction(
      new TransactionMessage({
        payerKey: payer.publicKey,
        recentBlockhash: "11111111111111111111111111111111",
        instructions: [SystemProgram.transfer({ fromPubkey: payer.publicKey, toPubkey: Keypair.generate().publicKey, lamports: 5 })],
      }).compileToV0Message(),
    );
    const signed = VersionedTransaction.deserialize(await signerAt(fake.base).signSolana(unsigned.serialize()));
    assert.deepEqual(Buffer.from(signed.message.serialize()), Buffer.from(unsigned.message.serialize()));
    assert.ok(signed.signatures[0]?.some((byte) => byte !== 0));
  } finally {
    await fake.close();
  }
});
