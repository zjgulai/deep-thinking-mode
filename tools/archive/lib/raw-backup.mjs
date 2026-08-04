import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, rename, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, relative, resolve } from "node:path";
import { promisify } from "node:util";

import { sha256 } from "./hash.mjs";
import { canonicalJsonBytes } from "./json.mjs";
import { publishNoClobber } from "./fs-safety.mjs";

const execFileAsync = promisify(execFile);
const CREATE_VERIFIED_RAW_BUNDLE = "CREATE_VERIFIED_RAW_BUNDLE";
const FULL_GIT_SHA = /^[0-9a-f]{40}$/;
const HEX_40 = /^[0-9a-f]{40}$/;
const HEX_64 = /^[0-9a-f]{64}$/;
const KNOWN_REF = "refs/heads/main";
const REQUIRED_MANIFEST_KEYS = [
  "schema_version",
  "baseline_commit",
  "bundled_ref",
  "bundle_path",
  "bundle_sha256",
  "source_count",
  "source_hashes",
  "verify_ok",
  "restore_ok"
];

function makeFailure(code, message) {
  return { ok: false, errors: [{ code, message }] };
}

function asPositiveInteger(value) {
  const numeric = Number(value);
  return Number.isSafeInteger(numeric) && numeric > 0 ? numeric : null;
}

function canonicalizeRootRelative(repoRoot, value) {
  if (isAbsolute(value)) {
    return relative(repoRoot, value).replaceAll("\\", "/");
  }
  return value.replaceAll("\\", "/");
}

async function runGit(repoRoot, args, { encoding = "utf8" } = {}) {
  try {
    const { stdout } = await execFileAsync(
      "git",
      ["--no-optional-locks", "-C", repoRoot, ...args],
      { encoding }
    );
    return stdout;
  } catch (cause) {
    const error = new Error(`git command failed: ${cause.message}`);
    error.code = "GIT_COMMAND_FAILED";
    error.cause = cause;
    throw error;
  }
}

async function runGitWithoutRepo(args, { encoding = "utf8" } = {}) {
  try {
    const { stdout } = await execFileAsync("git", [...args], { encoding });
    return stdout;
  } catch (cause) {
    const error = new Error(`git command failed: ${cause.message}`);
    error.code = "GIT_COMMAND_FAILED";
    error.cause = cause;
    throw error;
  }
}

function compareSourceRecords(left, right) {
  if (left.length !== right.length) return false;
  for (let index = 0; index < left.length; index += 1) {
    if (left[index].path !== right[index].path || left[index].sha256 !== right[index].sha256) return false;
  }
  return true;
}

async function listRootMarkdownPathsFromCommit(repoRoot, commit) {
  const output = await runGit(repoRoot, ["ls-tree", "-r", "--name-only", commit], { encoding: "utf8" });
  return output
    .split("\n")
    .filter((path) => path.length > 0 && !path.includes("/") && path.endsWith(".md"))
    .sort();
}

async function collectSourceHashesFromCommit(repoRoot, commit, sourcePaths) {
  const sourceHashes = [];
  for (const path of sourcePaths) {
    const blob = await runGit(repoRoot, ["show", `${commit}:${path}`], { encoding: null });
    sourceHashes.push({ path, sha256: sha256(Buffer.isBuffer(blob) ? blob : Buffer.from(blob)) });
  }
  return sourceHashes;
}

function canonicalManifestBytes(manifest) {
  return canonicalJsonBytes(manifest);
}

function sameCanonicalJson(left, right) {
  return canonicalManifestBytes(left).equals(canonicalManifestBytes(right));
}

