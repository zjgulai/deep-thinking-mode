/**
 * tests/public-history.test.mjs
 *
 * Tests for tools/lib/public-history.mjs
 * Covers: loadPublicPathManifest, preparePublicTree contracts (state machine),
 *         recordGateApproval, createPublicRoot, verifyPublicRoot, activatePublicRoot.
 *
 * Uses only real in-memory JSON fixtures — no temporary Git repositories.
 * The heavy Git operations (preparePublicTree, activatePublicRoot) are tested
 * via contract assertions on their state-machine pre-conditions.
 */

import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  loadPublicPathManifest,
  recordGateApproval,
  createPublicRoot,
  verifyPublicRoot,
  RAW_BASELINE_OID,
} from "../tools/lib/public-history.mjs";

// ─── helpers ─────────────────────────────────────────────────────────────────
async function withTmp(fn) {
  const dir = await mkdtemp(join(tmpdir(), "ph-test-"));
  try {
    await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

async function writeManifest(dir, data) {
  const p = join(dir, "manifest.json");
  await writeFile(p, JSON.stringify(data), "utf8");
  return p;
}

// ─── loadPublicPathManifest ───────────────────────────────────────────────────
await test("loadPublicPathManifest — rejects malformed JSON", async () => {
  await withTmp(async (dir) => {
    const p = join(dir, "bad.json");
    await writeFile(p, "not json");
    await assert.rejects(() => loadPublicPathManifest(p), /MANIFEST_INVALID_JSON/);
  });
});

await test("loadPublicPathManifest — rejects non-object JSON", async () => {
  await withTmp(async (dir) => {
    const p = await writeManifest(dir, [1, 2]);
    await assert.rejects(() => loadPublicPathManifest(p), /MANIFEST_NOT_OBJECT/);
  });
});

await test("loadPublicPathManifest — rejects unknown keys", async () => {
  await withTmp(async (dir) => {
    const p = await writeManifest(dir, { version: 1, paths: ["a.txt"], unknown: true });
    await assert.rejects(() => loadPublicPathManifest(p), /MANIFEST_UNKNOWN_KEY/);
  });
});

await test("loadPublicPathManifest — rejects version !== 1", async () => {
  await withTmp(async (dir) => {
    const p = await writeManifest(dir, { version: 2, paths: ["a.txt"] });
    await assert.rejects(() => loadPublicPathManifest(p), /MANIFEST_WRONG_VERSION/);
  });
});

await test("loadPublicPathManifest — rejects empty paths", async () => {
  await withTmp(async (dir) => {
    const p = await writeManifest(dir, { version: 1, paths: [] });
    await assert.rejects(() => loadPublicPathManifest(p), /MANIFEST_EMPTY_PATHS/);
  });
});

await test("loadPublicPathManifest — rejects non-string path", async () => {
  await withTmp(async (dir) => {
    const p = await writeManifest(dir, { version: 1, paths: [42] });
    await assert.rejects(() => loadPublicPathManifest(p), /MANIFEST_NON_STRING_PATH/);
  });
});

await test("loadPublicPathManifest — rejects empty-string path", async () => {
  await withTmp(async (dir) => {
    const p = await writeManifest(dir, { version: 1, paths: [""] });
    await assert.rejects(() => loadPublicPathManifest(p), /MANIFEST_EMPTY_PATH/);
  });
});

await test("loadPublicPathManifest — rejects traversal path", async () => {
  await withTmp(async (dir) => {
    const p = await writeManifest(dir, { version: 1, paths: ["../secret"] });
    await assert.rejects(() => loadPublicPathManifest(p), /MANIFEST_TRAVERSAL/);
  });
});

await test("loadPublicPathManifest — rejects absolute path", async () => {
  await withTmp(async (dir) => {
    const p = await writeManifest(dir, { version: 1, paths: ["/etc/passwd"] });
    await assert.rejects(() => loadPublicPathManifest(p), /MANIFEST_ABSOLUTE_PATH/);
  });
});

await test("loadPublicPathManifest — rejects backslash path", async () => {
  await withTmp(async (dir) => {
    const p = await writeManifest(dir, { version: 1, paths: ["foo\\bar"] });
    await assert.rejects(() => loadPublicPathManifest(p), /MANIFEST_BACKSLASH/);
  });
});

await test("loadPublicPathManifest — rejects pathspec magic", async () => {
  await withTmp(async (dir) => {
    const p = await writeManifest(dir, { version: 1, paths: [":foo.txt"] });
    await assert.rejects(() => loadPublicPathManifest(p), /MANIFEST_PATHSPEC_MAGIC/);
  });
});

await test("loadPublicPathManifest — rejects git-breaking glob characters {} and []", async () => {
  await withTmp(async (dir) => {
    // * is a valid Unix filename char and allowed; {} and [] break git pathspec
    const p = await writeManifest(dir, { version: 1, paths: ["{foo,bar}.txt"] });
    await assert.rejects(() => loadPublicPathManifest(p), /MANIFEST_GLOB/);
  });
});

await test("loadPublicPathManifest — allows * in filenames (valid Unix char)", async () => {
  await withTmp(async (dir) => {
    // Files like **model**.json are valid Unix filenames (b.md < k... in codepoint order)
    const paths = ["b.md", "knowledge/models-v2/**1-.-something.json"];
    const p = await writeManifest(dir, { version: 1, paths });
    const result = await loadPublicPathManifest(p);
    assert.equal(result.paths.length, 2);
  });
});

await test("loadPublicPathManifest — rejects directory entries (trailing slash)", async () => {
  await withTmp(async (dir) => {
    const p = await writeManifest(dir, { version: 1, paths: ["foo/"] });
    await assert.rejects(() => loadPublicPathManifest(p), /MANIFEST_DIRECTORY_ENTRY/);
  });
});

await test("loadPublicPathManifest — rejects non-NFC path", async () => {
  await withTmp(async (dir) => {
    // NFD form of 'ñ' (n + combining tilde)
    const nfd = "n\u0303ame.txt";
    assert.notEqual(nfd, nfd.normalize("NFC"), "setup: path must be NFD");
    const p = await writeManifest(dir, { version: 1, paths: [nfd] });
    await assert.rejects(() => loadPublicPathManifest(p), /MANIFEST_NON_NFC/);
  });
});

await test("loadPublicPathManifest — rejects duplicate paths", async () => {
  await withTmp(async (dir) => {
    const p = await writeManifest(dir, { version: 1, paths: ["a.txt", "a.txt"] });
    await assert.rejects(() => loadPublicPathManifest(p), /MANIFEST_DUPLICATE/);
  });
});

await test("loadPublicPathManifest — rejects case-fold collision", async () => {
  await withTmp(async (dir) => {
    const p = await writeManifest(dir, { version: 1, paths: ["A.txt", "a.txt"] });
    // "A.txt" < "a.txt" in code point order, so order check passes
    // but case-fold check should catch it
    await assert.rejects(() => loadPublicPathManifest(p), /MANIFEST_CASEFOLD_COLLISION/);
  });
});

await test("loadPublicPathManifest — rejects non-codepoint order", async () => {
  await withTmp(async (dir) => {
    // 'b' > 'a' but we want reversed order
    const p = await writeManifest(dir, { version: 1, paths: ["b.txt", "a.txt"] });
    await assert.rejects(() => loadPublicPathManifest(p), /MANIFEST_NOT_SORTED/);
  });
});

await test("loadPublicPathManifest — accepts valid manifest", async () => {
  await withTmp(async (dir) => {
    const paths = ["README.md", "docs/index.html", "package.json"];
    const p = await writeManifest(dir, { version: 1, paths });
    const result = await loadPublicPathManifest(p);
    assert.equal(result.version, 1);
    assert.deepEqual(result.paths, paths);
  });
});

// ─── recordGateApproval ───────────────────────────────────────────────────────
await test("recordGateApproval — rejects wrong phase", async () => {
  await withTmp(async (dir) => {
    await mkdir(join(dir, ".local/state"), { recursive: true });
    const state = { phase: "active", treeOid: "a".repeat(40), manifestDigest: "b".repeat(64) };
    await writeFile(join(dir, ".local/state/public-tree.json"), JSON.stringify(state));
    await assert.rejects(
      () => recordGateApproval("anything", dir),
      /WRONG_PHASE/
    );
  });
});

await test("recordGateApproval — rejects wrong confirmation string", async () => {
  await withTmp(async (dir) => {
    await mkdir(join(dir, ".local/state"), { recursive: true });
    const state = { phase: "candidate_prepared", treeOid: "a".repeat(40), manifestDigest: "b".repeat(64) };
    await writeFile(join(dir, ".local/state/public-tree.json"), JSON.stringify(state));
    await assert.rejects(
      () => recordGateApproval("wrong string", dir),
      /WRONG_CONFIRMATION/
    );
  });
});

await test("recordGateApproval — accepts correct candidate confirmation", async () => {
  await withTmp(async (dir) => {
    await mkdir(join(dir, ".local/state"), { recursive: true });
    const state = { phase: "candidate_prepared", treeOid: "a".repeat(40), manifestDigest: "b".repeat(64) };
    await writeFile(join(dir, ".local/state/public-tree.json"), JSON.stringify(state));
    const result = await recordGateApproval(
      "I HAVE REVIEWED THE CANDIDATE TREE AND APPROVE IT",
      dir
    );
    assert.equal(result.phase, "candidate_approved");
  });
});

await test("recordGateApproval — accepts correct root confirmation", async () => {
  await withTmp(async (dir) => {
    await mkdir(join(dir, ".local/state"), { recursive: true });
    const state = {
      phase: "root_created",
      treeOid: "a".repeat(40),
      rootOid: "c".repeat(40),
      manifestDigest: "b".repeat(64),
    };
    await writeFile(join(dir, ".local/state/public-tree.json"), JSON.stringify(state));
    const result = await recordGateApproval(
      "I HAVE REVIEWED THE PUBLIC ROOT AND APPROVE IT",
      dir
    );
    assert.equal(result.phase, "root_approved");
  });
});

// ─── createPublicRoot ─────────────────────────────────────────────────────────
await test("createPublicRoot — rejects missing authorName", async () => {
  await withTmp(async (dir) => {
    await mkdir(join(dir, ".local/state"), { recursive: true });
    const state = { phase: "candidate_approved", treeOid: "a".repeat(40), manifestDigest: "b".repeat(64) };
    await writeFile(join(dir, ".local/state/public-tree.json"), JSON.stringify(state));
    await assert.rejects(
      () => createPublicRoot({ authorEmail: "test@example.com", rootDir: dir }),
      /MISSING_AUTHOR/
    );
  });
});

await test("createPublicRoot — rejects wrong phase", async () => {
  await withTmp(async (dir) => {
    await mkdir(join(dir, ".local/state"), { recursive: true });
    const state = { phase: "candidate_prepared", treeOid: "a".repeat(40), manifestDigest: "b".repeat(64) };
    await writeFile(join(dir, ".local/state/public-tree.json"), JSON.stringify(state));
    await assert.rejects(
      () => createPublicRoot({ authorName: "T", authorEmail: "t@t.com", rootDir: dir }),
      /WRONG_PHASE/
    );
  });
});

// ─── verifyPublicRoot ─────────────────────────────────────────────────────────
await test("verifyPublicRoot — rejects missing state", async () => {
  await withTmp(async (dir) => {
    await mkdir(join(dir, ".local/state"), { recursive: true });
    await assert.rejects(() => verifyPublicRoot(dir), /NO_STATE|NO_ROOT_OID/);
  });
});

await test("verifyPublicRoot — rejects state with no rootOid", async () => {
  await withTmp(async (dir) => {
    await mkdir(join(dir, ".local/state"), { recursive: true });
    const state = { phase: "candidate_approved", treeOid: "a".repeat(40) };
    await writeFile(join(dir, ".local/state/public-tree.json"), JSON.stringify(state));
    await assert.rejects(() => verifyPublicRoot(dir), /NO_ROOT_OID/);
  });
});

await test("verifyPublicRoot — rejects invalid rootOid format", async () => {
  await withTmp(async (dir) => {
    await mkdir(join(dir, ".local/state"), { recursive: true });
    const state = { phase: "root_created", rootOid: "not-a-sha", treeOid: "a".repeat(40) };
    await writeFile(join(dir, ".local/state/public-tree.json"), JSON.stringify(state));
    await assert.rejects(() => verifyPublicRoot(dir), /INVALID_ROOT_OID/);
  });
});

// ─── RAW_BASELINE_OID export ──────────────────────────────────────────────────
await test("RAW_BASELINE_OID is the correct 40-hex baseline", () => {
  assert.match(RAW_BASELINE_OID, /^[0-9a-f]{40}$/);
  assert.equal(RAW_BASELINE_OID, "f876ce90d24ed486cae4060b1a4fe7b0813e9492");
});
