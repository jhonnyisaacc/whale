import { PublicKey } from "@solana/web3.js";
import { decodeFunctionData, erc20Abi, type Hex } from "viem";
import { isAllowanceHolderExec, swapTerms, type SwapTerms } from "./signing-policy/swap-terms.js";
import { CHAINS } from "./chains.js";
import { assertTradableAction, type HyperliquidAction } from "./hyperliquid.js";

export * from "./signing-policy/swap-terms.js";
export * from "./signing-policy/turnkey.js";

export const JUPITER_PROGRAM_ID = "JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4";
const SYSTEM_PROGRAM = "11111111111111111111111111111111";
const COMPUTE_BUDGET_PROGRAM = "ComputeBudget111111111111111111111111111111";
const TOKEN_PROGRAM = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";
const TOKEN_2022_PROGRAM = "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb";
const ATA_PROGRAM = "ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL";

export const SOLANA_BASE_PROGRAMS = [JUPITER_PROGRAM_ID, SYSTEM_PROGRAM, COMPUTE_BUDGET_PROGRAM, TOKEN_PROGRAM, TOKEN_2022_PROGRAM, ATA_PROGRAM] as const;

export const DEFAULT_MAX_VALUE_WEI = 2_000_000_000_000_000n;
export const WSOL_MINT = "So11111111111111111111111111111111111111112";
const SOLANA_QUOTE_MINTS = [WSOL_MINT, "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v", "Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB"] as const;
export const JITO_TIP_ACCOUNTS = [
  "96gYZGLnJYVFmbjzopPSU6QiEV5fGqZNyN9nmNhvrZU5",
  "HFqU5x63VTqvQss8hp11i4wVV8bD44PvwucfZ2bU7gRe",
  "Cw8CFyM9FkoMi7K7Crf6HNQqf4uEMzpKw6QNghXLvLkY",
  "ADaUMid9yfUytqMBgopwjb2DTLSokTSzL1zt6iGPaS49",
  "DfXygSm4jCyNCybVYYK6DwvWqjKee8pbDmJGcLWNDXjh",
  "ADuUkR4vqLUMWXxW9gh6D6L8pMSawimctcNZ5pGwDcEt",
  "DttWaMuVvTiduZRnguLF7jNxTgiMBZ1hyAumKUiL2KRL",
  "3AVi9Tg9Uo68tJfuvoKvqKNWKkC5wPdSSdeBnizKZ6jT",
] as const;

export function wrappedSolAccount(owner: string): string {
  return associatedTokenAddress(owner, WSOL_MINT, TOKEN_PROGRAM);
}

export function associatedTokenAddress(owner: string, mint: string, program: string): string {
  return PublicKey.findProgramAddressSync(
    [new PublicKey(owner).toBuffer(), new PublicKey(program).toBuffer(), new PublicKey(mint).toBuffer()],
    new PublicKey(ATA_PROGRAM),
  )[0].toBase58();
}

export type EvmPurpose = "swap" | "approve" | "revoke" | "withdraw";
export type EvmApproval = { token: string; amount: bigint };

const EXACT_APPROVAL_LIMIT = 2n ** 255n;

export function evmChainIds(): number[] {
  return CHAINS.flatMap((chain) => (chain.chain.kind === "evm" ? [chain.chain.chainId] : []));
}

export function routersForChain(allowlist: Readonly<Record<number, readonly string[]>>, chainId: number): readonly string[] {
  return allowlist[chainId] ?? [];
}

type EvmSigningInput = {
  chainId: number;
  to: string;
  data: Hex;
  value: bigint;
  purpose: EvmPurpose;
  routers: readonly string[];
  settlers: readonly string[];
  withdrawAllowlist: readonly string[];
  maxValueWei: bigint;
  allowHotApproval: boolean;
  owner: string;
  allowOpaqueSwap: boolean;
  nativeSell?: boolean;
  recoveryTokens?: readonly string[];
  approval?: EvmApproval;
};