async function validateManifest(manifest, { requireVerify = true } = {}) {
  if (manifest === null || typeof manifest !== "object" || Array.isArray(manifest)) {
    return makeFailure("MANIFEST_INVALID", "manifest must be a JSON object");
  }
  if (REQUIRED_MANIFEST_KEYS.some((key) => !Object.hasOwn(manifest, key))) {
    return makeFailure("MANIFEST_INVALID", "manifest missing required keys");
  }
  if (
    manifest.schema_version !== "1.0.0" ||
    manifest.bundled_ref !== KNOWN_REF ||
    !FULL_GIT_SHA.test(manifest.baseline_commit) ||
    !HEX_64.test(manifest.bundle_sha256) ||
    typeof manifest.source_count !== "number" ||
    !Number.isSafeInteger(manifest.source_count) ||
    manifest.source_count <= 0 ||
    !Array.isArray(manifest.source_hashes) ||
    typeof manifest.verify_ok !== "boolean" ||
    typeof manifest.restore_ok !== "boolean"
  ) {
    return makeFailure("MANIFEST_INVALID", "manifest has malformed fields");
  }
  if (requireVerify && (!manifest.verify_ok || !manifest.restore_ok)) {
    return makeFailure("MANIFEST_INVALID", "manifest must be verified before use");
  }
  for (const item of manifest.source_hashes) {
    if (item === null || typeof item !== "object" || typeof item.path !== "string" || !item.path.endsWith(".md")) {
      return makeFailure("MANIFEST_INVALID", "source_hashes must contain path entries");
    }
    if (typeof item.sha256 !== "string" || !HEX_64.test(item.sha256)) {
      return makeFailure("MANIFEST_INVALID", "source_hashes must contain sha256 values");
    }
  }
  return null;
}

async function restoreAndVerifyBundleFromPath(bundlePath, baselineCommit, expectedSourceHashes) {
  const tmpRestoreRoot = await mkdtemp(resolve(tmpdir(), "raw-baseline-restore-"));
  const restoreRef = "refs/heads/raw-baseline-restore-main";
  try {
    await runGit(tmpRestoreRoot, ["init", "--quiet"]);
    await runGit(tmpRestoreRoot, ["fetch", "--quiet", bundlePath, `${KNOWN_REF}:${restoreRef}`]);
    const restoredCommit = (await runGit(tmpRestoreRoot, ["rev-parse", restoreRef], { encoding: "utf8" })).trim();
    if (restoredCommit !== baselineCommit) {
      return makeFailure("BUNDLE_RESTORE_COMMIT_MISMATCH", "bundled ref does not match expected baseline commit");
    }

    const paths = await listRootMarkdownPathsFromCommit(tmpRestoreRoot, restoreRef);
    const sourceHashes = await collectSourceHashesFromCommit(tmpRestoreRoot, restoreRef, paths);
    const normalizedExpected = expectedSourceHashes
      .map((entry) => ({ path: entry.path, sha256: entry.sha256 }))
      .sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));

    if (!compareSourceRecords(sourceHashes, normalizedExpected)) {
      return makeFailure("BUNDLE_RESTORE_HASH_MISMATCH", "bundled sources do not match expected source hashes");
    }
    return { ok: true, sourceHashes };
  } finally {
    await rm(tmpRestoreRoot, { recursive: true, force: true });
  }
}

async function writeManifest({ manifestPath, manifest }) {
  const manifestBytes = canonicalManifestBytes(manifest);
  const absoluteManifestPath = resolve(manifestPath);
  await mkdir(dirname(absoluteManifestPath), { recursive: true });
  let existingManifestBytes = null;
  try {
    existingManifestBytes = await readFile(absoluteManifestPath);
  } catch (cause) {
    if (cause?.code !== "ENOENT") throw cause;
  }

  if (existingManifestBytes !== null) {
    try {
      const existingManifest = JSON.parse(existingManifestBytes.toString("utf8"));
      if (sameCanonicalJson(existingManifest, manifest)) return false;
    } catch {
      // Ignore malformed manifest and replace it.
    }
  }

  const tmpManifestPath = resolve(
    dirname(absoluteManifestPath),
    `.raw-baseline-${manifest.baseline_commit}.json.tmp-${Date.now()}`
  );
  await writeFile(tmpManifestPath, manifestBytes);
  await rename(tmpManifestPath, absoluteManifestPath);
  return true;
}

