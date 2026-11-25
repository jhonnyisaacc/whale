import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import test from "node:test";
import { secp256k1 } from "@noble/curves/secp256k1";
import { p2wpkh, RawTx, Transaction } from "@scure/btc-signer";
import pg from "pg";
import { privateKeyToAccount } from "viem/accounts";
import { esploraIndexer, RAW_TX_OPTIONS, SimulationRefused, transactionId, type BitcoinIndexer, type Utxo } from "../src/bitcoin/esplora.js";
import type { BitcoinPolicy } from "../src/bitcoin/send.js";
import { BTC_PARAMS, sameScript } from "../src/bitcoin/wallet.js";
import { lookupAgedTx } from "../src/broadcast.js";
import { loadConfig } from "../src/config.js";
import { localSender } from "../src/local-sends.js";
import { startSignerQueue, type SignerQueue } from "../src/signer-queue.js";
import { poolFor, reconcileReserved } from "../src/spend.js";

const TOKEN = "t".repeat(40);
const KEY = new Uint8Array(32).fill(0x11);
const OWN = p2wpkh(secp256k1.getPublicKey(KEY, true), BTC_PARAMS.regtest);
const OWNER = p2wpkh(secp256k1.getPublicKey(new Uint8Array(32).fill(0x22), true), BTC_PARAMS.regtest).address as string;
const STRANGER = p2wpkh(secp256k1.getPublicKey(new Uint8Array(32).fill(0x33), true), BTC_PARAMS.regtest).address as string;
const EVM = privateKeyToAccount(`0x${"11".repeat(32)}`).address;
const EVM_DEST = "0x2222222222222222222222222222222222222222";
const hex = (bytes: Uint8Array) => Buffer.from(bytes).toString("hex");
const bytesOf = (text: string) => new Uint8Array(Buffer.from(text, "hex"));

function funding(sats: bigint, seed: number): Uint8Array {
  const input = { txid: new Uint8Array(32).fill(seed), index: 0, finalScriptSig: new Uint8Array([0x51]), sequence: 0xffffffff };
  return RawTx.encode({ version: 2, segwitFlag: false, inputs: [input], outputs: [{ amount: sats, script: OWN.script }], witnesses: [], lockTime: 0 });
}

type World = { indexer: BitcoinIndexer; simulated: string[]; broadcasts: string[]; feeRate: number; simulateError: Error | null; broadcastError: Error | null };

function world(coins: bigint[]): World {
  const previous = new Map(coins.map((sats, index) => [transactionId(funding(sats, index + 1)), funding(sats, index + 1)]));
  const state: World = {
    feeRate: 2,
    simulated: [],
    broadcasts: [],
    simulateError: null,
    broadcastError: null,
    indexer: {
      utxos: async (address) => (address === OWN.address ? [...previous].map(([txid], index): Utxo => ({ txid, vout: 0, sats: coins[index] as bigint, confirmed: true })) : []),
      transaction: async (txid) => previous.get(txid) as Uint8Array,
      feeRate: async () => state.feeRate,
      balance: async () => ({ confirmedSats: 0n, pendingSats: 0n }),
      simulate: async (signed) => {
        state.simulated.push(hex(signed));
        if (state.simulateError) throw state.simulateError;
      },
      broadcast: async (signed) => {
        if (state.broadcastError) throw state.broadcastError;
        state.broadcasts.push(hex(signed));
        return transactionId(signed);
      },
      transactionStatus: async () => null,
    },
  };
  return state;
}

type Call = { unsigned: string; previous: string[] };

function fakePolicy(calls: Call[]): BitcoinPolicy {
  return (unsigned, previous, rule) => {
    calls.push({ unsigned: hex(unsigned), previous: previous.map(hex) });
    const tx = Transaction.fromRaw(unsigned, RAW_TX_OPTIONS);
    const prevouts = previous.map((raw, index) => Transaction.fromRaw(raw, RAW_TX_OPTIONS).getOutput(tx.getInput(index).index as number)).map((output) => ({ script: output.script as Uint8Array, sats: output.amount as bigint }));
    const inputs = prevouts.reduce((sum, prevout) => sum + prevout.sats, 0n);
    let outputs = 0n;
    let changeSats = 0n;
    for (let index = 0; index < tx.outputsLength; index += 1) {
      const output = tx.getOutput(index);
      outputs += output.amount as bigint;
      if (sameScript(output.script as Uint8Array, rule.own)) changeSats += output.amount as bigint;
    }
    return { prevouts, feeSats: inputs - outputs, changeSats, spentSats: inputs - changeSats };
  };
}

