import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { secp256k1 } from "@noble/curves/secp256k1";
import { privateKeyToAccount } from "viem/accounts";
import { assertLiveEdges, loadConfig } from "../src/config.js";
import { BITCOIN_KEY, bitcoinWallet, destinationScript } from "../src/bitcoin/wallet.js";
import { priceKey } from "../src/prices.js";
import { keystorePublic } from "../src/whale-signer.js";

const KEY = new Uint8Array(32).fill(0x11);
const EVM = privateKeyToAccount(`0x${"11".repeat(32)}`).address;
const PUBLIC = Buffer.from(secp256k1.getPublicKey(KEY, true)).toString("hex");
const OWNER = bitcoinWallet(PUBLIC, EVM, "regtest").address;
const OWNER_MAINNET = bitcoinWallet(PUBLIC, EVM, "bitcoin").address;

test("Bitcoin is off until BITCOIN_NETWORK is set", () => {
  assert.equal(loadConfig({}).bitcoin, null);
  assert.equal(loadConfig({ BITCOIN_NETWORK: " " }).bitcoin, null);
  assert.throws(() => loadConfig({ BITCOIN_NETWORK: "mainnet" }), /BITCOIN_NETWORK must be one of bitcoin, testnet, signet, regtest/);
});

test("the withdraw addresses decode to scripts for the configured network, and any other network fails the load", () => {
  const config = loadConfig({ BITCOIN_NETWORK: "regtest", BITCOIN_ESPLORA_URL: "http://127.0.0.1:3002", BITCOIN_WITHDRAW_ADDRESSES: ` ${OWNER} ,` });
  assert.deepEqual(config.bitcoin?.destinations, [destinationScript(OWNER, "regtest")]);
  assert.equal(config.bitcoin?.maxFeeSats, 10_000n);
  assert.equal(config.bitcoin?.maxFeeRate, 50);
  assert.equal(config.bitcoin?.maxInputs, 20);
  assert.throws(() => loadConfig({ BITCOIN_NETWORK: "regtest", BITCOIN_ESPLORA_URL: "http://127.0.0.1:3002", BITCOIN_WITHDRAW_ADDRESSES: OWNER_MAINNET }), /which is not a regtest address/);
  assert.throws(() => loadConfig({ BITCOIN_NETWORK: "bitcoin", BITCOIN_WITHDRAW_ADDRESSES: EVM }), /which is not a bitcoin address/);
});

test("Esplora defaults to mempool.space per network, regtest needs its own, and live mainnet pins mempool.space", () => {
  assert.equal(loadConfig({ BITCOIN_NETWORK: "bitcoin" }).bitcoin?.esploraUrl, "https://mempool.space/api");
  assert.equal(loadConfig({ BITCOIN_NETWORK: "signet" }).bitcoin?.esploraUrl, "https://mempool.space/signet/api");
  assert.throws(() => loadConfig({ BITCOIN_NETWORK: "regtest" }), /needs BITCOIN_ESPLORA_URL/);
  assert.throws(() => loadConfig({ BITCOIN_NETWORK: "bitcoin", BITCOIN_MAX_FEE_SATS: "1.5" }), /BITCOIN_MAX_FEE_SATS must be a positive integer/);
  assert.throws(() => loadConfig({ BITCOIN_NETWORK: "bitcoin", BITCOIN_MAX_INPUTS: "500" }), /at most 100/);
  const env = { WHALE_BROADCAST: "true", BITCOIN_NETWORK: "bitcoin", BITCOIN_ESPLORA_URL: "https://esplora.example/api" };
  assert.throws(() => assertLiveEdges(loadConfig(env), env), /live mode pins BITCOIN_ESPLORA_URL to https:\/\/mempool.space\/api/);
});

test("the keystore's bitcoinPublicKey is read only when it belongs to the keystore's evmAddress", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "whale-btc-"));
  const file = (name: string, body: object) => {
    const target = path.join(dir, name);
    writeFileSync(target, JSON.stringify(body));
    return target;
  };
  const solanaAddress = "So11111111111111111111111111111111111111112";
  assert.equal(keystorePublic(file("old.json", { evmAddress: EVM, solanaAddress })).bitcoinPublicKey, null);
  assert.equal(keystorePublic(file("new.json", { evmAddress: EVM, solanaAddress, bitcoinPublicKey: PUBLIC })).bitcoinPublicKey, PUBLIC);
  const forged = Buffer.from(secp256k1.getPublicKey(new Uint8Array(32).fill(0x22), true)).toString("hex");
  assert.throws(() => keystorePublic(file("forged.json", { evmAddress: EVM, solanaAddress, bitcoinPublicKey: forged })), /does not belong to the keystore's evmAddress/);
  assert.throws(() => keystorePublic(file("bad.json", { evmAddress: EVM, solanaAddress, bitcoinPublicKey: `04${"00".repeat(64)}` })), /not a whale-signer keystore/);
});

test("native BTC prices under one key and nothing else on the bitcoin key does", () => {
  assert.equal(priceKey({ symbol: "BTC", address: OWNER, amount: 0, usd: 0, native: true, chainKey: BITCOIN_KEY }), "native:BTC");
  assert.equal(priceKey({ symbol: "X", address: OWNER, amount: 0, usd: 0, native: false, chainKey: BITCOIN_KEY }), null);
});
