export type HttpClass = "ok" | "compliance" | "rate" | "error";

const COMPLIANCE = /sanction|ofac|compliance|restricted jurisdiction|geoblock|denied by policy/;

export function classifyHttp(status: number, body: string): HttpClass {
  if (status >= 200 && status < 300) return "ok";
  if (status === 451 || COMPLIANCE.test(body.toLowerCase())) return "compliance";
  if (status === 429) return "rate";
  return "error";
}

export function retryAfterAt(header: string | null, now: number): number | null {
  if (!header) return null;
  const trimmed = header.trim();
  if (/^\d+$/.test(trimmed)) return now + Number(trimmed) * 1000;
  const at = Date.parse(trimmed);
  return Number.isFinite(at) && at > now ? at : null;
}

export type ProviderErrorClass = "http" | "rate" | "compliance" | "network" | "schema";

export type ProviderHealthSnapshot = {
  provider: string;
  state: "healthy" | "degraded" | "open" | "compliance";
  consecutiveFailures: number;
  lastSuccessAt: number | null;
  lastFailureAt: number | null;
  lastErrorClass: ProviderErrorClass | null;
  openUntil: number | null;
  callsInWindow: number;
};

type Row = { failures: number; openUntil: number; used: number; windowStart: number; compliance: boolean; lastSuccessAt: number | null; lastFailureAt: number | null; lastErrorClass: ProviderErrorClass | null };

export class ProviderGuard {
  private readonly rows = new Map<string, Row>();

  constructor(
    private readonly options: {
      budget: number;
      windowMs: number;
      failureThreshold: number;
      openMs: number;
      now: () => number;
    },
  ) {}

  before(id: string): "allow" | "open" | "budget" {
    const row = this.row(id);
    const now = this.options.now();
    if (row.openUntil > now) return "open";
    if (now - row.windowStart >= this.options.windowMs) {
      row.windowStart = now;
      row.used = 0;
    }
    if (row.used >= this.options.budget) return "budget";
    row.used += 1;
    return "allow";
  }

  success(id: string): void {
    const row = this.row(id);
    row.failures = 0;
    row.compliance = false;
    row.lastSuccessAt = this.options.now();
    row.lastErrorClass = null;
  }

  failure(id: string, errorClass: ProviderErrorClass = "http"): void {
    const row = this.row(id);
    row.failures += 1;
    row.lastFailureAt = this.options.now();
    row.lastErrorClass = errorClass;
    if (row.failures >= this.options.failureThreshold) row.openUntil = this.options.now() + this.options.openMs;
  }

  rateLimited(id: string, retryAt: number | null): void {
    this.failure(id, "rate");
    const row = this.row(id);
    if (retryAt !== null && retryAt > row.openUntil) row.openUntil = retryAt;
  }

  compliance(id: string): void {
    const row = this.row(id);
    row.compliance = true;
    row.lastFailureAt = this.options.now();
    row.lastErrorClass = "compliance";
    row.openUntil = this.options.now() + this.options.openMs;
  }

  snapshot(): ProviderHealthSnapshot[] {
    const now = this.options.now();
    return [...this.rows.entries()]
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([provider, row]) => ({
        provider,
        state: row.compliance && row.openUntil > now ? "compliance" : row.openUntil > now ? "open" : row.failures > 0 ? "degraded" : "healthy",
        consecutiveFailures: row.failures,
        lastSuccessAt: row.lastSuccessAt,
        lastFailureAt: row.lastFailureAt,
        lastErrorClass: row.lastErrorClass,
        openUntil: row.openUntil > now ? row.openUntil : null,
        callsInWindow: row.used,
      }));
  }

  complianceOpen(id: string): boolean {
    return this.row(id).compliance && this.row(id).openUntil > this.options.now();
  }

  private row(id: string): Row {
    const existing = this.rows.get(id);
    if (existing) return existing;
    const created: Row = { failures: 0, openUntil: 0, used: 0, windowStart: this.options.now(), compliance: false, lastSuccessAt: null, lastFailureAt: null, lastErrorClass: null };
    this.rows.set(id, created);
    return created;
  }
}