async function buildBaselineManifest({ repoRoot, baselineCommit, bundlePath, expectedCount }) {
  if (!FULL_GIT_SHA.test(baselineCommit)) return { error: makeFailure("BASELINE_COMMIT_INVALID", "baseline must be full SHA-1") };
  const sourceCount = asPositiveInteger(expectedCount);
  if (sourceCount === null) return { error: makeFailure("EXPECTED_COUNT_INVALID", "expect-count must be a positive integer") };

  const mainCommit = (await runGit(repoRoot, ["rev-parse", KNOWN_REF], { encoding: "utf8" })).trim();
  if (mainCommit !== baselineCommit) return { error: makeFailure("BASELINE_MISMATCH", "refs/heads/main must point to baseline commit") };

  const sourcePaths = await listRootMarkdownPathsFromCommit(repoRoot, baselineCommit);
  if (sourcePaths.length !== sourceCount) {
    return { error: makeFailure("SOURCE_COUNT_MISMATCH", `expected ${sourceCount}, got ${sourcePaths.length}`) };
  }

  const sourceHashes = await collectSourceHashesFromCommit(repoRoot, baselineCommit, sourcePaths);
  return {
    value: {
      schema_version: "1.0.0",
      baseline_commit: baselineCommit,
      bundled_ref: KNOWN_REF,
      bundle_path: canonicalizeRootRelative(repoRoot, bundlePath),
      bundle_sha256: null,
      source_count: sourceHashes.length,
      source_hashes: sourceHashes,
      verify_ok: true,
      restore_ok: true
    },
    sourceHashes
  };
}

export async function verifyExistingRawBackup({ repoRoot, bundlePath, manifestPath }) {
  const absoluteManifestPath = resolve(repoRoot, manifestPath);
  const absoluteBundlePath = resolve(repoRoot, bundlePath);
  let manifest;
  try {
    manifest = JSON.parse((await readFile(absoluteManifestPath, "utf8")));
  } catch (cause) {
    if (cause?.code === "ENOENT") return makeFailure("MANIFEST_NOT_FOUND", "manifest not found");
    return makeFailure("MANIFEST_READ_FAILED", `manifest read failed: ${cause.message}`);
  }

  const manifestFailure = await validateManifest(manifest);
  if (manifestFailure) return manifestFailure;

  const manifestBundlePath = resolve(repoRoot, manifest.bundle_path);
  if (manifestBundlePath !== absoluteBundlePath) return makeFailure("MANIFEST_BUNDLE_MISMATCH", "manifest bundle path mismatch");

  let existingBundle;
  try {
    existingBundle = await readFile(absoluteBundlePath);
  } catch (cause) {
    if (cause?.code === "ENOENT") return makeFailure("BUNDLE_NOT_FOUND", "bundle file not found");
    return makeFailure("BUNDLE_READ_FAILED", `bundle read failed: ${cause.message}`);
  }
  if (sha256(existingBundle) !== manifest.bundle_sha256) return makeFailure("BUNDLE_HASH_MISMATCH", "bundle digest mismatch");

  const localRef = (await runGit(repoRoot, ["show-ref", "--hash", KNOWN_REF], { encoding: "utf8" })).trim().split("\n")[0];
  if (localRef !== manifest.baseline_commit) return makeFailure("BASELINE_MISMATCH", "local baseline commit mismatch");

  try {
    await runGitWithoutRepo(["bundle", "verify", absoluteBundlePath], { encoding: "utf8" });
  } catch (cause) {
    if (cause.code === "GIT_COMMAND_FAILED") return makeFailure("BUNDLE_VERIFY_FAILED", "bundle verify failed");
    throw cause;
  }

  const normalizedExpected = manifest.source_hashes
    .map((entry) => ({ path: entry.path, sha256: entry.sha256 }))
    .sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  const restoreResult = await restoreAndVerifyBundleFromPath(absoluteBundlePath, manifest.baseline_commit, normalizedExpected);
  if (!restoreResult.ok) return restoreResult;

  return {
    ok: true,
    errors: [],
    manifest,
    verify_ok: true,
    restore_ok: true
  };
}

