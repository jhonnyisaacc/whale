const KNOWN_ACCOUNTS = 10_000;
const KNOWN_PER_ACCOUNT = 16;

type Holder = { agentId: string; accountId: string };

export function knownCredentials() {
  const holders = new Map<string, Holder>();
  const byAccount = new Map<string, string[]>();
  const drop = (digests: string[]) => {
    for (const digest of digests) holders.delete(digest);
  };
  return {
    agentOf: (digest: string) => holders.get(digest)?.agentId,
    remember(digest: string, holder: Holder) {
      const digests = (byAccount.get(holder.accountId) ?? []).filter((known) => known !== digest);
      digests.push(digest);
      drop(digests.splice(0, digests.length - KNOWN_PER_ACCOUNT));
      byAccount.delete(holder.accountId);
      byAccount.set(holder.accountId, digests);
      holders.set(digest, { agentId: holder.agentId, accountId: holder.accountId });
      if (byAccount.size <= KNOWN_ACCOUNTS) return;
      const [oldest, stale] = byAccount.entries().next().value as [string, string[]];
      byAccount.delete(oldest);
      drop(stale);
    },
    forget(digest: string) {
      const holder = holders.get(digest);
      if (!holder) return;
      holders.delete(digest);
      const digests = byAccount.get(holder.accountId)?.filter((known) => known !== digest) ?? [];
      if (digests.length) byAccount.set(holder.accountId, digests);
      else byAccount.delete(holder.accountId);
    },
  };
}
