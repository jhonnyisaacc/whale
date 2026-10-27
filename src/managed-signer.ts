import { createHash, timingSafeEqual } from "node:crypto";
import { VersionedTransaction } from "@solana/web3.js";
import { recoverTypedDataAddress, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import type { AppConfig } from "./config.js";
import { actionHash, signL1Action, type HyperliquidAction } from "./hyperliquid.js";
import { loadSigner, signerSecrets, solanaSigner, type SignerMaterial } from "./signer.js";
import { assertEvmSigning, assertHyperliquidSigning, assertSolanaSigning, routersForChain, type EvmApproval, type EvmPurpose, type SolanaMessage } from "./signing-policy.js";
import { assertLiveEdges, drainTimeoutMs, serviceTokens } from "./config.js";

export type EvmSignInput = {
  chainId: number;
  to: Hex;
  data: Hex;
  value: bigint;
  gas: bigint;
  nonce: number;
  maxFeePerGas: bigint;
  maxPriorityFeePerGas: bigint;
  purpose: EvmPurpose;
  nativeSell?: boolean;
  approval?: EvmApproval;
};

export interface TransactionSigner {
  readonly backend: "turnkey" | "keystore";
  evmAddress(): string | null;
  solanaAddress(): string | null;
  signEvm(input: EvmSignInput): Promise<Hex>;
  signSolana(serialized: Uint8Array): Promise<Uint8Array>;
  signHyperliquid(action: HyperliquidAction, nonce: number, isMainnet: boolean): Promise<{ r: Hex; s: Hex; v: number }>;
}

export type TurnkeyApi = {
  signEvm(unsigned: Hex, address: string): Promise<Hex>;
  signSolana(unsignedBase64: string, address: string): Promise<string>;
  signEip712(payload: string, address: string): Promise<{ r: string; s: string; v: string }>;
};

function policyConfig(config: AppConfig) {
  return {
    withdrawAllowlist: config.withdrawAllowlist,
    maxValueWei: config.maxValueWei,
    allowHotApproval: config.allowHotApproval,
    solanaPrograms: config.solanaProgramAllowlist,
    maxLeverage: config.maxLeverage,
    recoveryTokens: config.tokenRecoveryAllowlist,
    allowOpaqueSwap: config.lifiLive,
  };
}

export function withPolicy(inner: TransactionSigner, config: AppConfig): TransactionSigner {
  const policy = policyConfig(config);
  return {
    backend: inner.backend,
    evmAddress: () => inner.evmAddress(),
    solanaAddress: () => inner.solanaAddress(),
    async signEvm(input) {
      assertEvmSigning({
        ...input,
        ...policy,
        routers: routersForChain(config.routerAllowlist, input.chainId),
        settlers: routersForChain(config.zeroExSettlers, input.chainId),
        owner: inner.evmAddress() ?? "",
        nativeSell: input.nativeSell === true,
      });
      return inner.signEvm(input);
    },
    async signSolana(serialized) {
      const expected = inner.solanaAddress();
      if (!expected) throw new Error("solana signer is not loaded");
      assertSolanaSigning({
        message: solanaMessage(serialized),
        expectedFeePayer: expected,
        allowlist: policy.solanaPrograms,
        withdrawAllowlist: policy.withdrawAllowlist,
        maxTipLamports: config.jitoTipLamports,
        maxPriorityLamports: config.solanaMaxPriorityLamports,
      });
      return inner.signSolana(serialized);
    },
    async signHyperliquid(action, nonce, isMainnet) {
      assertHyperliquidSigning(action, policy.maxLeverage);
      return inner.signHyperliquid(action, nonce, isMainnet);
    },
  };
}

function solanaMessage(serialized: Uint8Array): SolanaMessage {
  const { message } = VersionedTransaction.deserialize(serialized);
  const keys = message.staticAccountKeys.map((key) => key.toBase58());
  return {
    feePayer: keys[0] ?? "",
    staticKeys: keys,
    instructions: message.compiledInstructions.map((ix) => ({
      program: keys[ix.programIdIndex] ?? "",
      accounts: ix.accountKeyIndexes.map((index) => keys[index] ?? null),
      data: ix.data,
    })),
  };
}

export function keystoreSigner(material: SignerMaterial): TransactionSigner {
  return {
    backend: "keystore",
    evmAddress: () => material.evmAddress,
    solanaAddress: () => material.solanaAddress,
    async signEvm(input) {
      if (!material.evm) throw new Error("evm signer is not loaded");
      const raw = material.evm.reveal();
      const account = privateKeyToAccount((raw.startsWith("0x") ? raw : `0x${raw}`) as Hex);
      return account.signTransaction({
        type: "eip1559",
        chainId: input.chainId,
        to: input.to,
        data: input.data,
        value: input.value,
        gas: input.gas,
        nonce: input.nonce,
        maxFeePerGas: input.maxFeePerGas,
        maxPriorityFeePerGas: input.maxPriorityFeePerGas,
      });
    },
    async signSolana(serialized) {
      const tx = VersionedTransaction.deserialize(serialized);
      tx.sign([solanaSigner(material)]);
      return tx.serialize();
    },
    async signHyperliquid(action, nonce, isMainnet) {
      if (!material.hyperliquid) throw new Error("hyperliquid agent key is not loaded");
      return signL1Action(material.hyperliquid, action, nonce, isMainnet);
    },
  };
}

export function turnkeySigner(api: TurnkeyApi, addresses: { evm: string | null; solana: string | null; hyperliquid: string | null }): TransactionSigner {
  return {
    backend: "turnkey",
    evmAddress: () => addresses.evm,
    solanaAddress: () => addresses.solana,
    async signEvm(input) {
      if (!addresses.evm) throw new Error("evm signer is not loaded");
      const unsigned = await unsignedEvm(input);
      return api.signEvm(unsigned, addresses.evm);
    },
    async signSolana(serialized) {
      if (!addresses.solana) throw new Error("solana signer is not loaded");
      const signed = await api.signSolana(Buffer.from(serialized).toString("base64"), addresses.solana);
      return Buffer.from(signed, "base64");
    },
    async signHyperliquid(action, nonce, isMainnet) {
      if (!addresses.hyperliquid) throw new Error("hyperliquid agent key is not loaded");
      const typed = {
        domain: { name: "Exchange", version: "1", chainId: 1337, verifyingContract: "0x0000000000000000000000000000000000000000" as Hex },
        types: { Agent: [{ name: "source", type: "string" }, { name: "connectionId", type: "bytes32" }] },
        primaryType: "Agent" as const,
        message: { source: isMainnet ? "a" : "b", connectionId: actionHash(action, null, nonce, null) },
      };
      const raw = await api.signEip712(JSON.stringify(typed), addresses.hyperliquid);
      const signature = { r: word(raw.r), s: word(raw.s), v: recoveryId(raw.v) };
      const signer = await recoverTypedDataAddress({ ...typed, signature: { r: signature.r, s: signature.s, v: BigInt(signature.v) } });
      if (signer.toLowerCase() !== addresses.hyperliquid.toLowerCase()) throw new Error("hyperliquid signature does not recover to the agent");
      return signature;
    },
  };
}

async function unsignedEvm(input: EvmSignInput): Promise<Hex> {
  const { serializeTransaction } = await import("viem");
  return serializeTransaction({
    type: "eip1559",
    chainId: input.chainId,
    to: input.to,
    data: input.data,
    value: input.value,
    gas: input.gas,
    nonce: input.nonce,
    maxFeePerGas: input.maxFeePerGas,
    maxPriorityFeePerGas: input.maxPriorityFeePerGas,
  });
}

export function turnkeyApiFromEnv(env: NodeJS.ProcessEnv): TurnkeyApi | null {
  if (!env.TURNKEY_ORGANIZATION_ID || !env.TURNKEY_API_PUBLIC_KEY || !env.TURNKEY_API_PRIVATE_KEY) return null;
  return {
    async signEvm(unsigned, address) {
      const { Turnkey } = await import("@turnkey/sdk-server");
      const client = new Turnkey({
        apiBaseUrl: env.TURNKEY_API_BASE ?? "https://api.turnkey.com",
        apiPublicKey: env.TURNKEY_API_PUBLIC_KEY ?? "",
        apiPrivateKey: env.TURNKEY_API_PRIVATE_KEY ?? "",
        defaultOrganizationId: env.TURNKEY_ORGANIZATION_ID ?? "",
      }).apiClient();
      const result = await client.signTransaction({ signWith: address, unsignedTransaction: unsigned, type: "TRANSACTION_TYPE_ETHEREUM" });
      const signed = "signedTransaction" in result ? result.signedTransaction : "";
      if (!signed) throw new Error("turnkey evm sign returned no transaction");
      return signed as Hex;
    },
    async signSolana(unsignedBase64, address) {
      const { Turnkey } = await import("@turnkey/sdk-server");
      const client = new Turnkey({
        apiBaseUrl: env.TURNKEY_API_BASE ?? "https://api.turnkey.com",
        apiPublicKey: env.TURNKEY_API_PUBLIC_KEY ?? "",
        apiPrivateKey: env.TURNKEY_API_PRIVATE_KEY ?? "",
        defaultOrganizationId: env.TURNKEY_ORGANIZATION_ID ?? "",
      }).apiClient();
      const result = await client.signTransaction({ signWith: address, unsignedTransaction: unsignedBase64, type: "TRANSACTION_TYPE_SOLANA" });
      const signed = "signedTransaction" in result ? result.signedTransaction : "";
      if (!signed) throw new Error("turnkey solana sign returned no transaction");
      return signed;
    },
    async signEip712(payload, address) {
      const { Turnkey } = await import("@turnkey/sdk-server");
      const client = new Turnkey({
        apiBaseUrl: env.TURNKEY_API_BASE ?? "https://api.turnkey.com",
        apiPublicKey: env.TURNKEY_API_PUBLIC_KEY ?? "",
        apiPrivateKey: env.TURNKEY_API_PRIVATE_KEY ?? "",
        defaultOrganizationId: env.TURNKEY_ORGANIZATION_ID ?? "",
      }).apiClient();
      const result = await client.signRawPayload({
        signWith: address,
        payload,
        encoding: "PAYLOAD_ENCODING_EIP712",
        hashFunction: "HASH_FUNCTION_NO_OP",
      });
      return { r: result.r, s: result.s, v: result.v };
    },
  };
}

const RAW_KEY_ENV = ["EVM_PRIVATE_KEY", "SOLANA_SECRET_KEY", "HYPERLIQUID_AGENT_KEY", "KEYSTORE_PATH", "KEYSTORE_PASSPHRASE"] as const;

export type ManagedSigner = { signer: TransactionSigner | null; secrets: string[] };

export function loadManagedSigner(env: NodeJS.ProcessEnv, config: AppConfig): ManagedSigner {
  if (config.live) {
    const present = RAW_KEY_ENV.filter((name) => env[name]);
    scrubRawKeys(env);
    if (present.length > 0) throw new Error(`live mode refuses raw key material in ${present.join(", ")}`);
  }
  const turnkey = [env.TURNKEY_API_PRIVATE_KEY, env.TURNKEY_API_PUBLIC_KEY].filter((item): item is string => Boolean(item));
  const api = turnkeyApiFromEnv(env);
  if (api && env.TURNKEY_EVM_ADDRESS) {
    scrubRawKeys(env);
    const signer = turnkeySigner(api, {
      evm: env.TURNKEY_EVM_ADDRESS,
      solana: env.TURNKEY_SOLANA_ADDRESS ?? null,
      hyperliquid: env.TURNKEY_HYPERLIQUID_ADDRESS ?? null,
    });
    return { signer: withPolicy(signer, config), secrets: turnkey };
  }
  if (config.live) throw new Error("live mode requires Turnkey");
  let material: SignerMaterial | null;
  try {
    material = loadSigner(env);
  } finally {
    scrubRawKeys(env);
  }
  return { signer: material ? withPolicy(keystoreSigner(material), config) : null, secrets: [...turnkey, ...signerSecrets(material)] };
}

function scrubRawKeys(env: NodeJS.ProcessEnv): void {
  for (const name of RAW_KEY_ENV) delete env[name];
}

export function tokenMatches(left: string, right: string): boolean {
  const a = createHash("sha256").update(left).digest();
  const b = createHash("sha256").update(right).digest();
  return timingSafeEqual(a, b);
}

function word(value: string): Hex {
  const hex = value.replace(/^0x/i, "");
  if (!/^[0-9a-fA-F]{1,64}$/.test(hex)) throw new Error("turnkey hyperliquid signature is not hex");
  return `0x${hex.padStart(64, "0")}`;
}

function recoveryId(v: string): number {
  const parsed = Number.parseInt(v.replace(/^0x/i, ""), 16);
  if (parsed === 0 || parsed === 1) return parsed + 27;
  if (parsed === 27 || parsed === 28) return parsed;
  throw new Error("turnkey hyperliquid signature v is not a recovery id");
}

function assertTokens(name: string, tokens: readonly string[], required: boolean): void {
  if (required && tokens.length === 0) throw new Error(`${name} is required`);
  if (tokens.some((token) => token.length < 16)) throw new Error(`${name} must be at least 16 characters`);
}

export function assertBoot(config: AppConfig, service: "executor" | "resolver", env: NodeJS.ProcessEnv = process.env): void {
  assertTokens("RESOLVER_AUTH_TOKEN", config.resolverAuthTokens, service === "resolver" || config.resolverUrl !== null);
  const allTokens = serviceTokens(config);
  if (new Set(allTokens).size !== allTokens.length) throw new Error("EXECUTOR_AUTH_TOKEN, RESOLVER_AUTH_TOKEN and strategy tokens must all differ");
  if (service === "executor") {
    assertTokens("EXECUTOR_AUTH_TOKEN", config.executorAuthTokens, true);
    for (const [id, strategy] of Object.entries(config.strategies)) assertTokens(`STRATEGY_CAPS_JSON token for ${id}`, strategy.tokens, true);
    if (config.live && config.reconcileAfterMinutes * 60_000 <= drainTimeoutMs(config)) {
      throw new Error("RECONCILE_AFTER_MINUTES must exceed the send bound so reconcile never touches an in-flight send");
    }
  }
  if (env.RAILWAY_PUBLIC_DOMAIN) throw new Error("a public Railway domain is set. Remove it and use the private network.");
  if (env.WITHDRAW_ENABLED !== undefined || config.withdrawEnabled) throw new Error("WITHDRAW_ENABLED is closed");
  assertLiveEdges(config, env);
}
