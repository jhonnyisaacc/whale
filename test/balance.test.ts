import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import test from "node:test";
import { Keypair } from "@solana/web3.js";
import bs58 from "bs58";
import { commandDeps } from "../src/command-callers.js";
import { run, type WalletCommand } from "../src/commands.js";
import { loadSigner } from "../src/signer.js";

const TOKEN = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";
const TOKEN_2022 = "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb";
const USDC = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
const PYUSD = "2b1kV6DkPAnxd5ixfnxCpjxmKwqjjaYmCZfHsFu24GXo";

type Account = { mint: string; amount: string; decimals: number };

function tokenAccount(owner: string, program: string, account: Account) {
  const ui = Number(account.amount) / 10 ** account.decimals;
  return {
    pubkey: Keypair.generate().publicKey.toBase58(),
    account: {
      data: {
        program: program === TOKEN ? "spl-token" : "spl-token-2022",
        parsed: { type: "account", info: { mint: account.mint, owner, state: "initialized", isNative: false, tokenAmount: { amount: account.amount, decimals: account.decimals, uiAmount: ui, uiAmountString: String(ui) } } },
        space: 165,
      },
      executable: false,
      lamports: 2039280,
      owner: program,
      rentEpoch: 0,
      space: 165,
    },
  };
}

async function solanaRpc(owner: string, lamports: number, accounts: Record<string, Account[]>, failing: string | null = null) {
  const server: Server = createServer((request, response) => {
    let body = "";
    request.on("data", (chunk: Buffer) => (body += chunk.toString()));
    request.on("end", () => {
      const call = JSON.parse(body) as { id: number; method: string; params: [string, { programId?: string }?] };
      const [address, filter] = call.params;
      const reply = (payload: object) => {
        response.writeHead(200, { "content-type": "application/json" });
        response.end(JSON.stringify({ jsonrpc: "2.0", id: call.id, ...payload }));
      };
      const program = filter?.programId ?? "";
      if (program === failing) return reply({ error: { code: -32005, message: "limit" } });
      const value =
        call.method === "getBalance"
          ? address === owner ? lamports : 0
          : address === owner ? (accounts[program] ?? []).map((account) => tokenAccount(owner, program, account)) : [];
      reply({ result: { context: { slot: 1 }, value } });
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as { port: number };
  return {
    url: `http://127.0.0.1:${port}`,
    close: () => new Promise<void>((resolve) => {
      server.closeAllConnections();
      server.close(() => resolve());
    }),
  };
}

function importedSolanaAddress(): string {
  const signer = loadSigner({ SOLANA_SECRET_KEY: bs58.encode(Keypair.generate().secretKey) });
  assert.ok(signer?.solanaAddress, "the imported key loads a Solana address");
  return signer.solanaAddress;
}

test("a balance with no reader fails instead of reporting an empty list", async () => {
  await assert.rejects(run({ kind: "balance", chainKey: "solana", address: USDC }), { message: "no balance reader configured for solana" });
  await assert.rejects(run({ kind: "balance", chainKey: "base", address: "0x1111111111111111111111111111111111111111" }, {}), { message: "no balance reader configured for base" });
});

test("an imported Solana key reports its SOL and its SPL tokens from both token programs", async () => {
  const owner = importedSolanaAddress();
  const rpc = await solanaRpc(owner, 2_500_000_000, {
    [TOKEN]: [
      { mint: USDC, amount: "1234567", decimals: 6 },
      { mint: USDC, amount: "1000000", decimals: 6 },
    ],
    [TOKEN_2022]: [{ mint: PYUSD, amount: "5000000000", decimals: 9 }],
  });
  try {
    const command: WalletCommand = { kind: "balance", chainKey: "solana", address: owner };
    const result = await run(command, commandDeps({ SOLANA_RPC_URL: rpc.url }, command));
    assert.deepEqual(result, {
      kind: "balance",
      holdings: [
        { symbol: "SOL", address: owner, amount: 2.5, usd: 0, native: true, decimals: 9, chainKey: "solana" },
        { symbol: USDC, address: owner, amount: 2.234567, usd: 0, native: false, decimals: 6, chainKey: "solana" },
        { symbol: PYUSD, address: owner, amount: 5, usd: 0, native: false, decimals: 9, chainKey: "solana" },
      ],
    });
  } finally {
    await rpc.close();
  }
});

test("a Solana balance whose token read fails reports a reason, not SOL alone", async () => {
  const owner = importedSolanaAddress();
  const rpc = await solanaRpc(owner, 2_500_000_000, { [TOKEN]: [{ mint: USDC, amount: "1234567", decimals: 6 }] }, TOKEN_2022);
  try {
    const command: WalletCommand = { kind: "balance", chainKey: "solana", address: owner };
    const result = await run(command, commandDeps({ SOLANA_RPC_URL: rpc.url }, command));
    assert.deepEqual(result, { kind: "balance", holdings: [], reason: "the solana RPC did not return a balance" });
  } finally {
    await rpc.close();
  }
});
