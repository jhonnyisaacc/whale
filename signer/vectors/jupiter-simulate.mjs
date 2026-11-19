import { readFileSync } from "node:fs";
import { MessageV0, PublicKey, VersionedMessage, VersionedTransaction } from "@solana/web3.js";

const RPC = process.env.SOLANA_RPC ?? "https://api.mainnet-beta.solana.com";
const JUPITER = "JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4";
const FAKE_TOKEN_PROGRAM = new PublicKey("Stake11111111111111111111111111111111111111");
const fixtures = JSON.parse(readFileSync(new URL("./jupiter.json", import.meta.url), "utf8"));

const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function rpc(method, params) {
  for (let attempt = 0; attempt < 6; attempt += 1) {
    const response = await fetch(RPC, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }) });
    if (response.status === 429) {
      await pause(2000);
      continue;
    }
    const body = await response.json();
    if (body.error) throw new Error(`${method}: ${JSON.stringify(body.error)}`);
    return body.result;
  }
  throw new Error(`${method}: rate limited`);
}

function jupiterInstruction(message) {
  const program = message.staticAccountKeys.findIndex((key) => key.toBase58() === JUPITER);
  return message.compiledInstructions.find((instruction) => instruction.programIdIndex === program);
}

function withFakeTokenProgram(message) {
  const statics = message.staticAccountKeys.length;
  const shift = (index) => (index >= statics ? index + 1 : index);
  const edited = new MessageV0({
    header: { ...message.header, numReadonlyUnsignedAccounts: message.header.numReadonlyUnsignedAccounts + 1 },
    staticAccountKeys: [...message.staticAccountKeys, FAKE_TOKEN_PROGRAM],
    recentBlockhash: message.recentBlockhash,
    compiledInstructions: message.compiledInstructions.map((instruction) => ({ ...instruction, programIdIndex: shift(instruction.programIdIndex), accountKeyIndexes: instruction.accountKeyIndexes.map(shift) })),
    addressTableLookups: message.addressTableLookups,
  });
  jupiterInstruction(edited).accountKeyIndexes[0] = statics;
  return edited;
}

async function simulate(message, watch) {
  const transaction = Buffer.from(new VersionedTransaction(message).serialize()).toString("base64");
  const { value } = await rpc("simulateTransaction", [transaction, { encoding: "base64", sigVerify: false, replaceRecentBlockhash: true, commitment: "processed", accounts: { encoding: "base64", addresses: [watch] } }]);
  return value;
}

function tokenAmount(base64) {
  const data = Buffer.from(base64, "base64");
  return data.length >= 72 ? data.readBigUInt64LE(64) : 0n;
}

for (const entry of fixtures.cases.filter((item) => item.owner === fixtures.funded)) {
  const message = VersionedMessage.deserialize(Buffer.from(entry.messageHex, "hex"));
  const source = message.staticAccountKeys[jupiterInstruction(message).accountKeyIndexes[3]].toBase58();
  const before = await rpc("getAccountInfo", [source, { encoding: "base64", commitment: "processed" }]);
  const accepted = await simulate(message, source);
  const after = accepted.accounts?.[0];
  const closed = !after || Buffer.from(after.data[0], "base64").length === 0;
  const change = closed ? "was closed back to the wallet" : `lost ${tokenAmount(before.value.data[0]) - tokenAmount(after.data[0])}`;
  console.log(`${entry.name}: ${accepted.err ? `failed ${JSON.stringify(accepted.err)}` : "succeeded"}, source ${source} ${change}, inAmount ${entry.inAmount}`);
  const faked = await simulate(withFakeTokenProgram(message), source);
  const reason = (faked.logs ?? []).find((line) => /Error|failed/.test(line));
  console.log(`${entry.name} with ${FAKE_TOKEN_PROGRAM.toBase58()} as token program: ${faked.err ? `failed ${JSON.stringify(faked.err)}` : "SUCCEEDED"}${reason ? `, ${reason}` : ""}`);
}
