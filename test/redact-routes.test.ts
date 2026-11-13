import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer, type Server } from "node:http";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { configSecrets, loadConfig } from "../src/config.js";
import { redactText } from "../src/redact.js";

const pathKey = "fakePathKey0123456789abcdef";
const queryKey = "fakeQueryKey9876543210";
const address = "0x000000000000000000000000000000000000dEaD";

async function failingRpc(): Promise<{ server: Server; url: string }> {
  const server = createServer((request, response) => {
    request.resume();
    request.on("end", () => {
      response.writeHead(500, { "content-type": "application/json" });
      response.end(JSON.stringify({ jsonrpc: "2.0", id: 1, error: { code: -32000, message: "down" } }));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as { port: number };
  return { server, url: `http://127.0.0.1:${port}/v2/${pathKey}?apikey=${queryKey}` };
}

function runScript(script: string, args: string[], env: Record<string, string>, input: string): Promise<{ stdout: string; stderr: string }> {
  const base = Object.fromEntries(Object.entries(process.env).filter(([name]) => !/RPC_URL|WHALE_/.test(name)));
  const child = spawn(process.execPath, [fileURLToPath(new URL(script, import.meta.url)), ...args], { env: { ...base, ...env } });
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk: Buffer) => (stdout += chunk.toString("utf8")));
  child.stderr.on("data", (chunk: Buffer) => (stderr += chunk.toString("utf8")));
  child.stdin.end(input);
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error("the script did not exit"));
    }, 20_000);
    child.on("close", () => {
      clearTimeout(timer);
      resolve({ stdout, stderr });
    });
  });
}

function assertNoKey(text: string): void {
  assert.equal(text.includes(pathKey), false, `path key leaked: ${text}`);
  assert.equal(text.includes(queryKey), false, `query key leaked: ${text}`);
}

test("the MCP balance tool does not return a keyed RPC URL when the RPC fails", async () => {
  const { server, url } = await failingRpc();
  try {
    const call = { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "balance", arguments: { chainKey: "base", address } } };
    const { stdout } = await runScript("../src/mcp-server.js", [], { RPC_URL_8453: url }, `${JSON.stringify(call)}\n`);
    const reply = JSON.parse(stdout) as { result: { isError?: boolean; content: { text: string }[] } };
    assert.equal(reply.result.isError, true);
    assert.match(reply.result.content[0].text, /\[redacted\]/);
    assertNoKey(reply.result.content[0].text);
  } finally {
    server.closeAllConnections();
    server.close();
  }
});

test("the CLI balance command does not print a keyed RPC URL when the RPC fails", async () => {
  const { server, url } = await failingRpc();
  try {
    const { stdout, stderr } = await runScript("../src/cli.js", ["balance", "--chain", "base", "--address", address], { RPC_URL_8453: url }, "");
    assert.equal(stdout, "");
    assert.match(stderr, /\[redacted\]/);
    assertNoKey(stderr);
  } finally {
    server.closeAllConnections();
    server.close();
  }
});

test("a key the provider echoes bare is redacted", () => {
  const secrets = configSecrets(loadConfig({ RPC_URL_8453: `https://rpcuser:rpcpassword1@rpc.example/v2/${pathKey}?apikey=${queryKey}` }));
  for (const echoed of [`denied for path /?apikey=${queryKey}`, `unknown key ${pathKey}`, "bad login rpcuser:rpcpassword1"]) {
    const redacted = redactText(echoed, secrets);
    assertNoKey(redacted);
    assert.equal(redacted.includes("rpcpassword1"), false);
  }
});

test("plain path segments and query words in an RPC URL stay readable", () => {
  const secrets = configSecrets(loadConfig({ RPC_URL_8453: "https://rpc.example/v1/solana-mainnet-beta/ethereum?network=optimism&chain=mainnet&tag=latest" }));
  const text = "v1 solana-mainnet-beta ethereum optimism mainnet latest";
  assert.equal(redactText(`call failed on ${text}`, secrets), `call failed on ${text}`);
});
