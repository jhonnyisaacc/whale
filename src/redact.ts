const HEX_KEY = /\b(?:0x)?[0-9a-fA-F]{64}\b/g;
const BASE58_SECRET = /\b[1-9A-HJ-NP-Za-km-z]{64,128}\b/g;
const CREDENTIAL_URL = /\b(?:postgres(?:ql)?|https?):\/\/[^:\s]+:[^@\s]+@\S+/gi;

const tracked: Secret[] = [];

export class Secret {
  private value: Buffer;

  constructor(value: string) {
    this.value = Buffer.from(value, "utf8");
  }

  reveal(): string {
    return this.value.toString("utf8");
  }

  zero(): void {
    this.value.fill(0);
    this.value = Buffer.alloc(0);
  }

  toString(): string {
    return "[redacted]";
  }

  toJSON(): string {
    return "[redacted]";
  }

  [Symbol.for("nodejs.util.inspect.custom")](): string {
    return "[redacted]";
  }
}

export function trackSecret(secret: Secret): Secret {
  tracked.push(secret);
  return secret;
}

export function zeroLoadedSecrets(): void {
  for (const secret of tracked) secret.zero();
  tracked.length = 0;
}

export function redactText(input: string, secrets: readonly string[] = []): string {
  let text = input;
  for (const secret of secrets) {
    if (secret.length >= 8) text = text.split(secret).join("[redacted]");
  }
  return text.replace(CREDENTIAL_URL, "[redacted]").replace(HEX_KEY, "[redacted]").replace(BASE58_SECRET, "[redacted]");
}

export function redactError(error: unknown, secrets: readonly string[] = []): string {
  const message = error instanceof Error ? error.message : String(error);
  return redactText(message, secrets);
}
