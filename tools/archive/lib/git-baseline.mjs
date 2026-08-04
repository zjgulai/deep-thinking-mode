import { execFile } from "node:child_process";
import { readdir } from "node:fs/promises";
import { promisify } from "node:util";

import { readCurrentCleaningState } from "./cleaning-state.mjs";

const execFileAsync = promisify(execFile);
const FULL_GIT_SHA = /^[0-9a-f]{40}$/;
const RESERVED_ROOT_MARKDOWN = new Set(["AGENTS.md", "README.md"]);
const CURRENT_POINTER = ".local/state/current-cleaning.json";

function error(code, message) {
  return { code, message };
}

function uniqueSorted(paths) {
  return [...new Set(paths)].sort();
}

function samePaths(left, right) {
  return left.length === right.length && left.every((path, index) => path === right[index]);
}

function validateOptions({ mode, rootDir, expectedNodeVersion, expectedBranch, baselineCommit, baselineSourceCount }) {
  if (mode !== "baseline" && mode !== "incremental") {
    throw new TypeError("mode must be baseline or incremental");
  }
  if (typeof rootDir !== "string" || rootDir.length === 0) {
    throw new TypeError("rootDir is required");
  }
  if (typeof expectedNodeVersion !== "string" || !expectedNodeVersion.startsWith("v")) {
    throw new TypeError("expectedNodeVersion must be a Node version");
  }
  if (typeof expectedBranch !== "string" || expectedBranch.length === 0) {
    throw new TypeError("expectedBranch is required");
  }
  if (!FULL_GIT_SHA.test(baselineCommit)) {
    throw new TypeError("baselineCommit must be a full 40-character SHA");
  }
  if (!Number.isInteger(baselineSourceCount) || baselineSourceCount < 1) {
    throw new TypeError("baselineSourceCount must be a positive integer");
  }
}

async function listRootMarkdown(rootDir) {
  const entries = await readdir(rootDir, { withFileTypes: true });
  return entries
    .filter((entry) => entry.isFile() && entry.name.endsWith(".md") && !RESERVED_ROOT_MARKDOWN.has(entry.name))
    .map((entry) => entry.name)
    .sort();
}

async function git(rootDir, args, { execFileImpl = execFileAsync } = {}) {
  const { stdout } = await execFileImpl(
    "git",
    ["--no-optional-locks", "-C", rootDir, ...args],
    { encoding: "utf8" }
  );
  return stdout;
}

function invalidIncrementalState(message) {
  return {
    kind: "expected",
    code: "LOCAL_STATE_INVALID",
    message,
    path: CURRENT_POINTER,
    source_id: null,
    persistent_writes_occurred: false
  };
}

export async function inspectIncrementalState(
  rootDir,
  { readCurrentCleaningStateImpl = readCurrentCleaningState } = {}
) {
  const initial = await readCurrentCleaningStateImpl({
    rootDir,
    currentPointer: CURRENT_POINTER,
    selectedSourceIds: []
  });
  if (!initial.ok) return { error: initial.error };

  const selectedSourceIds = initial.value.catalog_entries.map(({ source_id: sourceId }) => sourceId);
  if (selectedSourceIds.length === 0) {
    return { error: invalidIncrementalState("incremental preflight requires a nonempty cleaning catalog") };
  }

  const verified = await readCurrentCleaningStateImpl({
    rootDir,
    currentPointer: CURRENT_POINTER,
    selectedSourceIds
  });
  if (!verified.ok) {
    if (verified.error.code === "INVALID_CLEANING_INPUT") {
      return { error: invalidIncrementalState("cleaning state changed while outputs were verified") };
    }
    return { error: verified.error };
  }
  if (!initial.value.pointer_bytes.equals(verified.value.pointer_bytes)) {
    return { error: invalidIncrementalState("cleaning pointer changed while outputs were verified") };
  }
  return { registeredSourceCount: verified.value.catalog_entries.length };
}

export async function readProductionFacts(rootDir, baselineCommit, mode, { execFileImpl = execFileAsync } = {}) {
  const readGit = (args) => git(rootDir, args, { execFileImpl });
  const [branch, head, baselineTree, worktreeStatus, currentPaths] = await Promise.all([
    readGit(["branch", "--show-current"]),
    readGit(["rev-parse", "HEAD"]),
    mode === "baseline" ? readGit(["ls-tree", "-r", "-z", "--name-only", baselineCommit]) : Promise.resolve(""),
    readGit(["status", "--porcelain=v1", "-z", "--untracked-files=all"]),
    listRootMarkdown(rootDir)
  ]);
  const baselinePaths = baselineTree
    .split("\0")
    .filter((path) => path.length > 0 && !path.includes("/") && path.endsWith(".md"));

  return {
    nodeVersion: process.version,
    branch: branch.trim(),
    head: head.trim(),
    baselinePaths,
    currentPaths,
    worktreeError: worktreeStatus.length > 0
      ? error("WORKTREE_CONFLICT", "incremental preflight requires a clean working tree")
      : null
  };
}

export async function runPreflight(options) {
  validateOptions(options);
  const {
    mode,
    rootDir,
    expectedNodeVersion,
    expectedBranch,
    baselineCommit,
    baselineSourceCount,
    facts
  } = options;
  const suppliedFacts = facts !== undefined;
  const observed = facts ?? await readProductionFacts(rootDir, baselineCommit, mode);
  const currentPaths = observed.currentPaths ?? await listRootMarkdown(rootDir);
  const baselinePaths = uniqueSorted(observed.baselinePaths ?? []);
  const errors = [];

  if (observed.nodeVersion !== expectedNodeVersion) {
    errors.push(error("RUNTIME_VERSION_MISMATCH", `expected ${expectedNodeVersion}, received ${observed.nodeVersion}`));
  }
  if (observed.branch !== expectedBranch) {
    errors.push(error("BRANCH_MISMATCH", `expected ${expectedBranch}, received ${observed.branch || "detached HEAD"}`));
  }
  if (mode === "baseline") {
    if (
      observed.head !== baselineCommit ||
      baselinePaths.length !== baselineSourceCount ||
      !samePaths(baselinePaths, uniqueSorted(currentPaths))
    ) {
      errors.push(error("BASELINE_MISMATCH", "HEAD or root Markdown paths do not match the declared baseline"));
    }
  }
  const localState = mode === "incremental" ? await inspectIncrementalState(rootDir) : {};
  if (localState.error) {
    errors.push(localState.error);
  }
  if (mode === "incremental" && !suppliedFacts && observed.worktreeError) {
    errors.push(observed.worktreeError);
  }

  return {
    ok: errors.length === 0,
    mode,
    errors,
    facts: {
      nodeVersion: observed.nodeVersion,
      branch: observed.branch,
      head: observed.head,
      baselinePathCount: baselinePaths.length,
      currentRootMarkdownCount: currentPaths.length,
      registeredSourceCount: localState.registeredSourceCount ?? null
    }
  };
}
