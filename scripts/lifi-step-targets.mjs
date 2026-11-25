import { readFileSync, writeFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { decodeAbiParameters, getAddress, toFunctionSelector } from "viem";

const root = new URL("..", import.meta.url);
export const TS_FILE = new URL("src/signing-policy/lifi-targets.ts", root);
export const RUST_FILE = new URL("signer/src/lifi_targets.rs", root);

const DIAMOND = "0x1231DEB6f5749EF6cE6943a275A1D3E7486F4EaE";
export const CHAINS = [
  { chainId: 1, diamond: DIAMOND, rpcs: ["https://ethereum-rpc.publicnode.com", "https://eth.drpc.org"] },
  { chainId: 10, diamond: DIAMOND, rpcs: ["https://mainnet.optimism.io", "https://optimism-rpc.publicnode.com"] },
  { chainId: 324, diamond: "0x341e94069f53234fe6dabef707ad424830525715", rpcs: ["https://mainnet.era.zksync.io", "https://zksync.drpc.org"] },
  { chainId: 8453, diamond: DIAMOND, rpcs: ["https://mainnet.base.org", "https://base-rpc.publicnode.com"] },
  { chainId: 42161, diamond: DIAMOND, rpcs: ["https://arb1.arbitrum.io/rpc", "https://arbitrum-one-rpc.publicnode.com"] },
];

const APPROVE_ONLY = "0xffffffff";
const SWAP_CALLBACK = "uniswapV3SwapCallback(int256,int256,bytes)";
const OKX = [
  SWAP_CALLBACK,
  "smartSwapTo(uint256,address,(uint256,address,uint256,uint256,uint256),uint256[],(address[],address[],uint256[],bytes[],uint256)[][],(uint256,address,address,address,uint256,uint256,uint256,uint256,bool,bytes)[])",
  "uniswapV3SwapTo(uint256,uint256,uint256,uint256[])",
  "unxswapTo(uint256,uint256,uint256,address,bytes32[])",
  "swapWrap(uint256,uint256)",
];
const OKX_BASE_REQUEST = "swapWrapToWithBaseRequest(uint256,address,(uint256,address,uint256,uint256,uint256))";
const OKX_DAG = "dagSwapTo(uint256,address,(uint256,address,uint256,uint256,uint256),(address[],address[],uint256[],bytes[],uint256)[])";
const PARASWAP_ORDER = "(address,address,uint256,uint256,uint256,bytes32,address)";
const PARASWAP_POOL = "(address,address,uint256,uint256,uint256,bytes32,address,bytes)";
const KYBER_DESC = "(address,address,address[],uint256[],address[],uint256[],address,uint256,uint256,uint256,bytes)";

export const FAMILIES = [
  { family: "LI.FI FeeForwarder", role: "feeForwarder", variants: [["forwardERC20Fees(address,(address,uint256)[])", "forwardNativeFees((address,uint256)[])", "forwardERC20FeesShares(address,(address,uint64)[])"]] },
  { family: "approve-only spender", role: "spender", variants: [[APPROVE_ONLY]] },
  {
    family: "1inch AggregationRouterV6",
    role: "target",
    variants: [[SWAP_CALLBACK, "swap(address,(address,address,address,address,uint256,uint256,uint256),bytes)", "ethUnoswap(uint256,uint256)", "ethUnoswap2(uint256,uint256,uint256)", "ethUnoswap3(uint256,uint256,uint256,uint256)", "unoswap(uint256,uint256,uint256,uint256)", "unoswap2(uint256,uint256,uint256,uint256,uint256)", "unoswap3(uint256,uint256,uint256,uint256,uint256,uint256)"]],
  },
  { family: "Sushi RedSnwapper", role: "target", variants: [["snwap(address,uint256,address,address,uint256,address,bytes)", "snwapMultiple((address,uint256,address)[],(address,address,uint256)[],(address,uint256,bytes)[])"]] },
  { family: "OKX DexRouter", role: "target", variants: [OKX, [...OKX, OKX_BASE_REQUEST], [...OKX, OKX_BASE_REQUEST, OKX_DAG]] },
  {
    family: "Paraswap AugustusV6",
    role: "target",
    variants: [
      [
        SWAP_CALLBACK,
        `swapExactAmountIn(address,${PARASWAP_ORDER},uint256,bytes,bytes)`,
        `swapExactAmountOut(address,${PARASWAP_ORDER},uint256,bytes,bytes)`,
        `swapExactAmountInOnUniswapV2(${PARASWAP_POOL},uint256,bytes)`,
        `swapExactAmountOutOnUniswapV2(${PARASWAP_POOL},uint256,bytes)`,
        `swapExactAmountInOnUniswapV3(${PARASWAP_POOL},uint256,bytes)`,
        `swapExactAmountOutOnUniswapV3(${PARASWAP_POOL},uint256,bytes)`,
        "swapExactAmountInOnBalancerV2((uint256,uint256,uint256,bytes32,uint256),uint256,bytes,bytes)",
        "swapExactAmountOutOnBalancerV2((uint256,uint256,uint256,bytes32,uint256),uint256,bytes,bytes)",
        "swapExactAmountInOnCurveV1((uint256,uint256,address,address,uint256,uint256,uint256,bytes32,address),uint256,bytes)",
        "swapExactAmountInOnCurveV2((uint256,uint256,uint256,address,address,address,uint256,uint256,uint256,bytes32,address),uint256,bytes)",
        "swapOnAugustusRFQTryBatchFill((uint256,uint256,uint8,bytes32,address),((uint256,uint128,address,address,address,address,uint256,uint256),bytes,uint256,bytes,bytes)[],bytes)",
      ],
    ],
  },
  { family: "KyberSwap MetaAggregationRouterV2", role: "target", variants: [[`swap((address,address,bytes,${KYBER_DESC},bytes))`, `swapGeneric((address,address,bytes,${KYBER_DESC},bytes))`, `swapSimpleMode(address,${KYBER_DESC},bytes,bytes)`]] },
  { family: "Nordstern AggregatorGuard", role: "target", variants: [["IceCreamSwap()"]] },
  { family: "Fly DexAggregator", role: "target", variants: [["swapWithBackendSignature(bytes)"]] },
  { family: "LI.FI TokenWrapper", role: "target", variants: [["deposit()", "withdraw()"]] },
];

const selector = (item) => (item.startsWith("0x") ? item : toFunctionSelector(item));
const key = (selectors) => [...new Set(selectors.map((item) => item.toLowerCase()))].sort().join(",");
const FAMILY_BY_SELECTORS = new Map(FAMILIES.flatMap((family) => family.variants.map((variant) => [key(variant.map(selector)), family])));

const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function rpcUrls({ chainId, rpcs }, env = process.env) {
  const configured = [env[`RPC_URL_${chainId}`], env[`RPC_URLS_${chainId}`]]
    .flatMap((value) => (value ?? "").split(","))
    .map((url) => url.trim())
    .filter(Boolean);
  return configured.length > 0 ? [...new Set(configured)] : rpcs;
}

async function allowlistFrom(chainId, diamond, url) {
  const call = async (method, params) => {
    const response = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
      signal: AbortSignal.timeout(15_000),
    });
    if (!response.ok) throw new Error(`chain ${chainId}: ${method} failed with HTTP ${response.status}`);
    const body = await response.json();
    if (body.error || typeof body.result !== "string") throw new Error(`chain ${chainId}: ${method} failed: ${JSON.stringify(body.error ?? body)}`);
    return body.result;
  };
  const reported = Number(BigInt(await call("eth_chainId", [])));
  if (reported !== chainId) throw new Error(`chain ${chainId}: RPC answered eth_chainId with ${reported}`);
  const block = BigInt(await call("eth_blockNumber", []));
  const result = await call("eth_call", [{ to: diamond, data: toFunctionSelector("getAllContractSelectorPairs()") }, `0x${block.toString(16)}`]);
  const [contracts, selectors] = decodeAbiParameters([{ type: "address[]" }, { type: "bytes4[][]" }], result);
  if (contracts.length !== selectors.length) throw new Error(`chain ${chainId}: contract count ${contracts.length} does not match selector count ${selectors.length}`);
  return { block, pairs: contracts.map((address, index) => ({ address: getAddress(address), selectors: selectors[index] })) };
}

