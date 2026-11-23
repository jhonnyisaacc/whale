import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import test from "node:test";
import { Keypair } from "@solana/web3.js";
import { keccak256, toHex, type Hex } from "viem";
import { lifiQuote, resetProviderGuards } from "../src/aggregators.js";
import { rememberApproval, resetApprovals } from "../src/approvals.js";
import { broadcastRoute, createViemRpc, type EvmReceipt, type EvmRpc, type SendIo } from "../src/broadcast.js";
import { DEFAULT_EVM_FEE_LIMITS, chainByKey, evmFeeLimits } from "../src/chains.js";
import { loadConfig, type AppConfig } from "../src/config.js";
import type { RouteLeg } from "../src/domain.js";
import { BroadcastError } from "../src/executor.js";
import { HOSTED_CHAINS } from "../src/gateway/policy.js";
import type { EvmSignInput, TransactionSigner } from "../src/managed-signer.js";
import { createNonceManager } from "../src/nonce.js";
import { resetRpcClients } from "../src/rpc.js";
import { assertEvmFee, assertEvmSigning, DEFAULT_MAX_VALUE_WEI, swapTerms, turnkeyPolicyDocument } from "../src/signing-policy.js";
import { lifiData, type LifiSwap } from "./fixtures.js";

const ZKSYNC = 324;
const DIAMOND = "0x341e94069f53234fe6dabef707ad424830525715";
const OWNER = "0x2222222222222222222222222222222222222222";
const ATTACKER = "0x9999999999999999999999999999999999999999";
const USDC = "0x1d17CBcF0D6D143135aE902365D2E5e2A16538D4";
const ZK = "0x5A7d6b2F92C77FAD6CCaBd7EE0624E64907Eaf3E";
const OTHER = "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
const NATIVE = "0x0000000000000000000000000000000000000000";
const zksync = { kind: "evm" as const, chainId: ZKSYNC };

const feeStep = (token: string, amount: bigint, deposit = false): LifiSwap => ({ sell: token, buy: token, amount, deposit });
const usdcToZk = (amount: bigint, extra: LifiSwap[] = []) =>
  lifiData("swapTokensMultipleV3ERC20ToERC20", OWNER, 9_950_000n, [feeStep(USDC, amount, true), { sell: USDC, buy: ZK, amount: amount - 1_000n }, ...extra]);

test("zkSync signs type-2 sends under its own gas and fee-per-gas limit", () => {
  assert.equal(chainByKey("zksync")?.liveSend, "eip1559");
  const limit = DEFAULT_EVM_FEE_LIMITS[ZKSYNC];
  assert.deepEqual(limit, { maxGas: 6_000_000n, maxFeePerGas: 250_000_000n });
  const measured = { chainId: ZKSYNC, gas: 4_415_200n, maxFeePerGas: 54_300_000n, maxPriorityFeePerGas: 0n, data: usdcToZk(5_000_000n) };
  assert.doesNotThrow(() => assertEvmFee(limit, measured));
  assert.throws(() => assertEvmFee(limit, { ...measured, gas: 6_000_001n }), /zksync \(chain id 324\): EVM gas limit exceeds the signing policy/);
  assert.throws(() => assertEvmFee(limit, { ...measured, maxFeePerGas: 250_000_001n }), /maxFeePerGas exceeds the signing policy/);
  assert.equal(evmFeeLimits(JSON.stringify({ [ZKSYNC]: { maxGas: "7000000", maxFeePerGas: "300000000" } }))[ZKSYNC]?.maxGas, 7_000_000n);
});

test("hosted wallets and the Turnkey policy still leave zkSync out", () => {
  assert.equal(HOSTED_CHAINS.includes("zksync"), false);
  const policy = JSON.stringify(
    turnkeyPolicyDocument({
      userId: "a1b2c3d4-1111-4222-8333-944455556666",
      wallets: { evm: "0b5d7e2c-1a3f-4e6b-8c9d-7f2a1b3c4d5e", solana: "1c6e8f3d-2b4a-4f7c-9d0e-8a3b2c4d5e6f", hyperliquid: null },
      solanaAddress: Keypair.generate().publicKey.toBase58(),
      routers: { [ZKSYNC]: [DIAMOND], 1: [OTHER] },
      maxValueWei: 1n,
    }),
  );
  assert.match(policy, /eth\.tx\.chain_id == 1 /);
  assert.doesNotMatch(policy, /eth\.tx\.chain_id == 324/);
});

