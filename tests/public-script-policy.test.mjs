import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  TRUSTED_PUBLIC_SCRIPTS,
  auditPublicScript,
} from "../tools/lib/public-script-policy.mjs";

function codes(result) {
  return result.errors.map(({ code }) => code);
}

function assertDenied(source, relativePath, code) {
  const result = auditPublicScript({ source, relativePath });
  assert.ok(codes(result).includes(code), JSON.stringify(result, null, 2));
}

test("parses the three trusted public scripts with the required source type", async () => {
  assert.deepEqual(Object.keys(TRUSTED_PUBLIC_SCRIPTS).sort(), [
    "assets/router-controller.mjs",
    "assets/router-engine.mjs",
    "assets/site.js",
  ]);

  for (const [relativePath, sourceUrl] of Object.entries(TRUSTED_PUBLIC_SCRIPTS)) {
    const source = await readFile(sourceUrl, "utf8");
    const result = auditPublicScript({ source, relativePath });
    assert.deepEqual(result.errors, [], `${relativePath}: ${JSON.stringify(result.errors)}`);
  }
});

test("rejects storage capabilities represented as identifiers and exact string values", () => {
  const cases = [
    "localStorage.setItem('query', 'private');",
    "sessionStorage?.clear();",
    "indexedDB.open('router');",
    "globalThis['localStorage'].clear();",
    "const {['sessionStorage']: storage} = window;",
    "const root = self; root['indexedDB'].open('router');",
    "const key = 'localStorage'; globalThis[key].clear();",
    "const name = `sessionStorage`;",
    String.raw`window["local\123torage"].clear();`,
  ];

  for (const source of cases) {
    assertDenied(source, "assets/site.js", "SCRIPT_CAPABILITY_DENIED");
  }
});

test("allows storage spellings in comments and regular-expression literals", () => {
  const source = [
    "// localStorage is inert documentation.",
    "function* scan() {} /localStorage/.test('safe');",
    "class Matcher {} /sessionStorage/.test('safe');",
    "const ratio = 12 / 3 / 2;",
    "",
  ].join("\n");
  assert.deepEqual(auditPublicScript({ source, relativePath: "assets/site.js" }).errors, []);
});

test("uses script grammar for .js and module grammar for .mjs", () => {
  assertDenied(
    'import "./router-engine.mjs";',
    "assets/site.js",
    "SCRIPT_SYNTAX_ERROR",
  );
  assertDenied(
    'export { matchRoute } from "./router-engine.mjs";',
    "assets/site.js",
    "SCRIPT_SYNTAX_ERROR",
  );

  const result = auditPublicScript({
    source: [
      'import "./router-engine.mjs";',
      'export { matchRoute } from "./router-engine.mjs";',
      'export * from "/assets/router-engine.mjs?version=1#module";',
    ].join("\n"),
    relativePath: "assets/router-controller.mjs",
  });
  assert.deepEqual(result.errors, []);
  assert.deepEqual(result.imports, [
    "./router-engine.mjs",
    "./router-engine.mjs",
    "/assets/router-engine.mjs?version=1#module",
  ]);
});

test("rejects every dynamic import expression, including trailing commas and options", () => {
  for (const source of [
    'import("./router-engine.mjs");',
    'import("./router-engine.mjs",);',
    'import("./router-engine.mjs", { with: { type: "javascript" } });',
    'const target = "./router-engine.mjs"; import(target);',
  ]) {
    assertDenied(source, "assets/router-controller.mjs", "DYNAMIC_IMPORT_DENIED");
  }
});

test("rejects syntax errors distinctly", () => {
  assertDenied(
    "const broken = ;",
    "assets/router-controller.mjs",
    "SCRIPT_SYNTAX_ERROR",
  );
});

test("rejects code generation, cookie, network, and service-worker capabilities", () => {
  const cases = [
    "eval('1 + 1');",
    "Function('return 1')();",
    "new Function('return 1');",
    "document.cookie;",
    "fetch('/private');",
    "new XMLHttpRequest();",
    "new WebSocket('wss://example.test');",
    "new EventSource('/events');",
    "navigator.sendBeacon('/audit', 'x');",
    "navigator.serviceWorker.register('/worker.js');",
    "globalThis['fetch']('/private');",
    "window[`XMLHttpRequest`];",
  ];

  for (const source of cases) {
    assertDenied(source, "assets/site.js", "SCRIPT_CAPABILITY_DENIED");
  }
});
