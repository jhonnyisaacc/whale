import { createPublicClient, http, parseAbi, toFunctionSelector } from "viem";
import { BRIDGE_CONTRACTS, LIFI_ACROSS_ABI } from "../dist/src/signing-policy.js";

const ACROSS_FACET_V4 = "0xAd3f1634a917924cBb54A0F76e43ca035D2B6BCd";
const PUBLIC_RPC = {
  1: "https://ethereum-rpc.publicnode.com",
  10: "https://optimism-rpc.publicnode.com",
  137: "https://polygon-bor-rpc.publicnode.com",
  8453: "https://base-rpc.publicnode.com",
  42161: "https://arbitrum-one-rpc.publicnode.com",
};
const abi = parseAbi([
  "function facetAddress(bytes4 selector) view returns (address)",
  "function SPOKEPOOL() view returns (address)",
  "function chainId() view returns (uint256)",
]);
const same = (left, right) => left.toLowerCase() === right.toLowerCase();

let failed = false;
for (const [id, { lifi, across }] of Object.entries(BRIDGE_CONTRACTS)) {
  const client = createPublicClient({ transport: http(process.env[`RPC_URL_${id}`] ?? PUBLIC_RPC[id]) });
  const read = (address, functionName, args = []) => client.readContract({ address, abi, functionName, args });
  const facets = await Promise.all(LIFI_ACROSS_ABI.map((item) => read(lifi, "facetAddress", [toFunctionSelector(item)])));
  const checks = {
    "chain id": (await client.getChainId()) === Number(id),
    "diamond has code": ((await client.getCode({ address: lifi })) ?? "0x").length > 2,
    "both AcrossV4 entry points route to AcrossFacetV4": facets.every((facet) => same(facet, ACROSS_FACET_V4)),
    "AcrossFacetV4 deposits into the listed SpokePool": same(await read(ACROSS_FACET_V4, "SPOKEPOOL"), across),
    "SpokePool has code": ((await client.getCode({ address: across })) ?? "0x").length > 2,
    "SpokePool reports this chain": (await read(across, "chainId")) === BigInt(id),
  };
  for (const [name, ok] of Object.entries(checks)) {
    console.log(`${ok ? "ok  " : "FAIL"} ${id} ${name}`);
    failed ||= !ok;
  }
}
if (failed) process.exit(1);
