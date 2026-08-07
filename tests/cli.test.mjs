import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, mkdir, realpath, rmdir, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import test from "node:test";

import { runPreflight } from "../tools/lib/git-baseline.mjs";
import { runCorpusCli } from "../tools/lib/cli.mjs";
import { readCurrentCleaningState } from "../tools/lib/cleaning-state.mjs";
import { createCleaningStateFixture } from "./helpers/cleaning-state-fixture.mjs";

const execFileAsync = promisify(execFile);
const TEST_DIRECTORY = dirname(fileURLToPath(import.meta.url));
const REPOSITORY_ROOT = resolve(TEST_DIRECTORY, "..");
const CLI_PATH = join(REPOSITORY_ROOT, "tools/corpus.mjs");
const BASELINE_COMMIT = "f876ce90d24ed486cae4060b1a4fe7b0813e9492";
const EXPECTED_NODE = "v24.18.0";
const BASELINE_PATHS = Array.from({ length: 418 }, (_, index) =>
  `source-${String(index).padStart(3, "0")}.md`
);

function baselineFacts(overrides = {}) {
  return {
    nodeVersion: EXPECTED_NODE,
    branch: "main",
    head: BASELINE_COMMIT,
    baselinePaths: BASELINE_PATHS,
    ...overrides
  };
}

function corpusConfig(overrides = {}) {
  return {
    schema_version: "1.0.0",
    baseline_commit: BASELINE_COMMIT,
    baseline_source_count: 418,
    baseline_source_url_count: 418,
    baseline_body_image_count: 237,
    source_id_algorithm: "hmac-sha256-private-locator-first-32",
    cleaner_version: "1.0.0",
    ...overrides
  };
}

function invalidIncrementalStateError(message) {
  return {
    kind: "expected",
    code: "LOCAL_STATE_INVALID",
    message,
    path: ".local/state/current-cleaning.json",
    source_id: null,
    persistent_writes_occurred: false
  };
}

async function withRoot(paths, run) {
  const rootDir = await mkdtemp(join(tmpdir(), "brain-model-preflight-"));
  const createdFiles = [];
  const createdDirectories = [];
  const createFile = async (relativePath, contents) => {
    await writeFile(join(rootDir, relativePath), contents);
    createdFiles.unshift(relativePath);
  };
  const createDirectory = async (relativePath) => {
    await mkdir(join(rootDir, relativePath));
    createdDirectories.unshift(relativePath);
  };
  const removeFile = async (relativePath) => {
    await unlink(join(rootDir, relativePath));
    createdFiles.splice(createdFiles.indexOf(relativePath), 1);
  };
  try {
    for (const path of paths) {
      await createFile(path, "# source\n");
    }
    return await run({ rootDir, createFile, createDirectory, removeFile });
  } finally {
    await Promise.all(createdFiles.map((relativePath) => unlink(join(rootDir, relativePath))));
    for (const relativePath of createdDirectories) {
      await rmdir(join(rootDir, relativePath));
    }
    await rmdir(rootDir);
  }
}

test("preflight rejects a wrong runtime", async () => {
  await withRoot([], async ({ rootDir }) => {
    const result = await runPreflight({
      expectedNodeVersion: EXPECTED_NODE,
      expectedBranch: "main",
      mode: "baseline",
      baselineCommit: BASELINE_COMMIT,
      baselineSourceCount: 418,
      rootDir,
      facts: baselineFacts({ nodeVersion: "v26.0.0" })
    });

    assert.equal(result.ok, false);
    assert.equal(result.errors[0].code, "RUNTIME_VERSION_MISMATCH");
  });
});

test("preflight rejects a wrong branch", async () => {
  await withRoot([], async ({ rootDir }) => {
    const result = await runPreflight({
      expectedNodeVersion: EXPECTED_NODE,
      expectedBranch: "main",
      mode: "baseline",
      baselineCommit: BASELINE_COMMIT,
      baselineSourceCount: 418,
      rootDir,
      facts: baselineFacts({ branch: "feature/preflight" })
    });

    assert.equal(result.ok, false);
    assert.equal(result.errors[0].code, "BRANCH_MISMATCH");
  });
});

