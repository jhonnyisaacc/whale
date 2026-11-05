import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import test from "node:test";
import { evmReadClient, resetRpcClients } from "../src/rpc.js";

type Reply = { status: number; body: string; retryAfter?: string };

async function rpcServer(reply: Reply): Promise<{ url: string; requests: () => number; close: () => Promise<void> }> {
  let requests = 0;
  const server: Server = createServer((request, response) => {
    request.resume();
    request.on("end", () => {
      requests += 1;
      if (reply.retryAfter) response.setHeader("retry-after", reply.retryAfter);
      response.writeHead(reply.status, { "content-type": "application/json" });
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

const limited = [
  { name: "a plain body", body: "slow down" },
  { name: "a JSON-RPC error body", body: JSON.stringify({ jsonrpc: "2.0", id: 1, error: { code: -32005, message: "limit" } }) },
];

for (const { name, body } of limited) {
  test(`several RPCs that answer 429 with Retry-After and ${name} fail fast, once each`, async () => {
    resetRpcClients();
    const first = await rpcServer({ status: 429, body, retryAfter: "2" });
    const second = await rpcServer({ status: 429, body, retryAfter: "2" });
    try {
      const started = Date.now();
      await assert.rejects(evmReadClient([first.url, second.url]).getChainId());
      assert.deepEqual([first.requests(), second.requests()], [1, 1]);
      assert.ok(Date.now() - started < 1_000, "the read did not wait for Retry-After");
    } finally {
      await Promise.all([first.close(), second.close()]);
    }
  });
}

test("a limited RPC still falls through to a healthy one", async () => {
  resetRpcClients();
  const limitedRpc = await rpcServer({ status: 429, body: "slow down", retryAfter: "2" });
  const healthy = await rpcServer({ status: 200, body: JSON.stringify({ jsonrpc: "2.0", id: 1, result: "0x2105" }) });
  try {
    assert.equal(await evmReadClient([limitedRpc.url, healthy.url]).getChainId(), 8453);
  } finally {
    await Promise.all([limitedRpc.close(), healthy.close()]);
  }
});
