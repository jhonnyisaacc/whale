import { z } from "zod";
import { CHAINS } from "./chains.js";
import { turnkeyPolicyDocument, type TurnkeyPolicyInput } from "./signing-policy.js";

const address = z.string().regex(/^0x[0-9a-fA-F]{40}$/);
const solanaAddress = z.string().min(32).max(44);
const digits = z.string().regex(/^\d+$/);
const chainKey = z.enum(CHAINS.map((chain) => chain.key) as [string, ...string[]]);
const selector = z.string().regex(/^0x[0-9a-fA-F]{8}$/);
const turnkey = z.object({
  userId: z.string().uuid(),
  wallets: z.object({ evm: z.string().uuid(), solana: z.string().uuid(), hyperliquid: z.string().uuid().nullable() }),
  evmAddress: address,
  solanaAddress,
  hyperliquidAddress: address.nullable(),
});
const routersV1 = z.record(z.string().regex(/^\d+$/), z.array(address).min(1));
const routersV2 = z.record(z.string().regex(/^\d+$/), z.array(address));

const deploymentManifestV1Schema = z.object({
  version: z.literal(1),
  turnkey,
  routers: routersV1,
  selectors: z.array(selector).default([]),
  maxValueWei: digits,
  solanaPrograms: z.array(solanaAddress).default([]),
});

const deploymentManifestV2Schema = z.object({
  version: z.literal(2),
  turnkey: turnkey.optional(),
  chains: z.array(chainKey).optional(),
  routers: routersV2.optional(),
  settlers: routersV2.optional(),
  selectors: z.array(selector).default([]),
  solanaPrograms: z.array(solanaAddress).default([]),
  maxUsdPerTrade: digits.optional(),
  dailyUsdCap: digits.optional(),
  maxValueWei: digits.optional(),
  transferRecipients: z.array(z.union([address, solanaAddress])).optional(),
});

export const deploymentManifestSchema = z.discriminatedUnion("version", [deploymentManifestV1Schema, deploymentManifestV2Schema]);
export type DeploymentManifest = z.infer<typeof deploymentManifestSchema>;
export type DeploymentManifestV2 = z.infer<typeof deploymentManifestV2Schema>;

export function parseDeploymentManifest(raw: unknown): DeploymentManifest {
  const parsed = deploymentManifestSchema.safeParse(raw);
  if (!parsed.success) throw new Error(`deployment manifest is invalid: ${parsed.error.issues.map((issue) => `${issue.path.join(".")} ${issue.message}`).join("; ")}`);
  return parsed.data;
}

export function manifestRouters(manifest: DeploymentManifest): Record<number, string[]> {
  const out: Record<number, string[]> = {};
  for (const [id, list] of Object.entries(manifest.routers ?? {})) out[Number(id)] = list.map((item) => item.toLowerCase());
  return out;
}

export function manifestTurnkeyInput(manifest: DeploymentManifest): TurnkeyPolicyInput {
  if (!manifest.turnkey || manifest.maxValueWei === undefined) throw new Error("deployment manifest has no turnkey policy");
  return {
    userId: manifest.turnkey.userId,
    wallets: manifest.turnkey.wallets,
    solanaAddress: manifest.turnkey.solanaAddress,
    routers: manifestRouters(manifest),
    selectors: manifest.selectors,
    maxValueWei: BigInt(manifest.maxValueWei),
    solanaPrograms: manifest.solanaPrograms,
  };
}

export function manifestPolicyDocument(manifest: DeploymentManifest): unknown[] {
  return turnkeyPolicyDocument(manifestTurnkeyInput(manifest));
}

type PolicyRow = { policyName?: unknown; effect?: unknown; consensus?: unknown; condition?: unknown };

function policyKey(row: PolicyRow): string {
  return JSON.stringify([row.policyName, row.effect, row.consensus, row.condition]);
}

export function verifyTurnkeyPolicies(expected: unknown[], actual: unknown[]): { ok: true } | { ok: false; missing: string[]; extra: string[] } {
  const expectedRows = (expected as PolicyRow[]).map(policyKey);
  const actualRows = (actual as PolicyRow[]).map(policyKey);
  const missing = expectedRows.filter((row) => !actualRows.includes(row)).map((row) => String((JSON.parse(row) as unknown[])[0]));
  const extra = actualRows.filter((row) => !expectedRows.includes(row)).map((row) => String((JSON.parse(row) as unknown[])[0]));
  return missing.length === 0 && extra.length === 0 ? { ok: true } : { ok: false, missing, extra };
}