test("baseline preflight binds the full commit and exact path set", async () => {
  await withRoot(BASELINE_PATHS, async ({ rootDir, createFile, removeFile }) => {
    await createFile("AGENTS.md", "# public instructions\n");
    const initial = await runPreflight({
      expectedNodeVersion: EXPECTED_NODE,
      expectedBranch: "main",
      mode: "baseline",
      baselineCommit: BASELINE_COMMIT,
      baselineSourceCount: 418,
      rootDir,
      facts: baselineFacts()
    });
    assert.equal(initial.ok, true);

    const wrongHead = await runPreflight({
      expectedNodeVersion: EXPECTED_NODE,
      expectedBranch: "main",
      mode: "baseline",
      baselineCommit: BASELINE_COMMIT,
      baselineSourceCount: 418,
      rootDir,
      facts: baselineFacts({ head: "f876ce9" })
    });
    assert.deepEqual(wrongHead.errors.map(({ code }) => code), ["BASELINE_MISMATCH"]);

    await removeFile(BASELINE_PATHS.at(-1));
    await createFile("unexpected.md", "# changed set\n");
    const wrongPaths = await runPreflight({
      expectedNodeVersion: EXPECTED_NODE,
      expectedBranch: "main",
      mode: "baseline",
      baselineCommit: BASELINE_COMMIT,
      baselineSourceCount: 418,
      rootDir,
      facts: baselineFacts()
    });
    assert.deepEqual(wrongPaths.errors.map(({ code }) => code), ["BASELINE_MISMATCH"]);
  });
});

test("incremental preflight reads every output from a real 419-source immutable run", async (t) => {
  const state = await createCleaningStateFixture({ sourceCount: 419 });
  t.after(state.cleanup);
  {
    const result = await runPreflight({
      expectedNodeVersion: EXPECTED_NODE,
      expectedBranch: "main",
      mode: "incremental",
      baselineCommit: BASELINE_COMMIT,
      baselineSourceCount: 418,
      rootDir: state.rootDir,
      facts: baselineFacts({ baselinePaths: ["baseline-source.md"] })
    });

    assert.equal(result.ok, true);
    assert.equal(result.mode, "incremental");
    assert.equal(result.facts.registeredSourceCount, 419);
  }

  await state.deleteOutput(state.ids.at(-1));
  const missingOutput = await runPreflight({
    expectedNodeVersion: EXPECTED_NODE,
    expectedBranch: "main",
    mode: "incremental",
    baselineCommit: BASELINE_COMMIT,
    baselineSourceCount: 418,
    rootDir: state.rootDir,
    facts: baselineFacts({ baselinePaths: ["baseline-source.md"] })
  });
  assert.equal(missingOutput.errors[0].code, "LOCAL_STATE_MISSING");
  assert.equal(
    missingOutput.errors[0].path,
    `.local/cleaned/runs/${state.pointer.run_sha256}/sources/${state.ids.at(-1)}.md`
  );
});

test("incremental preflight passes sorted IDs on its second shared-reader call and rejects pointer drift", async (t) => {
  const gitBaseline = await import("../tools/lib/git-baseline.mjs");
  assert.equal(typeof gitBaseline.inspectIncrementalState, "function");
  const state = await createCleaningStateFixture({ sourceCount: 2 });
  t.after(state.cleanup);
  const firstSuccess = await readCurrentCleaningState({
    rootDir: state.rootDir,
    currentPointer: state.currentPointer,
    selectedSourceIds: []
  });
  assert.equal(firstSuccess.ok, true);
  const ids = firstSuccess.value.catalog_entries.map(({ source_id: sourceId }) => sourceId);
  const secondSuccess = await readCurrentCleaningState({
    rootDir: state.rootDir,
    currentPointer: state.currentPointer,
    selectedSourceIds: ids
  });
  assert.equal(secondSuccess.ok, true);
  assert.equal(typeof secondSuccess.value.selected_output_bytes.set, "undefined");
  const calls = [];
  const result = await gitBaseline.inspectIncrementalState(state.rootDir, {
    readCurrentCleaningStateImpl: async (options) => {
      calls.push(options);
      // The two real successful reader results differ only in these injected bytes.
      return calls.length === 1
        ? { ...firstSuccess, value: { ...firstSuccess.value, pointer_bytes: Buffer.from("first pointer") } }
        : { ...secondSuccess, value: { ...secondSuccess.value, pointer_bytes: Buffer.from("second pointer") } };
    }
  });
  assert.deepEqual(calls.map(({ currentPointer, selectedSourceIds }) => ({
    currentPointer,
    selectedSourceIds
  })), [
    { currentPointer: ".local/state/current-cleaning.json", selectedSourceIds: [] },
    { currentPointer: ".local/state/current-cleaning.json", selectedSourceIds: ids }
  ]);
  assert.deepEqual(result.error, invalidIncrementalStateError(
    "cleaning pointer changed while outputs were verified"
  ));
});

