export type EnclaveOutcome = "created" | "in_progress" | "conflict" | "attempt_dropped" | "step_up" | "busy" | "failed";

const OUTCOMES: Record<string, EnclaveOutcome> = {
  "409 enclave_exists": "created",
  "409 enclave_in_progress": "in_progress",
  "409 enclave_conflict": "conflict",
  "502 turnkey_refused": "attempt_dropped",
  "503 turnkey_unreachable": "attempt_dropped",
  "428 step_up_required": "step_up",
  "429 rate_limit": "busy",
};

export function enclaveOutcome(status: number, code: string): EnclaveOutcome {
  return OUTCOMES[`${status} ${code}`] ?? "failed";
}

export function pollDelayMs(attempt: number): number {
  return Math.min(2_000 * 2 ** attempt, 10_000);
}
