import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import test from "node:test";

import {
  createRouterPayload,
  renderRouterPage,
  serializeScriptJson
} from "../tools/build-site.mjs";
import { loadV3AgentData } from "../tools/lib/v3-agent-data.mjs";
import { parseRouterPayload } from "../tools/site-assets/router-controller.mjs";

const ROOT_URL = new URL("..", import.meta.url);
const ROOT = fileURLToPath(ROOT_URL);
const buildView = await loadV3AgentData(ROOT);
const modelFile = new Map(
  [...buildView.modelsById.keys()].map((modelId, index) => [modelId, `verified-${String(index).padStart(4, "0")}.html`])
);
const page = renderRouterPage({ buildView, modelFile });

function matches(source, pattern) {
  return [...source.matchAll(pattern)];
}

test("importing the site builder exposes pure Router renderers without starting a build", () => {
  const stdout = execFileSync(process.execPath, [
    "--input-type=module",
    "--eval",
    `await import(${JSON.stringify(new URL("../tools/build-site.mjs", import.meta.url).href)})`
  ], { cwd: ROOT, encoding: "utf8" });

  assert.equal(stdout, "");
});

test("compact Router payload is controller-valid, complete, and below the 96 KiB boundary", () => {
  const payload = createRouterPayload(buildView);
  const serialized = serializeScriptJson(payload);

  assert.ok(Buffer.byteLength(JSON.stringify(payload), "utf8") <= 96 * 1024);
  assert.deepEqual(Object.keys(payload), [
    "schema_version",
    "problem_types",
    "agent_stages",
    "safety_signals",
    "route_keys"
  ]);
  assert.equal(payload.problem_types.length, 8);
  assert.equal(payload.agent_stages.length, 8);
  assert.equal(payload.safety_signals.length, 4);
  assert.equal(payload.route_keys.length, 23);
  assert.deepEqual(
    parseRouterPayload({ textContent: serialized }),
    payload
  );
});

test("serializeScriptJson neutralizes HTML script termination and JavaScript separators with lossless JSON round-trip", () => {
  const value = {
    lessThan: "<tag>",
    terminator: "</script><script>alert(1)</script>",
    separators: "line\u2028paragraph\u2029end"
  };
  const serialized = serializeScriptJson(value);

  assert.doesNotMatch(serialized, /</u);
  assert.doesNotMatch(serialized, /\u2028|\u2029/u);
  assert.match(serialized, /\\u003c/u);
  assert.match(serialized, /\\u2028/u);
  assert.match(serialized, /\\u2029/u);
  assert.deepEqual(JSON.parse(serialized), value);
});

test("Router page renders the exact controller DOM contract and the sole page module", () => {
  const moduleScripts = matches(page, /<script\b[^>]*type="module"[^>]*src="([^"]+)"[^>]*><\/script>/gu);
  const payloadScripts = matches(page, /<script\b[^>]*data-router-payload[^>]*>([\s\S]*?)<\/script>/gu);
  const shortcuts = matches(page, /<button\b[^>]*data-shortcut-intent="([^"]+)"/gu).map((match) => match[1]);
  const clarificationButtons = matches(page, /<button\b[^>]*data-clarify-option="([^"]+)"/gu).map((match) => match[1]);
  const safetyPanels = matches(page, /<article\b[^>]*data-safety-signal="([^"]+)"/gu).map((match) => match[1]);
  const routeKeys = matches(page, /<article\b[^>]*data-route-key="([^"]+)"/gu).map((match) => match[1]);
  const stateSurfaces = [
    "data-router-examples",
    "data-router-results",
    "data-router-clarify",
    "data-router-safety",
    "data-router-unavailable"
  ];

  assert.deepEqual(moduleScripts.map((match) => match[1]), ["assets/router-controller.mjs"]);
  assert.equal(payloadScripts.length, 1);
  const renderedPayload = parseRouterPayload({ textContent: payloadScripts[0][1] });
  assert.ok(renderedPayload);
  assert.deepEqual(shortcuts, buildView.problemTypes.map(({ id }) => id));
  assert.deepEqual(clarificationButtons, buildView.problemTypes.map(({ id }) => id));
  assert.deepEqual(safetyPanels, buildView.safetySignals.map(({ id }) => id));
  assert.deepEqual(routeKeys, [...buildView.routesByProblemAndStage.keys()]);
  assert.deepEqual(routeKeys, renderedPayload.route_keys);
  for (const attribute of stateSurfaces) {
    assert.equal(matches(page, new RegExp(`\\s${attribute}(?:\\s|>)`, "gu")).length, 1, attribute);
  }
  for (const attribute of ["data-router-payload", "data-router-form", "data-router-input", "data-router-live", "data-router-copy", "data-router-copy-text"]) {
    assert.equal(matches(page, new RegExp(`\\s${attribute}(?:\\s|>)`, "gu")).length, 1, attribute);
  }
});

test("all 23 prerendered routes expose only validated model URLs and at most one core Chain", () => {
  const routeArticles = matches(page, /<article\b[^>]*data-route-key="([^"]+)"[^>]*>([\s\S]*?)<\/article>/gu);
  const knownModelUrls = new Set([...modelFile.values()].map((file) => `models/${file}`));

  assert.equal(routeArticles.length, 23);
  for (const [, routeKey, html] of routeArticles) {
    assert.match(html, /问题理解/u, routeKey);
    assert.match(html, /为什么这样匹配/u, routeKey);
    const coreModels = matches(html, /<a\b[^>]*data-router-model-link="core"[^>]*href="([^"]+)"/gu).map((match) => match[1]);
    const auxiliaryModels = matches(html, /<a\b[^>]*data-router-model-link="auxiliary"[^>]*href="([^"]+)"/gu).map((match) => match[1]);
    assert.ok(coreModels.length <= 4, routeKey);
    assert.ok(auxiliaryModels.length <= 2, routeKey);
    for (const url of [...coreModels, ...auxiliaryModels]) assert.ok(knownModelUrls.has(url), `${routeKey}: ${url}`);
    assert.ok(matches(html, /\bdata-router-chain\b/gu).length <= 1, routeKey);
  }
});

test("Router page keeps user input out of executable, persistent, and remote surfaces", () => {
  assert.doesNotMatch(page, /\son[a-z]+\s*=/iu);
  assert.doesNotMatch(page, /\bdata-keywords\b/u);
  assert.doesNotMatch(page, /\b(?:fetch|XMLHttpRequest|WebSocket|localStorage|sessionStorage|document\.cookie)\b/u);
  assert.doesNotMatch(page, /<(?:script|img|source)\b[^>]*(?:src|srcset)="https?:\/\//iu);
  assert.doesNotMatch(page, /<link\b[^>]*rel="stylesheet"[^>]*href="https?:\/\//iu);
});
