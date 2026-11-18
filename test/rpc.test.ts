import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import test from "node:test";
import { createViemRpc } from "../src/broadcast/shared.js";
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
      await assert.rejects(evmReadClient(8453, [first.url, second.url]).getChainId());
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
    assert.equal(await evmReadClient(8453, [first.url, second.url]).getChainId(), 8453);
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
    assert.equal(await evmReadClient(8453, [limitedRpc.url, healthy.url]).getChainId(), 8453);
  } finally {
    await Promise.all([limitedRpc.close(), healthy.close()]);
  }
});

type ChainStub = { chainId: string; down: boolean };

async function chainServer(state: ChainStub): Promise<{ url: string; chainIdCalls: () => number; close: () => Promise<void> }> {
  let chainIdCalls = 0;
  const server: Server = createServer((request, response) => {
    let raw = "";
    request.on("data", (chunk) => (raw += chunk));
    request.on("end", () => {
      if (state.down) {
        request.socket.destroy();
        return;
      }
      const body = JSON.parse(raw) as { id: number; method: string };
      if (body.method === "eth_chainId") chainIdCalls += 1;
      const result = body.method === "eth_chainId" ? state.chainId : "0x10";
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ jsonrpc: "2.0", id: body.id, result }));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as { port: number };
  return {
    url: `http://127.0.0.1:${port}`,
    chainIdCalls: () => chainIdCalls,
    close: () =>
      new Promise((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}

function chainMismatch(url: string) {
  return (error: unknown) => {
    const text = String(error);
    assert.match(text, /monad/);
    assert.match(text, /\b143\b/);
    assert.match(text, /\b1\b/);
    assert.equal(text.includes(url), false, "the error does not leak the RPC URL");
    return true;
  };
}

test("an RPC that answers another chain id is refused for reads and sends on that chain", async () => {
  resetRpcClients();
  const wrong = await chainServer({ chainId: "0x1", down: false });
  try {
    await assert.rejects(evmReadClient(143, [wrong.url]).getBlockNumber(), chainMismatch(wrong.url));
    await assert.rejects(createViemRpc(143, [wrong.url]).pendingNonce(`0x${"1".repeat(40)}`), chainMismatch(wrong.url));
  } finally {
    await wrong.close();
  }
});

test("an RPC on its configured chain is used, and its chain id is probed once per process", async () => {
  resetRpcClients();
  const right = await chainServer({ chainId: "0x8f", down: false });
  try {
    const client = evmReadClient(143, [right.url]);
    assert.equal(await client.getBlockNumber({ cacheTime: 0 }), 16n);
    assert.equal(await client.getBlockNumber({ cacheTime: 0 }), 16n);
    assert.equal(await createViemRpc(143, [right.url]).pendingNonce(`0x${"1".repeat(40)}`), 16);
    assert.equal(right.chainIdCalls(), 1);
  } finally {
    await right.close();
  }
});

test("an unreachable RPC is unchecked, so reads go on, and it is checked once it answers", async () => {
  resetRpcClients();
  const flakyState: ChainStub = { chainId: "0x1", down: true };
  const flaky = await chainServer(flakyState);
  const right = await chainServer({ chainId: "0x8f", down: false });
  try {
    const client = evmReadClient(143, [flaky.url, right.url]);
    assert.equal(await client.getBlockNumber({ cacheTime: 0 }), 16n);
    flakyState.down = false;
    await assert.rejects(client.getBlockNumber({ cacheTime: 0 }), chainMismatch(flaky.url));
  } finally {
    await Promise.all([flaky.close(), right.close()]);
  }
});
