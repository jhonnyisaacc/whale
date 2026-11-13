import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import test from "node:test";
import { cargoLockSourceProblems, cargoManifestSourceProblems } from "./cargo-sources.js";

function path(relative: string): URL {
  return new URL(`../../${relative}`, import.meta.url);
}

function read(relative: string): string {
  return readFileSync(path(relative), "utf8");
}

function setting(yaml: string, key: string): string | null {
  const match = yaml.match(new RegExp(`^${key}: *([^#\\n]+?) *(#.*)?$`, "m"));
  return match ? match[1] : null;
}

function listSetting(yaml: string, key: string): string[] {
  const block = yaml.match(new RegExp(`^${key}:\\n((?: +- .*\\n?)*)`, "m"));
  if (!block) return [];
  return block[1]
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.startsWith("- "))
    .map((line) => line.slice(2).replace(/\s+#.*$/, ""));
}

function workspacePackages(): string[] {
  return listSetting(read("pnpm-workspace.yaml"), "packages");
}

function registryImages(yaml: string): string[] {
  const lines = yaml.split("\n");
  const indent = (line: string) => line.length - line.trimStart().length;
  return lines.filter((line, index) => {
    if (!/^\s*image:/.test(line)) return false;
    let depth = indent(line);
    for (let above = index - 1; above >= 0; above -= 1) {
      const candidate = lines[above];
      if (candidate.trim() === "" || indent(candidate) >= depth) continue;
      depth = indent(candidate);
      if (/^\s*(services|container):/.test(candidate)) return true;
    }
    return false;
  });
}

function workflows(): { name: string; text: string }[] {
  return readdirSync(path(".github/workflows"))
    .filter((name) => name.endsWith(".yml"))
    .map((name) => ({ name, text: read(`.github/workflows/${name}`) }));
}

test("installs wait a week, keep publisher trust, and run no dependency build scripts", () => {
  const workspace = read("pnpm-workspace.yaml");
  assert.ok(Number(setting(workspace, "minimumReleaseAge")) >= 10080, "minimumReleaseAge is at least one week");
  assert.equal(setting(workspace, "minimumReleaseAgeStrict"), "true");
  assert.equal(setting(workspace, "minimumReleaseAgeIgnoreMissingTime"), "false");
  assert.equal(setting(workspace, "trustPolicy"), "no-downgrade");
  assert.equal(setting(workspace, "blockExoticSubdeps"), "true");
  assert.equal(setting(workspace, "strictDepBuilds"), "true");
  assert.equal(setting(workspace, "engineStrict"), "true");
  for (const key of ["minimumReleaseAgeExclude", "allowBuilds", "dangerouslyAllowAllBuilds", "ignoreScripts", "trustLockfile"]) {
    assert.equal(new RegExp(`^${key}:`, "m").test(workspace), false, `${key} weakens the install policy`);
  }
  assert.deepEqual(listSetting(workspace, "trustPolicyExclude"), ["undici-types@6.21.0"], "a new trust exception needs review here");
});

test("every package.json pins every dependency, the root pins the package manager, and none runs a lifecycle script", () => {
  const manifests = ["package.json", ...workspacePackages().map((dir) => `${dir}/package.json`)];
  assert.ok(manifests.includes("web/package.json"), "the web workspace is checked");
  for (const manifest of manifests) {
    const pkg = JSON.parse(read(manifest)) as { scripts?: Record<string, string>; dependencies?: Record<string, string>; devDependencies?: Record<string, string> };
    for (const [name, version] of Object.entries({ ...pkg.dependencies, ...pkg.devDependencies })) {
      assert.match(version, /^\d+\.\d+\.\d+$/, `${manifest}: ${name} is pinned to an exact version`);
    }
    for (const hook of ["preinstall", "install", "postinstall", "prepare", "prepack", "postpack", "prepublish", "prepublishOnly"]) {
      assert.equal(hook in (pkg.scripts ?? {}), false, `${manifest}: ${hook} runs on install or publish`);
    }
  }
  const root = JSON.parse(read("package.json")) as { packageManager?: string };
  assert.match(root.packageManager ?? "", /^pnpm@\d+\.\d+\.\d+\+sha512\.[0-9a-f]{128}$/);
  for (const lockfile of ["package-lock.json", "npm-shrinkwrap.json", "yarn.lock", "bun.lock", "bun.lockb"]) {
    assert.equal(existsSync(path(lockfile)), false, `${lockfile} would bypass the pnpm policy`);
  }
});

test("the Rust signer pins every crate exactly and commits its lockfile", () => {
  const manifest = read("signer/Cargo.toml");
  const tables = manifest.split(/^\[/m).slice(1).map((table) => {
    const [header = "", ...body] = table.split("\n");
    return { name: header.replace(/\]\s*$/, "").trim(), body: body.filter((line) => /^[a-z0-9_-]+\s*=/.test(line)) };
  });
  const lists = tables.filter((table) => /(^|\.)((dev|build)-)?dependencies$/.test(table.name));
  const single = tables.filter((table) => /(^|\.)((dev|build)-)?dependencies\.[^.]+$/.test(table.name));
  assert.ok(lists.some((table) => table.name === "dependencies" && table.body.length > 0));
  for (const line of lists.flatMap((table) => table.body)) assert.match(line, /"=\d+\.\d+\.\d+"/, line);
  for (const table of single) assert.ok(table.body.some((line) => /^version\s*=\s*"=\d+\.\d+\.\d+"/.test(line)), table.name);
  assert.match(manifest, /^\[profile\.release\]\noverflow-checks = true$/m, "release builds refuse integer overflow");
  assert.equal(existsSync(path("signer/Cargo.lock")), true, "Cargo.lock is committed");
  assert.match(read("signer/rust-toolchain.toml"), /channel = "\d+\.\d+\.\d+"/);
});

test("the Rust signer takes every crate from crates.io", () => {
  assert.deepEqual(cargoManifestSourceProblems(read("signer/Cargo.toml")), []);
  assert.deepEqual(cargoLockSourceProblems(read("signer/Cargo.lock"), "whale-signer"), []);
});

test("the Cargo source check refuses git, path, registry, patch, and replace in every table form", () => {
  const pinned = '[package]\nname = "x"\n\n[dependencies]\nhex = "=0.4.3"\nk256 = { version = "=0.14.0", features = ["ecdsa", "std"] }\n';
  assert.deepEqual(cargoManifestSourceProblems(pinned), []);
  const bad = [
    '[dependencies]\nfoo = { git = "https://example.com/foo", version = "=1.0.0" }\n',
    '[dev-dependencies]\nfoo = { version = "=1.0.0", path = "../foo" }\n',
    '[build-dependencies]\nfoo = { version = "=1.0.0", registry = "corp" }\n',
    '[dependencies.foo]\nversion = "=1.0.0"\ngit = "https://example.com/foo"\n',
    '[dependencies]\nfoo.version = "=1.0.0"\nfoo.path = "../foo"\n',
    "[target.'cfg(unix)'.dependencies]\nfoo = { version = \"=1.0.0\", git = \"https://example.com/foo\" }\n",
    '[target."cfg(target_os = \\"linux\\")".dependencies.foo]\nversion = "=1.0.0"\nregistry-index = "https://example.com/index"\n',
    '[workspace.dependencies]\nfoo = { version = "=1.0.0", path = "foo" }\n',
    '[patch.crates-io]\nsha2 = { version = "=0.11.1" }\n',
    '[patch."https://github.com/example/repo"]\n',
    '[replace]\n"sha2:0.11.1" = { version = "=0.11.1" }\n',
    '[dependencies]\nfoo = { version = "=1.0.0", "\\u0067it" = "https://example.com/foo" }\n',
    '[dependencies]\nfoo = { version = "=1.0.0", "p\\U00000061th" = "../foo" }\n',
    '["dep\\u0065ndencies"]\nfoo = { version = "=1.0.0", git = "https://example.com/foo" }\n',
    '["p\\u0061tch".crates-io]\nsha2 = { path = "../sha2" }\n',
    '[dev_dependencies]\nfoo = { version = "=1.0.0", path = "../foo" }\n',
    '[build_dependencies]\nfoo = { version = "=1.0.0", git = "https://example.com/foo" }\n',
  ];
  for (const manifest of bad) assert.notDeepEqual(cargoManifestSourceProblems(pinned + manifest), [], manifest);
  const lock = (source: string) => `version = 4\n\n[[package]]\nname = "foo"\nversion = "1.0.0"\n${source}\n[[package]]\nname = "whale-signer"\nversion = "0.1.0"\n`;
  assert.deepEqual(cargoLockSourceProblems(lock('source = "registry+https://github.com/rust-lang/crates.io-index"\n'), "whale-signer"), []);
  for (const source of ['source = "git+https://example.com/foo#abc"\n', 'source = "registry+https://example.com/index"\n', 'source = "sparse+https://example.com/index/"\n', ""]) {
    assert.notDeepEqual(cargoLockSourceProblems(lock(source), "whale-signer"), [], source || "no source");
  }
  const root = '[[package]]\nname = "whale-signer"\nversion = "0.1.0"\n';
  const evil = 'name = "evil"\nversion = "1.0.0"\nsource = "git+https://example.com/evil#abc"\n';
  const hidden = [
    `version = 4\n\n[[package]] \n${evil}\n${root}`,
    `version = 4\n\n[[package]] # x\n${evil}\n${root}`,
    `version = 4\n\n[[ package ]]\nname = "evil"\nversion = "1.0.0"\n\n${root}`,
    `version = 4\n\n[[package]]\r\n${evil.replace(/\n/g, "\r\n")}\r\n${root}`,
    'version = 4\npackage = [\n { name = "whale-signer", version = "0.1.0" },\n { name = "evil", version = "1.0.0", source = "git+https://example.com/evil#abc" },\n]\n',
    `version = 4\n\n${root}\n[[package]]\nname = "whale-signer"\nversion = "9.0.0"\nsource = 'git+https://example.com/evil#abc'\n`,
    `version = 4\n\n[[package]]\nversion = "1.0.0"\nsource = "registry+https://github.com/rust-lang/crates.io-index"\nname = "evil"\nsource2 = "git+https://example.com/evil#abc"\n\n${root}`,
    `version = 4\n\n[[package]]\nname="evil"\nversion="1.0.0"\nsource="git+https://example.com/evil#abc"\n\n${root}`,
  ];
  for (const lockfile of hidden) assert.notDeepEqual(cargoLockSourceProblems(lockfile, "whale-signer"), [], lockfile);
});

test("workflows pin every action and service image, and install only from the lockfile", () => {
  const found = workflows();
  assert.ok(found.length > 0);
  assert.deepEqual(registryImages("jobs:\n  a:\n    container:\n      image: x:1\n    steps:\n      - with:\n          image: local:scan\n"), ["      image: x:1"]);
  assert.ok(found.some(({ text }) => registryImages(text).length > 0), "the Postgres service image is checked");
  for (const { name, text } of found) {
    assert.match(text, /^permissions:/m, `${name} sets top-level permissions`);
    for (const line of text.split("\n").filter((entry) => /^\s*(- )?uses:/.test(entry))) {
      assert.match(line, /uses: [\w.-]+\/[\w./-]+@[0-9a-f]{40} # v\d/, `${name}: ${line.trim()}`);
    }
    for (const line of text.split("\n").filter((entry) => entry.includes("pnpm install"))) {
      assert.match(line, /--frozen-lockfile/, `${name}: ${line.trim()}`);
    }
    for (const line of registryImages(text)) {
      assert.match(line, /image: [\w./-]+:[\w.-]+@sha256:[0-9a-f]{64}$/, `${name}: ${line.trim()}`);
    }
    const checkouts = text.match(/uses: actions\/checkout@/g)?.length ?? 0;
    const sealed = text.match(/persist-credentials: false/g)?.length ?? 0;
    assert.equal(sealed, checkouts, `${name} keeps the token out of the checkout`);
  }
});

test("dependabot waits at least as long as pnpm before proposing a release", () => {
  const config = read(".github/dependabot.yml");
  const ecosystems = config.match(/package-ecosystem:/g)?.length ?? 0;
  const days = [...config.matchAll(/default-days: (\d+)/g)].map((match) => Number(match[1]));
  assert.ok(ecosystems > 0);
  assert.equal(days.length, ecosystems, "every ecosystem has a cooldown");
  for (const value of days) assert.ok(value >= 7, "cooldown is at least seven days");
});

test("dependabot never proposes a major npm update, so a person starts each one", () => {
  const config = read(".github/dependabot.yml");
  const npm = config.split(/\n  - package-ecosystem: /).find((block) => block.includes("package-ecosystem: npm") || block.startsWith("npm"));
  assert.ok(npm, "an npm ecosystem is configured");
  assert.match(npm, /ignore:\n\s+- dependency-name: "\*"\n\s+update-types:\n\s+- version-update:semver-major$/m);
});
