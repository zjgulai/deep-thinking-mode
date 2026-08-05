#!/usr/bin/env node
/**
 * tools/lib/public-history.mjs
 *
 * Public-history safety layer:
 *   loadPublicPathManifest()  — validate public-paths.json
 *   preparePublicTree()       — create a candidate Git tree via a temporary index
 *   createPublicRoot()        — create one parentless commit with the approved tree
 *   recordGateApproval()      — bind a gate decision to the current state
 *   verifyPublicRoot()        — re-read and verify the root commit from the object DB
 *   activatePublicRoot()      — compare-and-swap refs/heads/main to the root
 */

import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import {
  chmod,
  mkdir,
  open,
  readFile,
  rename,
  stat,
  unlink,
  writeFile,
} from "node:fs/promises";
import { existsSync } from "node:fs";
import { join, normalize, isAbsolute } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

// ─── constants ───────────────────────────────────────────────────────────────
export const RAW_BASELINE_OID = "f876ce90d24ed486cae4060b1a4fe7b0813e9492";
const FULL_SHA_RE = /^[0-9a-f]{40}$/;
const SHA256_RE   = /^[0-9a-f]{64}$/;
const LOCAL_STATE_DIR  = ".local/state";
const LOCAL_BACKUP_DIR = ".local/backup";
const STATE_FILE = ".local/state/public-tree.json";
const STATE_PERMS = 0o600;

// Credential patterns for content-leak detection
const CREDENTIAL_PATTERNS = [
  /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/,
  /ghp_[0-9A-Za-z]{36}/,
  /gho_[0-9A-Za-z]{36}/,
  /github_pat_[0-9A-Za-z_]{82}/,
  /sk-[0-9A-Za-z]{48}/,
  /AIza[0-9A-Za-z_-]{35}/,
];

// ─── helpers ─────────────────────────────────────────────────────────────────
function releaseError(code, message) {
  const msg = message ? `${code}: ${message}` : code;
  const err = new Error(msg);
  err.code = code;
  return err;
}

function sha256(buf) {
  return createHash("sha256").update(buf).digest("hex");
}

async function git(...args) {
  const { stdout, stderr } = await execFileAsync("git", args, {
    maxBuffer: 32 * 1024 * 1024,
  });
  return stdout;
}

async function gitEnv(env, ...args) {
  const { stdout } = await execFileAsync("git", args, {
    env: { ...process.env, ...env },
    maxBuffer: 32 * 1024 * 1024,
  });
  return stdout;
}

// ─── loadPublicPathManifest ───────────────────────────────────────────────────
/**
 * Load and strictly validate tools/config/public-paths.json.
 * Returns { version, paths } on success; throws on any violation.
 */
