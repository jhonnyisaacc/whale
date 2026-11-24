import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { bitcoinBalance } from "../src/bitcoin/read.js";
import { esploraIndexer, parseBalance, parseFeeRate, parseMempoolTest, parseUtxos, SimulationRefused, transactionId } from "../src/bitcoin/esplora.js";

const fixture = (name: string) => readFileSync(new URL(`../../test/fixtures/bitcoin/${name}`, import.meta.url), "utf8");
const TX_ID = "65c907744b0852012403a4096688d2d2ac7c063d4dca8d8e3ece4b8e8a9c8539";
const PREV_ID = "711b43b24ae04427dbe5a2b241e22323fe74aa2cb6363e01921642430a3c6842";
const ADDRESS = "bc1qjafqmk43zp2y0kg4jlr55u3dnqxxzrqlrx6k7q";

function fakeEsplora(routes: Record<string, { status?: number; body: string }>, calls: string[] = []): typeof fetch {
  return async (input, init) => {
    const url = new URL(String(input));
    calls.push(`${init?.method ?? "GET"} ${url.pathname}${init?.body ? ` ${String(init.body)}` : ""}`);
    const route = routes[`${init?.method ?? "GET"} ${url.pathname}`];
    return route ? new Response(route.body, { status: route.status ?? 200 }) : new Response("not found", { status: 404 });
  };
}

test("mempool.space answers parse into confirmed coins, balances, and a whole fee rate", () => {
  assert.deepEqual(parseUtxos(JSON.parse(fixture("utxo.json"))), [{ txid: TX_ID, vout: 0, sats: 12_533_781n, confirmed: true }]);
  assert.deepEqual(parseBalance(JSON.parse(fixture("address.json"))), { confirmedSats: 12_533_781n, pendingSats: 0n });
  assert.equal(parseFeeRate(JSON.parse(fixture("fee-estimates.json"))), 1, "a 0.5 sat/vB estimate rounds up to the 1 sat/vB relay floor");
  assert.equal(parseFeeRate({ "1": 30, "3": 12.2 }), 13);
});

test("hostile Esplora shapes are refused instead of read as money", () => {
  const coin = { txid: TX_ID, vout: 0, value: 1000, status: { confirmed: true } };
  assert.throws(() => parseUtxos([{ ...coin, value: -1 }]));
  assert.throws(() => parseUtxos([{ ...coin, value: 1.5 }]));
  assert.throws(() => parseUtxos([{ ...coin, value: 22e14 }]), "more sats than will ever exist");
  assert.throws(() => parseUtxos([{ ...coin, value: "1000" }]));
  assert.throws(() => parseUtxos([{ ...coin, txid: TX_ID.toUpperCase() }]));
  assert.throws(() => parseUtxos([{ ...coin, status: {} }]));
  assert.throws(() => parseUtxos(Array.from({ length: 5_001 }, () => coin)), "a truncated list is refused, not silently cut");
  assert.throws(() => parseBalance({ chain_stats: { funded_txo_sum: 1, spent_txo_sum: 2 }, mempool_stats: { funded_txo_sum: 0, spent_txo_sum: 0 } }));
  assert.throws(() => parseFeeRate({ "1": 5 }), /no 3-block fee estimate/);
  assert.throws(() => parseFeeRate({ "3": -1 }));
});

test("the indexer reads a previous transaction only when its bytes hash to the asked txid", async () => {
  const prev = fixture("prev.hex").trim();
  const indexer = esploraIndexer("https://esplora.test/api/", fakeEsplora({ [`GET /api/tx/${PREV_ID}/hex`]: { body: prev }, [`GET /api/tx/${TX_ID}/hex`]: { body: prev } }));
  assert.equal(Buffer.from(await indexer.transaction(PREV_ID)).toString("hex"), prev);
  await assert.rejects(indexer.transaction(TX_ID), /does not hash to 65c9/);
  await assert.rejects(indexer.transaction("../address"));
});

test("the indexer reads coins, balance, and fee rate from the Esplora routes", async () => {
  const fetchImpl = fakeEsplora({
    [`GET /api/address/${ADDRESS}/utxo`]: { body: fixture("utxo.json") },
    [`GET /api/address/${ADDRESS}`]: { body: fixture("address.json") },
    "GET /api/fee-estimates": { body: fixture("fee-estimates.json") },
  });
  const indexer = esploraIndexer("https://esplora.test/api", fetchImpl);
  assert.equal((await indexer.utxos(ADDRESS))[0]?.sats, 12_533_781n);
  assert.equal((await indexer.balance(ADDRESS)).confirmedSats, 12_533_781n);
  assert.equal(await indexer.feeRate(), 1);
  await assert.rejects(indexer.utxos("bc1qother"), /esplora address read failed 404/);
});

