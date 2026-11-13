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

type TomlEntry = { kind: "table" | "array-table" | "key"; path: string[]; value?: string };

const LOCK_PACKAGE_KEYS = new Set(["name", "version", "source", "checksum", "dependencies"]);

function tomlEntries(text: string): TomlEntry[] {
  const entries: TomlEntry[] = [];
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
  const value = (prefix: string[]): string | undefined => {
    skipBlank(false);
    const char = text[at];
    if (char === '"' || char === "'") return string();
    if (char === "[" || char === "{") {
      const close = char === "[" ? "]" : "}";
      at += 1;
      for (;;) {
        skipBlank(true);
        if (at >= text.length) throw new Error(`unclosed ${char} in TOML`);
        if (text[at] === close) {
          at += 1;
          return undefined;
        }
        if (text[at] === ",") at += 1;
        else if (char === "[") value(prefix);
        else assign(prefix);
      }
    }
    while (at < text.length && !/[,\]}\s#]/.test(text[at])) at += 1;
    return undefined;
  };
  const assign = (prefix: string[]) => {
    const path = [...prefix, ...key()];
    equals();
    entries.push({ kind: "key", path, value: value(path) });
  };
  let table: string[] = [];
  for (;;) {
    skipBlank(true);
    if (at >= text.length) return entries;
    if (text[at] === "[") {
      const brackets = text[at + 1] === "[" ? 2 : 1;
      at += brackets;
      table = key();
      if (!text.startsWith("]".repeat(brackets), at)) throw new Error(`unclosed table header at offset ${at}`);
      at += brackets;
      entries.push({ kind: brackets === 2 ? "array-table" : "table", path: table });
    } else assign(table);
  }
}

export function cargoManifestSourceProblems(manifest: string): string[] {
  const problems = new Set<string>();
  for (const { path } of tomlEntries(manifest)) {
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
  const problems = new Set<string>();
  const packages: { name?: string; source?: string }[] = [];
  let scope: "top" | "package" | "other" = "top";
  for (const entry of tomlEntries(lock)) {
    const at = entry.path.join(".");
    if (entry.kind !== "key") {
      scope = entry.kind === "array-table" && at === "package" ? "package" : "other";
      if (scope === "package") packages.push({});
      else problems.add(`[${at}] is not a Cargo.lock package table`);
    } else if (scope === "top" && at !== "version") problems.add(`${at} is not a Cargo.lock top-level key`);
    else if (scope === "package") {
      const field = entry.path[1];
      if (entry.path.length !== 2 || !LOCK_PACKAGE_KEYS.has(field)) problems.add(`package.${entry.path.slice(1).join(".")} is not a Cargo.lock package key`);
      else if (field === "name" || field === "source") packages[packages.length - 1][field] = entry.value ?? "a non-string value";
    }
  }
  const roots = packages.filter((pkg) => pkg.name === rootPackage);
  if (roots.length !== 1) problems.add(`Cargo.lock has ${roots.length} ${rootPackage} packages instead of one`);
  for (const { name = "?", source } of packages) {
    if (name === rootPackage) {
      if (source !== undefined) problems.add(`${name} comes from ${source}, but the root package has no source`);
    } else if (source === undefined) problems.add(`${name} has no source, so it is a path or workspace crate`);
    else if (source !== CRATES_IO) problems.add(`${name} comes from ${source}`);
  }
  return [...problems];
}
