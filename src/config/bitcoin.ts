import { BITCOIN_NETWORKS, destinationScript, type BitcoinNetwork, type Script } from "../bitcoin/wallet.js";

export type BitcoinConfig = {
  readonly network: BitcoinNetwork;
  readonly esploraUrl: string;
  readonly maxFeeSats: bigint;
  readonly maxFeeRate: number;
  readonly maxInputs: number;
  readonly destinations: readonly Script[];
};

export const ESPLORA_DEFAULTS: Readonly<Record<BitcoinNetwork, string | null>> = {
  bitcoin: "https://mempool.space/api",
  testnet: "https://mempool.space/testnet/api",
  signet: "https://mempool.space/signet/api",
  regtest: null,
};

function positive(env: NodeJS.ProcessEnv, name: string, fallback: number, integer: boolean): number {
  const raw = env[name]?.trim();
  const value = raw ? Number(raw) : fallback;
  if (!(Number.isFinite(value) && value > 0) || (integer && !Number.isSafeInteger(value))) throw new Error(`${name} must be a positive ${integer ? "integer" : "number"}`);
  return value;
}

export function bitcoinConfig(env: NodeJS.ProcessEnv): BitcoinConfig | null {
  const network = env.BITCOIN_NETWORK?.trim();
  if (!network) return null;
  if (!BITCOIN_NETWORKS.includes(network as BitcoinNetwork)) throw new Error(`BITCOIN_NETWORK must be one of ${BITCOIN_NETWORKS.join(", ")}`);
  const chosen = network as BitcoinNetwork;
  const esploraUrl = env.BITCOIN_ESPLORA_URL?.trim() || ESPLORA_DEFAULTS[chosen];
  if (!esploraUrl) throw new Error(`BITCOIN_NETWORK=${chosen} needs BITCOIN_ESPLORA_URL`);
  if (!/^https?:$/.test(new URL(esploraUrl).protocol)) throw new Error("BITCOIN_ESPLORA_URL must be an http or https URL");
  const maxInputs = positive(env, "BITCOIN_MAX_INPUTS", 20, true);
  if (maxInputs > 100) throw new Error("BITCOIN_MAX_INPUTS must be at most 100");
  const destinations = (env.BITCOIN_WITHDRAW_ADDRESSES ?? "")
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean)
    .map((address) => {
      const script = destinationScript(address, chosen);
      if (!script) throw new Error(`BITCOIN_WITHDRAW_ADDRESSES has ${address}, which is not a ${chosen} address`);
      return script;
    });
  return {
    network: chosen,
    esploraUrl,
    maxFeeSats: BigInt(positive(env, "BITCOIN_MAX_FEE_SATS", 10_000, true)),
    maxFeeRate: positive(env, "BITCOIN_MAX_FEE_RATE", 50, false),
    maxInputs,
    destinations,
  };
}
