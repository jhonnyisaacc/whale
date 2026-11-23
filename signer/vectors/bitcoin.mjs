import { readFileSync } from "node:fs";
import { secp256k1 } from "@noble/curves/secp256k1";
import { Address, OutScript, Transaction, p2wpkh } from "@scure/btc-signer";

const REGTEST = { bech32: "bcrt", pubKeyHash: 0x6f, scriptHash: 0xc4, wif: 0xef };
const RAW = { allowUnknownOutputs: true, allowUnknownInputs: true, disableScriptCheck: true };
const SEQUENCE = 0xfffffffd;
const KEY = Buffer.alloc(32, 0x11);
const PUBLIC_KEY = secp256k1.getPublicKey(KEY, true);
const OWN = p2wpkh(PUBLIC_KEY, REGTEST);
const ATTACKER = p2wpkh(secp256k1.getPublicKey(Buffer.alloc(32, 0x33), true), REGTEST);
const THORCHAIN_MEMO = "=:ETH.ETH:0x2222222222222222222222222222222222222222";
const MAX_FEE_SATS = 10_000n;
const DAILY_SATS = "600000";

const hex = (bytes) => Buffer.from(bytes).toString("hex");
const bytes = (text) => Uint8Array.from(Buffer.from(text, "hex"));
const same = (a, b) => hex(a) === hex(b);
const amountOutput = (sats) => {
  const amount = Buffer.alloc(8);
  amount.writeBigUInt64LE(sats);
  return `${amount.toString("hex")}16${hex(OWN.script)}`;
};

const captured = JSON.parse(readFileSync(new URL("./bitcoin-funding.json", import.meta.url), "utf8"));
if (captured.own !== OWN.address) throw new Error("bitcoin-funding.json pays a different key; rerun bitcoin-capture.mjs");
const OWNER = OutScript.encode(Address(REGTEST).decode(captured.owner));

const coins = captured.funding.map((funding) => {
  const tx = Transaction.fromRaw(bytes(funding.hex), RAW);
  if (tx.id !== funding.txid) throw new Error(`${funding.txid} does not hash to its txid`);
  const outputs = Array.from({ length: tx.outputsLength }, (_, index) => tx.getOutput(index));
  const own = outputs.findIndex((output) => same(output.script, OWN.script));
  const foreign = outputs.findIndex((output) => !same(output.script, OWN.script));
  return { txid: funding.txid, hex: funding.hex, own, foreign, sats: outputs[own].amount, foreignSats: outputs[foreign].amount, foreignScript: outputs[foreign].script };
});

function build({ inputs, outputs, version = 2, lockTime = 0, sequence = SEQUENCE }) {
  const tx = new Transaction({ version, lockTime, ...RAW });
  for (const input of inputs) tx.addInput({ txid: input.txid, index: input.index, sequence, witnessUtxo: { script: input.script, amount: input.sats } });
  for (const [script, amount] of outputs) tx.addOutput({ script, amount: BigInt(amount) });
  return tx;
}

const spend = (coin) => ({ txid: coin.txid, index: coin.own, script: OWN.script, sats: coin.sats });

function job(name, tx, previous) {
  return { id: name, kind: "bitcoin", transaction: hex(tx.toBytes(true, false)), previous: previous.map((coin) => (typeof coin === "string" ? coin : coin.hex)) };
}

function signed(tx) {
  tx.sign(KEY);
  tx.finalize();
  return hex(tx.extract());
}

const [f0, f1, f2, f3] = coins;
const send = { inputs: [spend(f0)], outputs: [[OWNER, 250_000], [OWN.script, f0.sats - 251_410n]] };
const sendTx = build(send);
const sendJob = job("pays owner with change", sendTx, [f0]);
const sendSigned = signed(build(send));
const consolidate = { inputs: [spend(f1), spend(f2)], outputs: [[OWN.script, f1.sats + f2.sats - 2_000n]] };
const atCap = { inputs: [spend(f0)], outputs: [[OWNER, 250_000], [OWN.script, f0.sats - 250_000n - MAX_FEE_SATS]] };
const memo = Uint8Array.from([0x6a, THORCHAIN_MEMO.length, ...Buffer.from(THORCHAIN_MEMO)]);
const multisig = OutScript.encode({ type: "ms", m: 1, pubkeys: [PUBLIC_KEY] });
const witnessV2 = Uint8Array.from([0x52, 0x20, ...Buffer.alloc(32, 0x44)]);
const lie = f0.hex.replace(amountOutput(f0.sats), amountOutput(251_410n));
if (lie === f0.hex) throw new Error("could not edit the funding amount");
const overLimit = { inputs: [spend(f0), spend(f1)], outputs: [[OWNER, 650_000], [OWN.script, f0.sats + f1.sats - 651_410n]] };

