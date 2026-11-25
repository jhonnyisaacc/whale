import { z } from "zod";

export const supportTierSchema = z.enum(["live", "dry_run", "disabled"]);
export type SupportTier = z.infer<typeof supportTierSchema>;

const DEFAULT_SUPPORT: Readonly<Record<string, SupportTier>> = { monad: "disabled", zksync: "dry_run" };

export function defaultSupportTier(chainKey: string): SupportTier {
  return DEFAULT_SUPPORT[chainKey] ?? "live";
}

export function supportByChain(chainKeys: Iterable<string>, raw: string | undefined): Record<string, SupportTier> {
  const out: Record<string, SupportTier> = {};
  for (const key of chainKeys) out[key] = defaultSupportTier(key);
  if (!raw) return out;
  for (const part of raw.split(",").map((item) => item.trim()).filter(Boolean)) {
    const [key, tier, ...rest] = part.split(":");
    const parsed = supportTierSchema.safeParse(tier);
    if (!key || !parsed.success || rest.length > 0) throw new Error("SUPPORT_TIERS entries look like chain:live, chain:dry_run, or chain:disabled");
    if (!Object.hasOwn(out, key)) throw new Error(`SUPPORT_TIERS names unknown chain ${key}. Known: ${Object.keys(out).join(", ")}`);
    out[key] = parsed.data;
  }
  return out;
}

export function supportTierFor(support: Readonly<Record<string, SupportTier>>, chainKey: string): SupportTier {
  return support[chainKey] ?? defaultSupportTier(chainKey);
}

export function liveTierBlocked(mode: "live" | "dry_run", tierFor: ((chainKey: string) => SupportTier) | undefined, chainKey: string): boolean {
  return mode === "live" && tierFor !== undefined && tierFor(chainKey) !== "live";
}

export function sendBlock(mode: "live" | "dry_run", tierFor: ((chainKey: string) => SupportTier) | undefined, venue: string, enabled: ReadonlySet<string>, isFlagged: boolean): string | null {
  if (mode !== "live") return null;
  if (!enabled.has(venue)) return `chain ${venue} is disabled`;
  if (liveTierBlocked(mode, tierFor, venue)) return "chain is not enabled for live sends";
  return isFlagged ? "token flagged for a transfer shortfall" : null;
}