async function allowlist(chain) {
  let lastError;
  for (const url of rpcUrls(chain)) {
    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        return await allowlistFrom(chain.chainId, chain.diamond, url);
      } catch (error) {
        lastError = error;
        if (error instanceof Error && error.message.includes("eth_chainId with")) break;
        if (attempt === 0) await pause(500);
      }
    }
  }
  throw lastError;
}

export function classify(chainId, pairs) {
  const rows = pairs.map((pair) => ({ ...pair, family: FAMILY_BY_SELECTORS.get(key(pair.selectors)) ?? null }));
  const forwarders = rows.filter((row) => row.family?.role === "feeForwarder");
  if (forwarders.length !== 1) throw new Error(`chain ${chainId}: expected one LI.FI FeeForwarder in the diamond allowlist, found ${forwarders.length}`);
  const order = (role) =>
    rows
      .filter((row) => row.family?.role === role)
      .sort((a, b) => FAMILIES.indexOf(a.family) - FAMILIES.indexOf(b.family) || a.address.toLowerCase().localeCompare(b.address.toLowerCase()))
      .map((row) => row.address);
  return { table: { feeForwarder: forwarders[0].address, targets: order("target"), spenders: order("spender") }, rows };
}

export function renderTs(tables) {
  const list = (name, items) => [`    ${name}: [`, ...items.map((item) => `      "${item}",`), "    ],"];
  const body = Object.entries(tables).flatMap(([chainId, table]) => [`  ${chainId}: {`, `    feeForwarder: "${table.feeForwarder}",`, ...list("targets", table.targets), ...list("spenders", table.spenders), "  },"]);
  return [
    "export type LifiStepTable = { readonly feeForwarder: string; readonly targets: readonly string[]; readonly spenders: readonly string[] };",
    "",
    "export const LIFI_STEP_TARGETS: Readonly<Record<number, LifiStepTable>> = {",
    ...body,
    "};",
    "",
  ].join("\n");
}