export async function createVerifiedRawBackup({
  repoRoot,
  baselineCommit,
  bundlePath,
  manifestPath,
  expectedCount,
  apply = false,
  confirmation = null
}) {
  if (typeof repoRoot !== "string" || repoRoot.length === 0) {
    return makeFailure("REPO_ROOT_INVALID", "repoRoot is required");
  }
  if (typeof bundlePath !== "string" || bundlePath.length === 0) {
    return makeFailure("BUNDLE_PATH_INVALID", "bundlePath is required");
  }
  if (typeof manifestPath !== "string" || manifestPath.length === 0) {
    return makeFailure("MANIFEST_PATH_INVALID", "manifestPath is required");
  }

  const baseManifest = await buildBaselineManifest({ repoRoot, baselineCommit, bundlePath, expectedCount });
  if (baseManifest.error) return baseManifest.error;

  const absoluteBundlePath = resolve(repoRoot, bundlePath);
  const absoluteManifestPath = resolve(repoRoot, manifestPath);
  await mkdir(dirname(absoluteBundlePath), { recursive: true });

  try {
    const existingBundle = await readFile(absoluteBundlePath);
    if (existingBundle && !apply) {
      return { ...baseManifest.value, ok: true, no_files_written: true, errors: [] };
    }
  } catch (cause) {
    if (cause?.code !== "ENOENT") return makeFailure("BUNDLE_PATH_CHECK_FAILED", `cannot access bundle path: ${cause.message}`);
  }

  if (!apply) {
    return { ...baseManifest.value, ok: true, no_files_written: true, errors: [] };
  }

  if (confirmation !== CREATE_VERIFIED_RAW_BUNDLE) {
    return {
      ok: false,
      errors: [{ code: "BACKUP_CONFIRMATION_REQUIRED", message: "create backup requires confirmation CREATE_VERIFIED_RAW_BUNDLE" }],
      no_files_written: false
    };
  }

  const expectedBundleShaPath = resolve(repoRoot, ".local", "tmp", `raw-baseline-${baselineCommit}.bundle.tmp`);
  await mkdir(dirname(expectedBundleShaPath), { recursive: true });

  try {
    await runGit(repoRoot, ["bundle", "create", expectedBundleShaPath, KNOWN_REF], { encoding: "binary" });
  } catch (cause) {
    if (cause.code === "GIT_COMMAND_FAILED") return makeFailure("BUNDLE_CREATE_FAILED", "bundle create failed");
    return makeFailure("BUNDLE_CREATE_FAILED", cause.message);
  }

  let bundleBytes;
  try {
    bundleBytes = await readFile(expectedBundleShaPath);
  } catch (cause) {
    return makeFailure("BUNDLE_READ_FAILED", `cannot read temporary bundle: ${cause.message}`);
  }
  const bundleSha256 = sha256(bundleBytes);
  try {
    const verified = { ...baseManifest.value, bundle_sha256: bundleSha256, verify_ok: true, restore_ok: true };
    await runGitWithoutRepo(["bundle", "verify", expectedBundleShaPath], { encoding: "utf8" });
    const restoreResult = await restoreAndVerifyBundleFromPath(expectedBundleShaPath, verified.baseline_commit, verified.source_hashes);
    if (!restoreResult.ok) return restoreResult;
    const published = await publishNoClobber({
      tempPath: expectedBundleShaPath,
      destinationPath: absoluteBundlePath,
      expectedSha256: bundleSha256
    });

    const manifest = { ...verified };
    const manifestWritten = await writeManifest({ manifestPath: absoluteManifestPath, manifest });
    const noFilesWritten = published === "same_hash" && !manifestWritten;
    return {
      ok: true,
      no_files_written: noFilesWritten,
      errors: [],
      manifest,
      published: published === "created" ? "bundle_published" : "bundle_unchanged"
    };
  } catch (cause) {
    if (cause?.code === "DESTINATION_CONFLICT") {
      return {
        ok: false,
        errors: [{ code: "BUNDLE_CONFLICT", message: "destination bundle exists with different digest" }],
        no_files_written: false
      };
    }
    if (cause?.code === "GIT_COMMAND_FAILED") {
      return makeFailure("BUNDLE_VERIFY_FAILED", "bundle verification failed");
    }
    if (cause?.kind === "io" || cause?.code === "EIO") {
      return makeFailure("IO_ERROR", cause.message);
    }
    throw cause;
  } finally {
    await rm(expectedBundleShaPath, { force: true }).catch(() => {});
  }
}

export { CREATE_VERIFIED_RAW_BUNDLE };
