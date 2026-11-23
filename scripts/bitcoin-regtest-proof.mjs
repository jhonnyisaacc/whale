import { execFileSync, spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { bitcoinWallet } from "../dist/src/bitcoin/wallet.js";
import { localSender } from "../dist/src/local-sends.js";
import { startSignerQueue } from "../dist/src/signer-queue.js";
import { keystorePublic } from "../dist/src/whale-signer.js";

const root = new URL("..", import.meta.url).pathname;
const signerBin = process.env.WHALE_SIGNER_BIN ?? path.join(root, "signer/target/release/whale-signer");
const fundingWallet = process.env.BITCOIN_RPC_WALLET ?? "miner";
const passphrase = { ...process.env, WHALE_SIGNER_PASSPHRASE: "regtest-proof-only-passphrase" };

function parsed(text) {
  try {
    return JSON.parse(text);
  } catch {
    return text.trim();
  }
}

async function rpc(method, params = [], wallet = null) {
  if (process.env.BITCOIN_CLI) {
    const args = [...(wallet ? [`-rpcwallet=${wallet}`] : []), method, ...params.map((item) => (typeof item === "string" ? item : JSON.stringify(item)))];
    return parsed(execFileSync(process.env.BITCOIN_CLI, args, { encoding: "utf8" }));
  }
  const url = process.env.BITCOIN_RPC_URL;
  if (!url) throw new Error("set BITCOIN_CLI to a bitcoin-cli wrapper, or BITCOIN_RPC_URL with BITCOIN_RPC_USER and BITCOIN_RPC_PASSWORD");
  const auth = Buffer.from(`${process.env.BITCOIN_RPC_USER ?? ""}:${process.env.BITCOIN_RPC_PASSWORD ?? ""}`).toString("base64");
  const response = await fetch(`${url.replace(/\/$/, "")}${wallet ? `/wallet/${wallet}` : ""}`, { method: "POST", headers: { authorization: `Basic ${auth}`, "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "1.0", id: "proof", method, params }) });
  const body = await response.json();
  if (body.error) throw new Error(`${method}: ${body.error.message}`);
  return body.result;
}

const satsOf = (btc) => BigInt(Math.round(btc * 1e8));

function bitcoindIndexer() {
  const heights = new Map();
  const scan = async (address) => {
    const found = await rpc("scantxoutset", ["start", [`addr(${address})`]]);
    if (!found.success) throw new Error("scantxoutset did not finish");
    for (const unspent of found.unspents) heights.set(unspent.txid, unspent.height);
    return found;
  };
  return {
    utxos: async (address) => (await scan(address)).unspents.map((unspent) => ({ txid: unspent.txid, vout: unspent.vout, sats: satsOf(unspent.amount), confirmed: true })),
    async transaction(txid) {
      const height = heights.get(txid);
      const params = height === undefined ? [txid, false] : [txid, false, await rpc("getblockhash", [height])];
      return new Uint8Array(Buffer.from(await rpc("getrawtransaction", params), "hex"));
    },
    async feeRate() {
      const estimate = await rpc("estimatesmartfee", [3]).catch(() => ({}));
      return typeof estimate.feerate === "number" ? Math.max(1, Math.ceil(estimate.feerate * 1e5)) : 2;
    },
    balance: async (address) => ({ confirmedSats: satsOf((await scan(address)).total_amount), pendingSats: 0n }),
    async simulate(signed) {
      const [accepted] = await rpc("testmempoolaccept", [[Buffer.from(signed).toString("hex")]]);
      if (accepted?.allowed !== true) throw new Error(`simulation rejected the transaction: ${accepted?.["reject-reason"] ?? "no answer"}`);
    },
    broadcast: async (signed) => rpc("sendrawtransaction", [Buffer.from(signed).toString("hex")]),
  };
}

function serve(keystore, policy, ledger, gateway) {
  const child = spawn(signerBin, ["serve", "--gateway", gateway, "--keystore", keystore, "--policy", policy, "--ledger", ledger], { env: passphrase, stdio: ["ignore", "inherit", "inherit"] });
  const exited = new Promise((resolve) => child.once("exit", resolve));
  return () => {
    child.kill();
    return exited;
  };
}

const work = mkdtempSync(path.join(tmpdir(), "bitcoin-proof-"));
const prices = createServer((_request, response) => {
  response.setHeader("content-type", "application/json");
  response.end(JSON.stringify({ bitcoin: { usd: 100 } }));
});
let queue = null;
let stop = async () => undefined;
let failed = false;
try {
  await new Promise((resolve) => prices.listen(0, "127.0.0.1", resolve));
  const keystore = path.join(work, "signer.json");
  execFileSync(signerBin, ["init", "--keystore", keystore], { env: passphrase, stdio: "ignore" });
  if (!JSON.parse(readFileSync(keystore, "utf8")).bitcoinPublicKey) execFileSync(signerBin, ["upgrade", "--keystore", keystore], { env: passphrase, stdio: "ignore" });
  const token = randomBytes(24).toString("hex");
  writeFileSync(path.join(work, "signer.token"), token, { mode: 0o600 });
  const keys = keystorePublic(keystore);
  const whale = bitcoinWallet(keys.bitcoinPublicKey, keys.evmAddress, "regtest").address;
  const owner = await rpc("getnewaddress", ["proof-owner", "bech32"], fundingWallet);
  const stranger = await rpc("getnewaddress", ["proof-stranger", "bech32"], fundingWallet);
  for (const amount of [0.004, 0.003]) await rpc("sendtoaddress", [whale, amount], fundingWallet);
  await rpc("generatetoaddress", [1, await rpc("getnewaddress", [], fundingWallet)]);
  const policy = (destinations) => {
    const file = path.join(work, `policy-${destinations.length}-${destinations[0].slice(-6)}.json`);
    writeFileSync(file, JSON.stringify({ version: 1, bitcoin: { network: "regtest", destinations, maxFeeSats: "10000", maxInputs: 20, dailyLimits: { "bitcoin:native": "1000000" } } }));
    return file;
  };
  const ledger = path.join(work, "ledger.json");
  queue = await startSignerQueue({ token, port: 0, answerTimeoutMs: 30_000 });
  const env = { BITCOIN_NETWORK: "regtest", BITCOIN_ESPLORA_URL: "http://127.0.0.1:1", BITCOIN_WITHDRAW_ADDRESSES: owner, COINGECKO_API_BASE: `http://127.0.0.1:${prices.address().port}` };
  const send = localSender(env, queue, { ...keys, token, port: 0, answerTimeoutMs: 30_000 }, { bitcoinIndexer: bitcoindIndexer() });

  stop = serve(keystore, policy([owner]), ledger, queue.url);
  const held = await send({ kind: "send_bitcoin", idempotencyKey: "regtest-proof", to: owner, sats: "250000", mode: "live" });
  if (held.status !== "signed" || !held.signedTransaction) throw new Error(`the send was not signed and held: ${JSON.stringify(held)}`);
  const [accepted] = await rpc("testmempoolaccept", [[held.signedTransaction]]);
  console.log(JSON.stringify({ txid: held.txid, plan: held.plan, testmempoolaccept: accepted }));
  if (accepted?.allowed !== true || accepted.txid !== held.txid) throw new Error(`testmempoolaccept refused the held transaction: ${accepted?.["reject-reason"] ?? "no answer"}`);
  if ((await rpc("getrawmempool")).includes(held.txid)) throw new Error("the held transaction reached the mempool with WHALE_BROADCAST off");
  await stop();

  stop = serve(keystore, policy([stranger]), ledger, queue.url);
  const refused = await send({ kind: "send_bitcoin", idempotencyKey: "regtest-proof-refused", to: owner, sats: "250000", mode: "live" }).then(
    (result) => ({ result }),
    (error) => ({ error }),
  );
  if (!refused.error || !/not an allowed destination/.test(refused.error.message)) throw new Error(`whale-signer did not refuse a destination outside its own policy: ${JSON.stringify(refused.result ?? refused.error?.message)}`);
  console.log(JSON.stringify({ signerRefusal: refused.error.message }));
  console.log("bitcoin regtest proof passed: the held send passes testmempoolaccept, and whale-signer refuses a destination outside its policy");
} catch (error) {
  failed = true;
  console.error(error instanceof Error ? error.message : String(error));
} finally {
  await stop();
  await queue?.close();
  prices.closeAllConnections();
  await new Promise((resolve) => prices.close(resolve));
  rmSync(work, { recursive: true, force: true });
}
process.exit(failed ? 1 : 0);
