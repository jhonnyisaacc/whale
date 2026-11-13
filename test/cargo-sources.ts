const DEPENDENCY_TABLES = new Set(["dependencies", "dev-dependencies", "build-dependencies", "dev_dependencies", "build_dependencies"]);
const SOURCE_KEYS = new Set(["git", "path", "registry", "registry-index"]);
const CRATES_IO = "registry+https://github.com/rust-lang/crates.io-index";

const ESCAPES: Record<string, string> = { b: "\b", t: "\t", n: "\n", f: "\f", r: "\r", '"': '"', "\\": "\\" };

function decodeBasic(basic: string): string {
  return basic.replace(/\\(?:u([0-9a-fA-F]{4})|U([0-9a-fA-F]{8})|[ \t]*\r?\n\s*|(.?))/g, (escape, short?: string, long?: string, char?: string) => {
    if (short || long) return String.fromCodePoint(parseInt(short ?? long ?? "", 16));
    if (char === undefined) return "";
    const decoded = ESCAPES[char];
    if (decoded === undefined) throw new Error(`invalid TOML escape ${escape}`);
    return decoded;
  });
}

function tomlKeyPaths(text: string): string[][] {
  const paths: string[][] = [];
  let at = 0;
  const skipBlank = (newlines: boolean) => {
    for (;;) {
      const char = text[at];
      if (char === " " || char === "\t" || (newlines && (char === "\n" || char === "\r"))) at += 1;
      else if (newlines && char === "#") while (at < text.length && text[at] !== "\n") at += 1;
      else return;
    }
  };
  const string = (): string => {
    const quote = text[at];
    const fence = text.startsWith(quote.repeat(3), at) ? quote.repeat(3) : quote;
    let end = at + fence.length;
    while (end < text.length && !text.startsWith(fence, end)) end += quote === '"' && text[end] === "\\" ? 2 : 1;
    const value = text.slice(at + fence.length, end);
    at = end + fence.length;
    return quote === "'" ? value : decodeBasic(value);
  };
  const key = (): string[] => {
    const parts: string[] = [];
    for (;;) {
      skipBlank(false);
      if (text[at] === '"' || text[at] === "'") parts.push(string());
      else {
        const bare = /^[A-Za-z0-9_-]+/.exec(text.slice(at))?.[0] ?? "";
        if (!bare) throw new Error(`unparsed TOML at offset ${at}`);
        parts.push(bare);
        at += bare.length;
      }
      skipBlank(false);
      if (text[at] !== ".") return parts;
      at += 1;
    }
  };
  const equals = () => {
    if (text[at] !== "=") throw new Error(`expected = at offset ${at}`);
    at += 1;
  };
  const value = (prefix: string[]) => {
    skipBlank(false);
    const char = text[at];
    if (char === '"' || char === "'") return void string();
    if (char === "[" || char === "{") {
      const close = char === "[" ? "]" : "}";
      at += 1;
      for (;;) {
        skipBlank(true);
        if (at >= text.length) throw new Error(`unclosed ${char} in TOML`);
        if (text[at] === close) return void (at += 1);
        if (text[at] === ",") at += 1;
        else if (char === "[") value(prefix);
        else {
          const path = [...prefix, ...key()];
          paths.push(path);
          equals();
          value(path);
        }
      }
    }
    while (at < text.length && !/[,\]}\s#]/.test(text[at])) at += 1;
  };
  let table: string[] = [];
  for (;;) {
    skipBlank(true);
    if (at >= text.length) return paths;
    if (text[at] === "[") {
      const brackets = text[at + 1] === "[" ? 2 : 1;
      at += brackets;
      table = key();
      at += brackets;
      paths.push(table);
    } else {
      const path = [...table, ...key()];
      paths.push(path);
      equals();
      value(path);
    }
  }
}

export function cargoManifestSourceProblems(manifest: string): string[] {
  const problems = new Set<string>();
  for (const path of tomlKeyPaths(manifest)) {
    if (path[0] === "patch" || path[0] === "replace") problems.add(`[${path[0]}] redirects a crate away from crates.io`);
    path.forEach((part, index) => {
      if (DEPENDENCY_TABLES.has(part) && path.length === index + 3 && SOURCE_KEYS.has(path[index + 2])) {
        problems.add(`${path.join(".")} pulls a crate from outside crates.io`);
      }
    });
  }
  return [...problems];
}

export function cargoLockSourceProblems(lock: string, rootPackage: string): string[] {
  return lock.split(/^\[\[package\]\]$/m).slice(1).flatMap((block) => {
    const name = /^name = "([^"]+)"$/m.exec(block)?.[1] ?? "?";
    const source = /^source = "([^"]*)"$/m.exec(block)?.[1];
    if (source === undefined) return name === rootPackage ? [] : [`${name} has no source, so it is a path or workspace crate`];
    return source === CRATES_IO ? [] : [`${name} comes from ${source}`];
  });
}
