import type { Latency } from "./domain.js";

export function stamp(latency: Latency, stage: keyof Omit<Latency, "alertReceivedMs">, now = Date.now()): Latency {
  return { ...latency, [stage]: now - latency.alertReceivedMs };
}

export function latencyLog(latency: Latency): Record<string, number> {
  const out: Record<string, number> = { alertReceivedMs: 0 };
  for (const key of ["resolvedMs", "quotedMs", "signedMs", "sentMs", "confirmedMs"] as const) {
    if (latency[key] !== undefined) out[key] = latency[key];
  }
  return out;
}
