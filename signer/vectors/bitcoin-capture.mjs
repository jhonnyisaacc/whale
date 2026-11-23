import { execFileSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { secp256k1 } from "@noble/curves/secp256k1";
import { p2wpkh } from "@scure/btc-signer";

const CLI = process.argv[2];
if (!CLI) throw new Error("usage: node signer/vectors/bitcoin-capture.mjs <bitcoin-cli wrapper for a funded regtest wallet named miner>");
const REGTEST = { bech32: "bcrt", pubKeyHash: 0x6f, scriptHash: 0xc4, wif: 0xef };
const own = p2wpkh(secp256k1.getPublicKey(Buffer.alloc(32, 0x11), true), REGTEST).address;
const cli = (...args) => execFileSync(CLI, ["-rpcwallet=miner", ...args], { encoding: "utf8" }).trim();
const SATS = [400_000, 300_000, 200_000, 100_000];

const owner = cli("getnewaddress", "owner", "bech32");
const funding = SATS.map((sats) => {
  const txid = cli("sendtoaddress", own, (sats / 1e8).toFixed(8));
  return { txid, sats, hex: JSON.parse(cli("gettransaction", txid)).hex };
});
cli("generatetoaddress", "1", cli("getnewaddress", "mined", "bech32"));
const target = new URL("./bitcoin-funding.json", import.meta.url).pathname;
writeFileSync(target, `${JSON.stringify({ network: "regtest", own, owner, funding }, null, 2)}\n`);
console.log(`captured ${funding.length} funding transactions to ${own}, owner ${owner}`);