test("swapTerms reads a LI.FI GenericSwapFacetV3 recipient, output, and what it pulls from the wallet", () => {
  assert.deepEqual(swapTerms(lifiData("swapTokensMultipleV3NativeToERC20", OWNER, 7n, [feeStep(NATIVE, 100n), { sell: NATIVE, buy: USDC, amount: 99n }])), {
    provider: "lifi",
    recipient: OWNER,
    buyToken: USDC,
    minOut: 7n,
    deposit: null,
  });
  assert.deepEqual(swapTerms(lifiData("swapTokensMultipleV3ERC20ToNative", OWNER, 7n, [feeStep(USDC, 5_000_000n, true), { sell: USDC, buy: NATIVE, amount: 4_990_000n }])), {
    provider: "lifi",
    recipient: OWNER,
    buyToken: NATIVE,
    minOut: 7n,
    deposit: { token: USDC, amount: 5_000_000n },
  });
  assert.deepEqual(swapTerms(lifiData("swapTokensSingleV3ERC20ToERC20", OWNER, 7n, [{ sell: USDC, buy: ZK, amount: 5n }])), {
    provider: "lifi",
    recipient: OWNER,
    buyToken: ZK,
    minOut: 7n,
    deposit: { token: USDC, amount: 5n },
  });
  assert.deepEqual(swapTerms(usdcToZk(5_000_000n, [feeStep(USDC, 2_000_000n, true)])), { provider: "lifi", recipient: OWNER, buyToken: USDC, minOut: 9_950_000n, deposit: { token: USDC, amount: 7_000_000n } });
  assert.equal(swapTerms(usdcToZk(5_000_000n, [feeStep(OTHER, 1n, true)])), null, "a swap that pulls a second token from the wallet is not decodable");
  assert.equal(swapTerms(lifiData("swapTokensMultipleV3ERC20ToERC20", OWNER, 7n, [feeStep(NATIVE, 1n, true)])), null, "an ERC20 entry point that deposits the native id is not decodable");
  assert.equal(swapTerms(lifiData("swapTokensMultipleV3ERC20ToERC20", OWNER, 7n, [])), null, "an empty route is not decodable");
});

const policyInput = {
  chainId: ZKSYNC,
  to: DIAMOND,
  value: 0n,
  purpose: "swap" as const,
  routers: [DIAMOND],
  settlers: [],
  withdrawAllowlist: [],
  maxValueWei: DEFAULT_MAX_VALUE_WEI,
  allowHotApproval: false,
  owner: OWNER,
  allowOpaqueSwap: false,
};

test("the signing policy reads a zkSync LI.FI swap and refuses one that pays someone else", () => {
  assert.doesNotThrow(() => assertEvmSigning({ ...policyInput, data: usdcToZk(5_000_000n) }));
  const stolen = lifiData("swapTokensMultipleV3ERC20ToERC20", ATTACKER, 1n, [feeStep(USDC, 5_000_000n, true)]);
  assert.throws(() => assertEvmSigning({ ...policyInput, data: stolen }), /zksync \(chain id 324\): swap recipient is not the hot wallet/);
  assert.throws(() => assertEvmSigning({ ...policyInput, data: usdcToZk(5_000_000n, [feeStep(OTHER, 1n, true)]) }), /does not name a checkable recipient/);
});

const reference = { spentUsd: 5, priceUsd: 0.5, decimals: 18 };
const lifiBody = (data: Hex, to = DIAMOND, value = "0") => ({
  estimate: { toAmount: "10000000000000000000", toAmountMin: "1", approvalAddress: to, feeCosts: [], gasCosts: [] },
  transactionRequest: { chainId: ZKSYNC, to, data, value, gasLimit: "4415200" },
});

test("a LI.FI quote is signable only when it decodes and its diamond is in the chain's router allowlist", () => {
  const listed = loadConfig({ ROUTER_ALLOWLIST_JSON: JSON.stringify({ [ZKSYNC]: [DIAMOND] }) });
  assert.equal(lifiQuote(listed, lifiBody(usdcToZk(5_000_000n)), reference, ZKSYNC).signable, true);
  assert.equal(lifiQuote(listed, lifiBody("0x12345678"), reference, ZKSYNC).signable, false);
  assert.equal(lifiQuote(listed, lifiBody(usdcToZk(5_000_000n), OTHER), reference, ZKSYNC).signable, false);
  assert.equal(lifiQuote(loadConfig({}), lifiBody(usdcToZk(5_000_000n)), reference, ZKSYNC).signable, false);
});

