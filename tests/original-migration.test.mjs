import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import fs, { lstat, mkdtemp, mkdir, readFile, rm, symlink, unlink, writeFile } from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import { homedir, tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import test from "node:test";

import {
  assertInsideLocalRoot,
  assertNoSymlinkTraversal,
  publishNoClobber
} from "../tools/lib/fs-safety.mjs";

const execFileAsync = promisify(execFile);
const TEST_DIRECTORY = dirname(fileURLToPath(import.meta.url));
const REPOSITORY_ROOT = resolve(TEST_DIRECTORY, "..");

function sha256(contents) {
  return createHash("sha256").update(contents).digest("hex");
}

async function withTemporaryRepository(run) {
  const repoRoot = await mkdtemp(join(tmpdir(), "brain-model-fs-safety-"));
  try {
    await mkdir(join(repoRoot, ".local"));
    return await run(repoRoot);
  } finally {
    await rm(repoRoot, { recursive: true, force: true });
  }
}

async function isIgnored(path) {
  try {
    await execFileAsync("git", ["-C", REPOSITORY_ROOT, "check-ignore", "--no-index", "--quiet", "--", path]);
    return true;
  } catch (cause) {
    if (cause.code === 1) return false;
    throw cause;
  }
}

async function expectDestinationConflict(operation) {
  await assert.rejects(operation, (cause) => cause?.code === "DESTINATION_CONFLICT");
}

test("public-safe ignore rules exclude local inputs while retaining named public paths", async () => {
  for (const path of [
    ".local/example.md",
    "inbox/example.md",
    ".local/backup/raw-baseline-f876ce9.bundle",
    "coding_session/private-placeholder.jsonl",
    ".DS_Store",
    "node_modules/markdown-it/index.mjs",
    "archives/raw-baseline.bundle",
    "root-input.md"
  ]) {
    assert.equal(await isIgnored(path), true, `${path} must be ignored`);
  }

  for (const path of ["AGENTS.md", "README.md", "docs/example.md", "knowledge/model.md", "tools/example.mjs", "tests/example.mjs", "site/index.html"]) {
    assert.equal(await isIgnored(path), false, `${path} must remain public`);
  }

  const graphifyIgnore = await readFile(join(REPOSITORY_ROOT, ".graphifyignore"), "utf8");
  assert.match(graphifyIgnore, /^\/coding_session\/$/m);

  const publicManifest = JSON.parse(await readFile(join(REPOSITORY_ROOT, "tools", "config", "public-paths.json"), "utf8"));
  assert.equal(publicManifest.paths.some((path) => path === "coding_session" || path.startsWith("coding_session/")), false);
});

test("local-root assertions reject paths outside .local and symlink traversal", async () => {
  await withTemporaryRepository(async (repoRoot) => {
    const localFile = join(repoRoot, ".local", "original", "source.md");
    await assert.doesNotReject(assertInsideLocalRoot({ repoRoot, candidatePath: localFile }));
    await assert.doesNotReject(assertNoSymlinkTraversal({ repoRoot, candidatePath: localFile }));

    for (const candidatePath of ["/", homedir(), repoRoot, join(repoRoot, "outside.md")]) {
      await assert.rejects(
        assertInsideLocalRoot({ repoRoot, candidatePath }),
        (cause) => cause?.code === "LOCAL_PATH_ESCAPE"
      );
    }

    await symlink(repoRoot, join(repoRoot, ".local", "escape"));
    await assert.rejects(
      assertNoSymlinkTraversal({ repoRoot, candidatePath: join(repoRoot, ".local", "escape", "outside.md") }),
      (cause) => cause?.code === "SYMLINK_TRAVERSAL"
    );
  });
});

test("publishNoClobber refuses a temporary artifact whose hash differs from its declared hash", async () => {
  await withTemporaryRepository(async (repoRoot) => {
    const tempPath = join(repoRoot, ".local", "artifact.tmp");
    const destinationPath = join(repoRoot, ".local", "artifact.txt");
    await writeFile(tempPath, "actual artifact\n");

    await assert.rejects(
      publishNoClobber({ tempPath, destinationPath, expectedSha256: sha256("declared artifact\n") }),
      (cause) => cause?.code === "SOURCE_HASH_MISMATCH"
    );
    await assert.rejects(readFile(destinationPath, "utf8"), (cause) => cause?.code === "ENOENT");
  });
});

test("publishNoClobber creates a new destination only when its hash matches the expected source", async () => {
  await withTemporaryRepository(async (repoRoot) => {
    const contents = "new published artifact\n";
    const tempPath = join(repoRoot, ".local", "artifact.tmp");
    const destinationPath = join(repoRoot, ".local", "artifact.txt");
    await writeFile(tempPath, contents);

    const result = await publishNoClobber({ tempPath, destinationPath, expectedSha256: sha256(contents) });

    assert.equal(result, "created");
    assert.equal(await readFile(destinationPath, "utf8"), contents);
  });
});

test("publishNoClobber accepts only an existing regular file with the same hash", async () => {
  await withTemporaryRepository(async (repoRoot) => {
    const contents = "stable artifact\n";
    const tempPath = join(repoRoot, ".local", "artifact.tmp");
    const destinationPath = join(repoRoot, ".local", "artifact.txt");
    await writeFile(tempPath, contents);
    await writeFile(destinationPath, contents);

    const result = await publishNoClobber({ tempPath, destinationPath, expectedSha256: sha256(contents) });

    assert.equal(result, "same_hash");
    assert.equal(await readFile(destinationPath, "utf8"), contents);
  });
});

test("publishNoClobber rejects a same-hash destination replaced by a symlink after initial inspection", async () => {
  await withTemporaryRepository(async (repoRoot) => {
    const contents = "stable artifact\n";
    const tempPath = join(repoRoot, ".local", "artifact.tmp");
    const destinationPath = join(repoRoot, ".local", "artifact.txt");
    const referentPath = join(repoRoot, ".local", "referent.txt");
    await writeFile(tempPath, contents);
    await writeFile(destinationPath, contents);
    await writeFile(referentPath, contents);

    const originalLstat = fs.lstat;
    let swapped = false;
    fs.lstat = async (path, ...args) => {
      const details = await originalLstat(path, ...args);
      if (!swapped && path === destinationPath) {
        swapped = true;
        await unlink(destinationPath);
        await symlink(referentPath, destinationPath);
      }
      return details;
    };
    syncBuiltinESMExports();
    try {
      await expectDestinationConflict(() => publishNoClobber({
        tempPath,
        destinationPath,
        expectedSha256: sha256(contents)
      }));
      assert.equal(swapped, true);
      assert.equal((await lstat(destinationPath)).isSymbolicLink(), true);
      assert.equal(await readFile(referentPath, "utf8"), contents);
    } finally {
      fs.lstat = originalLstat;
      syncBuiltinESMExports();
    }
  });
});

test("publishNoClobber refuses a different existing destination without changing it", async () => {
  await withTemporaryRepository(async (repoRoot) => {
    const tempPath = join(repoRoot, ".local", "artifact.tmp");
    const destinationPath = join(repoRoot, ".local", "artifact.txt");
    await writeFile(tempPath, "new artifact\n");
    await writeFile(destinationPath, "existing artifact\n");

    await expectDestinationConflict(() => publishNoClobber({
      tempPath,
      destinationPath,
      expectedSha256: sha256("new artifact\n")
    }));

    assert.equal(await readFile(destinationPath, "utf8"), "existing artifact\n");
  });
});

test("publishNoClobber refuses a symbolic-link destination without changing its referent", async () => {
  await withTemporaryRepository(async (repoRoot) => {
    const tempPath = join(repoRoot, ".local", "artifact.tmp");
    const destinationPath = join(repoRoot, ".local", "artifact.txt");
    const referentPath = join(repoRoot, ".local", "referent.txt");
    await writeFile(tempPath, "new artifact\n");
    await writeFile(referentPath, "protected artifact\n");
    await symlink(referentPath, destinationPath);

    await expectDestinationConflict(() => publishNoClobber({
      tempPath,
      destinationPath,
      expectedSha256: sha256("new artifact\n")
    }));

    assert.equal(await readFile(referentPath, "utf8"), "protected artifact\n");
  });
});

test("concurrent publishNoClobber calls never overwrite the destination that wins creation", async () => {
  await withTemporaryRepository(async (repoRoot) => {
    const firstTempPath = join(repoRoot, ".local", "first.tmp");
    const secondTempPath = join(repoRoot, ".local", "second.tmp");
    const destinationPath = join(repoRoot, ".local", "artifact.txt");
    await writeFile(firstTempPath, "first artifact\n");
    await writeFile(secondTempPath, "second artifact\n");

    const results = await Promise.allSettled([
      publishNoClobber({ tempPath: firstTempPath, destinationPath, expectedSha256: sha256("first artifact\n") }),
      publishNoClobber({ tempPath: secondTempPath, destinationPath, expectedSha256: sha256("second artifact\n") })
    ]);

    assert.equal(results.filter((result) => result.status === "fulfilled" && result.value === "created").length, 1);
    assert.equal(results.filter((result) => result.status === "rejected" && result.reason?.code === "DESTINATION_CONFLICT").length, 1);
    assert.ok(["first artifact\n", "second artifact\n"].includes(await readFile(destinationPath, "utf8")));
  });
});