test("incremental preflight rejects a real legal empty strict state without a second reader call", async (t) => {
  const state = await createCleaningStateFixture({ sourceCount: 0 });
  t.after(state.cleanup);
  let calls = 0;
  const result = await (await import("../tools/lib/git-baseline.mjs")).inspectIncrementalState(state.rootDir, {
    readCurrentCleaningStateImpl: async (options) => {
      calls += 1;
      return readCurrentCleaningState(options);
    }
  });
  assert.equal(calls, 1);
  assert.deepEqual(result.error, invalidIncrementalStateError(
    "incremental preflight requires a nonempty cleaning catalog"
  ));
});

test("incremental preflight normalizes second-pass derived-ID rejection at the pointer", async (t) => {
  const state = await createCleaningStateFixture({ sourceCount: 1 });
  t.after(state.cleanup);
  const firstSuccess = await readCurrentCleaningState({
    rootDir: state.rootDir,
    currentPointer: state.currentPointer,
    selectedSourceIds: []
  });
  assert.equal(firstSuccess.ok, true);
  const ids = firstSuccess.value.catalog_entries.map(({ source_id: sourceId }) => sourceId);
  let calls = 0;
  const callOptions = [];
  const result = await (await import("../tools/lib/git-baseline.mjs")).inspectIncrementalState(state.rootDir, {
    readCurrentCleaningStateImpl: async (options) => {
      calls += 1;
      callOptions.push(options);
      return calls === 1
        ? firstSuccess
        : {
          ok: false,
          error: {
            kind: "expected",
            code: "INVALID_CLEANING_INPUT",
            path: null,
            source_id: ids[0],
            persistent_writes_occurred: false
          }
        };
    }
  });
  assert.deepEqual(result.error, invalidIncrementalStateError(
    "cleaning state changed while outputs were verified"
  ));
  assert.deepEqual(callOptions.map(({ selectedSourceIds }) => selectedSourceIds), [[], ids]);
});

async function incrementalPreflight(rootDir) {
  return runPreflight({
    expectedNodeVersion: EXPECTED_NODE,
    expectedBranch: "main",
    mode: "incremental",
    baselineCommit: BASELINE_COMMIT,
    baselineSourceCount: 418,
    rootDir,
    facts: baselineFacts()
  });
}

function strictReaderError(code, path, sourceId = null) {
  return {
    kind: "expected",
    code,
    path,
    source_id: sourceId,
    persistent_writes_occurred: false
  };
}

function outputPath(state, sourceId) {
  return `.local/cleaned/runs/${state.pointer.run_sha256}/sources/${sourceId}.md`;
}

for (const [label, mutate, expectedError] of [
  ["pointer", (state) => state.deletePointer(), () =>
    strictReaderError("LOCAL_STATE_MISSING", ".local/state/current-cleaning.json")],
  ["catalog", (state) => state.deleteCatalog(), (state) =>
    strictReaderError("LOCAL_STATE_MISSING", state.pointer.catalog_path)],
  ["report", (state) => state.deleteReport(), (state) =>
    strictReaderError("LOCAL_STATE_MISSING", state.pointer.report_path)],
  ["output", (state) => state.deleteOutput(state.ids[0]), (state) =>
    strictReaderError("LOCAL_STATE_MISSING", outputPath(state, state.ids[0]), state.ids[0])]
]) {
  test(`incremental preflight propagates missing ${label} fields`, async (t) => {
    const state = await createCleaningStateFixture();
    t.after(state.cleanup);
    await mutate(state);
    const result = await incrementalPreflight(state.rootDir);
    assert.deepEqual(result.errors, [expectedError(state)]);
  });
}

test("incremental preflight propagates invalid pointer fields", async (t) => {
  const state = await createCleaningStateFixture();
  t.after(state.cleanup);
  await state.replacePointer(Buffer.from("{}\n"));
  const invalid = await incrementalPreflight(state.rootDir);
  assert.deepEqual(invalid.errors, [
    strictReaderError("LOCAL_STATE_INVALID", ".local/state/current-cleaning.json")
  ]);
});

