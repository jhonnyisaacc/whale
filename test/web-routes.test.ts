import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("../../", import.meta.url));

function sources(dir: string, pattern: RegExp): string[] {
  return readdirSync(dir, { recursive: true, encoding: "utf8" })
    .filter((name) => pattern.test(name))
    .map((name) => readFileSync(path.join(dir, name), "utf8"));
}

const shape = (method: string, route: string) => `${method} ${route.replace(/\$\{[^}]+\}|:[A-Za-z]+/g, ":param")}`;

function gatewayRoutes(): Set<string> {
  const routes = new Set<string>();
  for (const source of sources(path.join(ROOT, "src", "gateway"), /\.ts$/)) {
    for (const match of source.matchAll(/app\.(get|post|put|delete|patch)\("([^"]+)"/g)) routes.add(shape(match[1]!.toUpperCase(), match[2]!));
  }
  return routes;
}

function webCalls(): string[] {
  const calls: string[] = [];
  for (const source of sources(path.join(ROOT, "web", "src"), /\.tsx?$/)) {
    for (const match of source.matchAll(/\bapi(?:<[^(]*?>)?\((["`])([^"`]+)\1(?:,\s*\{\s*method:\s*"(\w+)")?/g)) {
      calls.push(shape(match[3] ?? "GET", match[2]!.split("?")[0]!));
    }
  }
  return calls;
}

test("every dashboard call with a literal path hits a route the gateway registers", () => {
  const routes = gatewayRoutes();
  const calls = webCalls();
  assert.ok(calls.length >= 20, `found ${calls.length} dashboard calls`);
  assert.deepEqual(calls.filter((call) => !routes.has(call)), []);
});
