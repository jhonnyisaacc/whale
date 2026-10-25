const NONCE_REJECTED = /nonce too low|nonce has already been used|replacement transaction underpriced|transaction underpriced|nonce_expired|invalid nonce/i;

// Node rejections that happen before the mempool: the transaction was never accepted anywhere.
const PRE_MEMPOOL_REJECTED = new RegExp(
  [
    "insufficient funds",
    "exceeds the balance of the account",
    "intrinsic gas too (?:low|high)",
    "exceeds block gas limit",
    "invalid sender",
    "fee cap less than block base fee",
    "max fee per gas less than block base fee",
    "cannot be lower than the block base fee",
    "fee cap too low",
    "tip higher than fee cap",
    "max priority fee per gas higher than max fee per gas",
    "transaction type not supported",
  ].join("|"),
  "i",
);

export function isNonceRejection(message: string): boolean {
  return NONCE_REJECTED.test(message);
}

export function isDefiniteRejection(message: string): boolean {
  return NONCE_REJECTED.test(message) || PRE_MEMPOOL_REJECTED.test(message);
}

type Slot = { next: number | null; tail: Promise<unknown> };

export type NonceManager = {
  use<T>(chainId: number, address: string, readPending: () => Promise<number>, send: (nonce: number) => Promise<T>): Promise<T>;
  resync(chainId: number, address: string): void;
};

export function createNonceManager(): NonceManager {
  const slots = new Map<string, Slot>();
  const slotFor = (chainId: number, address: string) => {
    const key = `${chainId}:${address.toLowerCase()}`;
    const slot = slots.get(key) ?? { next: null, tail: Promise.resolve() };
    slots.set(key, slot);
    return slot;
  };
  return {
    use(chainId, address, readPending, send) {
      const slot = slotFor(chainId, address);
      const run = slot.tail.then(async () => {
        if (slot.next === null) slot.next = await readPending();
        const nonce = slot.next;
        try {
          const out = await send(nonce);
          slot.next = nonce + 1;
          return out;
        } catch (error) {
          // Whether or not the node kept it, the pending count is the only source that cannot leave a gap.
          slot.next = null;
          throw error;
        }
      });
      slot.tail = run.catch(() => undefined);
      return run;
    },
    resync(chainId, address) {
      const slot = slotFor(chainId, address);
      slot.tail = slot.tail.then(() => {
        slot.next = null;
      });
    },
  };
}

export const evmNonces = createNonceManager();
