// AbortSignal.timeout uses an unref'd timer on Node 22, so a process whose only
// pending work is that timer can exit before it fires. Keep a ref'd timer instead,
// and clear it once the work settles so it never holds the process open afterwards.
export async function withTimeout<T>(ms: number, run: (signal: AbortSignal) => Promise<T>, outer?: AbortSignal): Promise<T> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error(`timeout after ${ms}ms`)), Math.max(0, ms));
  try {
    return await run(outer ? anySignal([outer, controller.signal]) : controller.signal);
  } finally {
    clearTimeout(timer);
  }
}

export function anySignal(signals: readonly AbortSignal[]): AbortSignal {
  const controller = new AbortController();
  for (const signal of signals) {
    if (signal.aborted) {
      controller.abort(signal.reason);
      return controller.signal;
    }
    signal.addEventListener("abort", () => controller.abort(signal.reason), { once: true });
  }
  return controller.signal;
}