export async function loadPublicPathManifest(manifestPath) {
  const raw = await readFile(manifestPath, "utf8");
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw releaseError("MANIFEST_INVALID_JSON", "public-paths.json is not valid JSON");
  }

  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw releaseError("MANIFEST_NOT_OBJECT", "public-paths.json must be a JSON object");
  }

  const allowedKeys = new Set(["version", "paths", "description"]);
  for (const k of Object.keys(parsed)) {
    if (!allowedKeys.has(k)) {
      throw releaseError("MANIFEST_UNKNOWN_KEY", `Unknown key in manifest: ${k}`);
    }
  }

  if (parsed.version !== 1) {
    throw releaseError("MANIFEST_WRONG_VERSION", "public-paths.json must have version: 1");
  }

  if (!Array.isArray(parsed.paths) || parsed.paths.length === 0) {
    throw releaseError("MANIFEST_EMPTY_PATHS", "public-paths.json must have a non-empty paths array");
  }

  const seen = new Set();
  const lowerSeen = new Set();

  for (let i = 0; i < parsed.paths.length; i++) {
    const p = parsed.paths[i];

    if (typeof p !== "string") {
      throw releaseError("MANIFEST_NON_STRING_PATH", `Path at index ${i} is not a string`);
    }
    if (p.length === 0) {
      throw releaseError("MANIFEST_EMPTY_PATH", `Path at index ${i} is empty`);
    }

    // No absolute paths
    if (isAbsolute(p)) {
      throw releaseError("MANIFEST_ABSOLUTE_PATH", `Path at index ${i} is absolute: ${p}`);
    }

    // No backslashes
    if (p.includes("\\")) {
      throw releaseError("MANIFEST_BACKSLASH", `Path at index ${i} contains backslash: ${p}`);
    }

    // No traversal
    const norm = normalize(p);
    if (norm.startsWith("..") || norm.startsWith("/")) {
      throw releaseError("MANIFEST_TRAVERSAL", `Path at index ${i} traverses parent: ${p}`);
    }

    // No pathspec magic (git pathspec chars at start)
    if (/^[:!]/.test(p)) {
      throw releaseError("MANIFEST_PATHSPEC_MAGIC", `Path at index ${i} has pathspec magic: ${p}`);
    }

    // No globs
    if (/[*?{}\[\]]/.test(p)) {
      throw releaseError("MANIFEST_GLOB", `Path at index ${i} contains glob character: ${p}`);
    }

    // No directory entries (trailing slash)
    if (p.endsWith("/")) {
      throw releaseError("MANIFEST_DIRECTORY_ENTRY", `Path at index ${i} is a directory entry: ${p}`);
    }

    // Must be NFC-normalized
    if (p.normalize("NFC") !== p) {
      throw releaseError("MANIFEST_NON_NFC", `Path at index ${i} is not NFC-normalized: ${p}`);
    }

    // No duplicates
    if (seen.has(p)) {
      throw releaseError("MANIFEST_DUPLICATE", `Duplicate path at index ${i}: ${p}`);
    }
    seen.add(p);

    // No case-fold collisions
    const lower = p.toLowerCase();
    if (lowerSeen.has(lower)) {
      throw releaseError("MANIFEST_CASEFOLD_COLLISION", `Case-fold collision at index ${i}: ${p}`);
    }
    lowerSeen.add(lower);

    // Codepoint order: each path must be > the previous
    if (i > 0) {
      const prev = parsed.paths[i - 1];
      if (!(p > prev)) {
        throw releaseError(
          "MANIFEST_NOT_SORTED",
          `Path at index ${i} is not in codepoint order: ${JSON.stringify(p)} after ${JSON.stringify(prev)}`
        );
      }
    }
  }

  return { version: parsed.version, paths: parsed.paths };
}

// ─── preparePublicTree ────────────────────────────────────────────────────────
/**
 * Create a candidate Git tree using a temporary index (never the real index).
 * Returns { treeOid, manifestDigest, pathCount } on success.
 */
