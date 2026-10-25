import { z } from "zod";

export const approvalModeSchema = z.enum(["autonomous", "iframe", "always_approve"]);
export type ApprovalMode = z.infer<typeof approvalModeSchema>;

export function parseApprovalMode(raw: string | undefined): ApprovalMode {
  if (raw === undefined || raw === "") return "always_approve";
  const parsed = approvalModeSchema.safeParse(raw);
  if (!parsed.success) throw new Error("WALLET_APPROVAL_MODE must be autonomous, iframe, or always_approve");
  return parsed.data;
}

export type ApprovalGate = { action: "sign" | "confirm" | "passkey"; reason: string };

export function approvalGate(mode: ApprovalMode, input: { live: boolean; screened: boolean }): ApprovalGate {
  if (!input.live) return { action: "sign", reason: "dry-run signs nothing" };
  if (!input.screened) return { action: "passkey", reason: "an unscreened live send needs a human" };
  if (mode === "autonomous") return { action: "sign", reason: "the grant allows unattended signing inside its caps" };
  if (mode === "iframe") return { action: "confirm", reason: "the grant needs a confirm in the signing window" };
  return { action: "passkey", reason: "the grant needs a passkey for every live send" };
}