for (const [label, mutate, expectedError] of [
  ["catalog", (fixture) => fixture.replaceCatalog(Buffer.from("invalid\n")), (fixture) =>
    strictReaderError("LOCAL_STATE_INVALID", fixture.pointer.catalog_path)],
  ["report", (fixture) => fixture.replaceReport(Buffer.from("invalid\n")), (fixture) =>
    strictReaderError("LOCAL_STATE_INVALID", fixture.pointer.report_path)],
  ["output", (fixture) => fixture.replaceOutput(fixture.ids[0], Buffer.from("invalid\n")), (fixture) =>
    strictReaderError("LOCAL_STATE_INVALID", outputPath(fixture, fixture.ids[0]), fixture.ids[0])]
]) {
  test(`incremental preflight propagates invalid ${label} fields`, async (t) => {
    const fixture = await createCleaningStateFixture();
    t.after(fixture.cleanup);
    await mutate(fixture);
    const result = await incrementalPreflight(fixture.rootDir);
    assert.deepEqual(result.errors, [expectedError(fixture)]);
  });
}

test("incremental preflight preserves strict reader I/O failure fields", async () => {
  const failure = {
    kind: "io",
    code: "CLEANING_IO_FAILURE",
    operation: "read",
    path: ".local/state/current-cleaning.json",
    persistent_writes_occurred: false
  };
  const result = await (await import("../tools/lib/git-baseline.mjs")).inspectIncrementalState("/synthetic-root", {
    readCurrentCleaningStateImpl: async () => ({ ok: false, error: failure })
  });
  assert.deepEqual(result.error, failure);
});

test("production Git reads disable optional locks and detect untracked worktree entries", async () => {
  const gitBaseline = await import("../tools/lib/git-baseline.mjs");
  assert.equal(typeof gitBaseline.readProductionFacts, "function");
  await withRoot(["source.md"], async ({ rootDir }) => {
    const calls = [];
    const execFileImpl = async (executable, args) => {
      calls.push({ executable, args });
      const command = args[3];
      if (command === "branch") return { stdout: "main\n" };
      if (command === "rev-parse") return { stdout: `${BASELINE_COMMIT}\n` };
      if (command === "status") return { stdout: "?? untracked.md\0" };
      throw new Error(`unexpected Git command: ${command}`);
    };
    const facts = await gitBaseline.readProductionFacts(rootDir, BASELINE_COMMIT, "incremental", { execFileImpl });
    assert.equal(facts.worktreeError.code, "WORKTREE_CONFLICT");
    assert.ok(calls.every(({ executable, args }) => executable === "git" && args[0] === "--no-optional-locks"));
    const statusCall = calls.find(({ args }) => args[3] === "status");
    assert.deepEqual(statusCall.args.slice(3), ["status", "--porcelain=v1", "-z", "--untracked-files=all"]);
  });
});

test("preflight CLI returns JSON and stable validation and I/O exits", async () => {
  await withRoot([], async ({ rootDir, createFile }) => {
    const configPath = join(rootDir, "corpus.json");
    await createFile("corpus.json", JSON.stringify(corpusConfig()));

    await assert.rejects(
      execFileAsync(process.execPath, [CLI_PATH, "preflight", "--mode", "unknown", "--root", rootDir, "--config", configPath], {
        cwd: rootDir
      }),
      (error) => {
        assert.equal(error.code, 2);
        assert.equal(JSON.parse(error.stdout).errors[0].code, "CLI_ARGUMENT_INVALID");
        return true;
      }
    );

    await assert.rejects(
      execFileAsync(process.execPath, [CLI_PATH, "preflight", "--mode", "baseline", "--root", rootDir, "--config", join(rootDir, "missing.json")], {
        cwd: rootDir
      }),
      (error) => {
        assert.equal(error.code, 5);
        assert.equal(JSON.parse(error.stdout).errors[0].code, "CONFIG_READ_FAILED");
        return true;
      }
    );
  });
});

