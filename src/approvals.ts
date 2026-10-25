export type ApprovalKey = {
  chainId: number;
  token: string;
  spender: string;
  owner: string;
};

const cache = new Map<string, bigint>();

export function resetApprovals(): void {
  cache.clear();
}

function keyOf(input: ApprovalKey): string {
  return `${input.chainId}:${input.token.toLowerCase()}:${input.spender.toLowerCase()}:${input.owner.toLowerCase()}`;
}

export function rememberApproval(input: ApprovalKey, amount: bigint): void {
  cache.set(keyOf(input), amount);
}

export function allowanceCovers(input: ApprovalKey, needed: bigint): boolean {
  const cached = cache.get(keyOf(input));
  return cached !== undefined && cached >= needed;
}

export function seedApprovals(rows: readonly (ApprovalKey & { amount: string })[]): void {
  for (const row of rows) {
    if (!/^\d+$/.test(row.amount)) continue;
    rememberApproval(row, BigInt(row.amount));
  }
}