export async function preparePublicTree(options = {}) {
  const {
    rootDir = ".",
    manifestPath = "tools/config/public-paths.json",
  } = options;

  // 1. Confirm HEAD is on main and resolves to the raw baseline
  const symbolicRef = (await git("symbolic-ref", "HEAD")).trim();
  if (symbolicRef !== "refs/heads/main") {
    throw releaseError("NOT_ON_MAIN", `HEAD is ${symbolicRef}, expected refs/heads/main`);
  }

  const currentHead = (await git("rev-parse", "HEAD")).trim();
  if (currentHead !== RAW_BASELINE_OID) {
    throw releaseError(
      "HEAD_NOT_BASELINE",
      `HEAD is ${currentHead}, expected baseline ${RAW_BASELINE_OID}`
    );
  }

  // 2. Load and validate the manifest
  const manifest = await loadPublicPathManifest(join(rootDir, manifestPath));

  // 3. Ensure local directories exist
  await mkdir(join(rootDir, LOCAL_STATE_DIR), { recursive: true });
  await mkdir(join(rootDir, LOCAL_BACKUP_DIR), { recursive: true });

  // 4. Create raw bundle backup
  const bundlePath = join(
    rootDir,
    LOCAL_BACKUP_DIR,
    `raw-baseline-${RAW_BASELINE_OID}.bundle`
  );
  if (!existsSync(bundlePath)) {
    await execFileAsync("git", ["bundle", "create", bundlePath, "--all"]);
    await chmod(bundlePath, 0o400);
  }
  const bundleBytes = await readFile(bundlePath);
  const bundleDigest = sha256(bundleBytes);

  // 5. Build candidate tree via a temporary index
  const tmpIndex = join(rootDir, LOCAL_STATE_DIR, "tmp-public.idx");
  try {
    if (existsSync(tmpIndex)) await unlink(tmpIndex);

    // Convert manifest paths to NUL-delimited for git update-index
    const pathsNul = manifest.paths.join("\0");
    await gitEnv(
      { GIT_INDEX_FILE: tmpIndex },
      "update-index", "--add", "--stdin", "-z"
    );

    // Actually add the paths: use ls-files then update-index with the tree
    // Build the tree by writing index entries from the working tree
    const addArgs = ["update-index", "--add", "--stdin"];
    const { stdout: _, stderr: __ } = await execFileAsync("git", addArgs, {
      env: { ...process.env, GIT_INDEX_FILE: tmpIndex },
      input: pathsNul,
      maxBuffer: 32 * 1024 * 1024,
    }).catch(() => ({ stdout: "", stderr: "" }));

    // Simpler: use git ls-files to get current object IDs then build tree
    // Use write-tree with the temporary index
    const treeOid = (
      await gitEnv({ GIT_INDEX_FILE: tmpIndex }, "write-tree")
    ).trim();

    if (!FULL_SHA_RE.test(treeOid)) {
      throw releaseError("INVALID_TREE_OID", `write-tree returned invalid OID: ${treeOid}`);
    }

    // 6. Read candidate entries back and verify
    const lsTreeOut = await git("ls-tree", "-r", treeOid);
    const candidateEntries = lsTreeOut
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((line) => {
        const m = line.match(/^(\d{6}) (\S+) ([0-9a-f]{40})\t(.+)$/);
        if (!m) throw releaseError("LS_TREE_PARSE", `Cannot parse ls-tree line: ${line}`);
        return { mode: m[1], type: m[2], oid: m[3], path: m[4] };
      });

    const candidatePaths = candidateEntries.map((e) => e.path).sort();
    const manifestPathsSorted = [...manifest.paths].sort();

    // Check exact membership
    if (candidatePaths.length !== manifestPathsSorted.length) {
      throw releaseError(
        "TREE_MEMBERSHIP_MISMATCH",
        `Tree has ${candidatePaths.length} entries, manifest has ${manifestPathsSorted.length}`
      );
    }
    for (let i = 0; i < candidatePaths.length; i++) {
      if (candidatePaths[i] !== manifestPathsSorted[i]) {
        throw releaseError(
          "TREE_PATH_MISMATCH",
          `Tree path ${candidatePaths[i]} != manifest path ${manifestPathsSorted[i]}`
        );
      }
    }

    // Check modes and types
    for (const entry of candidateEntries) {
      if (entry.type !== "blob") {
        throw releaseError("TREE_NON_BLOB", `Non-blob entry: ${entry.path} (${entry.type})`);
      }
      if (entry.mode !== "100644" && entry.mode !== "100755") {
        throw releaseError("TREE_WRONG_MODE", `Wrong mode ${entry.mode} for ${entry.path}`);
      }
      if (entry.mode === "120000" || entry.mode === "160000") {
        throw releaseError("TREE_SYMLINK_OR_GITLINK", `Symlink/gitlink: ${entry.path}`);
      }
    }

    // 7. Content-leak scan (redacted)
    let leakCount = 0;
    for (const entry of candidateEntries) {
      const blobOut = await git("cat-file", "blob", entry.oid);
      if (blobOut.includes("\0")) {
        throw releaseError("TREE_BINARY_CONTENT", `Binary NUL in ${entry.path}`);
      }
      for (const pat of CREDENTIAL_PATTERNS) {
        if (pat.test(blobOut)) {
          leakCount++;
          throw releaseError(
            "TREE_CREDENTIAL_LEAK",
            `Credential pattern detected in ${entry.path} (pattern: ${pat.source.slice(0, 20)}...)`
          );
        }
      }
    }

    // 8. Compute manifest digest
    const manifestBytes = await readFile(join(rootDir, manifestPath));
    const manifestDigest = sha256(manifestBytes);

    // 9. Write state atomically
    const state = {
      phase: "candidate_prepared",
      rawBaselineOid: RAW_BASELINE_OID,
      treeOid,
      manifestPath,
      manifestDigest,
      pathCount: manifest.paths.length,
      bundlePath,
      bundleDigest,
      leakCount,
      preparedAt: new Date().toISOString(),
    };

    const tmpState = STATE_FILE + ".tmp";
    await writeFile(tmpState, JSON.stringify(state, null, 2), "utf8");
    await chmod(tmpState, STATE_PERMS);
    await rename(tmpState, join(rootDir, STATE_FILE));

    return { treeOid, manifestDigest, pathCount: manifest.paths.length };
  } finally {
    if (existsSync(tmpIndex)) {
      await unlink(tmpIndex).catch(() => {});
    }
  }
}

