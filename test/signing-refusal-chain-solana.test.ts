import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import { PublicKey } from "@solana/web3.js";
import { assertHyperliquidSigning, assertSolanaSigning, associatedTokenAddress, JITO_TIP_ACCOUNTS, JUPITER_PROGRAM_ID, SOLANA_BASE_PROGRAMS, wrappedSolAccount, type SolanaInstruction } from "../src/signing-policy.js";

const key = (fill: number) => new PublicKey(Buffer.alloc(32, fill)).toBase58();
const PAYER = key(1);
const DESTINATION = key(3);
const STRANGER = key(4);
const MINT = key(5);
const SYSTEM = "11111111111111111111111111111111";
const COMPUTE = "ComputeBudget111111111111111111111111111111";
const TOKEN = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";
const TOKEN_2022 = "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb";
const ATA = "ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL";
const TIP = JITO_TIP_ACCOUNTS[0];
const discriminator = (name: string) => createHash("sha256").update(`global:${name}`).digest().subarray(0, 8);
const ROUTE = discriminator("route");
const SHARED_ROUTE = discriminator("shared_accounts_route");

const u32 = (value: number) => { const out = Buffer.alloc(4); out.writeUInt32LE(value); return out; };
const u64 = (value: bigint) => { const out = Buffer.alloc(8); out.writeBigUInt64LE(value); return out; };
const ix = (program: string, accounts: (string | null)[], data: Uint8Array): SolanaInstruction => ({ program, accounts, data });
const sol = (from: string | null, to: string, lamports = 1n) => ix(SYSTEM, [from, to], Buffer.concat([u32(2), u64(lamports)]));
const route = (authority: string, destination: string, fee = JUPITER_PROGRAM_ID, source: string | null = MINT, step = MINT) =>
  ix(JUPITER_PROGRAM_ID, [TOKEN, MINT, authority, source, MINT, MINT, destination, MINT, MINT, fee, JUPITER_PROGRAM_ID, MINT, JUPITER_PROGRAM_ID, step], SHARED_ROUTE);

function sign(instructions: SolanaInstruction[], feePayer = PAYER): void {
  assertSolanaSigning({
    message: { feePayer, staticKeys: [PAYER, DESTINATION, MINT], instructions },
    expectedFeePayer: PAYER,
    allowlist: [...SOLANA_BASE_PROGRAMS],
    withdrawAllowlist: [DESTINATION],
    maxTipLamports: 10_000,
    maxPriorityLamports: 100_000,
  });
}

type Refusal = [string, string, string, () => void];
const leverage = { type: "updateLeverage", asset: 0, isCross: false, leverage: 3 } as const;