test("preflight CLI strictly rejects a changed, missing, or extra config value", async () => {
  await withRoot([], async ({ rootDir, createFile }) => {
    const cases = [
      corpusConfig({ baseline_commit: "0".repeat(40) }),
      corpusConfig({ baseline_source_count: 0 }),
      corpusConfig({ baseline_body_image_count: -1 }),
      { exitCode: 2 },
      (() => {
        const config = corpusConfig();
        delete config.cleaner_version;
        return config;
      })(),
      corpusConfig({ unexpected: true })
    ];
    for (const [index, config] of cases.entries()) {
      const relativePath = `invalid-${index}.json`;
      await createFile(relativePath, JSON.stringify(config));
      const result = await runCorpusCli([
        "preflight", "--mode", "baseline", "--root", rootDir, "--config", join(rootDir, relativePath)
      ]);
      assert.equal(result.exitCode, 2);
      assert.equal(result.errors[0].code, "CONFIG_INVALID");
    }
    await assert.rejects(
      execFileAsync(process.execPath, [
        CLI_PATH, "preflight", "--mode", "baseline", "--root", rootDir, "--config", join(rootDir, "invalid-3.json")
      ], { cwd: rootDir }),
      (error) => {
        assert.equal(error.code, 2);
        assert.equal(JSON.parse(error.stdout).errors[0].code, "CONFIG_INVALID");
        return true;
      }
    );
  });
});

test("preflight CLI returns an isolated JSON success result with exit 0", async () => {
  await withRoot([], async ({ rootDir, createFile }) => {
    const configPath = join(rootDir, "corpus.json");
    await createFile("corpus.json", JSON.stringify(corpusConfig()));
    let calls = 0;
    const preflightRunner = async (options) => {
      calls += 1;
      assert.equal(options.rootDir, rootDir);
      assert.equal(options.expectedNodeVersion, EXPECTED_NODE);
      return {
        ok: true,
        mode: options.mode,
        errors: [],
        facts: { registeredSourceCount: null }
      };
    };
    const result = await runCorpusCli([
      "preflight",
      "--mode", "baseline",
      "--root", rootDir,
      "--config", configPath
    ], { preflightRunner });
    const json = JSON.parse(JSON.stringify(result));
    assert.equal(result.exitCode, 0);
    assert.equal(json.ok, true);
    assert.deepEqual(json.errors, []);
    assert.equal(calls, 1);
  });
});

async function runCliWithPreflightError(rootDir, configPath, error) {
  return runCorpusCli([
    "preflight", "--mode", "incremental", "--root", rootDir, "--config", configPath
  ], {
    preflightRunner: async () => ({
      ok: false,
      mode: "incremental",
      errors: [error],
      facts: { registeredSourceCount: null }
    })
  });
}

test("preflight CLI maps expected errors to exit 2", async () => {
  await withRoot([], async ({ rootDir, createFile }) => {
    const configPath = join(rootDir, "corpus.json");
    await createFile("corpus.json", JSON.stringify(corpusConfig()));
    const expected = await runCliWithPreflightError(rootDir, configPath, {
      code: "LOCAL_STATE_INVALID",
      kind: "expected",
      path: ".local/state/current-cleaning.json",
      source_id: null,
      persistent_writes_occurred: false
    });
    assert.equal(expected.exitCode, 2);
  });
});

test("preflight CLI maps kind-only I/O errors to exit 5", async () => {
  await withRoot([], async ({ rootDir, createFile }) => {
    const configPath = join(rootDir, "corpus.json");
    await createFile("corpus.json", JSON.stringify(corpusConfig()));
    const result = await runCliWithPreflightError(rootDir, configPath, {
      code: "OTHER_IO_FAILURE",
      kind: "io",
      operation: "read",
      path: ".local/state/current-cleaning.json",
      persistent_writes_occurred: false
    });
    assert.equal(result.exitCode, 5);
  });
});

test("preflight CLI maps code-only CLEANING_IO_FAILURE errors to exit 5", async () => {
  await withRoot([], async ({ rootDir, createFile }) => {
    const configPath = join(rootDir, "corpus.json");
    await createFile("corpus.json", JSON.stringify(corpusConfig()));
    const result = await runCliWithPreflightError(rootDir, configPath, {
      code: "CLEANING_IO_FAILURE",
      kind: "expected",
      path: ".local/state/current-cleaning.json",
      source_id: null,
      persistent_writes_occurred: false
    });
    assert.equal(result.exitCode, 5);
  });
});