function chainRpc(): { rpc: EvmRpc; sent: Hex[] } {
  const receipts = new Map<string, EvmReceipt>();
  const sent: Hex[] = [];
  const rpc: EvmRpc = {
    fees: async () => ({ maxFeePerGas: 54_300_000n, maxPriorityFeePerGas: 0n }),
    pendingNonce: async () => 1,
    confirmedNonce: async () => 1,
    estimateGas: async () => 2_245_953n,
    simulate: async () => undefined,
    sendRaw: async (signed) => {
      sent.push(signed);
      receipts.set(keccak256(signed), { status: "success", gasUsed: 2_000_000n, effectiveGasPrice: 45_250_000n, l1Fee: 0n });
    },
    receipt: async (hash) => receipts.get(hash) ?? null,
    seen: async (hash) => receipts.has(hash),
    balance: async () => 10n ** 20n,
    checkChain: async () => undefined,
  };
  return { rpc, sent };
}

function io(rpc: EvmRpc): SendIo {
  let clock = 0;
  return {
    evm: () => rpc,
    solana: () => {
      throw new Error("no solana rpc");
    },
    nonces: createNonceManager(),
    sleep: async (ms) => {
      clock += ms;
    },
    now: () => clock,
    confirmTimeoutMs: 1_000,
    pollMs: 100,
  };
}

function signer(signed: EvmSignInput[]): TransactionSigner {
  return {
    backend: "keystore",
    evmAddress: () => OWNER,
    solanaAddress: () => null,
    async signEvm(input) {
      signed.push(input);
      return toHex(`${signed.length}:${input.data}`);
    },
    async signSolana() {
      throw new Error("solana is not loaded");
    },
    async signHyperliquid() {
      return { r: "0x01", s: "0x02", v: 27 };
    },
  };
}

const leg = (raw: unknown): RouteLeg => ({
  sellAddress: USDC,
  buyAddress: ZK,
  sellAmount: "5000000",
  spentUsd: 5,
  priceUsd: 0.5,
  decimals: 18,
  impactPct: 0,
  quote: { provider: "lifi", raw, quotedAtMs: 900, sellAmount: "5000000", taker: OWNER },
});

const zkConfig = (): AppConfig => ({ ...loadConfig({ RPC_URL_324: "http://fake.invalid", ROUTER_ALLOWLIST_JSON: JSON.stringify({ [ZKSYNC]: [DIAMOND] }) }), now: () => 1_000 });
const route = (raw: unknown) => ({ kind: "evm" as const, description: "swap", chain: zksync, hyperliquidActions: [], provider: "lifi", legs: [leg(raw)] });
const serving = (body: unknown): typeof fetch => async (input) => (new URL(String(input)).hostname === "li.quest" ? Response.json(body) : new Response("{}", { status: 500 }));

test("a zkSync LI.FI swap signs from its decoded terms with the quote's gas limit", async () => {
  resetProviderGuards();
  resetApprovals();
  rememberApproval({ chainId: ZKSYNC, token: USDC, spender: DIAMOND, owner: OWNER }, 10n ** 30n);
  const signed: EvmSignInput[] = [];
  const chain = chainRpc();
  const data = lifiData("swapTokensMultipleV3ERC20ToERC20", OWNER, 9_950_000_000_000_000_000n, [feeStep(USDC, 5_000_000n, true), { sell: USDC, buy: ZK, amount: 4_990_000n }]);
  const result = await broadcastRoute(zkConfig(), signer(signed), route(lifiBody(data)), 1, serving(lifiBody(data)), [], { io: io(chain.rpc) });
  assert.equal(result.venue === "chain" && result.outcome, "landed");
  assert.equal(signed.length, 1);
  assert.equal(signed[0]?.chainId, ZKSYNC);
  assert.equal(signed[0]?.to, DIAMOND);
  assert.equal(signed[0]?.gas, 4_415_200n);
  assert.equal(signed[0]?.maxFeePerGas, 54_300_000n);
});