const refusals: Refusal[] = [
  ["another fee payer", "solana", "solana fee payer is not the hot wallet", () => sign([sol(PAYER, DESTINATION)], STRANGER)],
  ["an unlisted program", "solana", `solana program is not allowlisted ${STRANGER}`, () => sign([ix(STRANGER, [], Buffer.from([1]))])],
  ["a System instruction other than transfer", "solana", `solana instruction is not allowed ${SYSTEM} 0`, () => sign([ix(SYSTEM, [PAYER, DESTINATION], u32(0))])],
  ["an account from a lookup table", "solana", "solana instruction account is not a static key", () => sign([sol(null, DESTINATION)])],
  ["a truncated tip", "solana", "solana native transfer instruction is truncated", () => sign([ix(SYSTEM, [PAYER, TIP], u32(2))])],
  ["a truncated compute unit price", "solana", "solana compute unit price instruction is truncated", () => sign([ix(COMPUTE, [], Buffer.from([3]))])],
  ["a SOL transfer from a stranger", "solana", "solana native transfer source is not the hot wallet", () => sign([sol(STRANGER, DESTINATION)])],
  ["a SOL transfer to a stranger", "solana", "solana native transfer destination is not allowlisted", () => sign([sol(PAYER, STRANGER)])],
  ["a token transfer to a stranger", "solana", "solana token transfer destination is not allowlisted", () => sign([ix(TOKEN, [MINT, STRANGER, PAYER], Buffer.concat([Buffer.from([3]), u64(1n)]))])],
  ["a close paying a stranger", "solana", "solana close account destination is not the hot wallet", () => sign([ix(TOKEN, [MINT, STRANGER, PAYER], Buffer.from([9]))])],
  ["a token account owned by a stranger", "solana", "solana token account owner is not the hot wallet", () => sign([ix(TOKEN, [MINT, MINT], Buffer.concat([Buffer.from([18]), new PublicKey(STRANGER).toBuffer()]))])],
  ["a jupiter route under another authority", "solana", "jupiter transfer authority is not the hot wallet", () => sign([route(STRANGER, wrappedSolAccount(PAYER))])],
  ["a jupiter route with a platform fee", "solana", "jupiter platform fee account is set", () => sign([route(PAYER, wrappedSolAccount(PAYER), STRANGER)])],
  ["a jupiter route paying a stranger", "solana", "jupiter destination is not a hot wallet token account", () => sign([route(PAYER, STRANGER)])],
  ["a jupiter buy into a Token-2022 account", "solana", "jupiter destination is not a hot wallet token account", () => sign([route(PAYER, associatedTokenAddress(PAYER, MINT, TOKEN_2022))])],
  ["a jupiter route that passes the hot wallet to a step", "solana", "jupiter passes the hot wallet to an account other than the transfer authority", () => sign([route(PAYER, wrappedSolAccount(PAYER), JUPITER_PROGRAM_ID, MINT, PAYER)])],
  ["a jupiter source from a lookup table", "solana", "jupiter source is not a static key", () => sign([route(PAYER, wrappedSolAccount(PAYER), JUPITER_PROGRAM_ID, null)])],
  ["a jupiter route instruction", "solana", `solana instruction is not allowed ${JUPITER_PROGRAM_ID} ${ROUTE.toString("hex")}`, () => sign([ix(JUPITER_PROGRAM_ID, [TOKEN, PAYER, MINT, wrappedSolAccount(PAYER)], ROUTE)])],
  ["an associated account funded by a stranger", "solana", "associated account funder is not the hot wallet", () => sign([ix(ATA, [STRANGER, MINT, PAYER, MINT], Buffer.from([1]))])],
  ["an associated account for a stranger", "solana", "associated account owner is not allowlisted", () => sign([ix(ATA, [PAYER, MINT, STRANGER, MINT], Buffer.from([1]))])],
  ["a jito tip above the cap", "solana", "solana jito tip exceeds the signing policy", () => sign([sol(PAYER, TIP, 10_001n)])],
  ["a priority fee above the cap", "solana", "solana priority fee exceeds the signing policy", () => sign([ix(COMPUTE, [], Buffer.concat([Buffer.from([3]), u64(10n ** 12n)]))])],
  ["a hyperliquid withdraw", "hypercore", "refusing hyperliquid action withdraw3", () => assertHyperliquidSigning({ type: "withdraw3" }, { maxLeverage: 5, maxOrderUsd: 100, sellLimits: {} })],
  ["an unknown hyperliquid action", "hypercore", "unsupported hyperliquid action noop", () => assertHyperliquidSigning({ type: "noop" }, { maxLeverage: 5, maxOrderUsd: 100, sellLimits: {} })],
  ["leverage above the cap", "hypercore", "leverage 3 exceeds the 2x signing policy", () => assertHyperliquidSigning(leverage, { maxLeverage: 2, maxOrderUsd: 100, sellLimits: {} })],
];

const accepted: [string, () => void][] = [
  ["a SOL transfer to an allowlisted address", () => sign([sol(PAYER, DESTINATION)])],
  ["a SOL transfer into wrapped SOL", () => sign([sol(PAYER, wrappedSolAccount(PAYER))])],
  ["a tip within the cap", () => sign([sol(PAYER, TIP, 10_000n)])],
  ["a compute budget within the cap", () => sign([ix(COMPUTE, [], Buffer.concat([Buffer.from([2]), u32(200_000)])), ix(COMPUTE, [], Buffer.concat([Buffer.from([3]), u64(1_000n)]))])],
  ["a token transfer to the hot wallet", () => sign([ix(TOKEN, [MINT, PAYER, PAYER], Buffer.concat([Buffer.from([3]), u64(1n)]))])],
  ["a close paying the hot wallet", () => sign([ix(TOKEN, [MINT, PAYER, PAYER], Buffer.from([9]))])],
  ["an associated account for the hot wallet", () => sign([ix(ATA, [PAYER, MINT, PAYER, MINT], Buffer.from([1]))])],
  ["a jupiter route into wrapped SOL", () => sign([route(PAYER, wrappedSolAccount(PAYER))])],
  ["a jupiter route into the hot wallet's token account", () => sign([route(PAYER, associatedTokenAddress(PAYER, MINT, TOKEN))])],
  ["leverage within the cap", () => assertHyperliquidSigning(leverage, { maxLeverage: 3, maxOrderUsd: 100, sellLimits: {} })],
  ["a hyperliquid cancel", () => assertHyperliquidSigning({ type: "cancel", cancels: [{ a: 0, o: 1 }] } as { type: string }, { maxLeverage: 3, maxOrderUsd: 100, sellLimits: {} })],
];

test("every Solana and Hyperliquid signing refusal names its chain and keeps its reason", () => {
  for (const [name, chain, reason, check] of refusals) {
    assert.throws(check, (error: unknown) => error instanceof Error && error.message === `${chain}: ${reason}`, `${name}: expected "${chain}: ${reason}"`);
  }
});

test("naming the chain changes no Solana or Hyperliquid signing decision", () => {
  for (const [name, , reason, check] of refusals) {
    assert.throws(check, (error: unknown) => error instanceof Error && error.message.endsWith(reason), `${name} is still refused for ${reason}`);
  }
  for (const [name, check] of accepted) assert.doesNotThrow(check, `${name} is still signed`);
});