test("preflight CLI defaults to the real repository preflight", async () => {
  await withRoot([], async ({ rootDir, createFile }) => {
    const configPath = join(rootDir, "corpus.json");
    await createFile("corpus.json", JSON.stringify(corpusConfig()));
    const result = await runCorpusCli([
      "preflight", "--mode", "baseline", "--root", rootDir, "--config", configPath
    ]);
    assert.equal(result.exitCode, 5);
    assert.equal(result.errors[0].code, "PREFLIGHT_IO_FAILED");
  });
});

test("clean CLI rejects missing required arguments", async () => {
  const result = await runCorpusCli([
    "clean", "--input", ".local/original/baseline", "--runs-root", ".local/cleaned/runs"
  ]);
  assert.equal(result.exitCode, 2);
  assert.equal(result.errors[0].code, "CLI_ARGUMENT_INVALID");
});

test("clean CLI rejects unknown arguments", async () => {
  const result = await runCorpusCli([
    "clean",
    "--input", ".local/original/baseline",
    "--runs-root", ".local/cleaned/runs",
    "--current-pointer", ".local/state/current-cleaning.json",
    "--key", ".local/state/source-id-key.bin",
    "--foobar"
  ]);
  assert.equal(result.exitCode, 2);
  assert.equal(result.errors[0].code, "CLI_ARGUMENT_INVALID");
});

test("clean CLI rejects --apply and --dry-run together", async () => {
  const result = await runCorpusCli([
    "clean",
    "--input", ".local/original/baseline",
    "--runs-root", ".local/cleaned/runs",
    "--current-pointer", ".local/state/current-cleaning.json",
    "--key", ".local/state/source-id-key.bin",
    "--apply",
    "--dry-run"
  ]);
  assert.equal(result.exitCode, 2);
  assert.equal(result.errors[0].code, "CLI_ARGUMENT_INVALID");
  assert.equal(result.errors[0].message, "clean cannot use --apply and --dry-run together");
});

test("clean CLI maps directory inputs to cleanCorpus options", async () => {
  await withRoot([], async ({ rootDir, createDirectory, createFile }) => {
    const originalCwd = process.cwd();
    await createDirectory(".local");
    await createDirectory(".local/original");
    await createDirectory(".local/original/baseline");
    const sourceId = "src_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
    await createFile(`.local/original/baseline/${sourceId}.md`, "# source\n");

    let cleanOptions = null;
  const result = await (async () => {
      process.chdir(rootDir);
      try {
        return await runCorpusCli([
          "clean",
          "--input", ".local/original/baseline",
          "--runs-root", ".local/cleaned/runs",
          "--current-pointer", ".local/state/current-cleaning.json",
          "--key", ".local/state/source-id-key.bin",
          "--strict",
          "--dry-run"
        ], {
          cleanCorpusRunner: async (options) => {
            cleanOptions = options;
            return {
              ok: true,
              errors: [],
              facts: { registeredSourceCount: 1 }
            };
          }
        });
      } finally {
        process.chdir(originalCwd);
      }
    })();

    assert.equal(result.exitCode, 0);
    assert.equal(result.ok, true);
    assert.equal(result.errors.length, 0);
    assert.deepEqual(cleanOptions.runsRoot, ".local/cleaned/runs");
    assert.deepEqual(cleanOptions.currentPointer, ".local/state/current-cleaning.json");
    assert.equal(cleanOptions.stateMode, "initial_verified_baseline");
    assert.equal(cleanOptions.strict, true);
    assert.equal(cleanOptions.apply, false);
    assert.equal(cleanOptions.dryRun, true);
    assert.equal(cleanOptions.inputEntries.length, 1);
    assert.equal(cleanOptions.inputEntries[0].source_id, sourceId);
  });
});

