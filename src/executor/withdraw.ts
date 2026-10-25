export function decideWithdraw(input: {
  adminOk: boolean;
  enabled: boolean;
  amount: number | undefined;
  cap: number;
  destinationAllowed: boolean;
  mint: string | undefined;
  recoveryAllowlist: readonly string[];
  live: boolean;
  killSwitch: boolean;
  signerReady: boolean;
  chainKey: string | undefined;
  decimals: number | undefined;
}): { http: number; error?: string; decision?: "would_send" | "send" } {
  if (!input.adminOk) return { http: 401, error: "unauthorized" };
  if (!input.enabled) return { http: 403, error: "withdraw is disabled" };
  if (input.amount !== undefined && !(input.amount > 0 && input.amount <= input.cap)) return { http: 403, error: "withdraw exceeds the per-call cap" };
  if (!input.destinationAllowed) return { http: 403, error: "destination is not allowlisted" };
  if (input.mint) {
    const allowed = input.recoveryAllowlist.some((item) => item.toLowerCase() === input.mint?.toLowerCase());
    if (!allowed) return { http: 403, error: "token is not in the recovery allowlist" };
    if (input.decimals === undefined) return { http: 409, error: "token withdraw needs decimals" };
  }
  if (!input.live || input.killSwitch) return { http: 200, decision: "would_send" };
  if (!input.signerReady || !input.chainKey || !(input.amount && input.amount > 0)) {
    return { http: 409, error: "live withdraw needs a signer, chainKey, and amount" };
  }
  return { http: 200, decision: "send" };
}

export function authorizeWithdraw(to: string, allowlist: readonly string[]): { ok: true } | { ok: false; reason: string } {
  const target = to.toLowerCase();
  const allowed = allowlist.some((item) => item.toLowerCase() === target);
  if (!allowed) return { ok: false, reason: "destination is not allowlisted" };
  return { ok: true };
}