// ─── readState ────────────────────────────────────────────────────────────────
async function readState(rootDir = ".") {
  const stateFile = join(rootDir, STATE_FILE);
  const raw = await readFile(stateFile, "utf8").catch(() => null);
  if (!raw) throw releaseError("NO_STATE", "No release state found at " + STATE_FILE);
  try {
    return JSON.parse(raw);
  } catch {
    throw releaseError("STATE_CORRUPT", "Release state is not valid JSON");
  }
}

async function writeState(rootDir, state) {
  const stateFile = join(rootDir, STATE_FILE);
  const tmpState = stateFile + ".tmp";
  await writeFile(tmpState, JSON.stringify(state, null, 2), "utf8");
  await chmod(tmpState, STATE_PERMS);
  await rename(tmpState, stateFile);
}

// ─── recordGateApproval ───────────────────────────────────────────────────────
const GATE_CONFIRMATIONS = {
  candidate_prepared: "I HAVE REVIEWED THE CANDIDATE TREE AND APPROVE IT",
  root_created: "I HAVE REVIEWED THE PUBLIC ROOT AND APPROVE IT",
};

const GATE_NEXT_PHASE = {
  candidate_prepared: "candidate_approved",
  root_created: "root_approved",
};

export async function recordGateApproval(confirmationString, rootDir = ".") {
  const state = await readState(rootDir);
  const expected = GATE_CONFIRMATIONS[state.phase];
  if (!expected) {
    throw releaseError("WRONG_PHASE", `Cannot approve in phase: ${state.phase}`);
  }
  if (confirmationString !== expected) {
    throw releaseError(
      "WRONG_CONFIRMATION",
      `Expected confirmation: "${expected}"`
    );
  }

  // Re-verify state integrity before changing phase
  const stateBytes = await readFile(join(rootDir, STATE_FILE));
  const stateDigest = sha256(stateBytes);

  const nextPhase = GATE_NEXT_PHASE[state.phase];
  const updated = {
    ...state,
    phase: nextPhase,
    [`${state.phase}_approval`]: {
      confirmationString,
      stateDigest,
      treeOid: state.treeOid,
      rootOid: state.rootOid || null,
      manifestDigest: state.manifestDigest,
      approvedAt: new Date().toISOString(),
    },
  };
  await writeState(rootDir, updated);
  return { phase: nextPhase };
}

// ─── createPublicRoot ─────────────────────────────────────────────────────────
const ROOT_COMMIT_MESSAGE = "feat: 系统化思维 — 公开知识库初始发布";

export async function createPublicRoot(options = {}) {
  const { authorName, authorEmail, rootDir = "." } = options;

  if (!authorName || !authorEmail) {
    throw releaseError("MISSING_AUTHOR", "authorName and authorEmail are required");
  }

  const state = await readState(rootDir);
  if (state.phase !== "candidate_approved") {
    throw releaseError(
      "WRONG_PHASE",
      `createPublicRoot requires phase candidate_approved, got ${state.phase}`
    );
  }

  // Idempotent: if root already recorded, return it
  if (state.rootOid) {
    if (!FULL_SHA_RE.test(state.rootOid)) {
      throw releaseError("STATE_CORRUPT_ROOT", "Recorded rootOid is invalid");
    }
    return { rootOid: state.rootOid };
  }

  // Verify treeOid still exists
  const treeType = (await git("cat-file", "-t", state.treeOid)).trim();
  if (treeType !== "tree") {
    throw releaseError("TREE_MISSING", `Tree ${state.treeOid} not found`);
  }

  // Create parentless commit
  const isoDate = new Date().toISOString();
  const env = {
    GIT_AUTHOR_NAME: authorName,
    GIT_AUTHOR_EMAIL: authorEmail,
    GIT_AUTHOR_DATE: isoDate,
    GIT_COMMITTER_NAME: authorName,
    GIT_COMMITTER_EMAIL: authorEmail,
    GIT_COMMITTER_DATE: isoDate,
  };

  const rootOid = (
    await gitEnv(
      env,
      "commit-tree",
      state.treeOid,
      "-m",
      ROOT_COMMIT_MESSAGE
    )
  ).trim();

  if (!FULL_SHA_RE.test(rootOid)) {
    throw releaseError("INVALID_ROOT_OID", `commit-tree returned invalid OID: ${rootOid}`);
  }

  // Persist state with root
  const updated = {
    ...state,
    phase: "root_created",
    rootOid,
    authorName,
    authorEmail,
    rootMessage: ROOT_COMMIT_MESSAGE,
    rootCreatedAt: new Date().toISOString(),
  };
  await writeState(rootDir, updated);
  return { rootOid };
}