export function assertEvmSigning(input: EvmSigningInput): void {
  if (!evmChainIds().includes(input.chainId)) throw new Error("chain is not in the signing policy");
  if (input.value < 0n || input.value > input.maxValueWei) throw new Error("native value exceeds the signing policy");
  const to = input.to.toLowerCase();
  const allowlisted = (address: string) => input.withdrawAllowlist.some((item) => item.toLowerCase() === address.toLowerCase());
  if (input.purpose === "withdraw") {
    if (input.data === "0x") {
      if (!allowlisted(to)) throw new Error("withdraw destination is not allowlisted");
      return;
    }
    if (input.value !== 0n) throw new Error("token withdraw must not attach native value");
    let destination = "";
    try {
      const decoded = decodeFunctionData({ abi: erc20Abi, data: input.data });
      if (decoded.functionName !== "transfer") throw new Error("withdraw calldata is not a transfer");
      destination = String(decoded.args[0]);
    } catch (error) {
      if (error instanceof Error && error.message === "withdraw calldata is not a transfer") throw error;
      throw new Error("withdraw calldata is not a transfer");
    }
    if (!allowlisted(destination)) throw new Error("withdraw destination is not allowlisted");
    const recovery = new Set((input.recoveryTokens ?? []).map((item) => item.toLowerCase()));
    if (!recovery.has(to)) throw new Error("token is not in the recovery allowlist");
    return;
  }
  if (input.purpose === "approve" || input.purpose === "revoke") {
    assertApproval(input, to);
    return;
  }
  if (input.nativeSell !== true && input.value !== 0n) throw new Error("token sell must not attach native value");
  const routers = new Set(input.routers.map((item) => item.toLowerCase()));
  if (routers.size === 0) throw new Error("router allowlist is empty");
  if (!routers.has(to)) throw new Error("transaction destination is not an allowlisted router");
  const terms = swapTerms(input.data);
  if (terms) {
    if (terms.recipient.toLowerCase() !== input.owner.toLowerCase()) throw new Error("swap recipient is not the hot wallet");
    if (terms.provider === "zeroex") assertSettler(terms, to, input.settlers);
    return;
  }
  if (isAllowanceHolderExec(input.data)) throw new Error("0x exec does not call a Settler");
  if (!input.allowOpaqueSwap) throw new Error("swap calldata does not name a checkable recipient");
}

// AllowanceHolder.exec lends the sold-token allowance to `operator` for one call into `target`, so both must be a pinned Settler.
function assertSettler(terms: Extract<SwapTerms, { provider: "zeroex" }>, to: string, settlers: readonly string[]): void {
  const pinned = new Set(settlers.map((item) => item.toLowerCase()));
  const target = (terms.exec?.target ?? to).toLowerCase();
  if (terms.exec && terms.exec.operator.toLowerCase() !== target) throw new Error("0x exec operator is not its target");
  if (!pinned.has(target)) throw new Error("0x target is not a pinned Settler");
}

function assertApproval(input: EvmSigningInput, to: string): void {
  if (input.value !== 0n) throw new Error("approval must not attach native value");
  if (!input.approval || input.approval.token.toLowerCase() !== to) throw new Error("approval target is not the sold token");
  let spender = "";
  let amount = 0n;
  try {
    const decoded = decodeFunctionData({ abi: erc20Abi, data: input.data });
    if (decoded.functionName !== "approve") throw new Error("approval calldata is not approve");
    spender = String(decoded.args[0]).toLowerCase();
    amount = decoded.args[1];
  } catch {
    throw new Error("approval calldata is not approve");
  }
  if (input.purpose === "revoke") {
    if (amount !== 0n) throw new Error("revoke amount is not zero");
    return;
  }
  if (!input.allowHotApproval) throw new Error("approval is not cached");
  if (amount === 0n || amount >= EXACT_APPROVAL_LIMIT || amount !== input.approval.amount) throw new Error("approval amount is not the exact sell amount");
  if (!input.routers.some((item) => item.toLowerCase() === spender)) throw new Error("approval spender is not an allowlisted router");
}

export type SolanaInstruction = { program: string; accounts: readonly (string | null)[]; data: Uint8Array };
export type SolanaMessage = { feePayer: string; staticKeys: readonly string[]; instructions: readonly SolanaInstruction[] };

type SolanaFees = { tips: bigint; unitPrice: bigint | null; unitLimit: bigint | null };

