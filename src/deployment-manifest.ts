import { z } from "zod";
import { turnkeyPolicyDocument, type TurnkeyPolicyInput } from "./signing-policy.js";

const address = z.string().regex(/^0x[0-9a-fA-F]{40}$/);
const solanaAddress = z.string().min(32).max(44);

export const deploymentManifestSchema = z.object({
  version: z.literal(1),
  turnkey: z.object({
    userId: z.string().uuid(),
    wallets: z.object({ evm: z.string().uuid(), solana: z.string().uuid(), hyperliquid: z.string().uuid().nullable() }),
    evmAddress: address,
    solanaAddress,
    hyperliquidAddress: address.nullable(),
  }),
  routers: z.record(z.string().regex(/^\d+$/), z.array(address).min(1)),
  selectors: z.array(z.string().regex(/^0x[0-9a-fA-F]{8}$/)).default([]),
  maxValueWei: z.string().regex(/^\d+$/),
  solanaPrograms: z.array(solanaAddress).default([]),
});
export type DeploymentManifest = z.infer<typeof deploymentManifestSchema>;

export function parseDeploymentManifest(raw: unknown): DeploymentManifest {
  const parsed = deploymentManifestSchema.safeParse(raw);
  if (!parsed.success) throw new Error(`deployment manifest is invalid: ${parsed.error.issues.map((issue) => `${issue.path.join(".")} ${issue.message}`).join("; ")}`);
  return parsed.data;
}

export function manifestRouters(manifest: DeploymentManifest): Record<number, string[]> {
  const out: Record<number, string[]> = {};
  for (const [id, list] of Object.entries(manifest.routers)) out[Number(id)] = list.map((item) => item.toLowerCase());
  return out;
}

export function manifestTurnkeyInput(manifest: DeploymentManifest): TurnkeyPolicyInput {
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