test("clean CLI loads JSON input and passes parsed fields to cleanCorpusRunner", async () => {
  await withRoot([], async ({ rootDir, createFile }) => {
    const originalCwd = process.cwd();
    const sourceId = "src_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
    await createFile("input.json", JSON.stringify([{
      source_id: sourceId,
      raw_bytes: "hello",
      source_kind: "baseline_markdown",
      locator_sha256: "1".repeat(64),
      original_path: ".local/original/baseline/manual.md",
      ingest_status: "registered",
      snapshot_version: 1,
      publication_policy: "public_metadata"
    }]));

    let cleanOptions = null;
    const result = await (async () => {
      process.chdir(rootDir);
      try {
        return await runCorpusCli([
          "clean",
          "--input", "input.json",
          "--runs-root", ".local/cleaned/runs",
          "--current-pointer", ".local/state/current-cleaning.json",
          "--key", ".local/state/source-id-key.bin"
        ], {
          cleanCorpusRunner: async (options) => {
            cleanOptions = options;
            return { ok: true, errors: [], facts: { registeredSourceCount: 1 } };
          }
        });
      } finally {
        process.chdir(originalCwd);
      }
    })();

    assert.equal(result.exitCode, 0);
    assert.equal(cleanOptions.inputEntries.length, 1);
    assert.equal(cleanOptions.inputEntries[0].source_id, sourceId);
    assert.equal(Buffer.isBuffer(cleanOptions.inputEntries[0].raw_bytes), true);
    assert.equal(cleanOptions.inputEntries[0].raw_bytes.toString("utf8"), "hello");
  });
});

test("clean CLI rejects invalid input JSON", async () => {
  await withRoot([], async ({ rootDir, createFile }) => {
    const originalCwd = process.cwd();
    await createFile("bad-input.json", "{]");
    const result = await (async () => {
      process.chdir(rootDir);
      try {
        return await runCorpusCli([
          "clean",
          "--input", "bad-input.json",
          "--runs-root", ".local/cleaned/runs",
          "--current-pointer", ".local/state/current-cleaning.json",
          "--key", ".local/state/source-id-key.bin",
          "--dry-run"
        ], { cleanCorpusRunner: async () => ({
          ok: true,
          errors: [],
          facts: { registeredSourceCount: 1 }
        }) });
      } finally {
        process.chdir(originalCwd);
      }
    })();
    assert.equal(result.exitCode, 2);
    assert.equal(result.errors[0].code, "INPUT_FILE_INVALID");
  });
});

test("backup CLI forwards parsed arguments to createVerifiedRawBackup runner", async () => {
  await withRoot([], async ({ rootDir }) => {
    let backupOptions = null;
    const originalCwd = process.cwd();
    const result = await (async () => {
      process.chdir(rootDir);
      try {
        return await runCorpusCli([
          "backup",
          "--baseline", "f876ce90d24ed486cae4060b1a4fe7b0813e9492",
          "--bundle", ".local/backup/raw-baseline.bundle",
          "--manifest", ".local/state/raw-baseline.json",
          "--expect-count", "418",
          "--dry-run"
        ], {
          createVerifiedRawBackupRunner: async (options) => {
            backupOptions = options;
            return {
              ok: true,
              errors: [],
              no_files_written: true
            };
          }
        });
      } finally {
        process.chdir(originalCwd);
      }
    })();

    assert.equal(result.exitCode, 0);
    const expectedRoot = await realpath(rootDir);
    const actualRoot = await realpath(backupOptions.repoRoot);
    assert.equal(actualRoot, expectedRoot);
    assert.equal(backupOptions.baselineCommit, "f876ce90d24ed486cae4060b1a4fe7b0813e9492");
    assert.equal(backupOptions.bundlePath, ".local/backup/raw-baseline.bundle");
    assert.equal(backupOptions.manifestPath, ".local/state/raw-baseline.json");
    assert.equal(backupOptions.expectedCount, 418);
    assert.equal(backupOptions.apply, false);
    assert.equal(backupOptions.confirmation, null);
  });
});

test("backup CLI maps BACKUP_CONFIRMATION_REQUIRED to exit 4", async () => {
  const result = await runCorpusCli([
    "backup",
    "--baseline", "f876ce90d24ed486cae4060b1a4fe7b0813e9492",
    "--bundle", ".local/backup/raw-baseline.bundle",
    "--manifest", ".local/state/raw-baseline.json",
    "--expect-count", "418",
    "--apply"
  ], {
    createVerifiedRawBackupRunner: async () => ({
      ok: false,
      errors: [{ code: "BACKUP_CONFIRMATION_REQUIRED", message: "create backup requires confirmation CREATE_VERIFIED_RAW_BUNDLE" }],
      no_files_written: false
    })
  });

  assert.equal(result.exitCode, 4);
  assert.equal(result.errors[0].code, "BACKUP_CONFIRMATION_REQUIRED");
});