type SolanaContext = {
  payer: string;
  owners: ReadonlySet<string>;
  wrappedSol: string;
  staticKeys: readonly string[];
  fees: SolanaFees;
};

const MAX_COMPUTE_UNITS = 1_400_000n;

function readU64(data: Uint8Array, offset: number, what: string): bigint {
  if (data.length < offset + 8) throw new Error(`solana ${what} instruction is truncated`);
  return Buffer.from(data).readBigUInt64LE(offset);
}

function readU32(data: Uint8Array, offset: number, what: string): bigint {
  if (data.length < offset + 4) throw new Error(`solana ${what} instruction is truncated`);
  return BigInt(Buffer.from(data).readUInt32LE(offset));
}

type InstructionRule = (ix: SolanaInstruction, context: SolanaContext) => void;

type ProgramRules = { discriminator: (data: Uint8Array) => string; rules: Readonly<Record<string, InstructionRule>> };

const firstByte = (data: Uint8Array) => (data.length === 0 ? "empty" : String(data[0]));

function account(ix: SolanaInstruction, index: number): string {
  const key = ix.accounts[index];
  if (!key) throw new Error("solana instruction account is not a static key");
  return key;
}

function ownedTokenAccount(destination: string, owners: Iterable<string>, mints: Iterable<string>): boolean {
  for (const owner of owners) {
    for (const mint of mints) {
      for (const program of [TOKEN_PROGRAM, TOKEN_2022_PROGRAM]) {
        try {
          if (associatedTokenAddress(owner, mint, program) === destination) return true;
        } catch {
          continue;
        }
      }
    }
  }
  return false;
}

function systemTransfer(ix: SolanaInstruction, context: SolanaContext): void {
  if (account(ix, 0) !== context.payer) throw new Error("solana native transfer source is not the hot wallet");
  const destination = account(ix, 1);
  const tips = new Set<string>(JITO_TIP_ACCOUNTS);
  if (tips.has(destination)) {
    context.fees.tips += readU64(ix.data, 4, "native transfer");
    return;
  }
  if (!context.owners.has(destination) && destination !== context.wrappedSol) {
    throw new Error("solana native transfer destination is not allowlisted");
  }
}

function tokenTransfer(destinationIndex: number, mintIndex: number | null): InstructionRule {
  return (ix, context) => {
    const destination = account(ix, destinationIndex);
    if (context.owners.has(destination)) return;
    const mints = mintIndex === null ? [...context.staticKeys, ...SOLANA_QUOTE_MINTS] : [account(ix, mintIndex)];
    if (!ownedTokenAccount(destination, context.owners, mints)) throw new Error("solana token transfer destination is not allowlisted");
  };
}

function closeToPayer(ix: SolanaInstruction, context: SolanaContext): void {
  if (account(ix, 1) !== context.payer) throw new Error("solana close account destination is not the hot wallet");
}

function initializeForPayer(ix: SolanaInstruction, context: SolanaContext): void {
  if (ix.data.length < 33 || new PublicKey(ix.data.subarray(1, 33)).toBase58() !== context.payer) {
    throw new Error("solana token account owner is not the hot wallet");
  }
}

const TOKEN_RULES: ProgramRules = {
  discriminator: firstByte,
  rules: {
    "3": tokenTransfer(1, null),
    "9": closeToPayer,
    "12": tokenTransfer(2, 1),
    "17": () => {},
    "18": initializeForPayer,
  },
};

type JupiterLayout = { authority: number; destinations: readonly number[]; mint: number; platformFee: number };

function jupiterRoute(layout: JupiterLayout): InstructionRule {
  return (ix, context) => {
    if (account(ix, layout.authority) !== context.payer) throw new Error("jupiter transfer authority is not the hot wallet");
    if (account(ix, layout.platformFee) !== JUPITER_PROGRAM_ID) throw new Error("jupiter platform fee account is set");
    const mint = ix.accounts[layout.mint];
    const mints = mint ? [mint] : SOLANA_QUOTE_MINTS;
    for (const index of layout.destinations) {
      const destination = account(ix, index);
      if (destination === JUPITER_PROGRAM_ID && index !== layout.destinations[0]) continue;
      if (destination !== context.wrappedSol && !ownedTokenAccount(destination, [context.payer], mints)) {
        throw new Error("jupiter destination is not a hot wallet token account");
      }
    }
  };
}

