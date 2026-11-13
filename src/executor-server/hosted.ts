import type { FastifyInstance } from "fastify";
import type { CommandDeps, WalletCommand, WalletResult } from "../commands.js";
import { run } from "../commands.js";
import { hostedRequestSchema, walletCommandOf, type HostedRequest } from "../hosted-commands.js";
import { bearerOf } from "../bearer.js";
import { anyTokenMatches } from "../http.js";
import { cachedNetworkCosts, envCostReaders, skippedNetworks, type CostReaders } from "../network-costs.js";

export const HOSTED_TOKEN_ENV = "HOSTED_SERVICE_TOKEN";

export type HostedReply =
  | WalletResult
  | { kind: "swap"; status: "would_swap" | "skipped"; quote: Extract<WalletResult, { kind: "quote" }>["quote"]; reason: string };

// The gateway's token can only reach this route. It is a different secret from the executor bearer, so a gateway
// compromise cannot call /execute or /rebalance.
export function hostedServiceToken(env: NodeJS.ProcessEnv, executorTokens: readonly string[]): string | null {
  const token = env[HOSTED_TOKEN_ENV]?.trim();
  if (token === undefined) return null;
  if (token.length < 32) throw new Error(`${HOSTED_TOKEN_ENV} must be at least 32 characters`);
  if (executorTokens.includes(token)) throw new Error(`${HOSTED_TOKEN_ENV} must differ from EXECUTOR_AUTH_TOKEN`);
  return token;
}

async function defaultDeps(command: WalletCommand): Promise<CommandDeps> {
  const { commandDeps } = await import("../command-callers.js");
  const deps = commandDeps(process.env, command);
  return { ...(deps.quote ? { quote: deps.quote } : {}), ...(deps.readBalance ? { readBalance: deps.readBalance } : {}) };
}

// Only quote and balance readers reach run(). A hosted swap is a quote reported as the swap that would happen,
// so nothing on this route can sign or post.
export function registerHostedRoutes(app: FastifyInstance, options: { token: string; depsFor?: (command: WalletCommand) => Promise<CommandDeps>; costReaders?: CostReaders }): void {
  const depsFor = options.depsFor ?? defaultDeps;
  const costReaders = options.costReaders ?? envCostReaders(process.env);
  const perAccount = app.createRateLimit({ max: 600, timeWindow: "1 minute", keyGenerator: (request) => (request.body as HostedRequest).accountId });
  app.post("/hosted/commands", { config: { rateLimit: false } }, async (request, reply) => {
    if (!anyTokenMatches(bearerOf(request), [options.token])) return reply.code(401).send({ error: "unauthorized" });
    const parsed = hostedRequestSchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: "invalid request" });
    const limit = await perAccount(request);
    if (!limit.isAllowed && limit.isExceeded) return reply.code(429).header("retry-after", limit.ttlInSeconds).send({ error: "rate limit" });
    if (parsed.data.command.kind === "costs") return { kind: "costs", networks: await cachedNetworkCosts(parsed.data.command.chainKeys, costReaders), skipped: skippedNetworks(parsed.data.command.chainKeys) };
    const command = walletCommandOf(parsed.data.command);
    const deps = await depsFor(command);
    const result = await run(command, { ...(deps.quote ? { quote: deps.quote } : {}), ...(deps.readBalance ? { readBalance: deps.readBalance } : {}) });
    if (parsed.data.command.kind !== "swap" || result.kind !== "quote") return result satisfies HostedReply;
    const plan: HostedReply =
      result.status === "quoted"
        ? { kind: "swap", status: "would_swap", quote: result.quote, reason: "dry-run: this is the route a live swap would take. nothing was signed" }
        : { kind: "swap", status: "skipped", quote: null, reason: result.reason };
    return plan;
  });
}
