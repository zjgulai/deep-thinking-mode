/**
 * tests/pages-workflow.test.mjs
 *
 * Tests for tools/lib/pages-workflow.mjs
 * Covers: validatePins, renderPagesWorkflow, full-file workflow snapshot.
 */

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  loadPins,
  validatePins,
  renderPagesWorkflow,
  getCanonicalWorkflowBytes,
} from "../tools/lib/pages-workflow.mjs";

const FULL_SHA_RE = /^[0-9a-f]{40}$/;

// ─── validatePins ─────────────────────────────────────────────────────────────
await test("validatePins — accepts correct pins", async () => {
  const pins = await loadPins(".");
  assert.doesNotThrow(() => validatePins(pins));
});

await test("validatePins — rejects missing action", () => {
  const pins = {
    "actions/checkout": { tag: "v6", sha: "a".repeat(40) },
    "actions/setup-node": { tag: "v6", sha: "b".repeat(40) },
    "actions/configure-pages": { tag: "v5", sha: "c".repeat(40) },
    "actions/upload-pages-artifact": { tag: "v4", sha: "d".repeat(40) },
    // missing deploy-pages
  };
  assert.throws(() => validatePins(pins), /Missing pin/);
});

await test("validatePins — rejects non-lowercase SHA", () => {
  const pins = {
    "actions/checkout": { tag: "v6", sha: "A".repeat(40) },
    "actions/setup-node": { tag: "v6", sha: "b".repeat(40) },
    "actions/configure-pages": { tag: "v5", sha: "c".repeat(40) },
    "actions/upload-pages-artifact": { tag: "v4", sha: "d".repeat(40) },
    "actions/deploy-pages": { tag: "v4", sha: "e".repeat(40) },
  };
  assert.throws(() => validatePins(pins), /Invalid SHA/);
});

await test("validatePins — rejects abbreviated SHA", () => {
  const pins = {
    "actions/checkout": { tag: "v6", sha: "abc123" },
    "actions/setup-node": { tag: "v6", sha: "b".repeat(40) },
    "actions/configure-pages": { tag: "v5", sha: "c".repeat(40) },
    "actions/upload-pages-artifact": { tag: "v4", sha: "d".repeat(40) },
    "actions/deploy-pages": { tag: "v4", sha: "e".repeat(40) },
  };
  assert.throws(() => validatePins(pins), /Invalid SHA/);
});

await test("validatePins — rejects extra action", () => {
  const pins = {
    "actions/checkout": { tag: "v6", sha: "a".repeat(40) },
    "actions/setup-node": { tag: "v6", sha: "b".repeat(40) },
    "actions/configure-pages": { tag: "v5", sha: "c".repeat(40) },
    "actions/upload-pages-artifact": { tag: "v4", sha: "d".repeat(40) },
    "actions/deploy-pages": { tag: "v4", sha: "e".repeat(40) },
    "actions/extra": { tag: "v1", sha: "f".repeat(40) },
  };
  assert.throws(() => validatePins(pins), /Unexpected actions/);
});

await test("validatePins — rejects duplicate SHAs", () => {
  const sha = "a".repeat(40);
  const pins = {
    "actions/checkout": { tag: "v6", sha },
    "actions/setup-node": { tag: "v6", sha },
    "actions/configure-pages": { tag: "v5", sha: "c".repeat(40) },
    "actions/upload-pages-artifact": { tag: "v4", sha: "d".repeat(40) },
    "actions/deploy-pages": { tag: "v4", sha: "e".repeat(40) },
  };
  assert.throws(() => validatePins(pins), /Duplicate SHAs/);
});

// ─── renderPagesWorkflow ──────────────────────────────────────────────────────
await test("renderPagesWorkflow — output contains all pinned SHAs", async () => {
  const pins = await loadPins(".");
  const yaml = renderPagesWorkflow(pins);
  for (const [action, { sha }] of Object.entries(pins)) {
    assert.ok(yaml.includes(sha), `Missing SHA for ${action}`);
  }
});

await test("renderPagesWorkflow — push includes main and public branches", async () => {
  const pins = await loadPins(".");
  const yaml = renderPagesWorkflow(pins);
  assert.ok(yaml.includes("branches: [main, public]"), "Missing branches: [main, public]");
});

await test("renderPagesWorkflow — has workflow_dispatch", async () => {
  const pins = await loadPins(".");
  const yaml = renderPagesWorkflow(pins);
  assert.ok(yaml.includes("workflow_dispatch"), "Missing workflow_dispatch");
});

await test("renderPagesWorkflow — top-level permissions is contents: read only", async () => {
  const pins = await loadPins(".");
  const yaml = renderPagesWorkflow(pins);
  assert.ok(yaml.includes("permissions:"), "Missing permissions");
  assert.ok(yaml.includes("contents: read"), "Missing contents: read");
});