test("broadcast posts the hex and accepts only the transaction's own txid back", async () => {
  const signed = new Uint8Array(Buffer.from(fixture("tx.hex").trim(), "hex"));
  assert.equal(transactionId(signed), TX_ID);
  const calls: string[] = [];
  assert.equal(await esploraIndexer("https://esplora.test/api", fakeEsplora({ "POST /api/tx": { body: TX_ID } }, calls)).broadcast(signed), TX_ID);
  assert.deepEqual(calls, [`POST /api/tx ${fixture("tx.hex").trim()}`]);
  await assert.rejects(esploraIndexer("https://esplora.test/api", fakeEsplora({ "POST /api/tx": { body: PREV_ID } })).broadcast(signed), /answered txid 711b/);
  await assert.rejects(esploraIndexer("https://esplora.test/api", fakeEsplora({ "POST /api/tx": { status: 400, body: "bad-txns-inputs-missingorspent" } })).broadcast(signed), /esplora broadcast failed 400: bad-txns-inputs-missingorspent/);
  await assert.rejects(esploraIndexer("https://esplora.test/api", fakeEsplora({ "POST /api/tx": { status: 502, body: "" } })).broadcast(signed), /esplora broadcast failed 502/);
});

test("simulate posts the hex to txs/test and passes only an allowed answer for the same txid", async () => {
  const signed = new Uint8Array(Buffer.from(fixture("tx.hex").trim(), "hex"));
  const answer = (row: Record<string, unknown>) => ({ "POST /api/txs/test": { body: JSON.stringify([{ txid: TX_ID, wtxid: TX_ID, ...row }]) } });
  const calls: string[] = [];
  await esploraIndexer("https://esplora.test/api", fakeEsplora(answer({ allowed: true, vsize: 141, fees: { base: 0.00000282 } }), calls)).simulate(signed);
  assert.deepEqual(calls, [`POST /api/txs/test ${JSON.stringify([fixture("tx.hex").trim()])}`]);
  await assert.rejects(esploraIndexer("https://esplora.test/api", fakeEsplora(answer({ allowed: false, vsize: null, fees: null, "reject-reason": "missing-inputs" }))).simulate(signed), (error: unknown) => error instanceof SimulationRefused && /simulation rejected the transaction: missing-inputs/.test(error.message));
  await assert.rejects(esploraIndexer("https://esplora.test/api", fakeEsplora({})).simulate(signed), (error: unknown) => !(error instanceof SimulationRefused) && /txs\/test answered 404/.test(String(error)), "an Esplora without testmempoolaccept stops the send");
  assert.throws(() => parseMempoolTest([{ txid: PREV_ID, allowed: false }], TX_ID), (error: unknown) => !(error instanceof SimulationRefused) && /tested txid 711b/.test(String(error)), "a refusal of another txid is not a refusal of this one");
  assert.throws(() => parseMempoolTest([{ txid: PREV_ID, allowed: true }], TX_ID), /tested txid 711b/);
  assert.throws(() => parseMempoolTest([], TX_ID));
  assert.throws(() => parseMempoolTest([{ txid: TX_ID, allowed: true }, { txid: TX_ID, allowed: true }], TX_ID));
  assert.throws(() => parseMempoolTest([{ txid: TX_ID, allowed: "true" }], TX_ID));
});

test("a bitcoin balance reads confirmed sats as BTC and names pending sats, and refuses another network's address", async () => {
  const indexer = esploraIndexer("https://esplora.test/api", fakeEsplora({ [`GET /api/address/${ADDRESS}`]: { body: JSON.stringify({ chain_stats: { funded_txo_sum: 150_000_000, spent_txo_sum: 0 }, mempool_stats: { funded_txo_sum: 2_000, spent_txo_sum: 0 } }) } }));
  const read = await bitcoinBalance(indexer, ADDRESS, "bitcoin");
  assert.deepEqual(read.holdings.map((row) => [row.symbol, row.amount, row.raw, row.chainKey, row.native]), [["BTC", 1.5, "150000000", "bitcoin", true]]);
  assert.equal(read.reason, "2000 sats are unconfirmed");
  assert.deepEqual(await bitcoinBalance(indexer, ADDRESS, "regtest"), { holdings: [], reason: `${ADDRESS} is not a regtest bitcoin address` });
});
