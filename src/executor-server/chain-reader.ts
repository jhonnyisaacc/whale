import { chainByKey } from "../chains.js";
import type { AppConfig } from "../config.js";
import type { Holding } from "../domain.js";
import { holdingFitsChain, type BalanceReader } from "../balances.js";
import type { TransactionSigner } from "../managed-signer.js";
import { evmReadClient, firstOk, solanaConnection } from "../rpc.js";

export function chainReader(config: AppConfig, signer: TransactionSigner | null): BalanceReader {
  return async (holding: Holding) => {
    if (!signer || !holding.chainKey) return null;
    const spec = chainByKey(holding.chainKey);
    const rpcs = config.rpcUrlsByChainKey[holding.chainKey] ?? [];
    if (!spec || rpcs.length === 0) return null;
    const decimals = holding.decimals ?? (holding.native ? (spec.chain.kind === "solana" ? 9 : 18) : null);
    if (decimals === null) return null;
    if (holding.chainKey && !holdingFitsChain(holding, holding.chainKey)) return null;
    if (spec.chain.kind === "solana") {
      const owner = signer.solanaAddress();
      if (!owner) return null;
      const { PublicKey } = await import("@solana/web3.js");
      const ownerKey = new PublicKey(owner);
      if (holding.native) return firstOk(rpcs.map((rpc) => async () => (await solanaConnection(rpc).getBalance(ownerKey)) / 10 ** decimals));
      let mint;
      try {
        mint = new PublicKey(holding.address);
      } catch {
        return null;
      }
      const accounts = await firstOk(rpcs.map((rpc) => () => solanaConnection(rpc).getParsedTokenAccountsByOwner(ownerKey, { mint })));
      const ui = accounts.value[0]?.account.data.parsed?.info?.tokenAmount?.uiAmountString;
      return typeof ui === "string" ? Number(ui) : null;
    }
    if (spec.chain.kind !== "evm") return null;
    const owner = signer.evmAddress();
    if (!owner) return null;
    const { erc20Abi, formatUnits } = await import("viem");
    const client = evmReadClient(rpcs);
    if (holding.native) {
      const raw = await client.getBalance({ address: owner as `0x${string}` });
      return Number(formatUnits(raw, decimals));
    }
    if (!/^0x[0-9a-fA-F]{40}$/.test(holding.address)) return null;
    const raw = await client.readContract({ address: holding.address as `0x${string}`, abi: erc20Abi, functionName: "balanceOf", args: [owner as `0x${string}`] });
    return Number(formatUnits(raw, decimals));
  };
}
