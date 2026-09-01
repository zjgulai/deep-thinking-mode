import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, rm, symlink, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { verifyProductionSite } from "../tools/verify-production.mjs";

const FROZEN_FILES = Object.freeze({
  "assets/router-controller.mjs": Buffer.from("export const legacy = true;\n"),
  "index.html": Buffer.from("legacy index\n"),
});
const FROZEN_MANIFEST =
  "be1c246881fabc2f3635d92d34f3294f2d48684014005e2155e1f9b8fb6dbb68  ./assets/router-controller.mjs\n" +
  "cd96d6b896db6ddd5b307783d8c15140fc902538a20da0e7828d8ae063bf72aa  ./index.html\n";
const FROZEN_ARTIFACT_SHA = "7db2392934501c6fd7b094bc9390011d6ede6be1b367fce37301f97350687615";
const VERIFIER = fileURLToPath(new URL("../tools/verify-production.mjs", import.meta.url));

async function makeFrozenFixture(t) {
  const rootDir = await mkdtemp(join(tmpdir(), "frozen-production-verifier-"));
  t.after(() => rm(rootDir, { recursive: true, force: true }));
  const siteDir = join(rootDir, "site");
  for (const [relativePath, bytes] of Object.entries(FROZEN_FILES)) {
    const absolutePath = join(siteDir, relativePath);
    await mkdir(join(absolutePath, ".."), { recursive: true });
    await writeFile(absolutePath, bytes);
  }
  const frozenManifest = join(rootDir, "previous-site.files.sha256");
  const frozenArtifactShaFile = join(rootDir, "previous-artifact.sha256");
  const frozenFileCountFile = join(rootDir, "previous-site.file-count.txt");
  await writeFile(frozenManifest, FROZEN_MANIFEST);
  await writeFile(frozenArtifactShaFile, `${FROZEN_ARTIFACT_SHA}\n`);
  await writeFile(frozenFileCountFile, "  2\n");
  return { rootDir, siteDir, frozenManifest, frozenArtifactShaFile, frozenFileCountFile };
}

function frozenFetcher(files = FROZEN_FILES) {
  return async (url) => {
    const pathname = decodeURIComponent(new URL(url).pathname);
    const relativePath = pathname === "/" ? "index.html" : pathname.slice(1);
    const body = files[relativePath];
    return {
      body,
      finalUrl: url,
      status: body ? 200 : 404,
      contentType: relativePath.endsWith(".mjs") ? "application/javascript" : "text/html",
      redirects: [],
    };
  };
}

function verifyFrozen(fixture, fetcher = frozenFetcher(), options = {}) {
  return verifyProductionSite({
    siteDir: fixture.siteDir,
    frozenManifest: fixture.frozenManifest,
    frozenArtifactShaFile: fixture.frozenArtifactShaFile,
    frozenFileCountFile: fixture.frozenFileCountFile,
    targetUrl: "https://example.test/",
    fetcher,
    ...options,
  });
}

test("frozen rollback verification accepts exact frozen evidence even when a script differs from the current trusted source", async (t) => {
  const fixture = await makeFrozenFixture(t);
  const verification = await verifyFrozen(fixture);

  assert.deepEqual(verification.errors, []);
  assert.equal(verification.checkedFiles, 2);

  const currentPolicy = await verifyProductionSite({
    siteDir: fixture.siteDir,
    targetUrl: "https://example.test/",
    fetcher: frozenFetcher(),
  });
  assert.ok(currentPolicy.errors.some((issue) => issue.includes("SCRIPT_BYTES_MISMATCH")));
});

test("frozen rollback verification rejects a file changed after its evidence was frozen", async (t) => {
  const fixture = await makeFrozenFixture(t);
  await writeFile(join(fixture.siteDir, "index.html"), "tampered\n");

  const verification = await verifyFrozen(fixture);

  assert.equal(verification.checkedFiles, 0);
  assert.match(verification.errors.join("\n"), /frozen manifest digest mismatch: index\.html/u);
});