export function renderRust(tables) {
  const hex = (address) => `"${address.slice(2).toLowerCase()}"`;
  const list = (name, items) => {
    if (items.length === 0) return [`        ${name}: &[],`];
    if (items.length === 1) return [`        ${name}: &[${hex(items[0])}],`];
    return [`        ${name}: &[`, ...items.map((item) => `            ${hex(item)},`), "        ],"];
  };
  const body = Object.entries(tables).flatMap(([chainId, table]) => ["    StepTable {", `        chain: ${chainId},`, `        fee_forwarder: ${hex(table.feeForwarder)},`, ...list("targets", table.targets), ...list("spenders", table.spenders), "    },"]);
  return ["use crate::lifi::StepTable;", "", "pub const STEP_TARGETS: &[StepTable] = &[", ...body, "];", ""].join("\n");
}

export function changes(committed, fresh) {
  const out = [];
  for (const chainId of new Set([...Object.keys(committed), ...Object.keys(fresh)])) {
    const before = committed[chainId] ?? { feeForwarder: null, targets: [], spenders: [] };
    const after = fresh[chainId] ?? { feeForwarder: null, targets: [], spenders: [] };
    if (before.feeForwarder !== after.feeForwarder) out.push(`chain ${chainId}: fee forwarder ${before.feeForwarder} -> ${after.feeForwarder}`);
    for (const field of ["targets", "spenders"]) {
      for (const address of after[field]) if (!before[field].includes(address)) out.push(`chain ${chainId}: add ${field.slice(0, -1)} ${address}`);
      for (const address of before[field]) if (!after[field].includes(address)) out.push(`chain ${chainId}: drop ${field.slice(0, -1)} ${address}`);
    }
  }
  return out;
}

async function main() {
  const check = process.argv.includes("--check");
  const tables = {};
  for (const chain of CHAINS) {
    const { block, pairs } = await allowlist(chain);
    const { table, rows } = classify(chain.chainId, pairs);
    tables[chain.chainId] = table;
    console.log(`chain ${chain.chainId} at block ${block}: ${pairs.length} allowlisted contracts, ${table.targets.length} targets, ${table.spenders.length} spenders`);
    for (const row of rows) console.log(`  ${row.family ? `${row.family.role.padEnd(12)} ${row.family.family}` : `${"excluded".padEnd(12)} selectors ${row.selectors.join(",")}`}  ${row.address}`);
  }
  if (!check) {
    writeFileSync(TS_FILE, renderTs(tables));
    writeFileSync(RUST_FILE, renderRust(tables));
    console.log(`wrote ${TS_FILE.pathname} and ${RUST_FILE.pathname}`);
    return;
  }
  const { LIFI_STEP_TARGETS } = await import(TS_FILE.href);
  const drift = changes(LIFI_STEP_TARGETS, tables);
  const stale = readFileSync(TS_FILE, "utf8") !== renderTs(tables) || readFileSync(RUST_FILE, "utf8") !== renderRust(tables);
  if (drift.length > 0 || stale) {
    console.error([...drift, "the committed LI.FI step table differs from the on-chain allowlists; review the change, then run node scripts/lifi-step-targets.mjs and node signer/vectors/generate.mjs"].join("\n"));
    process.exit(1);
  }
  console.log("the committed LI.FI step table matches the on-chain allowlists");
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) await main();