const refusals = [
  ["pays a third party", { inputs: [spend(f0)], outputs: [[ATTACKER.script, 250_000], [OWN.script, f0.sats - 251_410n]] }, [f0], `output 0 pays ${ATTACKER.address}, which is not an allowed destination`],
  ["overpays the fee by one sat", { inputs: [spend(f0)], outputs: [[OWNER, 250_000], [OWN.script, f0.sats - 250_000n - MAX_FEE_SATS - 1n]] }, [f0], "the fee 10001 sats is above the 10000 sats cap"],
  ["sends the change as fee", { inputs: [spend(f0)], outputs: [[OWNER, 250_000]] }, [f0], "the fee 150000 sats is above the 10000 sats cap"],
  ["carries a THORChain OP_RETURN memo", { inputs: [spend(f0)], outputs: [[OWNER, 250_000], [memo, 0], [OWN.script, f0.sats - 251_410n]] }, [f0], "output 1 is OP_RETURN"],
  ["pays a bare multisig script", { inputs: [spend(f0)], outputs: [[multisig, 250_000], [OWN.script, f0.sats - 251_410n]] }, [f0], "output 0 has an unknown script"],
  ["pays a future witness version", { inputs: [spend(f0)], outputs: [[witnessV2, 250_000], [OWN.script, f0.sats - 251_410n]] }, [f0], "output 0 has an unknown script"],
  ["lies about the input amount", { inputs: [spend(f0)], outputs: [[OWNER, 250_000]] }, [lie], `input 0: the previous transaction does not hash to ${f0.txid}`],
  ["hands over another previous transaction", send, [f1], `input 0: the previous transaction does not hash to ${f0.txid}`],
  ["spends an output the previous transaction lacks", { inputs: [{ ...spend(f0), index: 5 }], outputs: [[OWNER, 250_000]] }, [f0], "input 0: the previous transaction has no output 5"],
  ["spends a coin of another wallet", { inputs: [{ txid: f0.txid, index: f0.foreign, script: f0.foreignScript, sats: f0.foreignSats }], outputs: [[OWNER, 250_000]] }, [f0], "input 0 does not spend this wallet's address"],
  ["uses version 1", { ...send, version: 1 }, [f0], "the transaction must be version 2, lock time 0, and sequence 0xfffffffd on every input"],
  ["uses a final sequence", { ...send, sequence: 0xffffffff }, [f0], "the transaction must be version 2, lock time 0, and sequence 0xfffffffd on every input"],
  ["sets a lock time", { ...send, lockTime: 800_000 }, [f0], "the transaction must be version 2, lock time 0, and sequence 0xfffffffd on every input"],
  ["spends one coin twice", { inputs: [spend(f0), spend(f0)], outputs: [[OWNER, 250_000], [OWN.script, f0.sats - 251_410n]] }, [f0, f0], "input 1 spends the same coin as an earlier input"],
  ["pays more than the inputs hold", { inputs: [spend(f0)], outputs: [[OWNER, 900_000]] }, [f0], "outputs spend more than the inputs hold"],
  ["has more inputs than the limit", { inputs: [spend(f0), spend(f1), spend(f2), spend(f3)], outputs: [[OWN.script, f0.sats + f1.sats + f2.sats + f3.sats - 4_000n]] }, [f0, f1, f2, f3], "4 inputs is above the 3 input limit"],
  ["omits the previous transactions", send, [], "previous must list one transaction per input"],
  ["has no outputs", { inputs: [spend(f0)], outputs: [] }, [f0], "the transaction has no outputs"],
];

export function bitcoinVectors() {
  const cases = [
    { name: sendJob.id, job: sendJob, expect: "signed", signedTransaction: sendSigned, spent: { "bitcoin:native": "251410" } },
    { name: "consolidates to its own address", job: job("consolidates to its own address", build(consolidate), [f1, f2]), expect: "signed", signedTransaction: signed(build(consolidate)), spent: { "bitcoin:native": "2000" } },
    { name: "pays the fee cap exactly", job: job("pays the fee cap exactly", build(atCap), [f0]), expect: "signed", signedTransaction: signed(build(atCap)), spent: { "bitcoin:native": "260000" } },
    ...refusals.map(([name, shape, previous, reason]) => ({ name, job: job(name, build(shape), previous), expect: "refused", reason })),
    { name: "already carries a signature", job: { ...sendJob, id: "already carries a signature", transaction: sendSigned }, expect: "refused", reason: "input 0 carries a signature already" },
    { name: "crosses the daily sats limit", job: job("crosses the daily sats limit", build(overLimit), [f0, f1]), expect: "refused", reason: `651410 of bitcoin:native is above its whole ${DAILY_SATS} daily limit`, signerOnly: true, spentSats: "651410" },
  ];
  return {
    policy: { network: "regtest", destinations: [captured.owner], maxFeeSats: String(MAX_FEE_SATS), maxInputs: 3, dailyLimits: { "bitcoin:native": DAILY_SATS } },
    file: { network: "regtest", publicKey: hex(PUBLIC_KEY), own: OWN.address, owner: captured.owner, attacker: ATTACKER.address, cases },
  };
}
