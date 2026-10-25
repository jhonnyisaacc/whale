import { chmodSync, writeFileSync } from "node:fs";
import { createWalletMaterial, encryptWallet, keystoreContainsSecret } from "./keystore.js";

export type HiddenStream = {
  isRaw?: boolean;
  setRawMode(mode: boolean): void;
  resume(): void;
  pause(): void;
  on(event: "data", listener: (chunk: Buffer) => void): void;
  off(event: "data", listener: (chunk: Buffer) => void): void;
};

export async function readHiddenLine(stdin: HiddenStream, stdout: { write(chunk: string): void }): Promise<string> {
  stdout.write("Keystore passphrase: ");
  const previous = stdin.isRaw ?? false;
  stdin.setRawMode(true);
  stdin.resume();
  let line = "";
  await new Promise<void>((resolve, reject) => {
    const onData = (chunk: Buffer) => {
      for (const char of chunk.toString("utf8")) {
        if (char === "\n" || char === "\r") {
          stdin.setRawMode(previous);
          stdin.pause();
          stdin.off("data", onData);
          stdout.write("\n");
          resolve();
          return;
        }
        if (char === "\u0003") {
          stdin.setRawMode(previous);
          stdin.pause();
          stdin.off("data", onData);
          stdout.write("\n");
          reject(new Error("passphrase prompt cancelled"));
          return;
        }
        if (char === "\u007f" || char === "\b") {
          line = line.slice(0, -1);
          continue;
        }
        line += char;
      }
    };
    stdin.on("data", onData);
  });
  return line;
}

export function writeKeystoreFile(path: string, contents: string): void {
  writeFileSync(path, contents, { mode: 0o600, flag: "wx" });
  chmodSync(path, 0o600);
}

async function main(): Promise<void> {
  let passphrase = process.env.KEYSTORE_PASSPHRASE ?? "";
  if (!passphrase && process.stdin.isTTY) passphrase = await readHiddenLine(process.stdin, process.stdout);
  const outPath = process.env.KEYSTORE_PATH ?? "wallet.keystore.json";
  if (passphrase.length < 12) {
    console.error("Set KEYSTORE_PASSPHRASE to at least 12 characters. The key is not printed.");
    process.exit(2);
  }
  const material = createWalletMaterial();
  const file = encryptWallet(material, passphrase);
  if (keystoreContainsSecret(file, material)) {
    console.error("Refusing to write a keystore that contains a raw key.");
    process.exit(1);
  }
  try {
    writeKeystoreFile(outPath, `${JSON.stringify(file, null, 2)}\n`);
  } finally {
    material.evmPrivateKey.zero();
    material.solanaSecretKey.zero();
  }
  console.log(JSON.stringify({ path: outPath, evmAddress: file.addresses.evm, solanaAddress: file.addresses.solana }));
}

const entry = process.argv[1] ?? "";
if (entry.endsWith("create-wallet.js")) {
  main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : "create-wallet failed");
    process.exit(1);
  });
}