type Job = { id: string; kind: string; payload: { transaction: string; previous: string[] } };

function signer(queue: SignerQueue, jobs: Job[], refuse: () => boolean): () => void {
  let stopped = false;
  void (async () => {
    while (!stopped) {
      const response = await fetch(`${queue.url}/signer/v1/jobs?wait=1`, { headers: { authorization: `Bearer ${TOKEN}` } }).catch(() => null);
      if (!response || response.status !== 200) continue;
      const job = (await response.json()) as Job;
      jobs.push(job);
      const tx = Transaction.fromRaw(bytesOf(job.payload.transaction), RAW_TX_OPTIONS);
      job.payload.previous.forEach((raw, index) => {
        const output = Transaction.fromRaw(bytesOf(raw), RAW_TX_OPTIONS).getOutput(tx.getInput(index).index as number);
        tx.updateInput(index, { witnessUtxo: { script: output.script as Uint8Array, amount: output.amount as bigint } });
      });
      tx.sign(KEY);
      tx.finalize();
      const answer = refuse() ? { decision: "refused", reasons: ["bitcoin: output 0 pays someone, which is not an allowed destination"] } : { decision: "signed", result: { signedTransaction: hex(tx.extract()) } };
      await fetch(`${queue.url}/signer/v1/jobs/${job.id}/result`, { method: "POST", headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" }, body: JSON.stringify(answer) }).catch(() => null);
    }
  })();
  return () => {
    stopped = true;
  };
}

type Harness = { send: ReturnType<typeof localSender>; world: World; jobs: Job[]; calls: Call[]; refuse: { next: boolean } };

async function withBitcoin(env: Record<string, string>, coins: bigint[], run: (harness: Harness) => Promise<void>, realPolicy = false): Promise<void> {
  const prices = createServer((request, response) => {
    response.setHeader("content-type", "application/json");
    response.end(JSON.stringify(request.url?.includes("ids=bitcoin") ? { bitcoin: { usd: 100_000 } } : { ethereum: { usd: 3000 } }));
  });
  await new Promise<void>((resolve) => prices.listen(0, "127.0.0.1", resolve));
  const priceUrl = `http://127.0.0.1:${(prices.address() as AddressInfo).port}`;
  const queue = await startSignerQueue({ token: TOKEN, port: 0, answerTimeoutMs: 5_000 });
  const jobs: Job[] = [];
  const calls: Call[] = [];
  const refuse = { next: false };
  const stop = signer(queue, jobs, () => refuse.next);
  try {
    const state = world(coins);
    const base = { BITCOIN_NETWORK: "regtest", BITCOIN_ESPLORA_URL: "http://127.0.0.1:1", BITCOIN_WITHDRAW_ADDRESSES: OWNER, OWNER_WITHDRAW_ADDRESSES: EVM_DEST, COINGECKO_API_BASE: priceUrl, DEXSCREENER_API_BASE: priceUrl, MAX_USD_PER_TRADE: "10", DAILY_USD_CAP: "10" };
    const setup = { evmAddress: EVM, solanaAddress: "So11111111111111111111111111111111111111112", bitcoinPublicKey: hex(secp256k1.getPublicKey(KEY, true)), token: TOKEN, port: 0, answerTimeoutMs: 5_000 };
    const send = localSender({ ...base, ...env }, queue, setup, realPolicy ? { bitcoinIndexer: state.indexer } : { bitcoinIndexer: state.indexer, bitcoinPolicy: fakePolicy(calls) });
    await run({ send, world: state, jobs, calls, refuse });
  } finally {
    stop();
    await queue.close();
    prices.closeAllConnections();
    await new Promise((resolve) => prices.close(resolve));
  }
}

const btc = (key: string, sats: string, to = OWNER, mode: "dry_run" | "live" = "live") => ({ kind: "send_bitcoin" as const, idempotencyKey: key, to, sats, mode });
const eth = (key: string) => ({ kind: "transfer" as const, idempotencyKey: key, mode: "live" as const, asset: { chain: { kind: "evm" as const, chainId: 8453 }, chainKey: "base", address: "0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee", symbol: "ETH", decimals: 18 }, to: EVM_DEST, amount: "1500000000000000" });

test("with WHALE_BROADCAST off a live send is signed by whale-signer, verified, and held with its txid", () =>
  withBitcoin({}, [100_000n], async ({ send, world, jobs, calls }) => {
    const result = await send(btc("hold", "6000"));
    assert.equal(result.status, "signed", JSON.stringify(result));
    assert.match(result.reason, /WHALE_BROADCAST is off/);
    assert.deepEqual(world.broadcasts, []);
    assert.deepEqual(world.simulated, [], "a held transaction is not handed to the indexer");
    assert.equal(jobs.length, 1);
    assert.equal(calls.length, 1, "the app policy runs exactly once");
    assert.deepEqual(calls[0], { unsigned: jobs[0]?.payload.transaction, previous: jobs[0]?.payload.previous }, "the policy saw the exact bytes the signer got");
    assert.equal(result.txid, transactionId(bytesOf(result.signedTransaction as string)));
    assert.equal(result.plan?.spentSats, String(6000n + BigInt(result.plan?.feeSats ?? "0")));
  }));

test("a destination outside BITCOIN_WITHDRAW_ADDRESSES is refused before any signer job", () =>
  withBitcoin({}, [100_000n], async ({ send, jobs, calls }) => {
    const result = await send(btc("stranger", "6000", STRANGER));
    assert.deepEqual([result.status, result.reason], ["skipped", "destination is not in BITCOIN_WITHDRAW_ADDRESSES"]);
    assert.equal((await send(btc("mainnet", "6000", "bc1qjafqmk43zp2y0kg4jlr55u3dnqxxzrqlrx6k7q"))).reason, "bc1qjafqmk43zp2y0kg4jlr55u3dnqxxzrqlrx6k7q is not a regtest bitcoin address");
    assert.deepEqual([jobs.length, calls.length], [0, 0]);
  }));

test("a fee rate above BITCOIN_MAX_FEE_RATE is refused, not clamped", () =>
  withBitcoin({ BITCOIN_MAX_FEE_RATE: "50" }, [100_000n], async ({ send, world, jobs }) => {
    world.feeRate = 51;
    const result = await send(btc("spike", "6000"));
    assert.deepEqual([result.status, result.reason], ["skipped", "the fee market is at 51 sat/vB, above BITCOIN_MAX_FEE_RATE 50"]);
    assert.equal(jobs.length, 0);
  }));

test("a dry run plans the send and signs nothing, and its key stays free for the live send", () =>
  withBitcoin({}, [100_000n], async ({ send, jobs }) => {
    const planned = await send(btc("same", "6000", OWNER, "dry_run"));
    assert.equal(planned.status, "planned");
    assert.equal(jobs.length, 0);
    assert.equal((await send(btc("same", "6000"))).status, "signed");
  }));

test("a send above MAX_USD_PER_TRADE is refused before signing", () =>
  withBitcoin({}, [100_000n], async ({ send, jobs }) => {
    const result = await send(btc("big", "20000"));
    assert.deepEqual([result.status, result.reason], ["skipped", "notional exceeds 10 USD"]);
    assert.equal(jobs.length, 0);
  }));

test("a held send keeps its USD reservation because its signed transaction can still be sent, and a refused one gives it back", () =>
  withBitcoin({}, [100_000n], async ({ send, refuse }) => {
    refuse.next = true;
    await assert.rejects(send(btc("r1", "6000")), /whale-signer refused/);
    refuse.next = false;
    assert.equal((await send(btc("h1", "6000"))).status, "signed", "a refused send spent nothing");
    assert.equal((await send(btc("h2", "6000"))).reason, "daily cap 10 USD", "a held send counts against the cap");
  }).then(() =>
    withBitcoin({ WHALE_BROADCAST: "true" }, [100_000n], async ({ send, world }) => {
      const sent = await send(btc("b1", "6000"));
      assert.equal(sent.status, "sent", JSON.stringify(sent));
      assert.equal(world.broadcasts.length, 1);
      assert.equal((await send(btc("b2", "6000"))).reason, "daily cap 10 USD");
    }),
  ));

test("a live send is simulated before broadcast, only a matching mempool refusal gives its reservation back, and any other simulation failure keeps it", () =>
  withBitcoin({ WHALE_BROADCAST: "true" }, [100_000n], async ({ send, world }) => {
    world.simulateError = new SimulationRefused("simulation rejected the transaction: min relay fee not met");
    await assert.rejects(send(btc("unsimulated", "6000")), /min relay fee not met/);
    assert.equal(world.simulated.length, 1);
    assert.deepEqual(world.broadcasts, []);
    world.simulateError = null;
    const sent = await send(btc("simulated", "6000"));
    assert.equal(sent.status, "sent", JSON.stringify(sent));
    assert.deepEqual(world.broadcasts, [world.simulated.at(-1)], "the broadcast bytes are the simulated bytes");
  }).then(() =>
    withBitcoin({ WHALE_BROADCAST: "true" }, [100_000n], async ({ send, world }) => {
      world.simulateError = new Error("esplora could not simulate the transaction: txs/test answered 404");
      await assert.rejects(send(btc("no-route", "6000")), /txs\/test answered 404/);
      assert.deepEqual(world.broadcasts, []);
      world.simulateError = null;
      assert.equal((await send(btc("after", "6000"))).reason, "daily cap 10 USD", "the indexer got the signed transaction, so the spend stays charged");
    }),
  ));

type Answer = { status?: number; body: string } | { error: Error };

function esploraAnswers(simulation: (txid: string) => Answer, broadcast: (txid: string) => Answer): Pick<BitcoinIndexer, "simulate" | "broadcast"> {
  const fetchImpl: typeof fetch = async (input, init) => {
    const path = new URL(String(input)).pathname;
    const raw = path === "/txs/test" ? (JSON.parse(String(init?.body)) as string[])[0] : String(init?.body);
    const answer = (path === "/txs/test" ? simulation : broadcast)(transactionId(bytesOf(raw as string)));
    if ("error" in answer) throw answer.error;
    return new Response(answer.body, { status: answer.status ?? 200 });
  };
  const real = esploraIndexer("http://esplora.test", fetchImpl);
  return { simulate: real.simulate, broadcast: real.broadcast };
}

const OTHER_TXID = "00".repeat(32);
const echo = (txid: string): Answer => ({ body: txid });
const allowed = (txid: string): Answer => ({ body: JSON.stringify([{ txid, allowed: true }]) });
const refusedFor = (txid: string): Answer => ({ body: JSON.stringify([{ txid, allowed: false, "reject-reason": "missing-inputs" }]) });
const dropped = (): Answer => ({ error: new TypeError("fetch failed") });
const outcomes: [string, (txid: string) => Answer, (txid: string) => Answer, "released" | "committed"][] = [
  ["sim-refused", refusedFor, echo, "released"],
  ["sim-refused-other-txid", () => refusedFor(OTHER_TXID), echo, "committed"],
  ["sim-allowed-other-txid", () => allowed(OTHER_TXID), echo, "committed"],
  ["sim-500", () => ({ status: 500, body: "boom" }), echo, "committed"],
  ["sim-404", () => ({ status: 404, body: "Not Found" }), echo, "committed"],
  ["sim-non-json", () => ({ body: "<html>ok</html>" }), echo, "committed"],
  ["sim-network", dropped, echo, "committed"],
  ["broadcast-400", allowed, () => ({ status: 400, body: "sendrawtransaction RPC error" }), "committed"],
  ["broadcast-500", allowed, () => ({ status: 500, body: "down" }), "committed"],
  ["broadcast-network", allowed, dropped, "committed"],
  ["broadcast-other-txid", allowed, () => ({ body: "11".repeat(32) }), "committed"],
  ["broadcast-ok", allowed, echo, "committed"],
];

test("every simulation and broadcast outcome after signing keeps the reservation except a mempool refusal of the same txid", async () => {
  for (const [key, simulation, broadcast, status] of outcomes) {
    await withBitcoin({ WHALE_BROADCAST: "true" }, [100_000n], async ({ send, world }) => {
      Object.assign(world.indexer, esploraAnswers(simulation, broadcast));
      await send(btc(key, "6000")).catch(() => undefined);
      Object.assign(world.indexer, esploraAnswers(allowed, echo));
      if (status === "released") {
        assert.equal((await send(btc(key, "6000"))).status, "sent", `${key}: released key can retry and spend`);
      } else {
        if (key !== "broadcast-ok") assert.equal((await send(btc(key, "6000"))).reason, "duplicate spend", `${key}: committed key cannot send again`);
        assert.equal((await send(btc(`${key}-next`, "6000"))).reason, "daily cap 10 USD", `${key}: committed spend counts against the daily cap`);
      }
    });
  }
});

test("once the indexer holds the signed transaction, only a mempool refusal of that txid releases the reservation in Postgres", { skip: !process.env.TEST_DATABASE_URL }, async () => {
  const schema = `t_${randomUUID().replaceAll("-", "").slice(0, 12)}`;
  const admin = new pg.Client({ connectionString: process.env.TEST_DATABASE_URL });
  await admin.connect();
  await admin.query(`CREATE SCHEMA ${schema}`);
  const databaseUrl = `${process.env.TEST_DATABASE_URL}?options=${encodeURIComponent(`-c search_path=${schema}`)}`;
  try {
    await withBitcoin({ WHALE_BROADCAST: "true", DATABASE_URL: databaseUrl, DAILY_USD_CAP: "1000" }, [100_000n], async ({ send, world }) => {
      const seen: Record<string, string | undefined> = {};
      for (const [key, simulation, broadcast] of outcomes) {
        Object.assign(world.indexer, esploraAnswers(simulation, broadcast));
        await send(btc(key, "6000")).catch(() => undefined);
        seen[key] = (await admin.query(`SELECT status FROM ${schema}.spend_journal WHERE idempotency_key = $1`, [key])).rows[0]?.status;
      }
      assert.deepEqual(seen, Object.fromEntries(outcomes.map(([key, , , status]) => [key, status])));
    });
  } finally {
    await (await import("../src/spend.js")).closeSpendPools();
    await admin.query(`DROP SCHEMA ${schema} CASCADE`);
    await admin.end();
  }
});

test("a live BTC send is refused before any signer job when SUPPORT_TIERS holds bitcoin below live", () =>
  withBitcoin({ SUPPORT_TIERS: "bitcoin:dry_run" }, [100_000n], async ({ send, jobs }) => {
    const live = await send(btc("tier-live", "6000"));
    assert.deepEqual([live.status, live.reason], ["skipped", "chain is not enabled for live sends"]);
    assert.equal(jobs.length, 0);
    const planned = await send(btc("tier-dry", "6000", OWNER, "dry_run"));
    assert.equal(planned.status, "planned", JSON.stringify(planned));
  }));

test("BTC and other local sends share one daily USD cap", () =>
  withBitcoin({ WHALE_BROADCAST: "true" }, [100_000n], async ({ send }) => {
    assert.equal((await send(btc("btc-first", "6000"))).status, "sent");
    const transfer = await send(eth("eth-after"));
    assert.deepEqual([transfer.status, transfer.reason], ["skipped", "daily cap 10 USD"]);
  }));

test("the real app policy accepts the plan the sender builds, across several inputs with change", () =>
  withBitcoin({}, [4_000n, 3_000n, 2_500n], async ({ send, jobs }) => {
    const result = await send(btc("real-policy", "8000"));
    assert.equal(result.status, "signed", JSON.stringify(result));
    assert.equal(result.plan?.inputs, 3);
    assert.equal(jobs[0]?.payload.previous.length, 3);
  }, true));

test("an aged bitcoin tx is read from the configured indexer", async () => {
  let confirmed = false;
  const id = "ab".repeat(32);
  const server = createServer((request, response) => {
    if (request.url !== `/tx/${id}`) {
      response.writeHead(404).end("missing");
      return;
    }
    response.end(JSON.stringify({ status: { confirmed } }));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const config = loadConfig({ BITCOIN_NETWORK: "regtest", BITCOIN_ESPLORA_URL: `http://127.0.0.1:${(server.address() as AddressInfo).port}` });
  const aged = { chainKey: "bitcoin", txHash: id, from: null, nonce: null };
  try {
    assert.equal(await lookupAgedTx(config, aged), "pending");
    confirmed = true;
    assert.equal(await lookupAgedTx(config, aged), "landed");
    assert.equal(await lookupAgedTx(config, { ...aged, txHash: "cd".repeat(32) }), null);
    assert.equal(await lookupAgedTx(loadConfig({}), aged), null, "bitcoin stays unreadable until BITCOIN_NETWORK is set");
  } finally {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  }
});

async function withJournalFault(fault: string, run: (input: { databaseUrl: string; row: (key: string) => Promise<Record<string, unknown> | undefined> }) => Promise<void>): Promise<void> {
  const schema = `t_${randomUUID().replaceAll("-", "").slice(0, 12)}`;
  const admin = new pg.Client({ connectionString: process.env.TEST_DATABASE_URL });
  await admin.connect();
  await admin.query(`CREATE SCHEMA ${schema}`);
  const databaseUrl = `${process.env.TEST_DATABASE_URL}?options=${encodeURIComponent(`-c search_path=${schema}`)}`;
  try {
    await poolFor(databaseUrl);
    await admin.query(`CREATE FUNCTION ${schema}.fault() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF ${fault} THEN RAISE EXCEPTION 'journal is down'; END IF; RETURN NEW; END $$`);
    await admin.query(`CREATE TRIGGER fault BEFORE UPDATE ON ${schema}.spend_journal FOR EACH ROW EXECUTE FUNCTION ${schema}.fault()`);
    await run({ databaseUrl, row: async (key) => (await admin.query(`SELECT status, tx_hash, chain_key FROM ${schema}.spend_journal WHERE idempotency_key = $1`, [key])).rows[0] });
  } finally {
    await admin.query(`DROP SCHEMA ${schema} CASCADE`);
    await admin.end();
  }
}

test("a live send whose journal commit fails reports it, and reconciliation commits the row once the indexer confirms the tx", { skip: !process.env.TEST_DATABASE_URL }, () =>
  withJournalFault("NEW.status = 'committed' AND nextval('fault_seq') = 1", async ({ databaseUrl, row }) => {
    await (await poolFor(databaseUrl)).query("CREATE SEQUENCE fault_seq");
    let confirmed = false;
    let txid = "";
    const server = createServer((request, response) => {
      if (request.url !== `/tx/${txid}`) {
        response.writeHead(404).end("missing");
        return;
      }
      response.end(JSON.stringify({ status: { confirmed } }));
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const esplora = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const lookup = (tx: Parameters<typeof lookupAgedTx>[1]) => lookupAgedTx(loadConfig({ BITCOIN_NETWORK: "regtest", BITCOIN_ESPLORA_URL: esplora }), tx);
    try {
      await withBitcoin({ WHALE_BROADCAST: "true", DATABASE_URL: databaseUrl }, [100_000n], async ({ send, world }) => {
        const sent = await send(btc("commit-lost", "6000"));
        assert.equal(sent.status, "sent", JSON.stringify(sent));
        assert.match(sent.reason, /broadcast [0-9a-f]{64}, but the spend journal did not commit/);
        txid = sent.txid ?? "";
        assert.deepEqual(await row("commit-lost"), { status: "reserved", tx_hash: sent.txid, chain_key: "bitcoin" });
        const actions: string[] = [];
        const settle = async () => {
          actions.length = 0;
          await reconcileReserved(databaseUrl, 0, lookup, (entry) => void actions.push(`${entry.idempotencyKey}:${entry.action}`));
        };
        await settle();
        assert.deepEqual(actions, ["commit-lost:keep"], "an unconfirmed tx stays reserved and still counts");
        assert.equal((await row("commit-lost"))?.status, "reserved");
        confirmed = true;
        await settle();
        assert.deepEqual(actions, ["commit-lost:commit"]);
        assert.equal((await row("commit-lost"))?.status, "committed");
        assert.equal((await send(btc("second", "6000"))).reason, "daily cap 10 USD");
        assert.equal(world.broadcasts.length, 1);
      });
    } finally {
      server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
    }
  }));

test("a live send whose txid cannot be recorded is released and never reaches the indexer", { skip: !process.env.TEST_DATABASE_URL }, () =>
  withJournalFault("NEW.tx_hash IS NOT NULL", async ({ databaseUrl, row }) => {
    await withBitcoin({ WHALE_BROADCAST: "true", DATABASE_URL: databaseUrl }, [100_000n], async ({ send, world }) => {
      await assert.rejects(send(btc("unrecorded", "6000")), /journal is down/);
      assert.deepEqual([world.simulated, world.broadcasts], [[], []]);
      assert.deepEqual(await row("unrecorded"), { status: "released", tx_hash: null, chain_key: null });
    });
  }));