const ROUTE = jupiterRoute({ authority: 1, destinations: [3, 4], mint: 5, platformFee: 6 });
const SHARED_ROUTE = jupiterRoute({ authority: 2, destinations: [6], mint: 8, platformFee: 9 });

// Account layouts follow the published Jupiter v6 IDL. Quotes are always exactIn, so the exact-out routes
// (exact_out_route, shared_accounts_exact_out_route) and the v2 routes are not listed and are denied.
const SOLANA_INSTRUCTION_TABLE: Readonly<Record<string, ProgramRules>> = {
  [SYSTEM_PROGRAM]: {
    discriminator: (data) => (data.length >= 4 ? String(Buffer.from(data).readUInt32LE(0)) : "short"),
    rules: { "2": systemTransfer },
  },
  [COMPUTE_BUDGET_PROGRAM]: {
    discriminator: firstByte,
    rules: {
      "2": (ix, context) => {
        context.fees.unitLimit = readU32(ix.data, 1, "compute unit limit");
      },
      "3": (ix, context) => {
        context.fees.unitPrice = readU64(ix.data, 1, "compute unit price");
      },
      "4": () => {},
    },
  },
  [TOKEN_PROGRAM]: TOKEN_RULES,
  [TOKEN_2022_PROGRAM]: TOKEN_RULES,
  [ATA_PROGRAM]: {
    discriminator: firstByte,
    rules: {
      "1": (ix, context) => {
        if (account(ix, 0) !== context.payer) throw new Error("associated account funder is not the hot wallet");
        if (!context.owners.has(account(ix, 2))) throw new Error("associated account owner is not allowlisted");
      },
    },
  },
  [JUPITER_PROGRAM_ID]: {
    discriminator: (data) => Buffer.from(data.subarray(0, 8)).toString("hex"),
    rules: {
      e517cb977ae3ad2a: ROUTE,
      "96564774a75d0e68": ROUTE,
      c1209b3341d69c81: SHARED_ROUTE,
      e6798f50779f6aaa: SHARED_ROUTE,
    },
  },
};

export function assertSolanaSigning(input: {
  message: SolanaMessage;
  expectedFeePayer: string;
  allowlist: readonly string[];
  withdrawAllowlist: readonly string[];
  maxTipLamports: number;
  maxPriorityLamports: number;
}): void {
  const payer = input.expectedFeePayer;
  if (input.message.feePayer !== payer) throw new Error("solana fee payer is not the hot wallet");
  const allowed = new Set(input.allowlist);
  const context: SolanaContext = {
    payer,
    owners: new Set([payer, ...input.withdrawAllowlist]),
    wrappedSol: wrappedSolAccount(payer),
    staticKeys: input.message.staticKeys,
    fees: { tips: 0n, unitPrice: null, unitLimit: null },
  };
  for (const ix of input.message.instructions) {
    if (!allowed.has(ix.program)) throw new Error(`solana program is not allowlisted ${ix.program}`);
    const table = SOLANA_INSTRUCTION_TABLE[ix.program];
    if (!table) continue;
    const kind = table.discriminator(ix.data);
    const rule = table.rules[kind];
    if (!rule) throw new Error(`solana instruction is not allowed ${ix.program} ${kind}`);
    rule(ix, context);
  }
  const { tips, unitPrice, unitLimit } = context.fees;
  if (tips > BigInt(input.maxTipLamports)) throw new Error("solana jito tip exceeds the signing policy");
  const priority = unitPrice === null ? 0n : (unitPrice * (unitLimit ?? MAX_COMPUTE_UNITS) + 999_999n) / 1_000_000n;
  if (priority + tips > BigInt(input.maxPriorityLamports)) throw new Error("solana priority fee exceeds the signing policy");
}

export function assertHyperliquidSigning(action: { type: string }, maxLeverage: number): asserts action is HyperliquidAction {
  assertTradableAction(action);
  if (action.type === "updateLeverage" && action.leverage > maxLeverage) throw new Error("leverage exceeds the signing policy");
}