test("frozen rollback verification rejects tampered or malformed evidence", async (t) => {
  const cases = [
    ["manifest digest", (fixture) => writeFile(
      fixture.frozenManifest,
      FROZEN_MANIFEST.replace("be1c", "0e1c"),
    ), /manifest digest mismatch/u],
    ["manifest duplicate", (fixture) => writeFile(
      fixture.frozenManifest,
      `${FROZEN_MANIFEST}${FROZEN_MANIFEST.split("\n")[0]}\n`,
    ), /repeats path/u],
    ["manifest noncanonical path", (fixture) => writeFile(
      fixture.frozenManifest,
      FROZEN_MANIFEST.replace("./index.html", "./nested/../index.html"),
    ), /invalid entry/u],
    ["manifest file set", (fixture) => writeFile(
      fixture.frozenManifest,
      FROZEN_MANIFEST.split("\n")[0] + "\n",
    ), /file set differs/u],
    ["artifact SHA", (fixture) => writeFile(
      fixture.frozenArtifactShaFile,
      `${"0".repeat(64)}\n`,
    ), /artifact SHA mismatch/u],
    ["file count", (fixture) => writeFile(fixture.frozenFileCountFile, "3\n"), /file count differs/u],
    ["evidence format", (fixture) => writeFile(
      fixture.frozenArtifactShaFile,
      FROZEN_ARTIFACT_SHA,
    ), /must contain one lowercase SHA-256 and LF/u],
  ];

  for (const [name, mutate, expected] of cases) {
    await t.test(name, async (caseContext) => {
      const fixture = await makeFrozenFixture(caseContext);
      await mutate(fixture);
      const verification = await verifyFrozen(fixture);
      assert.equal(verification.checkedFiles, 0);
      assert.match(verification.errors.join("\n"), expected);
    });
  }
});

test("frozen rollback verification rejects symlinks before reading their referents", async (t) => {
  const fixture = await makeFrozenFixture(t);
  const outsidePath = join(fixture.rootDir, "outside.html");
  await writeFile(outsidePath, FROZEN_FILES["index.html"]);
  await unlink(join(fixture.siteDir, "index.html"));
  await symlink(outsidePath, join(fixture.siteDir, "index.html"));

  const verification = await verifyFrozen(fixture);
  assert.equal(verification.checkedFiles, 0);
  assert.match(verification.errors.join("\n"), /must not be a symbolic link/u);
});

test("frozen rollback verification rejects symlinked evidence files", async (t) => {
  const fixture = await makeFrozenFixture(t);
  const outsideManifest = join(fixture.rootDir, "outside-manifest.sha256");
  await writeFile(outsideManifest, FROZEN_MANIFEST);
  await unlink(fixture.frozenManifest);
  await symlink(outsideManifest, fixture.frozenManifest);

  const verification = await verifyFrozen(fixture);
  assert.equal(verification.checkedFiles, 0);
  assert.match(verification.errors.join("\n"), /frozen manifest must be a regular non-symlink file/u);
});

test("frozen rollback verification still rejects remote byte drift", async (t) => {
  const fixture = await makeFrozenFixture(t);
  const remoteFiles = {
    ...FROZEN_FILES,
    "index.html": Buffer.from("remote drift\n"),
  };
  const verification = await verifyFrozen(fixture, frozenFetcher(remoteFiles));

  assert.equal(verification.checkedFiles, 2);
  assert.match(verification.errors.join("\n"), /index\.html: byte mismatch at offset/u);
});

test("frozen rollback verification compares the frozen byte snapshot if the local tree later drifts", async (t) => {
  const fixture = await makeFrozenFixture(t);
  let firstRequest = true;
  const fetcher = frozenFetcher();
  const verification = await verifyFrozen(fixture, async (url, options) => {
    if (firstRequest) {
      firstRequest = false;
      await writeFile(join(fixture.siteDir, "index.html"), "late local drift\n");
    }
    return fetcher(url, options);
  }, { concurrency: 1 });

  assert.deepEqual(verification.errors, []);
  assert.equal(verification.checkedFiles, 2);
});

test("frozen rollback CLI requires all three evidence flags together", async (t) => {
  const fixture = await makeFrozenFixture(t);
  const partial = spawnSync(process.execPath, [
    VERIFIER,
    "--site-dir", fixture.siteDir,
    "--frozen-manifest", fixture.frozenManifest,
  ], { cwd: fixture.rootDir, encoding: "utf8" });

  assert.equal(partial.status, 1, `${partial.stdout}\n${partial.stderr}`);
  assert.match(partial.stderr, /must be provided together/u);

  const complete = spawnSync(process.execPath, [
    VERIFIER,
    "--url", "http://127.0.0.1:1/",
    "--site-dir", fixture.siteDir,
    "--frozen-manifest", fixture.frozenManifest,
    "--frozen-artifact-sha-file", fixture.frozenArtifactShaFile,
    "--frozen-file-count-file", fixture.frozenFileCountFile,
  ], { cwd: fixture.rootDir, encoding: "utf8" });
  assert.equal(complete.status, 1, `${complete.stdout}\n${complete.stderr}`);
  assert.match(complete.stderr, /fetch failed/u);
  assert.doesNotMatch(complete.stderr, /LOCAL_ARTIFACT_INVALID|FROZEN_ARTIFACT_INVALID/u);
});
