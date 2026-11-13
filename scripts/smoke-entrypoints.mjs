import { spawn } from "node:child_process";

const base = { ...process.env, EXECUTOR_AUTH_TOKEN: "executor-token-123456", RESOLVER_AUTH_TOKEN: "resolver-token-123456" };
const children = [];
function start(name, file, env) {
  const merged = Object.fromEntries(Object.entries({ ...base, ...env }).filter(([, value]) => value !== undefined));
  const child = spawn("node", [file], { cwd: new URL("..", import.meta.url).pathname, env: merged, stdio: ["ignore", "pipe", "pipe"] });
  children.push(child);
  return child;
}
async function waitHealth(port) {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    try {
      const reply = await fetch(`http://127.0.0.1:${port}/health`);
      if (reply.ok) return;
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  throw new Error(`port ${port} never became healthy`);
}
try {
  start("executor", "dist/src/executor-server.js", { PORT: "18798" });
  await waitHealth(18798);
  const status = await fetch("http://127.0.0.1:18798/status", { headers: { authorization: "Bearer executor-token-123456" } }).then((reply) => reply.json());
  if (status.live !== false) throw new Error("executor did not boot in dry-run");
  const health = await fetch("http://127.0.0.1:18798/provider-health", { headers: { authorization: "Bearer executor-token-123456" } }).then((reply) => reply.json());
  if (!Array.isArray(health.providers)) throw new Error("provider-health did not return a list");
  const denied = await fetch("http://127.0.0.1:18798/provider-health");
  if (denied.status !== 401) throw new Error("provider-health accepted an unauthenticated call");
  console.log("smoke ok: executor boots with logging on, dry-run holds, provider-health is authenticated");
  if (process.env.TEST_DATABASE_URL) {
    const gatewayEnv = {
      EXECUTOR_AUTH_TOKEN: undefined,
      RESOLVER_AUTH_TOKEN: undefined,
      PORT: "18799",
      DATABASE_URL: process.env.TEST_DATABASE_URL,
      GATEWAY_PUBLIC_URL: "http://localhost:18799",
      GATEWAY_SECRET: Buffer.alloc(32, 9).toString("base64url"),
      GOOGLE_CLIENT_ID: "smoke.apps.googleusercontent.com",
      GOOGLE_CLIENT_SECRET: "smoke",
    };
    start("gateway", "dist/src/gateway-server.js", gatewayEnv);
    await waitHealth(18799);
    const me = await fetch("http://127.0.0.1:18799/api/me");
    if (me.status !== 401) throw new Error("gateway /api/me answered without a session");
    const crossSite = await fetch("http://127.0.0.1:18799/auth/logout", { method: "POST", headers: { origin: "https://evil.example" } });
    if (crossSite.status !== 403) throw new Error("gateway accepted a cross-origin logout");
    console.log("smoke ok: gateway migrates, boots, requires a session, and refuses cross-origin posts");
  }
} finally {
  for (const child of children) child.kill();
}