// ─── verifyPublicRoot ─────────────────────────────────────────────────────────
export async function verifyPublicRoot(rootDir = ".") {
  const state = await readState(rootDir);
  if (!state.rootOid) {
    throw releaseError("NO_ROOT_OID", "State has no rootOid");
  }

  if (!FULL_SHA_RE.test(state.rootOid)) {
    throw releaseError("INVALID_ROOT_OID", "rootOid is not a valid 40-hex SHA");
  }

  // Read commit object
  const commitRaw = await git("cat-file", "commit", state.rootOid);

  // Must have no parent
  if (/^parent /m.test(commitRaw)) {
    throw releaseError("ROOT_HAS_PARENT", "Root commit has a parent");
  }

  // Tree must match
  const treeMatch = commitRaw.match(/^tree ([0-9a-f]{40})$/m);
  if (!treeMatch) {
    throw releaseError("ROOT_NO_TREE", "Cannot find tree in root commit");
  }
  if (treeMatch[1] !== state.treeOid) {
    throw releaseError(
      "ROOT_TREE_MISMATCH",
      `Root tree ${treeMatch[1]} != expected ${state.treeOid}`
    );
  }

  // Message must match
  const msgStart = commitRaw.indexOf("\n\n");
  if (msgStart === -1) {
    throw releaseError("ROOT_NO_MESSAGE", "Cannot find message in root commit");
  }
  const actualMsg = commitRaw.slice(msgStart + 2).trim();
  if (actualMsg !== ROOT_COMMIT_MESSAGE) {
    throw releaseError(
      "ROOT_MESSAGE_MISMATCH",
      `Root message mismatch: got "${actualMsg}"`
    );
  }

  return {
    rootOid: state.rootOid,
    treeOid: state.treeOid,
    message: actualMsg,
  };
}

// ─── activatePublicRoot ───────────────────────────────────────────────────────
export async function activatePublicRoot(rootDir = ".") {
  const state = await readState(rootDir);

  if (state.phase !== "root_approved") {
    throw releaseError(
      "WRONG_PHASE",
      `activatePublicRoot requires phase root_approved, got ${state.phase}`
    );
  }

  // 1. Check HEAD is still on main
  const symbolicRef = (await git("symbolic-ref", "HEAD")).trim();
  if (symbolicRef !== "refs/heads/main") {
    throw releaseError("NOT_ON_MAIN", `HEAD is ${symbolicRef}, expected refs/heads/main`);
  }

  // 2. Check main still points to baseline
  const currentMain = (await git("rev-parse", "refs/heads/main")).trim();
  if (currentMain !== RAW_BASELINE_OID) {
    throw releaseError(
      "MAIN_DRIFTED",
      `refs/heads/main is ${currentMain}, expected ${RAW_BASELINE_OID}`
    );
  }

  // 3. Verify root and tree
  await verifyPublicRoot(rootDir);

  // 4. Compare-and-swap: set main to rootOid, expecting baselineOid
  try {
    await git(
      "update-ref",
      "refs/heads/main",
      state.rootOid,
      RAW_BASELINE_OID
    );
  } catch (err) {
    throw releaseError("UPDATE_REF_FAILED", `update-ref failed: ${err.message}`);
  }

  // 5. Record active phase
  const updated = { ...state, phase: "active", activatedAt: new Date().toISOString() };
  await writeState(rootDir, updated).catch((reconcileErr) => {
    // State write failed after successful ref update — mark incomplete
    const incomplete = {
      ...state,
      phase: "activation_incomplete",
      refUpdateSucceeded: true,
      reconcileError: reconcileErr.message,
      recoveryCommand: "git reset --mixed refs/heads/main",
    };
    // Best-effort write
    writeFile(join(rootDir, STATE_FILE), JSON.stringify(incomplete, null, 2)).catch(() => {});
    throw releaseError(
      "ACTIVATION_INCOMPLETE",
      `Ref updated to ${state.rootOid} but state write failed. Run: git reset --mixed refs/heads/main then verify-active. Error: ${reconcileErr.message}`
    );
  });

  return { rootOid: state.rootOid, phase: "active" };
}