test("a zkSync LI.FI swap whose calldata differs from the leg is refused before signing", async () => {
  const min = 9_950_000_000_000_000_000n;
  const honest = (overrides: { recipient?: string; minOut?: bigint; swaps?: LifiSwap[] } = {}) =>
    lifiData("swapTokensMultipleV3ERC20ToERC20", overrides.recipient ?? OWNER, overrides.minOut ?? min, overrides.swaps ?? [feeStep(USDC, 5_000_000n, true), { sell: USDC, buy: ZK, amount: 4_990_000n }]);
  const cases: Array<[Hex, RegExp]> = [
    [honest({ recipient: ATTACKER }), /recipient is not the hot wallet/],
    [honest({ minOut: 1n }), /below ours/],
    [honest({ swaps: [feeStep(USDC, 5_000_000n, true), { sell: USDC, buy: OTHER, amount: 4_990_000n }] }), /buys a different token/],
    [honest({ swaps: [feeStep(USDC, 5_000_001n, true), { sell: USDC, buy: ZK, amount: 4_990_000n }] }), /does not pull the leg's sell token and amount/],
    ["0x12345678", /quote-only until facet calldata can be verified/],
  ];
  for (const [data, error] of cases) {
    resetProviderGuards();
    resetApprovals();
    rememberApproval({ chainId: ZKSYNC, token: USDC, spender: DIAMOND, owner: OWNER }, 10n ** 30n);
    const signed: EvmSignInput[] = [];
    await assert.rejects(
      () => broadcastRoute(zkConfig(), signer(signed), route(lifiBody(data)), 1, serving(lifiBody(data)), [], { io: io(chainRpc().rpc) }),
      (thrown: unknown) => thrown instanceof BroadcastError && !thrown.broadcast && error.test(thrown.message),
      String(error),
    );
    assert.equal(signed.length, 0);
  }
});

type EraReply = { simulate: "unlisted" | "reverts"; call: "ok" | "reverts" };

async function eraRpc(reply: EraReply): Promise<{ url: string; methods: string[]; params: unknown[][]; close: () => Promise<void> }> {
  const methods: string[] = [];
  const params: unknown[][] = [];
  const server: Server = createServer((request, response) => {
    let raw = "";
    request.on("data", (chunk) => (raw += chunk));
    request.on("end", () => {
      const body = JSON.parse(raw) as { id: number; method: string; params: unknown[] };
      methods.push(body.method);
      params.push(body.params);
      const reverted = { code: 3, message: "execution reverted", data: "0x" };
      const answer =
        body.method === "eth_chainId"
          ? { result: "0x144" }
          : body.method === "eth_estimateGas"
            ? { result: "0x2be2a" }
            : body.method === "eth_simulateV1"
            ? { error: reply.simulate === "unlisted" ? { code: -32601, message: "rpc method is not whitelisted" } : reverted }
            : reply.call === "ok"
              ? { result: "0x" }
              : { error: reverted };
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ jsonrpc: "2.0", id: body.id, ...answer }));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as { port: number };
  return { url: `http://127.0.0.1:${port}`, methods, params, close: () => new Promise((resolve) => (server.closeAllConnections(), server.close(() => resolve()))) };
}

test("an RPC without eth_simulateV1, as zkSync's public one, still simulates through eth_call and still refuses a revert", async () => {
  const call = { from: OWNER as Hex, to: DIAMOND as Hex, data: "0x12345678" as Hex, value: 0n };
  for (const [reply, passes] of [
    [{ simulate: "unlisted", call: "ok" }, true],
    [{ simulate: "unlisted", call: "reverts" }, false],
    [{ simulate: "reverts", call: "ok" }, false],
  ] as const) {
    resetRpcClients();
    const rpc = await eraRpc(reply);
    try {
      const simulated = createViemRpc(ZKSYNC, [rpc.url]).simulate(call);
      if (passes) await simulated;
      else await assert.rejects(simulated);
      assert.equal(rpc.methods.includes("eth_call"), reply.simulate === "unlisted", JSON.stringify(reply));
    } finally {
      await rpc.close();
    }
  }
});

test("gas is estimated as the type-2 transaction Whale signs, which zkSync prices above an untyped call", async () => {
  resetRpcClients();
  const rpc = await eraRpc({ simulate: "unlisted", call: "ok" });
  try {
    const gas = await createViemRpc(ZKSYNC, [rpc.url]).estimateGas({ from: OWNER as Hex, to: OWNER as Hex, data: "0x", value: 1n });
    assert.equal(gas, 179_754n);
    const [request] = rpc.params[rpc.methods.indexOf("eth_estimateGas")] as [Record<string, unknown>];
    assert.equal(request.type, "0x2");
  } finally {
    await rpc.close();
  }
});
