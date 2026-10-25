import { chainByKey } from "./chains.js";
import { run, type Asset, type WalletCommand } from "./commands.js";

function flag(argv: readonly string[], name: string): string | null {
  const index = argv.indexOf(name);
  if (index < 0) return null;
  return argv[index + 1] ?? null;
}

function asset(argv: readonly string[], prefix: string): Asset {
  const chainKey = flag(argv, `--${prefix}-chain`);
  const spec = chainKey ? chainByKey(chainKey) : undefined;
  if (!chainKey || !spec) throw new Error(`--${prefix}-chain must name a known chain`);
  const address = flag(argv, `--${prefix}-address`);
  const symbol = flag(argv, `--${prefix}-symbol`);
  if (!address || !symbol) throw new Error(`--${prefix}-address and --${prefix}-symbol are required`);
  const decimals = flag(argv, `--${prefix}-decimals`);
  return { chain: spec.chain, chainKey, address, symbol, decimals: decimals === null ? null : Number(decimals) };
}

export function parseCommand(argv: readonly string[]): WalletCommand {
  const [kind, ...rest] = argv;
  if (kind === "quote" || kind === "swap") {
    const sellAmount = flag(rest, "--sell-amount");
    const slippage = flag(rest, "--slippage-bps");
    if (!sellAmount || slippage === null) throw new Error("--sell-amount and --slippage-bps are required");
    const shared = {
      sell: asset(rest, "sell"),
      buy: asset(rest, "buy"),
      sellAmount,
      slippageBps: Number(slippage),
    };
    if (kind === "quote") return { kind, ...shared, taker: flag(rest, "--taker") };
    const idempotencyKey = flag(rest, "--idempotency-key");
    if (!idempotencyKey) throw new Error("--idempotency-key is required");
    return { kind, ...shared, idempotencyKey, mode: "dry_run" };
  }
  if (kind === "balance") {
    const chainKey = flag(rest, "--chain");
    const address = flag(rest, "--address");
    if (!chainKey || !address) throw new Error("--chain and --address are required");
    return { kind, chainKey, address };
  }
  if (kind === "transfer") {
    const idempotencyKey = flag(rest, "--idempotency-key");
    const to = flag(rest, "--to");
    const amount = flag(rest, "--amount");
    if (!idempotencyKey || !to || !amount) throw new Error("--idempotency-key, --to, and --amount are required");
    return { kind, idempotencyKey, asset: asset(rest, "asset"), to, amount, mode: "dry_run" };
  }
  if (kind === "bridge") {
    throw new Error("bridge quotes are not fetched yet. pass them to run() from a caller. see the TODO in src/commands.ts");
  }
  throw new Error("usage: quote | swap | bridge | balance | transfer");
}

const entry = process.argv[1] ?? "";
if (entry.endsWith("cli.js")) {
  const command = parseCommand(process.argv.slice(2));
  run(command)
    .then((result) => {
      process.stdout.write(`${JSON.stringify(result)}\n`);
    })
    .catch((error: unknown) => {
      console.error(error instanceof Error ? error.message : "command failed");
      process.exit(1);
    });
}
