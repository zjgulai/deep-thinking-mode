#!/usr/bin/env node
/**
 * tools/check-public-tree.mjs
 *
 * Public-only CI verifier: validates that a Git tree matches the
 * literal path manifest exactly (membership, modes, object types).
 * Does NOT require .local/ or perform private-source fingerprinting.
 *
 * Usage:
 *   node tools/check-public-tree.mjs --git-ref HEAD --manifest tools/config/public-paths.json
 */

import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const FULL_SHA_RE = /^[0-9a-f]{40}$/;

async function git(...args) {
  const { stdout } = await execFileAsync("git", args, { maxBuffer: 32 * 1024 * 1024 });
  return stdout;
}

async function resolveRef(ref) {
  const oid = (await git("rev-parse", ref)).trim();
  if (!FULL_SHA_RE.test(oid)) throw new Error(`Cannot resolve ref: ${ref}`);
  return oid;
}

async function getTreeForRef(ref) {
  const oid = await resolveRef(ref);
  const type = (await git("cat-file", "-t", oid)).trim();
  if (type === "tree") return oid;
  if (type === "commit") {
    const commitRaw = await git("cat-file", "commit", oid);
    const m = commitRaw.match(/^tree ([0-9a-f]{40})$/m);
    if (!m) throw new Error(`Cannot find tree in commit ${oid}`);
    return m[1];
  }
  throw new Error(`Ref ${ref} points to ${type}, not a commit or tree`);
}

async function loadManifestPaths(manifestPath) {
  const raw = await readFile(manifestPath, "utf8");
  const parsed = JSON.parse(raw);
  if (!Array.isArray(parsed.paths)) throw new Error("Manifest must have paths array");
  return parsed.paths;
}

async function main() {
  const args = process.argv.slice(2);
  let gitRef = "HEAD";
  let manifestPath = "tools/config/public-paths.json";

  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--git-ref" && args[i + 1]) gitRef = args[++i];
    else if (args[i] === "--manifest" && args[i + 1]) manifestPath = args[++i];
  }

  let exitCode = 0;
  const errors = [];

  try {
    // 1. Resolve tree
    const treeOid = await getTreeForRef(gitRef);

    // 2. Load manifest
    const manifestPaths = await loadManifestPaths(manifestPath);
    const manifestSet = new Set(manifestPaths);

    // 3. List tree entries (use -z to avoid quoted/escaped paths for non-ASCII)
    const lsOut = await git("ls-tree", "-r", "-z", treeOid);
    const entries = lsOut
      .split("\x00")
      .filter(Boolean)
      .map((line) => {
        const m = line.match(/^(\d{6}) (\S+) ([0-9a-f]{40})\t(.+)$/);
        if (!m) throw new Error(`Cannot parse ls-tree line: ${line}`);
        return { mode: m[1], type: m[2], oid: m[3], path: m[4] };
      });

    const treePaths = new Set(entries.map((e) => e.path));

    // 4. Check membership: extra paths in tree
    for (const p of treePaths) {
      if (!manifestSet.has(p)) {
        errors.push(`EXTRA_PATH: ${p} is in tree but not in manifest`);
      }
    }

    // 5. Check membership: missing paths from tree
    for (const p of manifestSet) {
      if (!treePaths.has(p)) {
        errors.push(`MISSING_PATH: ${p} is in manifest but not in tree`);
      }
    }

    // 6. Check modes and types
    for (const entry of entries) {
      if (entry.type !== "blob") {
        errors.push(`NON_BLOB: ${entry.path} has type ${entry.type}`);
      }
      if (entry.mode !== "100644" && entry.mode !== "100755") {
        errors.push(`WRONG_MODE: ${entry.path} has mode ${entry.mode}`);
      }
      if (entry.mode === "120000") errors.push(`SYMLINK: ${entry.path}`);
      if (entry.mode === "160000") errors.push(`GITLINK: ${entry.path}`);
    }

    // 7. Report
    if (errors.length === 0) {
      console.log(`✓ public-tree check passed: ${entries.length} paths, tree ${treeOid}`);
    } else {
      console.error(`✗ public-tree check failed (${errors.length} errors):`);
      for (const e of errors) console.error(`  ${e}`);
      exitCode = 1;
    }
  } catch (err) {
    console.error(`✗ public-tree check error: ${err.message}`);
    exitCode = 1;
  }

  process.exit(exitCode);
}

main();
