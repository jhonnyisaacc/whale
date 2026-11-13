export type GatewayConfig = {
  publicUrl: URL;
  port: number;
  databaseUrl: string;
  google: { clientId: string; clientSecret: string };
  secret: Buffer;
  trustProxyHops: number;
  executor: { url: URL; token: string } | null;
};

// The gateway is public and holds no signing credential. Boot refuses one, so a copied executor env cannot
// turn the public process into a signer.
const SIGNING_ENV = ["TURNKEY_API_PRIVATE_KEY", "KEYSTORE_PATH", "KEYSTORE_PASSWORD", "WHALE_BROADCAST", "EXECUTOR_AUTH_TOKEN"];
const CLOSED_ENV = ["HOSTED_LIVE"];
const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);

function required(env: NodeJS.ProcessEnv, name: string): string {
  const value = env[name]?.trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
}

export function publicUrlFrom(raw: string): URL {
  const url = new URL(raw);
  if (url.pathname !== "/" || url.search || url.hash || url.username || url.password) throw new Error("GATEWAY_PUBLIC_URL must be a bare origin like https://whale.example");
  if (url.protocol !== "https:" && !(url.protocol === "http:" && LOCAL_HOSTS.has(url.hostname))) throw new Error("GATEWAY_PUBLIC_URL must use https outside localhost");
  return url;
}

export function secretFrom(raw: string): Buffer {
  const secret = Buffer.from(raw, "base64url");
  if (secret.byteLength < 32) throw new Error("GATEWAY_SECRET must be at least 32 random bytes, base64url encoded");
  return secret;
}

export function loadGatewayConfig(env: NodeJS.ProcessEnv = process.env): GatewayConfig {
  for (const name of CLOSED_ENV) if (env[name] !== undefined) throw new Error(`${name} is closed until ADR 0003 is accepted`);
  for (const name of SIGNING_ENV) if (env[name] !== undefined) throw new Error(`${name} belongs to the executor; the gateway holds no signing credential`);
  const clientId = required(env, "GOOGLE_CLIENT_ID");
  if (!clientId.endsWith(".apps.googleusercontent.com")) throw new Error("GOOGLE_CLIENT_ID is not a Google OAuth client id");
  const port = Number(env.PORT ?? "8080");
  if (!Number.isInteger(port) || port < 1 || port > 65_535) throw new Error("PORT must be a TCP port");
  const publicUrl = publicUrlFrom(required(env, "GATEWAY_PUBLIC_URL"));
  const deployed = !LOCAL_HOSTS.has(publicUrl.hostname);
  if (deployed && !env.GATEWAY_TRUST_PROXY_HOPS?.trim()) throw new Error("GATEWAY_TRUST_PROXY_HOPS is required when GATEWAY_PUBLIC_URL is not localhost: 1 behind one proxy, 0 with none");
  const hops = Number(env.GATEWAY_TRUST_PROXY_HOPS ?? "0");
  if (!Number.isInteger(hops) || hops < 0 || hops > 3) throw new Error("GATEWAY_TRUST_PROXY_HOPS must be 0 to 3");
  return {
    publicUrl,
    port,
    databaseUrl: required(env, "DATABASE_URL"),
    google: { clientId, clientSecret: required(env, "GOOGLE_CLIENT_SECRET") },
    secret: secretFrom(required(env, "GATEWAY_SECRET")),
    trustProxyHops: hops,
    executor: executorFrom(env),
  };
}

// The executor stays on the private network. The gateway reaches only its /hosted/commands route, with a token
// that the executor refuses on every other route.
export function executorFrom(env: NodeJS.ProcessEnv): { url: URL; token: string } | null {
  const raw = env.HOSTED_EXECUTOR_URL?.trim();
  if (!raw) return null;
  const url = new URL(raw);
  if (url.protocol !== "http:" && url.protocol !== "https:") throw new Error("HOSTED_EXECUTOR_URL must be http or https");
  const token = required(env, "HOSTED_SERVICE_TOKEN");
  if (token.length < 32) throw new Error("HOSTED_SERVICE_TOKEN must be at least 32 characters");
  return { url, token };
}

export function gatewaySecrets(config: GatewayConfig): string[] {
  return [config.google.clientSecret, config.secret.toString("base64url"), config.databaseUrl, ...(config.executor ? [config.executor.token] : [])];
}
