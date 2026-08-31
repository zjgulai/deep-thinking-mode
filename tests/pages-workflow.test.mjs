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

// Independently reviewed from each upstream action tag/commit. Keep this map
// literal: deriving it from the pin configuration would make a tag/SHA typo
// self-confirming. upload-pages-artifact is composite and its pinned action.yml
// delegates to upload-artifact@v7.0.0, whose runtime is node24.
const TRUSTED_NODE24_ACTIONS = Object.freeze({
  "actions/checkout": Object.freeze({
    tag: "v6.1.0",
    sha: "d23441a48e516b6c34aea4fa41551a30e30af803",
    runtime: "node24",
  }),
  "actions/setup-node": Object.freeze({
    tag: "v6.5.0",
    sha: "249970729cb0ef3589644e2896645e5dc5ba9c38",
    runtime: "node24",
  }),
  "actions/configure-pages": Object.freeze({
    tag: "v6.0.0",
    sha: "45bfe0192ca1faeb007ade9deae92b16b8254a0d",
    runtime: "node24",
  }),
  "actions/upload-pages-artifact": Object.freeze({
    tag: "v5.0.0",
    sha: "fc324d3547104276b827a68afc52ff2a11cc49c9",
    runtime: "composite",
    delegatesTo: Object.freeze({
      action: "actions/upload-artifact",
      tag: "v7.0.0",
      sha: "bbbca2ddaa5d8feaa63e36b76fdaad77386f024f",
      runtime: "node24",
    }),
  }),
  "actions/deploy-pages": Object.freeze({
    tag: "v5.0.0",
    sha: "cd2ce8fcbc39b97be8ca5fce6e763baed58fa128",
    runtime: "node24",
  }),
});

function expectedPinsFromTrustSet() {
  return Object.fromEntries(
    Object.entries(TRUSTED_NODE24_ACTIONS).map(([action, { tag, sha }]) => [
      action,
      { tag, sha },
    ])
  );
}

function getTopLevelBlock(yaml, key) {
  const lines = yaml.split("\n");
  const start = lines.indexOf(`${key}:`);
  assert.notEqual(start, -1, `Missing top-level ${key} block`);
  const end = lines.findIndex((line, index) => index > start && /^\S/.test(line));
  return lines.slice(start, end === -1 ? lines.length : end).join("\n").trimEnd();
}

function getBuildStepBlock(yaml, name) {
  const lines = yaml.split("\n");
  const buildStart = lines.indexOf("  build:");
  const deployStart = lines.indexOf("  deploy:");
  const marker = `      - name: ${name}`;
  const start = lines.indexOf(marker);
  assert.ok(
    buildStart !== -1 && deployStart !== -1 && start > buildStart && start < deployStart,
    `Missing build step: ${name}`
  );
  const nextStep = lines.findIndex(
    (line, index) => index > start && index < deployStart && /^      - name: /.test(line)
  );
  return lines.slice(start, nextStep === -1 ? deployStart : nextStep).join("\n").trimEnd();
}

function assertTopLevelPermissionsPolicy(yaml) {
  assert.deepEqual(
    yaml.split("\n").filter((line) => /^\s*permissions\s*:/.test(line)),
    ["permissions:", "    permissions:"]
  );
  assert.equal(
    getTopLevelBlock(yaml, "permissions"),
    "permissions:\n  contents: read\n  pages: read"
  );
}

function assertPublishingSourceGatePolicy(yaml) {
  const gate = getBuildStepBlock(yaml, "Verify single Pages publishing source");
  assert.equal(
    gate,
    `      - name: Verify single Pages publishing source
        env:
          GH_TOKEN: \${{ github.token }}
        run: |
          mode="$(gh api "repos/\${GITHUB_REPOSITORY}/pages" --jq '.build_type')"
          test "$mode" = workflow`
  );
  assert.ok(
    yaml.indexOf("      - name: Verify single Pages publishing source") <
      yaml.indexOf("      - name: Install dependencies"),
    "Pages publishing-source gate must run before npm ci"
  );
}

await test("current action pins match the independently reviewed Node 24 trust set", async () => {
  const pins = await loadPins(".");
  assert.deepEqual(pins, expectedPinsFromTrustSet());
  assert.deepEqual(
    TRUSTED_NODE24_ACTIONS["actions/upload-pages-artifact"].delegatesTo,
    {
      action: "actions/upload-artifact",
      tag: "v7.0.0",
      sha: "bbbca2ddaa5d8feaa63e36b76fdaad77386f024f",
      runtime: "node24",
    }
  );
});

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

await test("renderPagesWorkflow — push is restricted to main", async () => {
  const pins = await loadPins(".");
  const yaml = renderPagesWorkflow(pins);
  assert.ok(yaml.includes("branches: [main]"), "Missing branches: [main]");
  assert.ok(!yaml.includes("branches: [main, public]"), "Public branch must not trigger production Pages");
});

await test("renderPagesWorkflow — has workflow_dispatch", async () => {
  const pins = await loadPins(".");
  const yaml = renderPagesWorkflow(pins);
  assert.ok(yaml.includes("workflow_dispatch"), "Missing workflow_dispatch");
});

await test("renderPagesWorkflow — top-level permissions are read-only", async () => {
  const pins = await loadPins(".");
  const yaml = renderPagesWorkflow(pins);
  assertTopLevelPermissionsPolicy(yaml);
});

await test("renderPagesWorkflow — fails closed unless Pages uses workflow publishing", async () => {
  const pins = await loadPins(".");
  const yaml = renderPagesWorkflow(pins);
  assertPublishingSourceGatePolicy(yaml);
});

await test("workflow safety policy rejects permission and source-gate regressions", async () => {
  const pins = await loadPins(".");
  const yaml = renderPagesWorkflow(pins);
  const gate = getBuildStepBlock(yaml, "Verify single Pages publishing source");
  const install = getBuildStepBlock(yaml, "Install dependencies");

  const permissionMutations = [
    yaml.replace("  contents: read", "  contents: write"),
    yaml.replace("  pages: read", "  pages: read\n  issues: read"),
    yaml.replace("  build:\n", "  build:\n    permissions: write-all\n"),
  ];
  for (const mutation of permissionMutations) {
    assert.throws(() => assertTopLevelPermissionsPolicy(mutation));
  }

  const gateMutations = [
    yaml.replace("          GH_TOKEN: ${{ github.token }}\n", ""),
    yaml.replace('          test "$mode" = workflow', '          test "$mode" != legacy'),
    yaml.replace(`${gate}\n\n${install}`, `${install}\n\n${gate}`),
  ];
  for (const mutation of gateMutations) {
    assert.throws(() => assertPublishingSourceGatePolicy(mutation));
  }
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
  const lines = yaml.split("\n");
  const start = lines.indexOf("    permissions:");
  const end = lines.indexOf("    steps:", start);
  assert.ok(start !== -1 && end > start, "Missing deploy permissions block");
  assert.equal(
    lines.slice(start, end).join("\n").trimEnd(),
    "    permissions:\n      pages: write\n      id-token: write"
  );
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

await test("renderPagesWorkflow — verifies the complete generated site and manifest", async () => {
  const pins = await loadPins(".");
  const yaml = renderPagesWorkflow(pins);
  assert.ok(yaml.includes("git diff --exit-code -- site docs"));
  assert.ok(yaml.includes("npm run manifest:check"));
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
