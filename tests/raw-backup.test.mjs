import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { promisify } from "node:util";
import test from "node:test";

import { verifyExistingRawBackup, createVerifiedRawBackup } from "../tools/lib/raw-backup.mjs";

const execFileAsync = promisify(execFile);

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

async function createBaselineRepo(fileMap) {
  const rootDir = await mkdtemp(join(tmpdir(), "raw-baseline-repo-"));
  try {
    for (const [relativePath, contents] of Object.entries(fileMap)) {
      await writeFile(join(rootDir, relativePath), contents);
    }
    await execFileAsync("git", ["-C", rootDir, "init", "-q"]);
    await execFileAsync("git", ["-C", rootDir, "config", "user.name", "brain-model-backup"]);
    await execFileAsync("git", ["-C", rootDir, "config", "user.email", "backup@example.com"]);
    await execFileAsync("git", ["-C", rootDir, "add", ...Object.keys(fileMap)]);
    await execFileAsync("git", ["-C", rootDir, "commit", "-m", "baseline", "-q"]);
    const head = (await execFileAsync("git", ["-C", rootDir, "rev-parse", "HEAD"], { encoding: "utf8" })).stdout.trim();
    return { rootDir, commit: head };
  } catch (cause) {
    await rm(rootDir, { recursive: true, force: true });
    throw cause;
  }
}

test("createVerifiedRawBackup rejects baseline mismatch", async () => {
  const state = await createBaselineRepo({
    "a.md": "# a\n",
    "b.md": "# b\n"
  });
  try {
    const result = await createVerifiedRawBackup({
      repoRoot: state.rootDir,
      baselineCommit: `${state.commit.slice(0, 39)}${state.commit.endsWith("0") ? "1" : "0"}`,
      bundlePath: ".local/backup/raw-baseline-f999.json",
      manifestPath: ".local/state/raw-baseline.json",
      expectedCount: 2
    });
    assert.equal(result.ok, false);
    assert.equal(result.errors[0].code, "BASELINE_MISMATCH");
  } finally {
    await rm(state.rootDir, { recursive: true, force: true });
  }
});

test("createVerifiedRawBackup dry-run does not write outputs", async () => {
  const state = await createBaselineRepo({
    "a.md": "# a\n",
    "b.md": "# b\n"
  });
  try {
    const bundlePath = ".local/backup/raw-baseline-fake.bundle";
    const manifestPath = ".local/state/raw-baseline.json";
    const result = await createVerifiedRawBackup({
      repoRoot: state.rootDir,
      baselineCommit: state.commit,
      bundlePath,
      manifestPath,
      expectedCount: 2,
      apply: false
    });

    assert.equal(result.ok, true);
    assert.equal(result.no_files_written, true);
    await assert.rejects(() => stat(resolve(state.rootDir, bundlePath)), { code: "ENOENT" });
    await assert.rejects(() => stat(resolve(state.rootDir, manifestPath)), { code: "ENOENT" });
  } finally {
    await rm(state.rootDir, { recursive: true, force: true });
  }
});

test("createVerifiedRawBackup applies verified bundle and manifest after restore check", async () => {
  const state = await createBaselineRepo({
    "a.md": "# a\n",
    "b.md": "# b\n"
  });
  const bundlePath = ".local/backup/raw-baseline-f999.bundle";
  const manifestPath = ".local/state/raw-baseline.json";
  try {
    const result = await createVerifiedRawBackup({
      repoRoot: state.rootDir,
      baselineCommit: state.commit,
      bundlePath,
      manifestPath,
      expectedCount: 2,
      apply: true,
      confirmation: "CREATE_VERIFIED_RAW_BUNDLE"
    });
    assert.equal(result.ok, true);
    assert.equal(result.no_files_written, false);

    const manifest = JSON.parse(await readFile(resolve(state.rootDir, manifestPath), "utf8"));
    assert.equal(manifest.baseline_commit, state.commit);
    assert.equal(manifest.bundle_path, bundlePath);
    assert.equal(manifest.source_count, 2);
    assert.equal(manifest.verify_ok, true);
    assert.equal(manifest.restore_ok, true);

    const verification = await verifyExistingRawBackup({
      repoRoot: state.rootDir,
      bundlePath: resolve(state.rootDir, bundlePath),
      manifestPath: resolve(state.rootDir, manifestPath)
    });
    assert.equal(verification.ok, true);
    assert.equal(verification.verify_ok, true);
    assert.equal(verification.restore_ok, true);
  } finally {
    await rm(state.rootDir, { recursive: true, force: true });
  }
});

test("createVerifiedRawBackup refuses different existing bundle", async () => {
  const state = await createBaselineRepo({
    "a.md": "# a\n",
    "b.md": "# b\n"
  });
  const bundlePath = ".local/backup/raw-baseline-f999.bundle";
  const manifestPath = ".local/state/raw-baseline.json";
  try {
    await createVerifiedRawBackup({
      repoRoot: state.rootDir,
      baselineCommit: state.commit,
      bundlePath,
      manifestPath: ".local/state/raw-baseline.json",
      expectedCount: 2,
      apply: true,
      confirmation: "CREATE_VERIFIED_RAW_BUNDLE"
    });

    const destination = resolve(state.rootDir, bundlePath);
    await writeFile(destination, "corrupted-bundle");

    const tampered = await createVerifiedRawBackup({
      repoRoot: state.rootDir,
      baselineCommit: state.commit,
      bundlePath,
      manifestPath,
      expectedCount: 2,
      apply: true,
      confirmation: "CREATE_VERIFIED_RAW_BUNDLE"
    });

    assert.equal(tampered.ok, false);
    assert.equal(tampered.errors[0].code, "BUNDLE_CONFLICT");

    const reloaded = await readFile(destination, "utf8");
    assert.equal(reloaded, "corrupted-bundle");
  } finally {
    await rm(state.rootDir, { recursive: true, force: true });
  }
});

test("createVerifiedRawBackup is idempotent when destination bundle stays unchanged", async () => {
  const state = await createBaselineRepo({
    "a.md": "# a\n",
    "b.md": "# b\n"
  });
  const bundlePath = ".local/backup/raw-baseline-f999.bundle";
  const manifestPath = ".local/state/raw-baseline.json";
  try {
    const first = await createVerifiedRawBackup({
      repoRoot: state.rootDir,
      baselineCommit: state.commit,
      bundlePath,
      manifestPath,
      expectedCount: 2,
      apply: true,
      confirmation: "CREATE_VERIFIED_RAW_BUNDLE"
    });
    assert.equal(first.ok, true);

    const before = await readFile(resolve(state.rootDir, manifestPath), "utf8");
    const second = await createVerifiedRawBackup({
      repoRoot: state.rootDir,
      baselineCommit: state.commit,
      bundlePath,
      manifestPath,
      expectedCount: 2,
      apply: true,
      confirmation: "CREATE_VERIFIED_RAW_BUNDLE"
    });
    assert.equal(second.ok, true);
    assert.equal(second.no_files_written, true);
    assert.equal(await readFile(resolve(state.rootDir, manifestPath), "utf8"), before);

    const expectedBundleSha = sha256(await readFile(resolve(state.rootDir, bundlePath)));
    const manifest = JSON.parse(before);
    assert.equal(manifest.bundle_sha256, expectedBundleSha);
  } finally {
    await rm(state.rootDir, { recursive: true, force: true });
  }
});
