import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import test from "node:test";

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

test("package.json pins every dependency and the package manager, and runs no lifecycle script", () => {
  const pkg = JSON.parse(read("package.json")) as {
    packageManager?: string;
    scripts: Record<string, string>;
    dependencies: Record<string, string>;
    devDependencies: Record<string, string>;
  };
  for (const [name, version] of Object.entries({ ...pkg.dependencies, ...pkg.devDependencies })) {
    assert.match(version, /^\d+\.\d+\.\d+$/, `${name} is pinned to an exact version`);
  }
  assert.match(pkg.packageManager ?? "", /^pnpm@\d+\.\d+\.\d+\+sha512\.[0-9a-f]{128}$/);
  for (const hook of ["preinstall", "install", "postinstall", "prepare", "prepack", "postpack", "prepublish", "prepublishOnly"]) {
    assert.equal(hook in pkg.scripts, false, `${hook} runs on install or publish`);
  }
  for (const lockfile of ["package-lock.json", "npm-shrinkwrap.json", "yarn.lock", "bun.lock", "bun.lockb"]) {
    assert.equal(existsSync(path(lockfile)), false, `${lockfile} would bypass the pnpm policy`);
  }
});

test("workflows pin every action to a commit and install only from the lockfile", () => {
  const found = workflows();
  assert.ok(found.length > 0);
  for (const { name, text } of found) {
    assert.match(text, /^permissions:/m, `${name} sets top-level permissions`);
    for (const line of text.split("\n").filter((entry) => /^\s*(- )?uses:/.test(entry))) {
      assert.match(line, /uses: [\w.-]+\/[\w./-]+@[0-9a-f]{40} # v\d/, `${name}: ${line.trim()}`);
    }
    for (const line of text.split("\n").filter((entry) => entry.includes("pnpm install"))) {
      assert.match(line, /--frozen-lockfile/, `${name}: ${line.trim()}`);
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
