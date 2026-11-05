import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import test from "node:test";
import { evmReadClient, resetRpcClients } from "../src/rpc.js";

type Reply = { status: number; body: string; retryAfter?: string; contentType?: string };

async function rpcServer(next: () => Reply): Promise<{ url: string; requests: () => number; close: () => Promise<void> }> {
  let requests = 0;
  const server: Server = createServer((request, response) => {
    request.resume();
    request.on("end", () => {
      requests += 1;
      const reply = next();
      if (reply.retryAfter) response.setHeader("retry-after", reply.retryAfter);
      response.writeHead(reply.status, { "content-type": reply.contentType ?? "application/json" });
      response.end(reply.body);
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as { port: number };
  return {
    url: `http://127.0.0.1:${port}`,
    requests: () => requests,
    close: () =>
      new Promise((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}

const failure = JSON.stringify({ jsonrpc: "2.0", id: 1, error: { code: -32005, message: "limit" } });
const chainId = JSON.stringify({ jsonrpc: "2.0", id: 1, result: "0x2105" });

for (const { name, body, contentType } of [
  { name: "a plain body", body: "slow down", contentType: "text/plain" },
  { name: "a JSON-RPC error body", body: failure },
]) {
  test(`a long Retry-After with ${name} does not stall reads across several RPCs`, async () => {
    resetRpcClients();
    const first = await rpcServer(() => ({ status: 429, body, contentType, retryAfter: "30" }));
    const second = await rpcServer(() => ({ status: 429, body, contentType, retryAfter: "30" }));
    try {
      const started = Date.now();
      await assert.rejects(evmReadClient([first.url, second.url]).getChainId());
      assert.ok(Date.now() - started < 10_000, "the read did not wait for Retry-After");
    } finally {
      await Promise.all([first.close(), second.close()]);
    }
  });
}

test("a one-off failure on every RPC is retried, so the read still succeeds", async () => {
  resetRpcClients();
  const flaky = () => {
    let calls = 0;
    return () => {
      calls += 1;
      return calls === 1 ? { status: 429, body: failure, retryAfter: "30" } : { status: 200, body: chainId };
    };
  };
  const first = await rpcServer(flaky());
  const second = await rpcServer(flaky());
  try {
    const started = Date.now();
    assert.equal(await evmReadClient([first.url, second.url]).getChainId(), 8453);
    assert.ok(Date.now() - started < 10_000, "the retry did not wait for Retry-After");
  } finally {
    await Promise.all([first.close(), second.close()]);
  }
});

test("a limited RPC still falls through to a healthy one", async () => {
  resetRpcClients();
  const limitedRpc = await rpcServer(() => ({ status: 429, body: "slow down", contentType: "text/plain", retryAfter: "30" }));
  const healthy = await rpcServer(() => ({ status: 200, body: chainId }));
  try {
    assert.equal(await evmReadClient([limitedRpc.url, healthy.url]).getChainId(), 8453);
  } finally {
    await Promise.all([limitedRpc.close(), healthy.close()]);
  }
});