await test("renderPagesWorkflow — concurrency group is pages", async () => {
  const pins = await loadPins(".");
  const yaml = renderPagesWorkflow(pins);
  assert.ok(yaml.includes("group: pages"), "Missing concurrency.group: pages");
  assert.ok(yaml.includes("cancel-in-progress: false"), "Missing cancel-in-progress: false");
});

await test("renderPagesWorkflow — deploy job has main guard", async () => {
  const pins = await loadPins(".");
  const yaml = renderPagesWorkflow(pins);
  assert.ok(
    yaml.includes("if: github.ref == 'refs/heads/main'"),
    "Missing main guard on deploy job"
  );
});

await test("renderPagesWorkflow — upload artifact path is ./site", async () => {
  const pins = await loadPins(".");
  const yaml = renderPagesWorkflow(pins);
  assert.ok(yaml.includes("path: ./site"), "Upload path must be ./site");
});

await test("renderPagesWorkflow — deploy job has pages: write and id-token: write", async () => {
  const pins = await loadPins(".");
  const yaml = renderPagesWorkflow(pins);
  assert.ok(yaml.includes("pages: write"), "Missing pages: write");
  assert.ok(yaml.includes("id-token: write"), "Missing id-token: write");
});

await test("renderPagesWorkflow — no tag-based uses references", async () => {
  const pins = await loadPins(".");
  const yaml = renderPagesWorkflow(pins);
  // Each 'uses:' line should contain a 40-char SHA, not @vX.Y.Z
  const usesLines = yaml.split("\n").filter((l) => l.includes("uses:"));
  for (const line of usesLines) {
    assert.ok(
      FULL_SHA_RE.test(line.trim().split("@")[1]?.split(/\s/)[0] || ""),
      `uses: line does not contain full SHA: ${line.trim()}`
    );
  }
});

await test("renderPagesWorkflow — no persist-credentials on checkout", async () => {
  const pins = await loadPins(".");
  const yaml = renderPagesWorkflow(pins);
  assert.ok(yaml.includes("persist-credentials: false"), "Missing persist-credentials: false");
});

await test("renderPagesWorkflow — includes check-public-tree step", async () => {
  const pins = await loadPins(".");
  const yaml = renderPagesWorkflow(pins);
  assert.ok(
    yaml.includes("check-public-tree.mjs"),
    "Missing check-public-tree step"
  );
});

await test("renderPagesWorkflow — includes npm run check:public", async () => {
  const pins = await loadPins(".");
  const yaml = renderPagesWorkflow(pins);
  assert.ok(yaml.includes("check:public"), "Missing check:public step");
});

// ─── full-file snapshot ───────────────────────────────────────────────────────
await test("canonical workflow matches .github/workflows/pages.yml", async () => {
  const canonical = await getCanonicalWorkflowBytes(".");
  const actual = await readFile(".github/workflows/pages.yml");

  if (!canonical.equals(actual)) {
    // Print diff hint
    const canonStr = canonical.toString("utf8");
    const actualStr = actual.toString("utf8");
    const canonLines = canonStr.split("\n");
    const actualLines = actualStr.split("\n");
    const maxLines = Math.max(canonLines.length, actualLines.length);
    const diffs = [];
    for (let i = 0; i < maxLines; i++) {
      if (canonLines[i] !== actualLines[i]) {
        diffs.push(`Line ${i + 1}: canonical=${JSON.stringify(canonLines[i])} actual=${JSON.stringify(actualLines[i])}`);
        if (diffs.length >= 5) { diffs.push("...more diffs..."); break; }
      }
    }
    assert.fail(
      `Workflow file does not match canonical rendering.\n${diffs.join("\n")}\n\n` +
      `Run: node -e "import('./tools/lib/pages-workflow.mjs').then(m=>m.getCanonicalWorkflowBytes()).then(b=>require('fs').writeFileSync('.github/workflows/pages.yml',b))" to fix.`
    );
  }
});

// ─── negative tests ───────────────────────────────────────────────────────────
await test("renderPagesWorkflow — rejects tag pin instead of SHA", () => {
  const pins = {
    "actions/checkout": { tag: "v6", sha: "v6.1.0" }, // tag as SHA
    "actions/setup-node": { tag: "v6", sha: "b".repeat(40) },
    "actions/configure-pages": { tag: "v5", sha: "c".repeat(40) },
    "actions/upload-pages-artifact": { tag: "v4", sha: "d".repeat(40) },
    "actions/deploy-pages": { tag: "v4", sha: "e".repeat(40) },
  };
  assert.throws(() => renderPagesWorkflow(pins), /Invalid SHA/);
});
