import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { constants as fsConstants, symlinkSync, unlinkSync } from "node:fs";
import {
  chmod,
  lstat,
  link,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  readdir,
  rename,
  rm,
  stat,
  symlink,
  truncate,
  unlink,
  writeFile
} from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";

import { sha256 } from "../tools/lib/hash.mjs";
import {
  canonicalJsonBytes,
  canonicalJsonDocumentBytes
} from "../tools/lib/json.mjs";

const GOLDEN_VALUE = {
  中: { b: true, a: 2 },
  z: { β: "值", a: [3, { z: false, a: null }] },
  a: ["second", "first"]
};
const GOLDEN_JSON =
  '{"a":["second","first"],"z":{"a":[3,{"a":null,"z":false}],"β":"值"},"中":{"a":2,"b":true}}';

function assertCanonicalInvalid(value, message) {
  assert.throws(
    () => canonicalJsonBytes(value),
    (error) => {
      assert.equal(error instanceof TypeError, true);
      assert.equal(error.code, "CANONICAL_JSON_INVALID");
      return true;
    },
    message
  );
}

function compareAscii(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

function assertInvalidAtRootAndNested(label, makeValue) {
  assertCanonicalInvalid(makeValue(), `${label} must be rejected at the root`);
  assertCanonicalInvalid(
    { valid: [0, makeValue()] },
    `${label} must be rejected when nested`
  );
}

const PROXY_TRAP_NAMES = [
  "apply",
  "construct",
  "defineProperty",
  "deleteProperty",
  "get",
  "getOwnPropertyDescriptor",
  "getPrototypeOf",
  "has",
  "isExtensible",
  "ownKeys",
  "preventExtensions",
  "set",
  "setPrototypeOf"
];

function makeTrackedProxy(target) {
  let trapCalls = 0;
  const handler = Object.fromEntries(PROXY_TRAP_NAMES.map((trapName) => [
    trapName,
    (...args) => {
      trapCalls += 1;
      return Reflect[trapName](...args);
    }
  ]));

  return {
    value: new Proxy(target, handler),
    getTrapCalls: () => trapCalls
  };
}

test("canonical JSON bytes use a hand-written recursive-ordering golden string", () => {
  const result = canonicalJsonBytes(GOLDEN_VALUE);

  assert.equal(Buffer.isBuffer(result), true);
  assert.deepEqual(result, Buffer.from(GOLDEN_JSON, "utf8"));
  assert.equal(result.toString("utf8"), GOLDEN_JSON);
  assert.equal(result.includes(0x0a), false);
});

test("canonical JSON document bytes append exactly one terminal LF", () => {
  const bare = canonicalJsonBytes(GOLDEN_VALUE);
  const document = canonicalJsonDocumentBytes(GOLDEN_VALUE);

  assert.equal(Buffer.isBuffer(document), true);
  assert.deepEqual(document, Buffer.concat([bare, Buffer.from([0x0a])]));
  assert.equal(document.at(-1), 0x0a);
  assert.notEqual(document.at(-2), 0x0a);
});

test("canonical JSON accepts nested Unicode, finite primitives, and null-prototype objects", () => {
  const nullPrototype = Object.create(null);
  nullPrototype.雪 = "❄️";
  nullPrototype.a = -12.5;

  assert.equal(
    canonicalJsonBytes({ yes: true, no: false, none: null, zero: -0, nested: nullPrototype })
      .toString("utf8"),
    '{"nested":{"a":-12.5,"雪":"❄️"},"no":false,"none":null,"yes":true,"zero":0}'
  );
});

test("canonical JSON rejects every unsupported primitive at root and nested positions", () => {
  const cases = [
    ["undefined", () => undefined],
    ["NaN", () => Number.NaN],
    ["positive infinity", () => Number.POSITIVE_INFINITY],
    ["negative infinity", () => Number.NEGATIVE_INFINITY],
    ["BigInt", () => 1n],
    ["function", () => function unsupported() {}],
    ["symbol", () => Symbol("unsupported")]
  ];

  for (const [label, makeValue] of cases) {
    assertInvalidAtRootAndNested(label, makeValue);
  }
});

test("canonical JSON rejects sparse arrays and arrays with extra own properties", () => {
  assertInvalidAtRootAndNested("sparse array", () => {
    const value = [1, 2];
    delete value[0];
    return value;
  });
  assertInvalidAtRootAndNested("array with a string property", () => {
    const value = [1];
    value.extra = 2;
    return value;
  });
  assertInvalidAtRootAndNested("array with a symbol property", () => {
    const value = [1];
    value[Symbol("extra")] = 2;
    return value;
  });
});

test("canonical JSON rejects symbol keys and accessors without evaluating them", () => {
  let getterCalls = 0;

  assertInvalidAtRootAndNested("symbol-keyed plain object", () => {
    const value = { valid: true };
    value[Symbol("hidden")] = "unsupported";
    return value;
  });
  assertInvalidAtRootAndNested("plain-object accessor", () => {
    const value = {};
    Object.defineProperty(value, "secret", {
      enumerable: true,
      get() {
        getterCalls += 1;
        return "must not be read";
      }
    });
    return value;
  });
  assertInvalidAtRootAndNested("array-index accessor", () => {
    const value = [0];
    Object.defineProperty(value, "0", {
      enumerable: true,
      get() {
        getterCalls += 1;
        return "must not be read";
      }
    });
    return value;
  });
  assert.equal(getterCalls, 0);
});

test("canonical JSON rejects non-plain objects at root and nested positions", () => {
  class CustomRecord {
    constructor() {
      this.value = 1;
    }
  }

  const cases = [
    ["Date", () => new Date(0)],
    ["Map", () => new Map([["a", 1]])],
    ["boxed primitive", () => new Number(1)],
    ["custom prototype", () => Object.create({ inherited: true })],
    ["class instance", () => new CustomRecord()]
  ];

  for (const [label, makeValue] of cases) {
    assertInvalidAtRootAndNested(label, makeValue);
  }
});

test("canonical JSON rejects object and array proxies without invoking any traps", () => {
  const cases = [
    ["object Proxy", () => ({ z: 2, a: 1 })],
    ["array Proxy", () => [2, 1]]
  ];

  for (const [label, makeTarget] of cases) {
    for (const position of ["root", "nested"]) {
      const tracked = makeTrackedProxy(makeTarget());
      const input = position === "root" ? tracked.value : { nested: tracked.value };
      let error = null;
      try {
        canonicalJsonBytes(input);
      } catch (caught) {
        error = caught;
      }

      assert.deepEqual(
        {
          isTypeError: error instanceof TypeError,
          code: error?.code ?? null,
          trapCalls: tracked.getTrapCalls()
        },
        {
          isTypeError: true,
          code: "CANONICAL_JSON_INVALID",
          trapCalls: 0
        },
        `${label} must be rejected ${position === "root" ? "at root" : "when nested"}`
      );
    }
  }
});

test("canonical JSON rejects circular objects and arrays but accepts shared references", () => {
  assertInvalidAtRootAndNested("circular object", () => {
    const value = { valid: true };
    value.self = value;
    return value;
  });
  assertInvalidAtRootAndNested("circular array", () => {
    const value = [1];
    value.push(value);
    return value;
  });

  const shared = { z: 2, a: "same" };
  assert.equal(
    canonicalJsonBytes({ right: shared, left: shared }).toString("utf8"),
    '{"left":{"a":"same","z":2},"right":{"a":"same","z":2}}'
  );
});

test("canonical JSON does not call toJSON, coerce values, or mutate input", () => {
  let toJsonCalls = 0;
  const withToJson = {
    value: 1,
    toJSON() {
      toJsonCalls += 1;
      return { replaced: true };
    }
  };
  assertCanonicalInvalid(withToJson);
  assert.equal(toJsonCalls, 0);

  const nested = Object.freeze({ z: "末", a: 1 });
  const stableArray = Object.freeze(["z", "a", nested]);
  const input = Object.freeze({ z: nested, a: stableArray });
  const rootKeysBefore = Reflect.ownKeys(input);
  const nestedKeysBefore = Reflect.ownKeys(nested);
  const arrayBefore = [...stableArray];

  const result = canonicalJsonBytes(input);

  assert.equal(
    result.toString("utf8"),
    '{"a":["z","a",{"a":1,"z":"末"}],"z":{"a":1,"z":"末"}}'
  );
  assert.deepEqual(Reflect.ownKeys(input), rootKeysBefore);
  assert.deepEqual(Reflect.ownKeys(nested), nestedKeysBefore);
  assert.deepEqual([...stableArray], arrayBefore);
});

const POINTER_RELATIVE_PATH = ".local/state/current-cleaning.json";
const SOURCE_A = "src_00000000000000000000000000000001";
const SOURCE_B = "src_00000000000000000000000000000002";
const CLEANER_VERSION = "synthetic-cleaner-1";
const CLEAN_OUTPUT = Buffer.from("abcdef\n![x](u)\nB  \n", "utf8");
const REVIEW_OUTPUT = Buffer.from("raw-B\n", "utf8");
const MAX_POINTER_BYTES = 64 * 1024;
const MAX_CATALOG_BYTES = 64 * 1024 * 1024;
const MAX_CATALOG_LINE_BYTES = 1024 * 1024;
const MAX_REPORT_BYTES = 256 * 1024 * 1024;
const MAX_OUTPUT_BYTES = 64 * 1024 * 1024;
const CLEANING_STATE_MODULE_URL =
  new URL("../tools/lib/cleaning-state.mjs", import.meta.url).href;
const CHILD_READER_SCRIPT = `
const [moduleUrl, rootDir, currentPointer, selectedSourceIdsJson] = process.argv.slice(1);
const { readCurrentCleaningState } = await import(moduleUrl);
const result = await readCurrentCleaningState({
  rootDir,
  currentPointer,
  selectedSourceIds: JSON.parse(selectedSourceIdsJson)
});
process.stdout.write(JSON.stringify(result.ok ? {
  ok: true,
  selected_size: result.value.selected_output_bytes.size,
  selected_ids: [...result.value.selected_output_bytes.keys()]
} : result));
`;
const RACING_SOCKET_CHILD_SCRIPT = `
import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { createServer } from "node:net";
import { join } from "node:path";

const [moduleUrl, rootDir, currentPointer] = process.argv.slice(1);
const realRoot = await fs.promises.realpath(rootDir);
const targetPath = join(realRoot, ".local", "state", "current-cleaning.json");
const originalLstat = fs.promises.lstat;
const originalOpen = fs.promises.open;
let preLstatSawRegular = false;
let replacementPublished = false;
let server = null;

fs.promises.lstat = async (...args) => {
  const stat = await originalLstat(...args);
  if (args[0] === targetPath && !replacementPublished && stat.isFile() &&
      !stat.isSymbolicLink()) {
    preLstatSawRegular = true;
  }
  return stat;
};
fs.promises.open = async (...args) => {
  if (args[0] === targetPath && !replacementPublished) {
    if (!preLstatSawRegular) throw new Error("leaf open happened before regular pre-lstat");
    await fs.promises.unlink(targetPath);
    server = createServer();
    await new Promise((resolve, reject) => {
      server.once("error", reject);
      server.listen(targetPath, resolve);
    });
    replacementPublished = true;
  }
  return originalOpen(...args);
};
syncBuiltinESMExports();

let result;
try {
  const { readCurrentCleaningState } = await import(moduleUrl);
  result = await readCurrentCleaningState({ rootDir, currentPointer });
} finally {
  fs.promises.lstat = originalLstat;
  fs.promises.open = originalOpen;
  syncBuiltinESMExports();
  if (server !== null) {
    await new Promise((resolve, reject) => {
      server.close((error) => error === undefined ? resolve() : reject(error));
    });
  }
}

process.stdout.write(JSON.stringify({
  result,
  pre_lstat_saw_regular: preLstatSawRegular,
  replacement_published: replacementPublished
}));
`;

function runBoundedChild(command, args, timeoutMs = 5_000) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      stdio: ["ignore", "pipe", "pipe"]
    });
    const stdout = [];
    const stderr = [];
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, timeoutMs);

    child.stdout.on("data", (chunk) => stdout.push(chunk));
    child.stderr.on("data", (chunk) => stderr.push(chunk));
    child.once("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.once("close", (code, signal) => {
      clearTimeout(timer);
      resolve({
        code,
        signal,
        timedOut,
        stdout: Buffer.concat(stdout).toString("utf8"),
        stderr: Buffer.concat(stderr).toString("utf8")
      });
    });
  });
}

function readerChildArgs(state, selectedSourceIds) {
  return [
    "--input-type=module",
    "--eval",
    CHILD_READER_SCRIPT,
    CLEANING_STATE_MODULE_URL,
    state.rootDir,
    state.currentPointer,
    JSON.stringify(selectedSourceIds)
  ];
}

async function readCleaningState(options) {
  const { readCurrentCleaningState } = await import("../tools/lib/cleaning-state.mjs");
  return readCurrentCleaningState(options);
}

function span(start, end) {
  return { start, end };
}

function makeAudit() {
  const metadataKeys = [
    "title",
    "author",
    "original_status",
    "published_at",
    "location",
    "source_url"
  ];
  const metadataSpans = Object.fromEntries(metadataKeys.map((key, index) => {
    const hash = sha256(Buffer.from(String.fromCharCode(0x61 + index)));
    return [key, {
      source_span: span(index, index + 1),
      output_span: span(index, index + 1),
      before_sha256: hash,
      after_sha256: hash,
      preserved: true
    }];
  }));
  const imageToken = Buffer.from("![x](u)");

  return {
    source_byte_length: CLEAN_OUTPUT.length,
    output_byte_length: CLEAN_OUTPUT.length,
    retained_spans: [
      {
        source_line: 1,
        source_span: span(0, 7),
        output_span: span(0, 7),
        before_sha256: sha256(Buffer.from("abcdef\n")),
        after_sha256: sha256(Buffer.from("abcdef\n"))
      },
      {
        source_line: 2,
        source_span: span(7, 15),
        output_span: span(7, 15),
        before_sha256: sha256(Buffer.from("![x](u)\n")),
        after_sha256: sha256(Buffer.from("![x](u)\n"))
      },
      {
        source_line: 3,
        source_span: span(15, 19),
        output_span: span(15, 19),
        before_sha256: sha256(Buffer.from("B  \n")),
        after_sha256: sha256(Buffer.from("B  \n"))
      }
    ],
    metadata_spans: metadataSpans,
    image_spans: [
      {
        ordinal: 1,
        source_token_span: span(7, 14),
        output_token_span: span(7, 14),
        source_sha256: sha256(imageToken),
        output_sha256: sha256(imageToken),
        alt_sha256: sha256(Buffer.from("x")),
        url_sha256: sha256(Buffer.from("u"))
      }
    ],
    hard_breaks: [
      {
        source_line: 3,
        source_span: span(16, 18),
        output_span: span(16, 18),
        preserved: true
      }
    ],
    body_output_span: span(7, 19),
    ordered_body_images_preserved: true,
    body_non_whitespace_code_points: 1
  };
}

function makeCleanedRecord() {
  const audit = makeAudit();
  const rawSha256 = sha256(CLEAN_OUTPUT);
  const cleanedSha256 = sha256(CLEAN_OUTPUT);
  const auditSha256 = sha256(canonicalJsonBytes(audit));

  return {
    source: {
      source_id: SOURCE_A,
      source_kind: "baseline_markdown",
      locator_sha256: "1".repeat(64),
      original_path: `.local/original/synthetic/${SOURCE_A}.md`,
      raw_sha256: rawSha256,
      cleaned_relative_path: `sources/${SOURCE_A}.md`,
      cleaned_sha256: cleanedSha256,
      title: "A",
      author: "Synthetic Author",
      original_status: "原创",
      published_at: "2026-01-02 03:04",
      location: "Synthetic",
      source_url: "https://mp.weixin.qq.com/s/synthetic-a",
      body_image_urls: ["u"],
      content_mode: "mixed",
      ingest_status: "registered",
      cleaning_status: "cleaned",
      processing_status: "cleaned",
      cleaner_version: CLEANER_VERSION,
      snapshot_version: 1,
      publication_policy: "public_metadata",
      review_state_owner: "mechanical",
      review_state_version: 0,
      review_state_bound_raw_sha256: rawSha256,
      review_state_bound_cleaned_sha256: cleanedSha256,
      review_state_bound_audit_sha256: auditSha256,
      review_state_bound_cleaner_version: CLEANER_VERSION,
      audit,
      audit_sha256: auditSha256,
      changes: [],
      warnings: []
    },
    bytes: Buffer.from(CLEAN_OUTPUT)
  };
}

function makeNeedsReviewRecord() {
  const rawSha256 = sha256(REVIEW_OUTPUT);

  return {
    source: {
      source_id: SOURCE_B,
      source_kind: "markdown",
      locator_sha256: "2".repeat(64),
      original_path: `.local/original/synthetic/${SOURCE_B}.md`,
      raw_sha256: rawSha256,
      cleaned_relative_path: `sources/${SOURCE_B}.md`,
      cleaned_sha256: rawSha256,
      title: null,
      author: null,
      original_status: null,
      published_at: null,
      location: null,
      source_url: null,
      body_image_urls: [],
      content_mode: "text",
      ingest_status: "registered",
      cleaning_status: "needs_review",
      processing_status: "needs_review",
      cleaner_version: CLEANER_VERSION,
      snapshot_version: 1,
      publication_policy: "local_only",
      review_state_owner: "mechanical",
      review_state_version: 0,
      review_state_bound_raw_sha256: rawSha256,
      review_state_bound_cleaned_sha256: rawSha256,
      review_state_bound_audit_sha256: null,
      review_state_bound_cleaner_version: CLEANER_VERSION,
      audit: null,
      audit_sha256: null,
      changes: [],
      warnings: ["SYNTHETIC_REVIEW"]
    },
    bytes: Buffer.from(REVIEW_OUTPUT)
  };
}

function makeValidRecords() {
  return [makeCleanedRecord(), makeNeedsReviewRecord()];
}

const CHANGE_RULE_KIND_CASES = [
  ["WECHAT_HEADER_V1", "delete"],
  ["WECHAT_FOOTER_SQUARE_V1", "delete"],
  ["WECHAT_FOOTER_COGNITION_V1", "delete"],
  ["DUPLICATE_FIGURE_LABEL_V1", "delete"],
  ["CONFIRMED_PLATFORM_CTA_V1", "delete"],
  ["NBSP_NORMALIZATION_V1", "normalize"],
  ["BLANK_LINE_NORMALIZATION_V1", "normalize"],
  ["EOF_NEWLINE_V1", "append_eof"]
];

function makeChange(ruleId, kind) {
  if (kind === "append_eof") {
    return {
      ruleId,
      kind,
      sourceLines: null,
      beforeSha256: sha256(Buffer.alloc(0)),
      afterSha256: sha256(Buffer.from([0x0a]))
    };
  }
  return {
    ruleId,
    kind,
    sourceLines: [1],
    beforeSha256: "3".repeat(64),
    afterSha256: kind === "delete" ? sha256(Buffer.alloc(0)) : "4".repeat(64)
  };
}

function projectCatalogEntry(source, runSha256) {
  const {
    cleaned_relative_path: cleanedRelativePath,
    audit: _audit,
    changes: _changes,
    warnings: _warnings,
    ...persisted
  } = source;
  return {
    schema_version: "1.0.0",
    ...persisted,
    cleaned_path: `.local/cleaned/runs/${runSha256}/${cleanedRelativePath}`
  };
}

async function materializeState(t, records = makeValidRecords(), options = {}) {
  const rootDir = await mkdtemp(
    options.rootPrefix ?? join(tmpdir(), "strict-cleaning-state-")
  );
  t.after(() => rm(rootDir, { recursive: true, force: true }));

  const sources = records.map(({ source }) => structuredClone(source));
  const runPreimage = {
    schema_version: "1.0.0",
    cleaner_version: CLEANER_VERSION,
    sources
  };
  const runSha256 = sha256(canonicalJsonBytes(runPreimage));
  const runPath = `.local/cleaned/runs/${runSha256}`;
  const catalogEntries = sources.map((source) => projectCatalogEntry(source, runSha256));
  const catalogBytes = Buffer.concat(
    catalogEntries.map((entry) => canonicalJsonDocumentBytes(entry))
  );
  const report = {
    schema_version: "1.0.0",
    run_sha256: runSha256,
    run_preimage: runPreimage
  };
  const reportBytes = canonicalJsonDocumentBytes(report);
  const pointer = {
    schema_version: "1.0.0",
    run_sha256: runSha256,
    run_path: runPath,
    catalog_path: `${runPath}/catalog/sources.jsonl`,
    catalog_sha256: sha256(catalogBytes),
    report_path: `${runPath}/cleaning-report.json`,
    report_sha256: sha256(reportBytes)
  };
  const pointerBytes = canonicalJsonDocumentBytes(pointer);
  const currentPointer = join(rootDir, POINTER_RELATIVE_PATH);

  await mkdir(join(rootDir, runPath, "catalog"), { recursive: true });
  await mkdir(join(rootDir, runPath, "sources"), { recursive: true });
  await mkdir(dirname(currentPointer), { recursive: true });
  for (const record of records) {
    await writeFile(
      join(rootDir, runPath, "sources", `${record.source.source_id}.md`),
      record.bytes
    );
  }
  await writeFile(join(rootDir, pointer.catalog_path), catalogBytes);
  await writeFile(join(rootDir, pointer.report_path), reportBytes);
  await writeFile(currentPointer, pointerBytes);

  return {
    rootDir,
    currentPointer,
    records,
    sources,
    runPreimage,
    runSha256,
    runPath,
    catalogEntries,
    catalogBytes,
    report,
    reportBytes,
    pointer,
    pointerBytes
  };
}

async function rewritePointer(state, pointer, bytes = canonicalJsonDocumentBytes(pointer)) {
  await writeFile(state.currentPointer, bytes);
  state.pointer = pointer;
  state.pointerBytes = bytes;
}

async function rewriteCatalog(state, bytes) {
  await writeFile(join(state.rootDir, state.pointer.catalog_path), bytes);
  const pointer = { ...state.pointer, catalog_sha256: sha256(bytes) };
  await rewritePointer(state, pointer);
}

async function rewriteReport(state, report, bytes = canonicalJsonDocumentBytes(report)) {
  await writeFile(join(state.rootDir, state.pointer.report_path), bytes);
  const pointer = { ...state.pointer, report_sha256: sha256(bytes) };
  await rewritePointer(state, pointer);
}

function expectedFailure(code, path, sourceId = null) {
  return {
    ok: false,
    error: {
      kind: "expected",
      code,
      path,
      source_id: sourceId,
      persistent_writes_occurred: false
    }
  };
}

async function assertLocalInvalid(state, options = {}) {
  const result = await readCleaningState({
    rootDir: state.rootDir,
    currentPointer: state.currentPointer,
    ...options
  });
  assert.equal(result.ok, false);
  assert.equal(result.error.kind, "expected");
  assert.equal(result.error.code, "LOCAL_STATE_INVALID");
  assert.equal(result.error.persistent_writes_occurred, false);
  return result;
}

test("strict reader returns the exact verified two-source snapshot and readonly selected map", async (t) => {
  const state = await materializeState(t);
  const additionalPath = ".local/original/synthetic/additional.bin";
  const additionalBytes = Buffer.from("additional synthetic bytes");
  await mkdir(dirname(join(state.rootDir, additionalPath)), { recursive: true });
  await writeFile(join(state.rootDir, additionalPath), additionalBytes);

  let callbackBytes = null;
  const result = await readCleaningState({
    rootDir: state.rootDir,
    currentPointer: POINTER_RELATIVE_PATH,
    selectedSourceIds: [SOURCE_A, SOURCE_B],
    readAdditionalArtifacts: async ({ readVerifiedArtifact }) => {
      callbackBytes = await readVerifiedArtifact({
        repoRelativePath: additionalPath,
        expectedSha256: sha256(additionalBytes),
        maxBytes: 1024
      });
      return { marker: "callback-result" };
    }
  });

  assert.equal(result.ok, true);
  assert.deepEqual(Object.keys(result.value).sort(), [
    "additional_result",
    "catalog_bytes",
    "catalog_entries",
    "pointer",
    "pointer_bytes",
    "report",
    "report_bytes",
    "selected_output_bytes"
  ]);
  assert.deepEqual(result.value.pointer_bytes, state.pointerBytes);
  assert.deepEqual(result.value.pointer, state.pointer);
  assert.deepEqual(result.value.catalog_bytes, state.catalogBytes);
  assert.deepEqual(result.value.catalog_entries, state.catalogEntries);
  assert.deepEqual(result.value.report_bytes, state.reportBytes);
  assert.deepEqual(result.value.report, state.report);
  assert.deepEqual(result.value.additional_result, { marker: "callback-result" });
  assert.deepEqual(callbackBytes, additionalBytes);

  const selected = result.value.selected_output_bytes;
  assert.equal(selected.size, 2);
  assert.equal(typeof selected.get, "function");
  assert.equal(typeof selected.has, "function");
  assert.equal(typeof selected.keys, "function");
  assert.equal(typeof selected.values, "function");
  assert.equal(typeof selected.entries, "function");
  assert.equal(typeof selected.forEach, "function");
  assert.equal(typeof selected[Symbol.iterator], "function");
  assert.equal(selected.set, undefined);
  assert.equal(selected.delete, undefined);
  assert.equal(selected.clear, undefined);
  assert.deepEqual([...selected.keys()], [SOURCE_A, SOURCE_B]);
  assert.deepEqual([...selected.values()], [CLEAN_OUTPUT, REVIEW_OUTPUT]);
  assert.deepEqual([...selected], [
    [SOURCE_A, CLEAN_OUTPUT],
    [SOURCE_B, REVIEW_OUTPUT]
  ]);
  const seen = [];
  selected.forEach((value, key, map) => seen.push([key, value, map === selected]));
  assert.deepEqual(seen, [
    [SOURCE_A, CLEAN_OUTPUT, true],
    [SOURCE_B, REVIEW_OUTPUT, true]
  ]);

  selected.get(SOURCE_A)[0] = 0x5a;
  assert.deepEqual(
    await readFile(join(state.rootDir, state.runPath, "sources", `${SOURCE_A}.md`)),
    CLEAN_OUTPUT
  );
  assert.deepEqual(state.records[0].bytes, CLEAN_OUTPUT);
});

test("strict reader accepts an empty RunPreimage and zero-byte catalog", async (t) => {
  const state = await materializeState(t, []);
  const result = await readCleaningState({
    rootDir: state.rootDir,
    currentPointer: state.currentPointer
  });

  assert.equal(result.ok, true);
  assert.deepEqual(result.value.catalog_entries, []);
  assert.equal(result.value.catalog_bytes.length, 0);
  assert.equal(result.value.selected_output_bytes.size, 0);
  assert.equal(result.value.additional_result, null);
});

test("strict reader rejects malformed top-level arguments as programmer TypeErrors", async (t) => {
  const state = await materializeState(t);
  const valid = { rootDir: state.rootDir, currentPointer: state.currentPointer };
  const invalidCalls = [
    () => readCleaningState(),
    () => readCleaningState(null),
    () => readCleaningState({ ...valid, rootDir: null }),
    () => readCleaningState({ ...valid, currentPointer: null }),
    () => readCleaningState({ ...valid, currentPointer: ".local/state/other.json" }),
    () => readCleaningState({ ...valid, selectedSourceIds: null }),
    () => readCleaningState({ ...valid, selectedSourceIds: ["bad"] }),
    () => readCleaningState({ ...valid, selectedSourceIds: [SOURCE_B, SOURCE_A] }),
    () => readCleaningState({ ...valid, selectedSourceIds: [SOURCE_A, SOURCE_A] }),
    () => readCleaningState({ ...valid, readAdditionalArtifacts: true })
  ];

  for (const invoke of invalidCalls) {
    await assert.rejects(invoke, TypeError);
  }
});

test("well-formed unregistered selected source is INVALID_CLEANING_INPUT", async (t) => {
  const state = await materializeState(t);
  const missingId = "src_ffffffffffffffffffffffffffffffff";
  const result = await readCleaningState({
    rootDir: state.rootDir,
    currentPointer: state.currentPointer,
    selectedSourceIds: [missingId]
  });

  assert.deepEqual(
    result,
    expectedFailure("INVALID_CLEANING_INPUT", null, missingId)
  );
});

test("pointer, report, and catalog require exact canonical bytes", async (t) => {
  await t.test("pointer non-canonical bytes", async (t) => {
    const state = await materializeState(t);
    await rewritePointer(state, state.pointer, Buffer.from(`${JSON.stringify(state.pointer, null, 2)}\n`));
    await assertLocalInvalid(state);
  });
  await t.test("report non-canonical bytes", async (t) => {
    const state = await materializeState(t);
    await rewriteReport(
      state,
      state.report,
      Buffer.from(`${JSON.stringify(state.report, null, 2)}\n`)
    );
    await assertLocalInvalid(state);
  });
  await t.test("catalog non-canonical line", async (t) => {
    const state = await materializeState(t);
    const bytes = Buffer.concat([
      Buffer.from(`${JSON.stringify(state.catalogEntries[0], null, 2)}\n`),
      canonicalJsonDocumentBytes(state.catalogEntries[1])
    ]);
    await rewriteCatalog(state, bytes);
    await assertLocalInvalid(state);
  });
});

test("pointer, report, and catalog reject missing or unknown schema keys", async (t) => {
  const cases = [
    ["pointer unknown", async (state) => rewritePointer(state, { ...state.pointer, unknown: true })],
    ["pointer missing", async (state) => {
      const pointer = { ...state.pointer };
      delete pointer.report_sha256;
      await rewritePointer(state, pointer);
    }],
    ["report unknown", async (state) => rewriteReport(state, { ...state.report, unknown: true })],
    ["report missing", async (state) => {
      const report = { ...state.report };
      delete report.run_preimage;
      await rewriteReport(state, report);
    }],
    ["catalog unknown", async (state) => {
      const entries = structuredClone(state.catalogEntries);
      entries[0].unknown = true;
      await rewriteCatalog(state, Buffer.concat(entries.map(canonicalJsonDocumentBytes)));
    }],
    ["catalog missing", async (state) => {
      const entries = structuredClone(state.catalogEntries);
      delete entries[0].title;
      await rewriteCatalog(state, Buffer.concat(entries.map(canonicalJsonDocumentBytes)));
    }]
  ];

  for (const [label, mutate] of cases) {
    await t.test(label, async (t) => {
      const state = await materializeState(t);
      await mutate(state);
      await assertLocalInvalid(state);
    });
  }
});

test("pointer hashes and every derived persisted path are cross-validated", async (t) => {
  const cases = [
    ["wrong catalog hash", (state) => ({ ...state.pointer, catalog_sha256: "0".repeat(64) })],
    ["wrong report hash", (state) => ({ ...state.pointer, report_sha256: "0".repeat(64) })],
    ["wrong run path", (state) => ({ ...state.pointer, run_path: ".local/cleaned/runs/wrong" })],
    ["wrong catalog path", (state) => ({ ...state.pointer, catalog_path: `${state.runPath}/catalog/other.jsonl` })],
    ["wrong report path", (state) => ({ ...state.pointer, report_path: `${state.runPath}/other.json` })]
  ];
  for (const [label, mutate] of cases) {
    await t.test(label, async (t) => {
      const state = await materializeState(t);
      await rewritePointer(state, mutate(state));
      await assertLocalInvalid(state);
    });
  }
});

test("catalog physical framing rejects blank lines, missing LF, and oversized lines", async (t) => {
  await t.test("blank line", async (t) => {
    const state = await materializeState(t);
    await rewriteCatalog(state, Buffer.concat([state.catalogBytes, Buffer.from("\n")]));
    await assertLocalInvalid(state);
  });
  await t.test("missing terminal LF", async (t) => {
    const state = await materializeState(t);
    await rewriteCatalog(state, state.catalogBytes.subarray(0, state.catalogBytes.length - 1));
    await assertLocalInvalid(state);
  });
  await t.test("physical line over one MiB", async (t) => {
    const state = await materializeState(t);
    const bytes = Buffer.concat([
      Buffer.alloc(MAX_CATALOG_LINE_BYTES, 0x61),
      Buffer.from("\n")
    ]);
    await rewriteCatalog(state, bytes);
    await assertLocalInvalid(state);
  });
});

test("report and catalog reject duplicate or unsorted source IDs", async (t) => {
  await t.test("unsorted report IDs", async (t) => {
    const records = makeValidRecords().reverse();
    const state = await materializeState(t, records);
    await assertLocalInvalid(state);
  });
  await t.test("duplicate report IDs", async (t) => {
    const records = makeValidRecords();
    records[1].source.source_id = SOURCE_A;
    records[1].source.cleaned_relative_path = `sources/${SOURCE_A}.md`;
    const state = await materializeState(t, records);
    await assertLocalInvalid(state);
  });
  await t.test("unsorted catalog IDs", async (t) => {
    const state = await materializeState(t);
    await rewriteCatalog(
      state,
      Buffer.concat([...state.catalogEntries].reverse().map(canonicalJsonDocumentBytes))
    );
    await assertLocalInvalid(state);
  });
  await t.test("duplicate catalog IDs", async (t) => {
    const state = await materializeState(t);
    await rewriteCatalog(
      state,
      Buffer.concat([
        canonicalJsonDocumentBytes(state.catalogEntries[0]),
        canonicalJsonDocumentBytes(state.catalogEntries[0])
      ])
    );
    await assertLocalInvalid(state);
  });
});

test("catalog is only the exact pure projection of report RunPreimage", async (t) => {
  const state = await materializeState(t);
  const entries = structuredClone(state.catalogEntries);
  entries[0].title = "projection drift";
  await rewriteCatalog(state, Buffer.concat(entries.map(canonicalJsonDocumentBytes)));
  await assertLocalInvalid(state);
});

test("RunPreimage source schema rejects invalid enums, scalar types, and cleaner drift", async (t) => {
  const mutations = [
    ["source kind", (source) => { source.source_kind = "file"; }],
    ["snapshot version", (source) => { source.snapshot_version = 0; }],
    ["content mode", (source) => { source.content_mode = "video"; }],
    ["ingest status", (source) => { source.ingest_status = "fetch_failed"; }],
    ["cleaning status", (source) => { source.cleaning_status = "ready"; }],
    ["processing status", (source) => { source.processing_status = "fetch_failed"; }],
    ["publication policy", (source) => { source.publication_policy = "public"; }],
    ["body image URL type", (source) => { source.body_image_urls = [1]; }],
    ["cleaner version drift", (source) => { source.cleaner_version = "other-cleaner"; }],
    ["original path traversal", (source) => { source.original_path = ".local/original/../escape.md"; }],
    ["cleaned relative path drift", (source) => { source.cleaned_relative_path = "sources/wrong.md"; }]
  ];
  for (const [label, mutate] of mutations) {
    await t.test(label, async (t) => {
      const records = makeValidRecords();
      mutate(records[0].source);
      const state = await materializeState(t, records);
      await assertLocalInvalid(state);
    });
  }
});

test("warning and change ledgers enforce exact closed schemas", async (t) => {
  const mutations = [
    ["lowercase warning", (source) => { source.warnings = ["bad_warning"]; }],
    ["duplicate warning", (source) => { source.warnings = ["DUP", "DUP"]; }],
    ["unknown change key", (source) => {
      source.changes = [{
        ruleId: "NBSP_NORMALIZATION_V1",
        kind: "normalize",
        sourceLines: [1],
        beforeSha256: "3".repeat(64),
        afterSha256: "4".repeat(64),
        extra: true
      }];
    }],
    ["invalid change kind", (source) => {
      source.changes = [{
        ruleId: "NBSP_NORMALIZATION_V1",
        kind: "replace",
        sourceLines: [1],
        beforeSha256: "3".repeat(64),
        afterSha256: "4".repeat(64)
      }];
    }],
    ["invalid change line ordering", (source) => {
      source.changes = [{
        ruleId: "NBSP_NORMALIZATION_V1",
        kind: "normalize",
        sourceLines: [2, 1],
        beforeSha256: "3".repeat(64),
        afterSha256: "4".repeat(64)
      }];
    }]
  ];
  for (const [label, mutate] of mutations) {
    await t.test(label, async (t) => {
      const records = makeValidRecords();
      mutate(records[0].source);
      const state = await materializeState(t, records);
      await assertLocalInvalid(state);
    });
  }
});

test("change ruleId has one exact kind across every legal rule category", async (t) => {
  for (const [ruleId, kind] of CHANGE_RULE_KIND_CASES) {
    await t.test(`${ruleId} accepts only ${kind}`, async (t) => {
      const records = makeValidRecords();
      records[0].source.changes = [makeChange(ruleId, kind)];
      const state = await materializeState(t, records);
      const result = await readCleaningState({
        rootDir: state.rootDir,
        currentPointer: state.currentPointer
      });
      assert.equal(result.ok, true);
    });
  }
});

test("change ruleId rejects every cross-paired kind", async (t) => {
  const kinds = ["delete", "normalize", "append_eof"];
  for (const [ruleId, validKind] of CHANGE_RULE_KIND_CASES) {
    for (const wrongKind of kinds.filter((kind) => kind !== validKind)) {
      await t.test(`${ruleId} rejects ${wrongKind}`, async (t) => {
        const records = makeValidRecords();
        records[0].source.changes = [makeChange(ruleId, wrongKind)];
        const state = await materializeState(t, records);
        await assertLocalInvalid(state);
      });
    }
  }
});

function rebindAudit(source) {
  source.audit_sha256 = sha256(canonicalJsonBytes(source.audit));
  source.review_state_bound_audit_sha256 = source.audit_sha256;
}

test("audit schema, canonical hash, ranges, ordering, spans, and containment fail closed", async (t) => {
  const mutations = [
    ["audit hash", (source) => { source.audit_sha256 = "0".repeat(64); source.review_state_bound_audit_sha256 = source.audit_sha256; }],
    ["audit unknown key", (source) => { source.audit.unknown = true; rebindAudit(source); }],
    ["audit missing key", (source) => { delete source.audit.body_output_span; rebindAudit(source); }],
    ["out-of-range span", (source) => { source.audit.retained_spans[2].output_span.end = CLEAN_OUTPUT.length + 1; rebindAudit(source); }],
    ["zero-length span", (source) => { source.audit.retained_spans[0].source_span.end = 0; rebindAudit(source); }],
    ["retained span order", (source) => { source.audit.retained_spans.reverse(); rebindAudit(source); }],
    ["image ordinal", (source) => { source.audit.image_spans[0].ordinal = 0; rebindAudit(source); }],
    ["image URL declaration", (source) => { source.audit.image_spans[0].url_sha256 = "0".repeat(64); rebindAudit(source); }],
    ["image containment", (source) => { source.audit.image_spans[0].output_token_span = span(1, 3); rebindAudit(source); }],
    ["hard-break width", (source) => { source.audit.hard_breaks[0].output_span = span(11, 12); rebindAudit(source); }],
    ["metadata preserved", (source) => { source.audit.metadata_spans.title.preserved = false; rebindAudit(source); }],
    ["body span overlaps fixed metadata", (source) => { source.audit.body_output_span.start = 0; rebindAudit(source); }],
    ["body range", (source) => { source.audit.body_output_span.end = CLEAN_OUTPUT.length + 1; rebindAudit(source); }],
    ["ordered images flag", (source) => { source.audit.ordered_body_images_preserved = false; rebindAudit(source); }]
  ];
  for (const [label, mutate] of mutations) {
    await t.test(label, async (t) => {
      const records = makeValidRecords();
      mutate(records[0].source);
      const state = await materializeState(t, records);
      await assertLocalInvalid(state);
    });
  }

  await t.test("positive non-contiguous image ordinal remains valid", async (t) => {
    const records = makeValidRecords();
    records[0].source.audit.image_spans[0].ordinal = 7;
    rebindAudit(records[0].source);
    const state = await materializeState(t, records);
    const result = await readCleaningState({
      rootDir: state.rootDir,
      currentPointer: state.currentPointer
    });
    assert.equal(result.ok, true);
  });
});

test("audit metadata spans and body count enforce structural bounds", async (t) => {
  const mutations = [
    ["metadata source spans overlap", (source) => {
      source.audit.metadata_spans.author.source_span =
        structuredClone(source.audit.metadata_spans.title.source_span);
    }],
    ["metadata output spans overlap", (source) => {
      source.audit.metadata_spans.author.output_span =
        structuredClone(source.audit.metadata_spans.title.output_span);
    }],
    ["zero-length body rejects nonzero count", (source) => {
      source.body_image_urls = [];
      source.content_mode = "text";
      source.audit.image_spans = [];
      source.audit.body_output_span = span(15, 15);
      source.audit.body_non_whitespace_code_points = 1;
    }],
    ["body count cannot exceed non-image body bytes", (source) => {
      source.audit.body_non_whitespace_code_points = 6;
    }]
  ];

  for (const [label, mutate] of mutations) {
    await t.test(label, async (t) => {
      const records = makeValidRecords();
      mutate(records[0].source);
      rebindAudit(records[0].source);
      const state = await materializeState(t, records);
      await assertLocalInvalid(state);
    });
  }
});

test("preserved audit declarations allow unequal valid digest pairs", async (t) => {
  await t.test("metadata before and after digests may differ", async (t) => {
    const records = makeValidRecords();
    records[0].source.audit.metadata_spans.title.after_sha256 = "0".repeat(64);
    rebindAudit(records[0].source);
    const state = await materializeState(t, records);
    const result = await readCleaningState({
      rootDir: state.rootDir,
      currentPointer: state.currentPointer
    });
    assert.equal(result.ok, true);
  });

  await t.test("image source and output digests may differ", async (t) => {
    const records = makeValidRecords();
    records[0].source.audit.image_spans[0].output_sha256 = "0".repeat(64);
    rebindAudit(records[0].source);
    const state = await materializeState(t, records);
    const result = await readCleaningState({
      rootDir: state.rootDir,
      currentPointer: state.currentPointer
    });
    assert.equal(result.ok, true);
  });
});

test("mechanical and reviewer state enforce the four-way binding", async (t) => {
  const mechanicalMutations = [
    ["raw binding", (source) => { source.review_state_bound_raw_sha256 = "0".repeat(64); }],
    ["cleaned binding", (source) => { source.review_state_bound_cleaned_sha256 = "0".repeat(64); }],
    ["audit binding", (source) => { source.review_state_bound_audit_sha256 = "0".repeat(64); }],
    ["cleaner binding", (source) => { source.review_state_bound_cleaner_version = "other"; }],
    ["mechanical version", (source) => { source.review_state_version = 1; }],
    ["mechanical processing", (source) => { source.processing_status = "ready"; }],
    ["mechanical image dominant", (source) => { source.content_mode = "image_dominant"; }]
  ];
  for (const [label, mutate] of mechanicalMutations) {
    await t.test(label, async (t) => {
      const records = makeValidRecords();
      mutate(records[0].source);
      const state = await materializeState(t, records);
      await assertLocalInvalid(state);
    });
  }

  await t.test("valid reviewer-owned binding is accepted", async (t) => {
    const records = makeValidRecords();
    Object.assign(records[0].source, {
      review_state_owner: "reviewer",
      review_state_version: 3,
      processing_status: "ready",
      content_mode: "image_dominant"
    });
    const state = await materializeState(t, records);
    const result = await readCleaningState({
      rootDir: state.rootDir,
      currentPointer: state.currentPointer
    });
    assert.equal(result.ok, true);
  });

  await t.test("reviewer version zero is invalid", async (t) => {
    const records = makeValidRecords();
    Object.assign(records[0].source, {
      review_state_owner: "reviewer",
      review_state_version: 0,
      processing_status: "ready"
    });
    const state = await materializeState(t, records);
    await assertLocalInvalid(state);
  });
});

test("cleaning-status audit and no-op bindings are exact", async (t) => {
  await t.test("cleaned requires audit", async (t) => {
    const records = makeValidRecords();
    records[0].source.audit = null;
    records[0].source.audit_sha256 = null;
    records[0].source.review_state_bound_audit_sha256 = null;
    const state = await materializeState(t, records);
    await assertLocalInvalid(state);
  });
  await t.test("needs_review requires null audit", async (t) => {
    const records = makeValidRecords();
    records[1].source.audit = makeAudit();
    records[1].source.audit_sha256 = sha256(canonicalJsonBytes(records[1].source.audit));
    records[1].source.review_state_bound_audit_sha256 = records[1].source.audit_sha256;
    const state = await materializeState(t, records);
    await assertLocalInvalid(state);
  });
  await t.test("needs_review raw and cleaned hashes must match", async (t) => {
    const records = makeValidRecords();
    records[1].source.raw_sha256 = "0".repeat(64);
    records[1].source.review_state_bound_raw_sha256 = records[1].source.raw_sha256;
    const state = await materializeState(t, records);
    await assertLocalInvalid(state);
  });
  await t.test("needs_review requires all-null extracted metadata", async (t) => {
    const records = makeValidRecords();
    records[1].source.title = "must not survive a no-op failure";
    const state = await materializeState(t, records);
    await assertLocalInvalid(state);
  });
});

test("missing pointer, catalog, report, and requested output have exact missing failures", async (t) => {
  await t.test("pointer", async (t) => {
    const rootDir = await mkdtemp(join(tmpdir(), "missing-cleaning-pointer-"));
    t.after(() => rm(rootDir, { recursive: true, force: true }));
    const result = await readCleaningState({
      rootDir,
      currentPointer: POINTER_RELATIVE_PATH
    });
    assert.deepEqual(result, expectedFailure("LOCAL_STATE_MISSING", POINTER_RELATIVE_PATH));
  });
  await t.test("catalog", async (t) => {
    const state = await materializeState(t);
    await unlink(join(state.rootDir, state.pointer.catalog_path));
    const result = await readCleaningState({ rootDir: state.rootDir, currentPointer: state.currentPointer });
    assert.deepEqual(result, expectedFailure("LOCAL_STATE_MISSING", state.pointer.catalog_path));
  });
  await t.test("report", async (t) => {
    const state = await materializeState(t);
    await unlink(join(state.rootDir, state.pointer.report_path));
    const result = await readCleaningState({ rootDir: state.rootDir, currentPointer: state.currentPointer });
    assert.deepEqual(result, expectedFailure("LOCAL_STATE_MISSING", state.pointer.report_path));
  });
  await t.test("selected output", async (t) => {
    const state = await materializeState(t);
    const outputPath = `${state.runPath}/sources/${SOURCE_A}.md`;
    await unlink(join(state.rootDir, outputPath));
    const result = await readCleaningState({
      rootDir: state.rootDir,
      currentPointer: state.currentPointer,
      selectedSourceIds: [SOURCE_A]
    });
    assert.deepEqual(result, expectedFailure("LOCAL_STATE_MISSING", outputPath, SOURCE_A));
  });
});

test("selected outputs reject hash mismatch, non-regular leaves, symlink leaves, and symlink parents", async (t) => {
  await t.test("hash mismatch", async (t) => {
    const state = await materializeState(t);
    const outputPath = `${state.runPath}/sources/${SOURCE_A}.md`;
    await writeFile(join(state.rootDir, outputPath), Buffer.from("tampered"));
    const failure = await assertLocalInvalid(state, { selectedSourceIds: [SOURCE_A] });
    assert.equal(failure.error.path, outputPath);
    assert.equal(failure.error.source_id, SOURCE_A);
  });
  await t.test("directory leaf", async (t) => {
    const state = await materializeState(t);
    const outputPath = join(state.rootDir, state.runPath, "sources", `${SOURCE_A}.md`);
    await unlink(outputPath);
    await mkdir(outputPath);
    await assertLocalInvalid(state, { selectedSourceIds: [SOURCE_A] });
  });
  await t.test("symlink leaf", async (t) => {
    const state = await materializeState(t);
    const sourcesDir = join(state.rootDir, state.runPath, "sources");
    const outputPath = join(sourcesDir, `${SOURCE_A}.md`);
    await unlink(outputPath);
    await symlink(`${SOURCE_B}.md`, outputPath);
    await assertLocalInvalid(state, { selectedSourceIds: [SOURCE_A] });
  });
  await t.test("symlink parent", async (t) => {
    const state = await materializeState(t);
    const sourcesDir = join(state.rootDir, state.runPath, "sources");
    const movedDir = join(state.rootDir, state.runPath, "real-sources");
    await rename(sourcesDir, movedDir);
    await symlink("real-sources", sourcesDir);
    await assertLocalInvalid(state, { selectedSourceIds: [SOURCE_A] });
  });
});

test("actual FIFO and Unix-socket selected leaves fail closed without blocking", async (t) => {
  await t.test("FIFO is bounded and returns exact LOCAL_STATE_INVALID", async (t) => {
    const state = await materializeState(t);
    const outputPath = `${state.runPath}/sources/${SOURCE_A}.md`;
    const absoluteOutputPath = join(state.rootDir, outputPath);
    await unlink(absoluteOutputPath);
    const mkfifo = await runBoundedChild("/usr/bin/mkfifo", [absoluteOutputPath]);
    assert.deepEqual(
      { code: mkfifo.code, timedOut: mkfifo.timedOut, stderr: mkfifo.stderr },
      { code: 0, timedOut: false, stderr: "" }
    );

    const child = await runBoundedChild(
      process.execPath,
      readerChildArgs(state, [SOURCE_A]),
      2_000
    );
    assert.equal(child.timedOut, false, `FIFO reader timed out: ${child.stderr}`);
    assert.equal(child.code, 0, child.stderr);
    assert.deepEqual(
      JSON.parse(child.stdout),
      expectedFailure("LOCAL_STATE_INVALID", outputPath, SOURCE_A)
    );
  });

  await t.test("Unix socket is exact LOCAL_STATE_INVALID", async (t) => {
    const state = await materializeState(t);
    const socketPath = ".local/socket-leaf";
    const absoluteSocketPath = join(state.rootDir, socketPath);

    const server = createServer();
    await new Promise((resolve, reject) => {
      server.once("error", reject);
      server.listen(absoluteSocketPath, resolve);
    });
    t.after(() => new Promise((resolve, reject) => {
      server.close((error) => error === undefined ? resolve() : reject(error));
    }));

    const result = await readCleaningState({
      rootDir: state.rootDir,
      currentPointer: state.currentPointer,
      readAdditionalArtifacts: ({ readVerifiedArtifact }) => readVerifiedArtifact({
        repoRelativePath: socketPath,
        expectedSha256: "0".repeat(64),
        maxBytes: 1
      })
    });
    assert.deepEqual(
      result,
      expectedFailure("LOCAL_STATE_INVALID", socketPath)
    );
  });
});

test("leaf replacement after regular pre-lstat but before open is LOCAL_STATE_INVALID", async (t) => {
  const state = await materializeState(t, makeValidRecords(), {
    rootPrefix: "/tmp/strict-state-race-"
  });
  const child = await runBoundedChild(process.execPath, [
    "--input-type=module",
    "--eval",
    RACING_SOCKET_CHILD_SCRIPT,
    CLEANING_STATE_MODULE_URL,
    state.rootDir,
    state.currentPointer
  ], 3_000);

  assert.equal(child.timedOut, false, child.stderr);
  assert.equal(child.code, 0, child.stderr);
  const observed = JSON.parse(child.stdout);
  assert.deepEqual(
    {
      pre_lstat_saw_regular: observed.pre_lstat_saw_regular,
      replacement_published: observed.replacement_published
    },
    {
      pre_lstat_saw_regular: true,
      replacement_published: true
    }
  );
  assert.deepEqual(
    observed.result,
    expectedFailure("LOCAL_STATE_INVALID", POINTER_RELATIVE_PATH)
  );
});

test("pointer symlink and persisted traversal corruption are LOCAL_STATE_INVALID", async (t) => {
  await t.test("pointer symlink", async (t) => {
    const state = await materializeState(t);
    const realPointer = join(dirname(state.currentPointer), "real-pointer.json");
    await rename(state.currentPointer, realPointer);
    await symlink("real-pointer.json", state.currentPointer);
    await assertLocalInvalid(state);
  });
  await t.test("persisted traversal", async (t) => {
    const state = await materializeState(t);
    await rewritePointer(state, {
      ...state.pointer,
      report_path: `${state.runPath}/../escape.json`
    });
    await assertLocalInvalid(state);
  });
});

test("sparse pointer, catalog, report, and selected output limits fail before content reads", async (t) => {
  const cases = [
    ["pointer", MAX_POINTER_BYTES + 1, (state) => state.currentPointer, {}],
    ["catalog", MAX_CATALOG_BYTES + 1, (state) => join(state.rootDir, state.pointer.catalog_path), {}],
    ["report", MAX_REPORT_BYTES + 1, (state) => join(state.rootDir, state.pointer.report_path), {}],
    ["output", MAX_OUTPUT_BYTES + 1, (state) => join(state.rootDir, state.runPath, "sources", `${SOURCE_A}.md`), { selectedSourceIds: [SOURCE_A] }]
  ];
  for (const [label, size, pathFor, options] of cases) {
    await t.test(label, async (t) => {
      const state = await materializeState(t);
      await truncate(pathFor(state), size);
      await assertLocalInvalid(state, options);
    });
  }
});

test("selected-output aggregate limit is checked across the whole sparse set", async (t) => {
  const records = [];
  const selectedSourceIds = [];
  for (let index = 0; index < 17; index += 1) {
    const record = makeNeedsReviewRecord();
    const suffix = (index + 1).toString(16).padStart(32, "0");
    record.source.source_id = `src_${suffix}`;
    record.source.cleaned_relative_path = `sources/src_${suffix}.md`;
    record.source.original_path = `.local/original/synthetic/src_${suffix}.md`;
    records.push(record);
    selectedSourceIds.push(record.source.source_id);
  }
  const state = await materializeState(t, records);
  for (const sourceId of selectedSourceIds) {
    await truncate(
      join(state.rootDir, state.runPath, "sources", `${sourceId}.md`),
      MAX_OUTPUT_BYTES
    );
  }
  await assertLocalInvalid(state, { selectedSourceIds });
});

test("high-cardinality tiny selected outputs succeed under a lowered descriptor limit", async (t) => {
  const records = [];
  const selectedSourceIds = [];
  for (let index = 1; index <= 96; index += 1) {
    const sourceId = `src_${index.toString(16).padStart(32, "0")}`;
    const record = makeNeedsReviewRecord();
    record.source.source_id = sourceId;
    record.source.cleaned_relative_path = `sources/${sourceId}.md`;
    record.source.original_path = `.local/original/synthetic/${sourceId}.md`;
    records.push(record);
    selectedSourceIds.push(sourceId);
  }
  const state = await materializeState(t, records);

  const child = await runBoundedChild("/bin/sh", [
    "-c",
    'ulimit -n 64; exec "$@"',
    "strict-reader-low-fd",
    process.execPath,
    ...readerChildArgs(state, selectedSourceIds)
  ], 10_000);

  assert.equal(child.timedOut, false, child.stderr);
  assert.equal(child.code, 0, child.stderr);
  assert.deepEqual(JSON.parse(child.stdout), {
    ok: true,
    selected_size: selectedSourceIds.length,
    selected_ids: selectedSourceIds
  });
});

test("additional artifact capability validates exact requests and returns verified copies", async (t) => {
  const state = await materializeState(t);
  const relativePath = ".local/original/synthetic/extra.bin";
  const bytes = Buffer.from("extra");
  await mkdir(dirname(join(state.rootDir, relativePath)), { recursive: true });
  await writeFile(join(state.rootDir, relativePath), bytes);

  const invalidRequests = [
    null,
    {},
    { repoRelativePath: relativePath, expectedSha256: sha256(bytes), maxBytes: 0 },
    { repoRelativePath: relativePath, expectedSha256: sha256(bytes), maxBytes: MAX_OUTPUT_BYTES + 1 },
    { repoRelativePath: relativePath, expectedSha256: "A".repeat(64), maxBytes: 10 },
    { repoRelativePath: "../escape", expectedSha256: sha256(bytes), maxBytes: 10 },
    { repoRelativePath: "/absolute", expectedSha256: sha256(bytes), maxBytes: 10 },
    { repoRelativePath: ".local//extra", expectedSha256: sha256(bytes), maxBytes: 10 },
    { repoRelativePath: ".local/./extra", expectedSha256: sha256(bytes), maxBytes: 10 },
    { repoRelativePath: ".local\\extra", expectedSha256: sha256(bytes), maxBytes: 10 },
    { repoRelativePath: ".local/extra\0x", expectedSha256: sha256(bytes), maxBytes: 10 },
    { repoRelativePath: relativePath, expectedSha256: sha256(bytes), maxBytes: 10, extra: true }
  ];
  for (const request of invalidRequests) {
    await assert.rejects(
      () => readCleaningState({
        rootDir: state.rootDir,
        currentPointer: state.currentPointer,
        readAdditionalArtifacts: ({ readVerifiedArtifact }) => readVerifiedArtifact(request)
      }),
      TypeError
    );
  }
});

test("additional artifacts distinguish missing, hash mismatch, symlink, and hard-size failures", async (t) => {
  await t.test("missing", async (t) => {
    const state = await materializeState(t);
    const relativePath = ".local/original/synthetic/missing.bin";
    const result = await readCleaningState({
      rootDir: state.rootDir,
      currentPointer: state.currentPointer,
      readAdditionalArtifacts: ({ readVerifiedArtifact }) => readVerifiedArtifact({
        repoRelativePath: relativePath,
        expectedSha256: "0".repeat(64),
        maxBytes: 10
      })
    });
    assert.deepEqual(result, expectedFailure("LOCAL_STATE_MISSING", relativePath));
  });
  await t.test("hash mismatch", async (t) => {
    const state = await materializeState(t);
    const relativePath = ".local/original/synthetic/hash.bin";
    await mkdir(dirname(join(state.rootDir, relativePath)), { recursive: true });
    await writeFile(join(state.rootDir, relativePath), "bytes");
    const result = await readCleaningState({
      rootDir: state.rootDir,
      currentPointer: state.currentPointer,
      readAdditionalArtifacts: ({ readVerifiedArtifact }) => readVerifiedArtifact({
        repoRelativePath: relativePath,
        expectedSha256: "0".repeat(64),
        maxBytes: 10
      })
    });
    assert.deepEqual(result, expectedFailure("LOCAL_STATE_INVALID", relativePath));
  });
  await t.test("symlink", async (t) => {
    const state = await materializeState(t);
    const directory = ".local/original/synthetic";
    await mkdir(join(state.rootDir, directory), { recursive: true });
    await writeFile(join(state.rootDir, directory, "target.bin"), "bytes");
    await symlink("target.bin", join(state.rootDir, directory, "link.bin"));
    const relativePath = `${directory}/link.bin`;
    const result = await readCleaningState({
      rootDir: state.rootDir,
      currentPointer: state.currentPointer,
      readAdditionalArtifacts: ({ readVerifiedArtifact }) => readVerifiedArtifact({
        repoRelativePath: relativePath,
        expectedSha256: sha256(Buffer.from("bytes")),
        maxBytes: 10
      })
    });
    assert.deepEqual(result, expectedFailure("LOCAL_STATE_INVALID", relativePath));
  });
  await t.test("sparse hard limit", async (t) => {
    const state = await materializeState(t);
    const relativePath = ".local/original/synthetic/large.bin";
    await mkdir(dirname(join(state.rootDir, relativePath)), { recursive: true });
    await writeFile(join(state.rootDir, relativePath), "x");
    await truncate(join(state.rootDir, relativePath), MAX_OUTPUT_BYTES + 1);
    const result = await readCleaningState({
      rootDir: state.rootDir,
      currentPointer: state.currentPointer,
      readAdditionalArtifacts: ({ readVerifiedArtifact }) => readVerifiedArtifact({
        repoRelativePath: relativePath,
        expectedSha256: "0".repeat(64),
        maxBytes: MAX_OUTPUT_BYTES
      })
    });
    assert.deepEqual(result, expectedFailure("LOCAL_STATE_INVALID", relativePath));
  });
});

test("additional capability rejects the 1025th call and revokes retained access", async (t) => {
  await t.test("1025th call", async (t) => {
    const state = await materializeState(t);
    const relativePath = ".local/original/synthetic/quota.bin";
    const bytes = Buffer.from("q");
    await mkdir(dirname(join(state.rootDir, relativePath)), { recursive: true });
    await writeFile(join(state.rootDir, relativePath), bytes);
    const result = await readCleaningState({
      rootDir: state.rootDir,
      currentPointer: state.currentPointer,
      readAdditionalArtifacts: async ({ readVerifiedArtifact }) => {
        for (let index = 0; index < 1025; index += 1) {
          await readVerifiedArtifact({
            repoRelativePath: relativePath,
            expectedSha256: sha256(bytes),
            maxBytes: 1
          });
        }
      }
    });
    assert.deepEqual(result, expectedFailure("LOCAL_STATE_INVALID", relativePath));
  });

  await t.test("retained capability", async (t) => {
    const state = await materializeState(t);
    let retained = null;
    const result = await readCleaningState({
      rootDir: state.rootDir,
      currentPointer: state.currentPointer,
      readAdditionalArtifacts: ({ readVerifiedArtifact }) => {
        retained = readVerifiedArtifact;
        return "done";
      }
    });
    assert.equal(result.ok, true);
    await assert.rejects(
      () => retained({
        repoRelativePath: ".local/original/synthetic/later.bin",
        expectedSha256: "0".repeat(64),
        maxBytes: 1
      }),
      (error) => error instanceof TypeError && error.code === "READ_WINDOW_CLOSED"
    );
  });
});

test("reader-owned issued failures beat callback throw and choose earliest issuance", async (t) => {
  const state = await materializeState(t);
  const firstPath = ".local/original/synthetic/first-missing.bin";
  const secondPath = ".local/original/synthetic/second-missing.bin";
  const callbackError = new Error("consumer failed");
  const result = await readCleaningState({
    rootDir: state.rootDir,
    currentPointer: state.currentPointer,
    readAdditionalArtifacts: ({ readVerifiedArtifact }) => {
      void readVerifiedArtifact({
        repoRelativePath: firstPath,
        expectedSha256: "0".repeat(64),
        maxBytes: 1
      }).catch(() => {});
      void readVerifiedArtifact({
        repoRelativePath: secondPath,
        expectedSha256: "0".repeat(64),
        maxBytes: 1
      }).catch(() => {});
      throw callbackError;
    }
  });

  assert.deepEqual(result, expectedFailure("LOCAL_STATE_MISSING", firstPath));
});

test("consumer callback exception is re-thrown unchanged when reader state stays valid", async (t) => {
  const state = await materializeState(t);
  const callbackError = new Error("exact callback error");
  await assert.rejects(
    () => readCleaningState({
      rootDir: state.rootDir,
      currentPointer: state.currentPointer,
      readAdditionalArtifacts: () => { throw callbackError; }
    }),
    (error) => error === callbackError
  );
});

test("pointer byte switch, same-byte inode replacement, and disappearance fail the final window", async (t) => {
  await t.test("different bytes", async (t) => {
    const state = await materializeState(t);
    const switched = canonicalJsonDocumentBytes({
      ...state.pointer,
      catalog_sha256: "0".repeat(64)
    });
    const replacement = join(dirname(state.currentPointer), "replacement.json");
    await writeFile(replacement, switched);
    const result = await readCleaningState({
      rootDir: state.rootDir,
      currentPointer: state.currentPointer,
      readAdditionalArtifacts: async () => {
        await rename(replacement, state.currentPointer);
        return "discard me";
      }
    });
    assert.deepEqual(result, expectedFailure("LOCAL_STATE_INVALID", POINTER_RELATIVE_PATH));
  });
  await t.test("same bytes new inode", async (t) => {
    const state = await materializeState(t);
    const replacement = join(dirname(state.currentPointer), "replacement.json");
    await writeFile(replacement, state.pointerBytes);
    const result = await readCleaningState({
      rootDir: state.rootDir,
      currentPointer: state.currentPointer,
      readAdditionalArtifacts: async () => {
        await rename(replacement, state.currentPointer);
      }
    });
    assert.deepEqual(result, expectedFailure("LOCAL_STATE_INVALID", POINTER_RELATIVE_PATH));
  });
  await t.test("deleted before second read", async (t) => {
    const state = await materializeState(t);
    const result = await readCleaningState({
      rootDir: state.rootDir,
      currentPointer: state.currentPointer,
      readAdditionalArtifacts: async () => {
        await unlink(state.currentPointer);
      }
    });
    assert.deepEqual(result, expectedFailure("LOCAL_STATE_MISSING", POINTER_RELATIVE_PATH));
  });
});

test("an unawaited issued additional read settles before pointer-after", async (t) => {
  const state = await materializeState(t);
  const relativePath = ".local/original/synthetic/unawaited.bin";
  const bytes = Buffer.from("unawaited");
  await mkdir(dirname(join(state.rootDir, relativePath)), { recursive: true });
  await writeFile(join(state.rootDir, relativePath), bytes);

  const result = await readCleaningState({
    rootDir: state.rootDir,
    currentPointer: state.currentPointer,
    readAdditionalArtifacts: ({ readVerifiedArtifact }) => {
      void readVerifiedArtifact({
        repoRelativePath: relativePath,
        expectedSha256: sha256(bytes),
        maxBytes: bytes.length
      }).then(() => unlink(state.currentPointer));
      return "callback returned first";
    }
  });

  assert.deepEqual(result, expectedFailure("LOCAL_STATE_MISSING", POINTER_RELATIVE_PATH));
});

test("failure and callback-throw paths perform no persistent writes", async (t) => {
  const state = await materializeState(t);
  const beforePointer = await readFile(state.currentPointer);
  const beforeCatalog = await readFile(join(state.rootDir, state.pointer.catalog_path));
  const callbackError = new Error("no writes");
  await assert.rejects(
    () => readCleaningState({
      rootDir: state.rootDir,
      currentPointer: state.currentPointer,
      readAdditionalArtifacts: () => { throw callbackError; }
    }),
    (error) => error === callbackError
  );
  assert.deepEqual(await readFile(state.currentPointer), beforePointer);
  assert.deepEqual(await readFile(join(state.rootDir, state.pointer.catalog_path)), beforeCatalog);
});

const SOURCE_C = "src_00000000000000000000000000000003";
const PREPARE_RUNS_ROOT = ".local/cleaned/runs";
const SIMPLE_RAW = Buffer.from("abcdefBODY\n", "utf8");

async function loadPrepareApi() {
  const module = await import("../tools/lib/corpus-cleaner.mjs");
  assert.equal(typeof module.prepareCleaningPlan, "function");
  return module.prepareCleaningPlan;
}

async function prepareCleaningPlan(options) {
  const prepare = await loadPrepareApi();
  return prepare(options);
}

function makeInputEntry(sourceId, rawBytes, overrides = {}) {
  return {
    source_id: sourceId,
    raw_bytes: Buffer.from(rawBytes),
    source_kind: "baseline_markdown",
    locator_sha256: sha256(Buffer.from(`locator:${sourceId}`, "utf8")),
    original_path: `.local/original/synthetic/${sourceId}.md`,
    ingest_status: "registered",
    snapshot_version: 1,
    publication_policy: "public_metadata",
    ...overrides
  };
}

function makeSimpleAudit(sourceBytes, outputBytes) {
  const metadataKeys = [
    "title",
    "author",
    "original_status",
    "published_at",
    "location",
    "source_url"
  ];
  const metadataSpans = Object.fromEntries(metadataKeys.map((key, index) => [
    key,
    {
      source_span: span(index, index + 1),
      output_span: span(index, index + 1),
      before_sha256: sha256(sourceBytes.subarray(index, index + 1)),
      after_sha256: sha256(outputBytes.subarray(index, index + 1)),
      preserved: true
    }
  ]));
  const bodyBytes = outputBytes.subarray(6);
  const bodyText = new TextDecoder("utf-8", { fatal: true }).decode(bodyBytes);
  const bodyCodePoints = [...bodyText].filter((character) => !/\s/u.test(character)).length;

  return {
    source_byte_length: sourceBytes.length,
    output_byte_length: outputBytes.length,
    retained_spans: [
      {
        source_line: 1,
        source_span: span(0, sourceBytes.length),
        output_span: span(0, outputBytes.length),
        before_sha256: sha256(sourceBytes),
        after_sha256: sha256(outputBytes)
      }
    ],
    metadata_spans: metadataSpans,
    image_spans: [],
    hard_breaks: [],
    body_output_span: span(6, outputBytes.length),
    ordered_body_images_preserved: true,
    body_non_whitespace_code_points: bodyCodePoints
  };
}

function makeCleanResult(sourceBytes = SIMPLE_RAW, outputBytes = sourceBytes) {
  const output = Buffer.from(outputBytes);
  return {
    status: "cleaned",
    outputBytes: output,
    cleanedMarkdown: output.toString("utf8"),
    metadata: {
      title: "Synthetic title",
      author: "Synthetic author",
      originalStatus: "原创",
      publishedAt: "2026-01-02 03:04",
      location: "Synthetic",
      sourceUrl: "https://mp.weixin.qq.com/s/synthetic"
    },
    bodyImages: [],
    changes: [],
    warnings: [],
    audit: makeSimpleAudit(Buffer.from(sourceBytes), output)
  };
}

function makeImageCleanResult() {
  return {
    status: "cleaned",
    outputBytes: Buffer.from(CLEAN_OUTPUT),
    cleanedMarkdown: CLEAN_OUTPUT.toString("utf8"),
    metadata: {
      title: "A",
      author: "B",
      originalStatus: "C",
      publishedAt: "D",
      location: "E",
      sourceUrl: "F"
    },
    bodyImages: [{ ordinal: 1, alt: "x", url: "u" }],
    changes: [],
    warnings: [],
    audit: makeAudit()
  };
}

function makeNeedsReviewResult(rawBytes, warning = "SYNTHETIC_REVIEW") {
  const raw = Buffer.from(rawBytes);
  return {
    status: "needs_review",
    outputBytes: raw,
    cleanedMarkdown: new TextDecoder("utf-8", { fatal: true }).decode(raw),
    metadata: {
      title: null,
      author: null,
      originalStatus: null,
      publishedAt: null,
      location: null,
      sourceUrl: null
    },
    bodyImages: [],
    changes: [],
    warnings: [warning],
    audit: null
  };
}

function cloneCleanResult(result) {
  return {
    status: result.status,
    outputBytes: Buffer.from(result.outputBytes),
    cleanedMarkdown: result.cleanedMarkdown,
    metadata: structuredClone(result.metadata),
    bodyImages: structuredClone(result.bodyImages),
    changes: structuredClone(result.changes),
    warnings: [...result.warnings],
    audit: result.audit === null ? null : structuredClone(result.audit)
  };
}

function cleanerFor(resultsBySourceId, calls = []) {
  return async ({ sourceId, rawBytes }) => {
    calls.push({ sourceId, rawBytes: Buffer.from(rawBytes) });
    const result = resultsBySourceId.get(sourceId);
    assert.notEqual(result, undefined, `unexpected cleaner source ${sourceId}`);
    return cloneCleanResult(result);
  };
}

function prepareOptions(rootDir, inputEntries, cleanSource, overrides = {}) {
  return {
    rootDir,
    inputEntries,
    additionSourceIds: [],
    cleanerVersion: CLEANER_VERSION,
    runsRoot: PREPARE_RUNS_ROOT,
    currentPointer: POINTER_RELATIVE_PATH,
    stateMode: "initial_verified_baseline",
    strict: false,
    cleanSource,
    ...overrides
  };
}

function makeIncrementalQuotaInputs(
  count,
  rawBytes,
  originalPath,
  lastOriginalPath = originalPath
) {
  const inputEntries = [];
  const additionSourceIds = [];
  for (let index = 1; index <= count; index += 1) {
    const sourceId = `src_${index.toString(16).padStart(32, "0")}`;
    additionSourceIds.push(sourceId);
    inputEntries.push(makeInputEntry(sourceId, Buffer.alloc(0), {
      raw_bytes: rawBytes,
      original_path: index === count ? lastOriginalPath : originalPath
    }));
  }
  return { inputEntries, additionSourceIds };
}

function expectedInitialSource(input, result) {
  const rawSha256 = sha256(input.raw_bytes);
  const cleanedSha256 = sha256(result.outputBytes);
  const auditSha256 = sha256(canonicalJsonBytes(result.audit));
  return {
    source_id: input.source_id,
    source_kind: input.source_kind,
    locator_sha256: input.locator_sha256,
    original_path: input.original_path,
    raw_sha256: rawSha256,
    cleaned_relative_path: `sources/${input.source_id}.md`,
    cleaned_sha256: cleanedSha256,
    title: result.metadata.title,
    author: result.metadata.author,
    original_status: result.metadata.originalStatus,
    published_at: result.metadata.publishedAt,
    location: result.metadata.location,
    source_url: result.metadata.sourceUrl,
    body_image_urls: result.bodyImages.map(({ url }) => url),
    content_mode: result.bodyImages.length === 0 ? "text" : "mixed",
    ingest_status: input.ingest_status,
    cleaning_status: result.status,
    processing_status: result.status,
    cleaner_version: CLEANER_VERSION,
    snapshot_version: input.snapshot_version,
    publication_policy: input.publication_policy,
    review_state_owner: "mechanical",
    review_state_version: 0,
    review_state_bound_raw_sha256: rawSha256,
    review_state_bound_cleaned_sha256: cleanedSha256,
    review_state_bound_audit_sha256: auditSha256,
    review_state_bound_cleaner_version: CLEANER_VERSION,
    audit: structuredClone(result.audit),
    audit_sha256: auditSha256,
    changes: structuredClone(result.changes),
    warnings: [...result.warnings]
  };
}

function expectedPlanForInitial(input, result) {
  const source = expectedInitialSource(input, result);
  const runPreimage = {
    schema_version: "1.0.0",
    cleaner_version: CLEANER_VERSION,
    sources: [source]
  };
  const runSha256 = sha256(canonicalJsonBytes(runPreimage));
  const runPath = `.local/cleaned/runs/${runSha256}`;
  const catalogEntry = projectCatalogEntry(source, runSha256);
  const catalogBytes = canonicalJsonDocumentBytes(catalogEntry);
  const report = {
    schema_version: "1.0.0",
    run_sha256: runSha256,
    run_preimage: runPreimage
  };
  const reportBytes = canonicalJsonDocumentBytes(report);
  const pointer = {
    schema_version: "1.0.0",
    run_sha256: runSha256,
    run_path: runPath,
    catalog_path: `${runPath}/catalog/sources.jsonl`,
    catalog_sha256: sha256(catalogBytes),
    report_path: `${runPath}/cleaning-report.json`,
    report_sha256: sha256(reportBytes)
  };
  const pointerBytes = canonicalJsonDocumentBytes(pointer);
  const artifacts = [
    {
      relative_path: "catalog/sources.jsonl",
      sha256: sha256(catalogBytes),
      size_bytes: catalogBytes.length,
      bytes: catalogBytes
    },
    {
      relative_path: "cleaning-report.json",
      sha256: sha256(reportBytes),
      size_bytes: reportBytes.length,
      bytes: reportBytes
    },
    {
      relative_path: `sources/${input.source_id}.md`,
      sha256: sha256(result.outputBytes),
      size_bytes: result.outputBytes.length,
      bytes: Buffer.from(result.outputBytes)
    }
  ];
  const artifactManifest = artifacts.map(({ bytes: _bytes, ...entry }) => entry);
  const manifest = {
    schema_version: "1.0.0",
    state_mode: "initial_verified_baseline",
    expected_prior_pointer: null,
    expected_prior_pointer_sha256: null,
    prior_run_sha256: null,
    prior_catalog_sha256: null,
    prior_report_sha256: null,
    prior_source_ids: [],
    run_preimage: runPreimage,
    artifact_manifest: artifactManifest,
    desired_pointer: pointer,
    desired_pointer_sha256: sha256(pointerBytes),
    registered_source_count: 1
  };

  return {
    ok: true,
    value: {
      kind: "prepared",
      plan: {
        manifest,
        manifest_sha256: sha256(canonicalJsonBytes(manifest)),
        artifacts
      },
      persistent_writes_occurred: false
    }
  };
}

function expectedCleanCorpusSummary(plan) {
  return {
    base: {
      expected_prior_pointer: plan.manifest.expected_prior_pointer,
      expected_prior_pointer_sha256: plan.manifest.expected_prior_pointer_sha256,
      prior_run_sha256: plan.manifest.prior_run_sha256,
      prior_catalog_sha256: plan.manifest.prior_catalog_sha256,
      prior_report_sha256: plan.manifest.prior_report_sha256,
      prior_source_ids: [...plan.manifest.prior_source_ids]
    },
    plan_manifest_sha256: plan.manifest_sha256,
    run_sha256: plan.manifest.desired_pointer.run_sha256,
    desired_pointer_sha256: plan.manifest.desired_pointer_sha256,
    desired_pointer: structuredClone(plan.manifest.desired_pointer),
    registered_source_count: plan.manifest.registered_source_count,
    sources: [...plan.manifest.run_preimage.sources]
      .sort((left, right) => compareAscii(left.source_id, right.source_id))
      .map((source) => ({
        source_id: source.source_id,
        cleaning_status: source.cleaning_status,
        processing_status: source.processing_status,
        raw_sha256: source.raw_sha256,
        cleaned_sha256: source.cleaned_sha256,
        audit_sha256: source.audit_sha256,
        warning_codes: [...source.warnings].sort(compareAscii)
      })),
    artifacts: [...plan.manifest.artifact_manifest]
      .sort((left, right) => compareAscii(left.relative_path, right.relative_path))
      .map(({ relative_path: relativePath, sha256, size_bytes }) => ({
        relative_path: relativePath,
        sha256,
        size_bytes
      })),
    conflicts: [],
    persistent_writes_occurred: false
  };
}

async function listTree(rootDir) {
  return (await readdir(rootDir, { recursive: true })).sort();
}

async function writeOriginal(rootDir, input) {
  const absolutePath = join(rootDir, input.original_path);
  await mkdir(dirname(absolutePath), { recursive: true });
  await writeFile(absolutePath, input.raw_bytes);
}

test("B4 publicly exports prepareCleaningPlan without exposing a partial cleanCorpus", async () => {
  const module = await import("../tools/lib/corpus-cleaner.mjs");
  assert.equal(typeof module.prepareCleaningPlan, "function");
  assert.equal(typeof module.cleanCorpus, "function");
});

test("cleanCorpus supports dry-run summary without artifact bytes", async (t) => {
  const rootDir = await mkdtemp(join(tmpdir(), "clean-corpus-dry-run-"));
  t.after(() => rm(rootDir, { recursive: true, force: true }));
  const input = makeInputEntry(SOURCE_A, SIMPLE_RAW);
  const corpusOptions = prepareOptions(rootDir, [input], cleanerFor(new Map([[SOURCE_A, makeCleanResult()]]), []), {
    strict: false,
    stateMode: "initial_verified_baseline"
  });
  const result = await (await import("../tools/lib/corpus-cleaner.mjs")).cleanCorpus({
    ...corpusOptions,
    apply: false
  });
  const planResult = await prepareCleaningPlan(corpusOptions);

  assert.deepEqual(result, {
    ok: true,
    value: {
      kind: "dry_run",
      summary: expectedCleanCorpusSummary(planResult.value.plan)
    }
  });
  assert.deepEqual(await listTree(rootDir), []);
});

test("cleanCorpus apply path stages and publishes a first run", async (t) => {
  const rootDir = await mkdtemp(join(tmpdir(), "clean-corpus-apply-"));
  t.after(() => rm(rootDir, { recursive: true, force: true }));
  const input = makeInputEntry(SOURCE_A, SIMPLE_RAW);
  const result = await (await import("../tools/lib/corpus-cleaner.mjs")).cleanCorpus(prepareOptions(
    rootDir,
    [input],
    cleanerFor(new Map([[SOURCE_A, makeCleanResult()]]), []),
    {
      apply: true,
      strict: false,
      stateMode: "initial_verified_baseline"
    }
  ));
  assert.equal(result.ok, true);
  assert.equal(result.value.kind, "published");
  assert.equal(result.value.publication.kind, "published");
  assert.equal(typeof result.value.publication.plan_manifest_sha256, "string");
  assert.equal(typeof result.value.publication.run_sha256, "string");
  assert.equal(result.value.publication.persistent_writes_occurred, true);
});

test("initial prepare produces the exact deterministic plan golden and performs zero writes", async (t) => {
  const rootDir = await mkdtemp(join(tmpdir(), "prepare-initial-golden-"));
  t.after(() => rm(rootDir, { recursive: true, force: true }));
  const input = makeInputEntry(SOURCE_A, SIMPLE_RAW);
  const result = makeCleanResult();
  const before = await listTree(rootDir);

  const actual = await prepareCleaningPlan(
    prepareOptions(rootDir, [input], cleanerFor(new Map([[SOURCE_A, result]])))
  );

  assert.deepEqual(actual, expectedPlanForInitial(input, result));
  assert.deepEqual(await listTree(rootDir), before);
  assert.equal(Object.isFrozen(actual.value.plan), true);
  assert.equal(Object.isFrozen(actual.value.plan.manifest), true);
  assert.equal(Object.isFrozen(actual.value.plan.manifest.run_preimage.sources), true);
  assert.equal(Object.isFrozen(actual.value.plan.artifacts), true);
});

test("initial prepare copies caller and cleaner bytes before awaits and isolates returned artifacts", async (t) => {
  const rootDir = await mkdtemp(join(tmpdir(), "prepare-copy-isolation-"));
  t.after(() => rm(rootDir, { recursive: true, force: true }));
  const prepare = await loadPrepareApi();
  const callerRaw = Buffer.from(SIMPLE_RAW);
  const input = makeInputEntry(SOURCE_A, callerRaw);
  input.raw_bytes = callerRaw;
  const result = makeCleanResult();
  const expectedRawHash = sha256(SIMPLE_RAW);
  const cleanSource = async ({ sourceId, rawBytes }) => {
    assert.equal(sourceId, SOURCE_A);
    assert.notEqual(rawBytes, callerRaw);
    assert.deepEqual(rawBytes, SIMPLE_RAW);
    rawBytes[0] = 0x7a;
    return result;
  };

  const pending = prepare(prepareOptions(rootDir, [input], cleanSource));
  callerRaw.fill(0x78);
  const actual = await pending;
  assert.equal(actual.ok, true);
  assert.equal(
    actual.value.plan.manifest.run_preimage.sources[0].raw_sha256,
    expectedRawHash
  );
  assert.deepEqual(
    actual.value.plan.artifacts.find(({ relative_path }) => relative_path.startsWith("sources/")).bytes,
    SIMPLE_RAW
  );

  result.outputBytes.fill(0x79);
  result.audit.retained_spans[0].after_sha256 = "0".repeat(64);
  assert.deepEqual(
    actual.value.plan.artifacts.find(({ relative_path }) => relative_path.startsWith("sources/")).bytes,
    SIMPLE_RAW
  );
  assert.notEqual(
    actual.value.plan.manifest.run_preimage.sources[0].audit.retained_spans[0].after_sha256,
    "0".repeat(64)
  );
});

test("initial mode accepts only an absent fixed pointer and an empty additions list", async (t) => {
  await t.test("empty corpus is a valid first plan", async (t) => {
    const rootDir = await mkdtemp(join(tmpdir(), "prepare-empty-initial-"));
    t.after(() => rm(rootDir, { recursive: true, force: true }));
    const result = await prepareCleaningPlan(
      prepareOptions(rootDir, [], cleanerFor(new Map()))
    );
    assert.equal(result.ok, true);
    assert.deepEqual(result.value.plan.manifest.prior_source_ids, []);
    assert.deepEqual(result.value.plan.manifest.run_preimage.sources, []);
    assert.deepEqual(
      result.value.plan.artifacts.map(({ relative_path }) => relative_path),
      ["catalog/sources.jsonl", "cleaning-report.json"]
    );
    assert.equal(result.value.plan.artifacts[0].bytes.length, 0);
    assert.deepEqual(await listTree(rootDir), []);
  });

  await t.test("an existing valid pointer is rejected at the fixed path", async (t) => {
    const state = await materializeState(t, []);
    const result = await prepareCleaningPlan(
      prepareOptions(state.rootDir, [], cleanerFor(new Map()))
    );
    assert.deepEqual(
      result,
      expectedFailure("INVALID_CLEANING_INPUT", POINTER_RELATIVE_PATH)
    );
  });

  await t.test("a pointer symlink propagates LOCAL_STATE_INVALID", async (t) => {
    const state = await materializeState(t, []);
    const realPointer = join(dirname(state.currentPointer), "real-pointer.json");
    await rename(state.currentPointer, realPointer);
    await symlink("real-pointer.json", state.currentPointer);
    const result = await prepareCleaningPlan(
      prepareOptions(state.rootDir, [], cleanerFor(new Map()))
    );
    assert.deepEqual(result, expectedFailure("LOCAL_STATE_INVALID", POINTER_RELATIVE_PATH));
  });

  await t.test("a non-empty initial additions list is rejected after absence proof", async (t) => {
    const rootDir = await mkdtemp(join(tmpdir(), "prepare-initial-additions-"));
    t.after(() => rm(rootDir, { recursive: true, force: true }));
    const input = makeInputEntry(SOURCE_A, SIMPLE_RAW);
    const result = await prepareCleaningPlan(prepareOptions(
      rootDir,
      [input],
      cleanerFor(new Map([[SOURCE_A, makeCleanResult()]])),
      { additionSourceIds: [SOURCE_A] }
    ));
    assert.deepEqual(result, expectedFailure("INVALID_CLEANING_INPUT", null, SOURCE_A));
  });
});

test("prepare rejects programmer misuse before invoking the cleaner", async (t) => {
  const rootDir = await mkdtemp(join(tmpdir(), "prepare-api-misuse-"));
  t.after(() => rm(rootDir, { recursive: true, force: true }));
  let calls = 0;
  const cleanSource = async () => {
    calls += 1;
    return makeCleanResult();
  };
  const valid = prepareOptions(rootDir, [], cleanSource);
  const invalidCalls = [
    () => prepareCleaningPlan(),
    () => prepareCleaningPlan(null),
    () => prepareCleaningPlan({ ...valid, extra: true }),
    () => prepareCleaningPlan({ ...valid, strict: "false" }),
    () => prepareCleaningPlan({ ...valid, stateMode: "bootstrap" }),
    () => prepareCleaningPlan({ ...valid, runsRoot: ".local/other-runs" }),
    () => prepareCleaningPlan({ ...valid, currentPointer: ".local/state/other.json" })
  ];

  for (const invoke of invalidCalls) {
    await assert.rejects(invoke, TypeError);
  }
  assert.equal(calls, 0);
  assert.deepEqual(await listTree(rootDir), []);
});

test("prepare snapshots array data without invoking caller iterators or accessors", async (t) => {
  const rootDir = await mkdtemp(join(tmpdir(), "prepare-array-snapshot-"));
  t.after(() => rm(rootDir, { recursive: true, force: true }));
  let cleanerCalls = 0;
  const cleanSource = async () => {
    cleanerCalls += 1;
    return makeCleanResult();
  };

  await t.test("a custom input iterator cannot hide an invalid element", async () => {
    const inputEntries = [null];
    inputEntries[Symbol.iterator] = function* hiddenIterator() {};
    const result = await prepareCleaningPlan(prepareOptions(
      rootDir,
      inputEntries,
      cleanSource
    ));
    assert.deepEqual(result, expectedFailure("INVALID_CLEANING_INPUT", null));
  });

  await t.test("an input accessor is rejected without being invoked", async () => {
    let getterCalls = 0;
    const inputEntries = [];
    Object.defineProperty(inputEntries, "0", {
      configurable: true,
      enumerable: true,
      get() {
        getterCalls += 1;
        throw new Error("input getter must not run");
      }
    });
    const result = await prepareCleaningPlan(prepareOptions(
      rootDir,
      inputEntries,
      cleanSource
    ));
    assert.deepEqual(result, expectedFailure("INVALID_CLEANING_INPUT", null));
    assert.equal(getterCalls, 0);
  });

  await t.test("a sparse input array is an exact value failure", async () => {
    const result = await prepareCleaningPlan(prepareOptions(
      rootDir,
      new Array(1),
      cleanSource
    ));
    assert.deepEqual(result, expectedFailure("INVALID_CLEANING_INPUT", null));
  });

  await t.test("a custom additions iterator cannot hide a declared source", async () => {
    const additionSourceIds = [SOURCE_A];
    additionSourceIds[Symbol.iterator] = function* hiddenIterator() {};
    const result = await prepareCleaningPlan(prepareOptions(
      rootDir,
      [],
      cleanSource,
      { additionSourceIds }
    ));
    assert.deepEqual(result, expectedFailure("INVALID_CLEANING_INPUT", null, SOURCE_A));
  });

  await t.test("an additions accessor is rejected without being invoked", async () => {
    let getterCalls = 0;
    const additionSourceIds = [];
    Object.defineProperty(additionSourceIds, "0", {
      configurable: true,
      enumerable: true,
      get() {
        getterCalls += 1;
        throw new Error("addition getter must not run");
      }
    });
    const result = await prepareCleaningPlan(prepareOptions(
      rootDir,
      [],
      cleanSource,
      { additionSourceIds }
    ));
    assert.deepEqual(result, expectedFailure("INVALID_CLEANING_INPUT", null));
    assert.equal(getterCalls, 0);
  });

  await t.test("duplicate additions remain an exact value failure", async () => {
    const result = await prepareCleaningPlan(prepareOptions(
      rootDir,
      [],
      cleanSource,
      { additionSourceIds: [SOURCE_A, SOURCE_A] }
    ));
    assert.deepEqual(result, expectedFailure("INVALID_CLEANING_INPUT", null, SOURCE_A));
  });

  await t.test("proxy arrays remain top-level programmer misuse", async () => {
    await assert.rejects(
      () => prepareCleaningPlan(prepareOptions(rootDir, new Proxy([], {}), cleanSource)),
      TypeError
    );
    await assert.rejects(
      () => prepareCleaningPlan(prepareOptions(rootDir, [], cleanSource, {
        additionSourceIds: new Proxy([], {})
      })),
      TypeError
    );
  });

  assert.equal(cleanerCalls, 0);
  assert.deepEqual(await listTree(rootDir), []);
});

test("prepare accepts fixed paths expressed through a symlink root or its real root", async (t) => {
  const container = await mkdtemp(join(tmpdir(), "prepare-root-alias-"));
  t.after(() => rm(container, { recursive: true, force: true }));
  const realRoot = join(container, "real");
  const aliasRoot = join(container, "alias");
  await mkdir(realRoot);
  await symlink("real", aliasRoot);
  const canonicalRoot = await realpath(realRoot);

  const cases = [
    ["relative", PREPARE_RUNS_ROOT, POINTER_RELATIVE_PATH],
    [
      "alias absolute",
      join(aliasRoot, PREPARE_RUNS_ROOT),
      join(aliasRoot, POINTER_RELATIVE_PATH)
    ],
    [
      "real absolute",
      join(canonicalRoot, PREPARE_RUNS_ROOT),
      join(canonicalRoot, POINTER_RELATIVE_PATH)
    ],
    [
      "mixed aliases",
      join(aliasRoot, PREPARE_RUNS_ROOT),
      join(canonicalRoot, POINTER_RELATIVE_PATH)
    ]
  ];

  for (const [label, runsRoot, currentPointer] of cases) {
    await t.test(label, async () => {
      const result = await prepareCleaningPlan(prepareOptions(
        aliasRoot,
        [],
        cleanerFor(new Map()),
        { runsRoot, currentPointer }
      ));
      assert.equal(result.ok, true);
      assert.equal(result.value.plan.manifest.registered_source_count, 0);
    });
  }

  await assert.rejects(
    () => prepareCleaningPlan(prepareOptions(
      aliasRoot,
      [],
      cleanerFor(new Map()),
      { runsRoot: join(realRoot, ".local/not-cleaning-runs") }
    )),
    TypeError
  );

  await t.test("retargeting the caller alias cannot move the reader after validation", async (t) => {
    const otherState = await materializeState(t, []);
    const prepare = await loadPrepareApi();
    const pending = prepare(prepareOptions(
      aliasRoot,
      [],
      cleanerFor(new Map()),
      {
        runsRoot: join(aliasRoot, PREPARE_RUNS_ROOT),
        currentPointer: join(aliasRoot, POINTER_RELATIVE_PATH)
      }
    ));
    unlinkSync(aliasRoot);
    symlinkSync(otherState.rootDir, aliasRoot);
    const result = await pending;
    assert.equal(result.ok, true);
    assert.equal(result.value.plan.manifest.expected_prior_pointer, null);
  });

  assert.deepEqual(await listTree(realRoot), []);
});

test("incremental prepare verifies full prior outputs and originals in one reader window", async (t) => {
  const records = [makeCleanedRecord()];
  Object.assign(records[0].source, {
    review_state_owner: "reviewer",
    review_state_version: 7,
    processing_status: "ready",
    content_mode: "image_dominant"
  });
  const state = await materializeState(t, records);
  const input = makeInputEntry(SOURCE_A, CLEAN_OUTPUT, {
    source_kind: records[0].source.source_kind,
    locator_sha256: records[0].source.locator_sha256,
    original_path: records[0].source.original_path,
    ingest_status: records[0].source.ingest_status,
    snapshot_version: records[0].source.snapshot_version,
    publication_policy: records[0].source.publication_policy
  });
  await writeOriginal(state.rootDir, input);
  const calls = [];

  const result = await prepareCleaningPlan(prepareOptions(
    state.rootDir,
    [input],
    cleanerFor(new Map([[SOURCE_A, makeImageCleanResult()]]), calls),
    { stateMode: "incremental" }
  ));

  assert.equal(result.ok, true);
  assert.deepEqual(calls.map(({ sourceId }) => sourceId), [SOURCE_A]);
  assert.deepEqual(calls[0].rawBytes, CLEAN_OUTPUT);
  assert.deepEqual(result.value.plan.manifest.expected_prior_pointer, state.pointer);
  assert.equal(
    result.value.plan.manifest.expected_prior_pointer_sha256,
    sha256(state.pointerBytes)
  );
  assert.equal(result.value.plan.manifest.prior_run_sha256, state.runSha256);
  assert.equal(result.value.plan.manifest.prior_catalog_sha256, sha256(state.catalogBytes));
  assert.equal(result.value.plan.manifest.prior_report_sha256, sha256(state.reportBytes));
  assert.deepEqual(result.value.plan.manifest.prior_source_ids, [SOURCE_A]);
  assert.deepEqual(
    {
      content_mode: result.value.plan.manifest.run_preimage.sources[0].content_mode,
      processing_status: result.value.plan.manifest.run_preimage.sources[0].processing_status,
      review_state_owner: result.value.plan.manifest.run_preimage.sources[0].review_state_owner,
      review_state_version: result.value.plan.manifest.run_preimage.sources[0].review_state_version
    },
    {
      content_mode: "image_dominant",
      processing_status: "ready",
      review_state_owner: "reviewer",
      review_state_version: 7
    }
  );
});

test("incremental prepare exposes prior-output and original-snapshot failures before cleaning", async (t) => {
  await t.test("missing selected prior output proves the second full-output pass", async (t) => {
    const state = await materializeState(t, [makeCleanedRecord()]);
    const input = makeInputEntry(SOURCE_A, CLEAN_OUTPUT, {
      original_path: state.sources[0].original_path,
      locator_sha256: state.sources[0].locator_sha256
    });
    await writeOriginal(state.rootDir, input);
    await unlink(join(state.rootDir, state.runPath, "sources", `${SOURCE_A}.md`));
    let cleanerCalls = 0;
    const result = await prepareCleaningPlan(prepareOptions(
      state.rootDir,
      [input],
      async () => { cleanerCalls += 1; return makeImageCleanResult(); },
      { stateMode: "incremental" }
    ));
    assert.deepEqual(
      result,
      expectedFailure(
        "LOCAL_STATE_MISSING",
        `${state.runPath}/sources/${SOURCE_A}.md`,
        SOURCE_A
      )
    );
    assert.equal(cleanerCalls, 0);
  });

  await t.test("missing required original remains inside the same pointer window", async (t) => {
    const state = await materializeState(t, [makeCleanedRecord()]);
    const input = makeInputEntry(SOURCE_A, CLEAN_OUTPUT, {
      original_path: state.sources[0].original_path,
      locator_sha256: state.sources[0].locator_sha256
    });
    let cleanerCalls = 0;
    const result = await prepareCleaningPlan(prepareOptions(
      state.rootDir,
      [input],
      async () => { cleanerCalls += 1; return makeImageCleanResult(); },
      { stateMode: "incremental" }
    ));
    assert.deepEqual(result, expectedFailure("LOCAL_STATE_MISSING", input.original_path));
    assert.equal(cleanerCalls, 0);
  });

  await t.test("original hash mismatch retains the reader's canonical path", async (t) => {
    const state = await materializeState(t, [makeCleanedRecord()]);
    const input = makeInputEntry(SOURCE_A, CLEAN_OUTPUT, {
      original_path: state.sources[0].original_path,
      locator_sha256: state.sources[0].locator_sha256
    });
    await writeOriginal(state.rootDir, {
      ...input,
      raw_bytes: Buffer.from("different synthetic snapshot\n")
    });
    let cleanerCalls = 0;
    const result = await prepareCleaningPlan(prepareOptions(
      state.rootDir,
      [input],
      async () => { cleanerCalls += 1; return makeImageCleanResult(); },
      { stateMode: "incremental" }
    ));
    assert.deepEqual(result, expectedFailure("LOCAL_STATE_INVALID", input.original_path));
    assert.equal(cleanerCalls, 0);
  });

  await t.test("original symlink identity fails closed before cleaning", async (t) => {
    const state = await materializeState(t, [makeCleanedRecord()]);
    const input = makeInputEntry(SOURCE_A, CLEAN_OUTPUT, {
      original_path: state.sources[0].original_path,
      locator_sha256: state.sources[0].locator_sha256
    });
    const originalPath = join(state.rootDir, input.original_path);
    await mkdir(dirname(originalPath), { recursive: true });
    await writeFile(join(dirname(originalPath), "target.md"), CLEAN_OUTPUT);
    await symlink("target.md", originalPath);
    let cleanerCalls = 0;
    const result = await prepareCleaningPlan(prepareOptions(
      state.rootDir,
      [input],
      async () => { cleanerCalls += 1; return makeImageCleanResult(); },
      { stateMode: "incremental" }
    ));
    assert.deepEqual(result, expectedFailure("LOCAL_STATE_INVALID", input.original_path));
    assert.equal(cleanerCalls, 0);
  });
});

test("incremental prepare propagates every original-reader capacity boundary", async (t) => {
  async function runCapacityCase(t, {
    count,
    rawBytes,
    originalSize,
    originalPath,
    overflowPath = originalPath
  }) {
    const state = await materializeState(t, []);
    const { inputEntries, additionSourceIds } = makeIncrementalQuotaInputs(
      count,
      rawBytes,
      originalPath,
      overflowPath
    );
    for (const path of new Set([originalPath, overflowPath])) {
      const absoluteOriginal = join(state.rootDir, path);
      await mkdir(dirname(absoluteOriginal), { recursive: true });
      await writeFile(absoluteOriginal, Buffer.alloc(0));
      await truncate(absoluteOriginal, originalSize);
    }
    const beforeTree = await listTree(state.rootDir);
    const beforePointer = await readFile(state.currentPointer);
    let cleanerCalls = 0;

    const result = await prepareCleaningPlan(prepareOptions(
      state.rootDir,
      inputEntries,
      async () => {
        cleanerCalls += 1;
        return makeCleanResult();
      },
      {
        stateMode: "incremental",
        additionSourceIds
      }
    ));

    assert.deepEqual(result, expectedFailure("LOCAL_STATE_INVALID", overflowPath));
    assert.equal(cleanerCalls, 0);
    assert.deepEqual(await readFile(state.currentPointer), beforePointer);
    assert.deepEqual(await listTree(state.rootDir), beforeTree);
  }

  await t.test("one original over 64 MiB fails at the per-item fstat gate", async (t) => {
    const rawBytes = Buffer.alloc(MAX_OUTPUT_BYTES + 1);
    await runCapacityCase(t, {
      count: 1,
      rawBytes,
      originalSize: rawBytes.length,
      originalPath: ".local/original/synthetic/prepare-over-limit.bin"
    });
  });

  await t.test("the 1025th original request fails below the aggregate limit", async (t) => {
    const rawBytes = Buffer.from([0]);
    await runCapacityCase(t, {
      count: 1025,
      rawBytes,
      originalSize: rawBytes.length,
      originalPath: ".local/original/synthetic/prepare-request-quota.bin",
      overflowPath: ".local/original/synthetic/prepare-request-overflow.bin"
    });
  });

  await t.test("the 17th 64 MiB original exceeds the 1 GiB aggregate limit", async (t) => {
    const rawBytes = Buffer.alloc(MAX_OUTPUT_BYTES);
    const fixture = makeIncrementalQuotaInputs(
      17,
      rawBytes,
      ".local/original/synthetic/prepare-aggregate-quota.bin",
      ".local/original/synthetic/prepare-aggregate-overflow.bin"
    );
    assert.equal(
      new Set(fixture.inputEntries.map(({ raw_bytes: bytes }) => bytes)).size,
      1,
      "the fixture must share one caller buffer so the test stays memory-bounded"
    );
    await runCapacityCase(t, {
      count: 17,
      rawBytes,
      originalSize: rawBytes.length,
      originalPath: ".local/original/synthetic/prepare-aggregate-quota.bin",
      overflowPath: ".local/original/synthetic/prepare-aggregate-overflow.bin"
    });
  });
});

test("incremental continuity is the exact prior/additions disjoint union", async (t) => {
  const state = await materializeState(t, [makeCleanedRecord()]);
  const priorInput = makeInputEntry(SOURCE_A, CLEAN_OUTPUT, {
    original_path: state.sources[0].original_path,
    locator_sha256: state.sources[0].locator_sha256
  });
  const addedInput = makeInputEntry(SOURCE_C, SIMPLE_RAW, { source_kind: "markdown" });
  await writeOriginal(state.rootDir, priorInput);
  await writeOriginal(state.rootDir, addedInput);
  const cleanSource = cleanerFor(new Map([
    [SOURCE_A, makeImageCleanResult()],
    [SOURCE_C, makeCleanResult()]
  ]));
  const cases = [
    ["omitted prior", [], [], SOURCE_A],
    ["unlabelled extra", [priorInput, addedInput], [], SOURCE_C],
    ["base marked as addition", [priorInput], [SOURCE_A], SOURCE_A],
    ["labelled addition missing from input", [priorInput], [SOURCE_C], SOURCE_C]
  ];

  for (const [label, inputs, additions, differingSourceId] of cases) {
    await t.test(label, async () => {
      const result = await prepareCleaningPlan(prepareOptions(
        state.rootDir,
        inputs,
        cleanSource,
        { stateMode: "incremental", additionSourceIds: additions }
      ));
      assert.deepEqual(
        result,
        expectedFailure("SOURCE_SET_DISCONTINUITY", null, differingSourceId)
      );
    });
  }

  await t.test("one exact explicit addition succeeds and remains sorted", async () => {
    const result = await prepareCleaningPlan(prepareOptions(
      state.rootDir,
      [addedInput, priorInput],
      cleanSource,
      { stateMode: "incremental", additionSourceIds: [SOURCE_C] }
    ));
    assert.equal(result.ok, true);
    assert.deepEqual(
      result.value.plan.manifest.run_preimage.sources.map(({ source_id: id }) => id),
      [SOURCE_A, SOURCE_C]
    );
  });
});

test("incremental empty prior state remains legal for the prepare producer", async (t) => {
  const state = await materializeState(t, []);
  const input = makeInputEntry(SOURCE_C, SIMPLE_RAW, { source_kind: "markdown" });
  await writeOriginal(state.rootDir, input);
  const result = await prepareCleaningPlan(prepareOptions(
    state.rootDir,
    [input],
    cleanerFor(new Map([[SOURCE_C, makeCleanResult()]])),
    { stateMode: "incremental", additionSourceIds: [SOURCE_C] }
  ));
  assert.equal(result.ok, true);
  assert.deepEqual(result.value.plan.manifest.prior_source_ids, []);
  assert.deepEqual(
    result.value.plan.manifest.run_preimage.sources.map(({ source_id: id }) => id),
    [SOURCE_C]
  );
});

test("reviewer state carries only on the exact four-way binding and otherwise resets", async (t) => {
  const reviewerRecord = makeCleanedRecord();
  Object.assign(reviewerRecord.source, {
    review_state_owner: "reviewer",
    review_state_version: 9,
    processing_status: "needs_ocr",
    content_mode: "image_dominant"
  });
  const changedRawBytes = Buffer.from("abcdef\n![x](u)\nC  \n");
  const changedRawAudit = makeAudit();
  changedRawAudit.retained_spans[2].before_sha256 = sha256(
    changedRawBytes.subarray(15, 19)
  );
  const cases = [
    ["raw", changedRawBytes, CLEAN_OUTPUT, changedRawAudit, CLEANER_VERSION],
    ["cleaned", CLEAN_OUTPUT, Buffer.from("abcdef\n![x](u)\nC  \n"), null, CLEANER_VERSION],
    ["audit", CLEAN_OUTPUT, CLEAN_OUTPUT, null, CLEANER_VERSION],
    ["version", CLEAN_OUTPUT, CLEAN_OUTPUT, makeAudit(), "synthetic-cleaner-2"]
  ];

  for (const [label, rawBytes, outputBytes, auditOverride, cleanerVersion] of cases) {
    await t.test(`${label} mismatch resets to exact mechanical state`, async (t) => {
      const state = await materializeState(t, [structuredClone(reviewerRecord)]);
      const input = makeInputEntry(SOURCE_A, rawBytes, {
        original_path: state.sources[0].original_path,
        locator_sha256: state.sources[0].locator_sha256
      });
      await writeOriginal(state.rootDir, input);
      let cleanResult;
      if (label === "cleaned") {
        cleanResult = makeCleanResult(rawBytes, outputBytes);
      } else {
        cleanResult = makeImageCleanResult();
        cleanResult.audit.source_byte_length = rawBytes.length;
        if (label === "audit") {
          cleanResult.audit.retained_spans[2].source_line = 4;
          cleanResult.audit.hard_breaks[0].source_line = 4;
        } else if (auditOverride !== null) {
          cleanResult.audit = structuredClone(auditOverride);
        }
      }
      const result = await prepareCleaningPlan(prepareOptions(
        state.rootDir,
        [input],
        cleanerFor(new Map([[SOURCE_A, cleanResult]])),
        { stateMode: "incremental", cleanerVersion }
      ));
      assert.equal(result.ok, true, JSON.stringify(result));
      const source = result.value.plan.manifest.run_preimage.sources[0];
      assert.deepEqual(
        {
          content_mode: source.content_mode,
          processing_status: source.processing_status,
          review_state_owner: source.review_state_owner,
          review_state_version: source.review_state_version,
          review_state_bound_raw_sha256: source.review_state_bound_raw_sha256,
          review_state_bound_cleaned_sha256: source.review_state_bound_cleaned_sha256,
          review_state_bound_audit_sha256: source.review_state_bound_audit_sha256,
          review_state_bound_cleaner_version: source.review_state_bound_cleaner_version
        },
        {
          content_mode: source.body_image_urls.length === 0 ? "text" : "mixed",
          processing_status: "cleaned",
          review_state_owner: "mechanical",
          review_state_version: 0,
          review_state_bound_raw_sha256: source.raw_sha256,
          review_state_bound_cleaned_sha256: source.cleaned_sha256,
          review_state_bound_audit_sha256: source.audit_sha256,
          review_state_bound_cleaner_version: cleanerVersion
        }
      );
    });
  }
});

test("input, duplicate, and cleaner-result failures are exact and stop before lower-priority work", async (t) => {
  await t.test("invalid input shape is a value failure before reader or cleaner", async (t) => {
    const rootDir = await mkdtemp(join(tmpdir(), "prepare-invalid-input-"));
    t.after(() => rm(rootDir, { recursive: true, force: true }));
    const input = makeInputEntry(SOURCE_A, SIMPLE_RAW);
    input.raw_bytes = "not bytes";
    let cleanerCalls = 0;
    const result = await prepareCleaningPlan(prepareOptions(
      rootDir,
      [input],
      async () => { cleanerCalls += 1; return makeCleanResult(); }
    ));
    assert.deepEqual(result, expectedFailure("INVALID_CLEANING_INPUT", null, SOURCE_A));
    assert.equal(cleanerCalls, 0);
    assert.deepEqual(await listTree(rootDir), []);
  });

  await t.test("first sorted duplicate ID wins before reader or cleaner", async (t) => {
    const rootDir = await mkdtemp(join(tmpdir(), "prepare-duplicate-input-"));
    t.after(() => rm(rootDir, { recursive: true, force: true }));
    const first = makeInputEntry(SOURCE_A, SIMPLE_RAW);
    const duplicate = makeInputEntry(SOURCE_A, SIMPLE_RAW, {
      original_path: `.local/original/synthetic/duplicate-${SOURCE_A}.md`
    });
    let cleanerCalls = 0;
    const result = await prepareCleaningPlan(prepareOptions(
      rootDir,
      [duplicate, first],
      async () => { cleanerCalls += 1; return makeCleanResult(); }
    ));
    assert.deepEqual(result, expectedFailure("DUPLICATE_SOURCE_ID", null, SOURCE_A));
    assert.equal(cleanerCalls, 0);
    assert.deepEqual(await listTree(rootDir), []);
  });

  await t.test("unknown cleaner-result key is INVALID_CLEANING_RESULT with no leaked detail", async (t) => {
    const rootDir = await mkdtemp(join(tmpdir(), "prepare-invalid-result-"));
    t.after(() => rm(rootDir, { recursive: true, force: true }));
    const input = makeInputEntry(SOURCE_A, SIMPLE_RAW);
    const invalidResult = { ...makeCleanResult(), extra: true };
    const result = await prepareCleaningPlan(prepareOptions(
      rootDir,
      [input],
      async () => invalidResult
    ));
    assert.deepEqual(result, expectedFailure("INVALID_CLEANING_RESULT", null, SOURCE_A));
    assert.deepEqual(await listTree(rootDir), []);
  });
});

test("needs_review strict policy is exact and lower-priority than integrity failures", async (t) => {
  const rootDir = await mkdtemp(join(tmpdir(), "prepare-strict-"));
  t.after(() => rm(rootDir, { recursive: true, force: true }));
  const inputA = makeInputEntry(SOURCE_A, SIMPLE_RAW);
  const inputB = makeInputEntry(SOURCE_B, REVIEW_OUTPUT, { source_kind: "markdown" });

  const nonStrict = await prepareCleaningPlan(prepareOptions(
    rootDir,
    [inputB],
    cleanerFor(new Map([[SOURCE_B, makeNeedsReviewResult(REVIEW_OUTPUT)]]))
  ));
  assert.equal(nonStrict.ok, true);
  assert.equal(
    nonStrict.value.plan.manifest.run_preimage.sources[0].processing_status,
    "needs_review"
  );

  const strict = await prepareCleaningPlan(prepareOptions(
    rootDir,
    [inputB],
    cleanerFor(new Map([[SOURCE_B, makeNeedsReviewResult(REVIEW_OUTPUT)]])),
    { strict: true }
  ));
  assert.deepEqual(strict, expectedFailure("STRICT_CLEANING_FAILED", null, SOURCE_B));

  const cleanerFailure = await prepareCleaningPlan(prepareOptions(
    rootDir,
    [inputA, inputB],
    async ({ sourceId }) => {
      if (sourceId === SOURCE_A) return makeNeedsReviewResult(SIMPLE_RAW);
      throw new Error("must not leak");
    },
    { strict: true }
  ));
  assert.deepEqual(cleanerFailure, expectedFailure("CLEANER_FAILURE", null, SOURCE_B));
  assert.deepEqual(await listTree(rootDir), []);
});

test("prepare rejects every authoritative audit byte-binding mutation", async (t) => {
  const mutations = [
    ["source length", (result) => { result.audit.source_byte_length += 1; }],
    ["output length", (result) => { result.audit.output_byte_length += 1; }],
    ["retained source", (result) => { result.audit.retained_spans[0].before_sha256 = "0".repeat(64); }],
    ["retained output", (result) => { result.audit.retained_spans[0].after_sha256 = "0".repeat(64); }],
    ["metadata source", (result) => { result.audit.metadata_spans.title.before_sha256 = "0".repeat(64); }],
    ["metadata output", (result) => { result.audit.metadata_spans.title.after_sha256 = "0".repeat(64); }],
    ["image source", (result) => { result.audit.image_spans[0].source_sha256 = "0".repeat(64); }],
    ["image output", (result) => { result.audit.image_spans[0].output_sha256 = "0".repeat(64); }],
    ["image alt", (result) => { result.audit.image_spans[0].alt_sha256 = "0".repeat(64); }],
    ["image URL", (result) => { result.audit.image_spans[0].url_sha256 = "0".repeat(64); }],
    ["hard-break source", (result) => { result.audit.hard_breaks[0].source_span = span(15, 17); }],
    ["hard-break output", (result) => { result.audit.hard_breaks[0].output_span = span(15, 17); }],
    ["body count", (result) => { result.audit.body_non_whitespace_code_points += 1; }],
    ["cleaned Markdown", (result) => { result.cleanedMarkdown += "x"; }]
  ];

  for (const [label, mutate] of mutations) {
    await t.test(label, async (t) => {
      const rootDir = await mkdtemp(join(tmpdir(), "prepare-audit-binding-"));
      t.after(() => rm(rootDir, { recursive: true, force: true }));
      const input = makeInputEntry(SOURCE_A, CLEAN_OUTPUT);
      const result = makeImageCleanResult();
      mutate(result);
      const actual = await prepareCleaningPlan(prepareOptions(
        rootDir,
        [input],
        cleanerFor(new Map([[SOURCE_A, result]]))
      ));
      assert.deepEqual(
        actual,
        expectedFailure("INVALID_CLEANING_RESULT", null, SOURCE_A),
        label
      );
      assert.deepEqual(await listTree(rootDir), []);
    });
  }
});

test("pure shared compiler owns persisted projection and rejects an invalid RunPreimage", async () => {
  const { compileCleaningStateArtifacts } = await import("../tools/lib/cleaning-state.mjs");
  assert.equal(typeof compileCleaningStateArtifacts, "function");
  const input = makeInputEntry(SOURCE_A, SIMPLE_RAW);
  const result = makeCleanResult();
  const source = expectedInitialSource(input, result);
  source.audit_sha256 = "0".repeat(64);
  source.review_state_bound_audit_sha256 = source.audit_sha256;
  const runPreimage = {
    schema_version: "1.0.0",
    cleaner_version: CLEANER_VERSION,
    sources: [source]
  };

  assert.deepEqual(
    compileCleaningStateArtifacts(runPreimage),
    { ok: false, source_id: SOURCE_A }
  );
});

test("pure shared compiler validates its detached ordinary-array snapshot", async () => {
  const { compileCleaningStateArtifacts } = await import("../tools/lib/cleaning-state.mjs");
  const sources = [{}];
  const inheritedIterator = Object.create(Array.prototype);
  Object.defineProperty(inheritedIterator, Symbol.iterator, {
    value: function* hiddenIterator() {}
  });
  Object.setPrototypeOf(sources, inheritedIterator);

  assert.deepEqual(
    compileCleaningStateArtifacts({
      schema_version: "1.0.0",
      cleaner_version: CLEANER_VERSION,
      sources
    }),
    { ok: false, source_id: null }
  );
});

test("pure shared compiler detaches its returned projection from caller mutation", async () => {
  const { compileCleaningStateArtifacts } = await import("../tools/lib/cleaning-state.mjs");
  const input = makeInputEntry(SOURCE_A, SIMPLE_RAW);
  const result = makeCleanResult();
  const source = expectedInitialSource(input, result);
  const runPreimage = {
    schema_version: "1.0.0",
    cleaner_version: CLEANER_VERSION,
    sources: [source]
  };
  const compiled = compileCleaningStateArtifacts(runPreimage);
  assert.equal(compiled.ok, true);
  const expectedReport = structuredClone(compiled.value.report);
  const expectedCatalogEntries = structuredClone(compiled.value.catalog_entries);
  const expectedReportBytes = Buffer.from(compiled.value.report_bytes);
  const expectedCatalogBytes = Buffer.from(compiled.value.catalog_bytes);
  const expectedRunSha256 = compiled.value.run_sha256;

  runPreimage.cleaner_version = "caller-mutated-cleaner";
  runPreimage.sources[0].title = "caller-mutated-title";
  runPreimage.sources[0].body_image_urls.push("caller-mutated-image");

  assert.deepEqual(compiled.value.report, expectedReport);
  assert.deepEqual(compiled.value.catalog_entries, expectedCatalogEntries);
  assert.deepEqual(compiled.value.report_bytes, expectedReportBytes);
  assert.deepEqual(compiled.value.catalog_bytes, expectedCatalogBytes);
  assert.equal(compiled.value.run_sha256, expectedRunSha256);
  assert.equal(
    sha256(canonicalJsonBytes(compiled.value.report.run_preimage)),
    compiled.value.run_sha256
  );
  assert.deepEqual(
    canonicalJsonDocumentBytes(compiled.value.report),
    compiled.value.report_bytes
  );
  assert.equal(Object.isFrozen(compiled.value.report.run_preimage), true);
  assert.equal(Object.isFrozen(compiled.value.report.run_preimage.sources[0]), true);
  assert.equal(Object.isFrozen(compiled.value.catalog_entries[0].body_image_urls), true);
});

// B5 RED contract suite. Keep these expectations independent from the staging
// implementation: every persisted byte, digest, and path is derived here.
const B5_RUNS_ROOT = ".local/cleaned/runs";
const B5_MODULE_URL = new URL("../tools/lib/clean-run-store.mjs", import.meta.url).href;

async function loadB5Module() {
  return import(B5_MODULE_URL);
}

async function loadStageCleaningRun() {
  const module = await loadB5Module();
  assert.deepEqual(Object.keys(module), [
    "publishCleaningRun",
    "recoverInterruptedCleaningCommit",
    "stageCleaningRun"
  ]);
  assert.equal(typeof module.stageCleaningRun, "function");
  return module.stageCleaningRun;
}

async function loadPublishCleaningRun() {
  const module = await loadB5Module();
  assert.deepEqual(Object.keys(module), [
    "publishCleaningRun",
    "recoverInterruptedCleaningCommit",
    "stageCleaningRun"
  ]);
  assert.equal(typeof module.publishCleaningRun, "function");
  return module.publishCleaningRun;
}

async function loadRecoverInterruptedCleaningCommit() {
  const module = await loadB5Module();
  assert.deepEqual(Object.keys(module), [
    "publishCleaningRun",
    "recoverInterruptedCleaningCommit",
    "stageCleaningRun"
  ]);
  assert.equal(typeof module.recoverInterruptedCleaningCommit, "function");
  return module.recoverInterruptedCleaningCommit;
}

function cloneB5Plan(plan) {
  return {
    manifest: structuredClone(plan.manifest),
    manifest_sha256: plan.manifest_sha256,
    artifacts: plan.artifacts.map((artifact) => ({
      relative_path: artifact.relative_path,
      sha256: artifact.sha256,
      size_bytes: artifact.size_bytes,
      bytes: Buffer.from(artifact.bytes)
    }))
  };
}

function makeB5GoldenPlan() {
  return cloneB5Plan(
    expectedPlanForInitial(
      makeInputEntry(SOURCE_A, SIMPLE_RAW),
      makeCleanResult()
    ).value.plan
  );
}

function makeB5EmptyPlan() {
  const runPreimage = {
    schema_version: "1.0.0",
    cleaner_version: CLEANER_VERSION,
    sources: []
  };
  const runSha256 = sha256(canonicalJsonBytes(runPreimage));
  const catalogBytes = Buffer.alloc(0);
  const report = {
    schema_version: "1.0.0",
    run_sha256: runSha256,
    run_preimage: runPreimage
  };
  const reportBytes = canonicalJsonDocumentBytes(report);
  const runPath = `${B5_RUNS_ROOT}/${runSha256}`;
  const pointer = {
    schema_version: "1.0.0",
    run_sha256: runSha256,
    run_path: runPath,
    catalog_path: `${runPath}/catalog/sources.jsonl`,
    catalog_sha256: sha256(catalogBytes),
    report_path: `${runPath}/cleaning-report.json`,
    report_sha256: sha256(reportBytes)
  };
  const artifacts = [
    {
      relative_path: "catalog/sources.jsonl",
      sha256: sha256(catalogBytes),
      size_bytes: 0,
      bytes: catalogBytes
    },
    {
      relative_path: "cleaning-report.json",
      sha256: sha256(reportBytes),
      size_bytes: reportBytes.length,
      bytes: reportBytes
    }
  ];
  const artifactManifest = artifacts.map(({ bytes: _bytes, ...entry }) => entry);
  const manifest = {
    schema_version: "1.0.0",
    state_mode: "initial_verified_baseline",
    expected_prior_pointer: null,
    expected_prior_pointer_sha256: null,
    prior_run_sha256: null,
    prior_catalog_sha256: null,
    prior_report_sha256: null,
    prior_source_ids: [],
    run_preimage: runPreimage,
    artifact_manifest: artifactManifest,
    desired_pointer: pointer,
    desired_pointer_sha256: sha256(canonicalJsonDocumentBytes(pointer)),
    registered_source_count: 0
  };
  return {
    manifest,
    manifest_sha256: sha256(canonicalJsonBytes(manifest)),
    artifacts
  };
}

function expectedB5Layout(plan, runsRoot = B5_RUNS_ROOT) {
  const manifest = structuredClone(plan.manifest);
  const planManifestSha256 = sha256(canonicalJsonBytes(manifest));
  const runSha256 = sha256(canonicalJsonBytes(manifest.run_preimage));
  const stagingPath = `.local/tmp/cleaning-${planManifestSha256}`;
  const finalRunPath = `${runsRoot}/${runSha256}`;
  const artifactIntents = manifest.artifact_manifest.map((artifact) => ({
    relative_path: artifact.relative_path,
    canonical_path: `${finalRunPath}/${artifact.relative_path}`,
    temp_path: `${finalRunPath}/${artifact.relative_path}.tmp-${artifact.sha256}.partial`,
    sha256: artifact.sha256,
    size_bytes: artifact.size_bytes
  }));
  const intent = {
    schema_version: "1.0.0",
    record_kind: "staging_intent",
    plan_manifest: manifest,
    plan_manifest_sha256: planManifestSha256,
    run_sha256: runSha256,
    staging_path: stagingPath,
    final_run_path: finalRunPath,
    artifact_intents: artifactIntents
  };
  const intentBytes = canonicalJsonDocumentBytes(intent);
  const intentSha256 = sha256(intentBytes);
  return {
    planManifestSha256,
    runSha256,
    stagingPath,
    finalRunPath,
    intent,
    intentBytes,
    intentSha256,
    intentPath: `${stagingPath}/intent.json`,
    intentCandidatePath: `${stagingPath}/intent.json.tmp-${intentSha256}.partial`,
    artifactIntents,
    success(persistentWritesOccurred) {
      return {
        ok: true,
        value: {
          kind: "staged",
          staged_run: {
            plan_manifest: structuredClone(manifest),
            plan_manifest_sha256: planManifestSha256,
            run_sha256: runSha256,
            staging_path: stagingPath,
            final_run_path: finalRunPath,
            artifact_manifest: structuredClone(manifest.artifact_manifest)
          },
          persistent_writes_occurred: persistentWritesOccurred
        }
      };
    }
  };
}

function b5Options(rootDir, plan, overrides = {}) {
  return { rootDir, runsRoot: B5_RUNS_ROOT, plan, ...overrides };
}

const B6_CURRENT_POINTER = ".local/state/current-cleaning.json";

function makeB6StagedRun(plan = makeB5GoldenPlan()) {
  const layout = expectedB5Layout(plan);
  return {
    plan_manifest: structuredClone(plan.manifest),
    plan_manifest_sha256: layout.planManifestSha256,
    run_sha256: layout.runSha256,
    staging_path: layout.stagingPath,
    final_run_path: layout.finalRunPath,
    artifact_manifest: structuredClone(plan.manifest.artifact_manifest)
  };
}

function makeB6IncrementalPlan(priorPlan) {
  const plan = cloneB5Plan(
    expectedPlanForInitial(
      makeInputEntry(SOURCE_A, SIMPLE_RAW),
      makeCleanResult(SIMPLE_RAW, Buffer.from("abcdefNEXT\n", "utf8"))
    ).value.plan
  );
  const priorPointer = structuredClone(priorPlan.manifest.desired_pointer);
  plan.manifest.state_mode = "incremental";
  plan.manifest.expected_prior_pointer = priorPointer;
  plan.manifest.expected_prior_pointer_sha256 = sha256(
    canonicalJsonDocumentBytes(priorPointer)
  );
  plan.manifest.prior_run_sha256 = priorPointer.run_sha256;
  plan.manifest.prior_catalog_sha256 = priorPointer.catalog_sha256;
  plan.manifest.prior_report_sha256 = priorPointer.report_sha256;
  plan.manifest.prior_source_ids = [SOURCE_A];
  return refreshB5ManifestHash(plan);
}

function b6Options(rootDir, stagedRun, overrides = {}) {
  return {
    rootDir,
    runsRoot: B5_RUNS_ROOT,
    currentPointer: B6_CURRENT_POINTER,
    stagedRun,
    ...overrides
  };
}

function makeB6CommitLockIntent(plan, ownerPid = 424242, ownerNonce = "1".repeat(32)) {
  return {
    schema_version: "1.0.0",
    owner_pid: ownerPid,
    owner_nonce: ownerNonce,
    plan_manifest: structuredClone(plan.manifest),
    plan_manifest_sha256: plan.manifest_sha256,
    expected_prior_pointer_sha256: plan.manifest.expected_prior_pointer_sha256,
    desired_pointer_sha256: plan.manifest.desired_pointer_sha256,
    desired_pointer: structuredClone(plan.manifest.desired_pointer),
    run_sha256: plan.manifest.desired_pointer.run_sha256
  };
}

function validateB6CanonicalLockForTest(bytes) {
  if (!Buffer.isBuffer(bytes) || bytes.at(-1) !== 0x0a) return null;
  let value;
  try {
    value = JSON.parse(bytes.subarray(0, -1).toString("utf8"));
  } catch {
    return null;
  }
  if (!canonicalJsonDocumentBytes(value).equals(bytes) ||
      !Number.isSafeInteger(value.owner_pid) || value.owner_pid <= 0 ||
      !/^[0-9a-f]{32}$/.test(value.owner_nonce ?? "")) return null;
  return value;
}

function b5ExpectedFailure(code, path = null, persistentWritesOccurred = false) {
  return {
    ok: false,
    error: {
      kind: "expected",
      code,
      path,
      source_id: null,
      persistent_writes_occurred: persistentWritesOccurred
    }
  };
}

function b5IoFailure(operation, path, persistentWritesOccurred) {
  return {
    ok: false,
    error: {
      kind: "io",
      code: "CLEANING_IO_FAILURE",
      operation,
      path,
      persistent_writes_occurred: persistentWritesOccurred
    }
  };
}

async function makeB5Root(t, label) {
  const rootDir = await mkdtemp(join(tmpdir(), `b5-${label}-`));
  t.after(() => rm(rootDir, { recursive: true, force: true }));
  return rootDir;
}

async function makeB5SocketCarrier(t, exactPath) {
  const carrierRoot = await mkdtemp(join(tmpdir(), "b5-socket-carrier-"));
  const carrierPath = join(carrierRoot, "socket");
  const server = createServer();
  let closed = false;
  const close = async () => {
    if (closed) return;
    closed = true;
    await new Promise((resolve, reject) =>
      server.close((error) => error === undefined ? resolve() : reject(error)));
  };
  t.after(async () => {
    await close();
    await rm(carrierRoot, { recursive: true, force: true });
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(carrierPath, resolve);
  });
  await link(carrierPath, exactPath);
  return { carrierRoot, close };
}

async function makeB6SocketSource(t) {
  const carrierRoot = await mkdtemp(join(tmpdir(), "b6-socket-source-"));
  const carrierPath = join(carrierRoot, "socket");
  const server = createServer();
  let closed = false;
  const close = async () => {
    if (closed) return;
    closed = true;
    await new Promise((resolve, reject) =>
      server.close((error) => error === undefined ? resolve() : reject(error)));
  };
  t.after(async () => {
    await close();
    await rm(carrierRoot, { recursive: true, force: true });
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(carrierPath, resolve);
  });
  return carrierPath;
}

async function writeB5Path(rootDir, relativePath, bytes) {
  const absolutePath = join(rootDir, relativePath);
  await mkdir(dirname(absolutePath), { recursive: true });
  await writeFile(absolutePath, bytes);
  return absolutePath;
}

async function writeB5Prefix(rootDir, relativePath, bytes, prefixLength) {
  return writeB5Path(rootDir, relativePath, bytes.subarray(0, prefixLength));
}

async function writeB5Intent(rootDir, layout, bytes = layout.intentBytes) {
  return writeB5Path(rootDir, layout.intentPath, bytes);
}

function b5ArtifactBytes(plan, relativePath) {
  const artifact = plan.artifacts.find((entry) => entry.relative_path === relativePath);
  assert.notEqual(artifact, undefined, `missing synthetic artifact ${relativePath}`);
  return Buffer.from(artifact.bytes);
}

async function materializeB5Final(rootDir, plan, layout, count = layout.artifactIntents.length) {
  for (const artifact of layout.artifactIntents.slice(0, count)) {
    await writeB5Path(
      rootDir,
      artifact.canonical_path,
      b5ArtifactBytes(plan, artifact.relative_path)
    );
  }
}

async function materializeB5Temps(rootDir, plan, layout, states = {}) {
  for (const artifact of layout.artifactIntents) {
    const bytes = b5ArtifactBytes(plan, artifact.relative_path);
    const state = states[artifact.relative_path] ?? "full";
    if (state === "absent") continue;
    const length = state === "empty"
      ? 0
      : state === "prefix"
        ? Math.max(0, bytes.length - 1)
        : bytes.length;
    await writeB5Prefix(rootDir, artifact.temp_path, bytes, length);
  }
}

async function snapshotB5Tree(rootDir) {
  const entries = [];
  async function visit(relativePath) {
    const absolutePath = relativePath === "" ? rootDir : join(rootDir, relativePath);
    const names = await readdir(absolutePath);
    names.sort();
    for (const name of names) {
      const child = relativePath === "" ? name : `${relativePath}/${name}`;
      const info = await lstat(join(rootDir, child));
      if (info.isDirectory()) {
        entries.push([child, "directory"]);
        await visit(child);
      } else if (info.isFile()) {
        entries.push([child, "file", (await readFile(join(rootDir, child))).toString("base64")]);
      } else if (info.isSymbolicLink()) {
        entries.push([child, "symlink"]);
      } else {
        entries.push([child, "other"]);
      }
    }
  }
  await visit("");
  return entries;
}

function refreshB5ManifestHash(plan) {
  plan.manifest_sha256 = sha256(canonicalJsonBytes(plan.manifest));
  return plan;
}

function encodeB5Plan(plan) {
  return Buffer.from(JSON.stringify({
    manifest: plan.manifest,
    manifest_sha256: plan.manifest_sha256,
    artifacts: plan.artifacts.map((artifact) => ({
      ...artifact,
      bytes: Buffer.from(artifact.bytes).toString("base64")
    }))
  }), "utf8").toString("base64");
}

function b5PlanMutations() {
  return [
    ["extra plan key", (plan) => { plan.extra = true; }],
    ["missing plan key", (plan) => { delete plan.manifest_sha256; }],
    ["extra manifest key", (plan) => { plan.manifest.extra = true; }],
    ["manifest digest", (plan) => { plan.manifest_sha256 = "0".repeat(64); }],
    ["state mode", (plan) => { plan.manifest.state_mode = "incremental"; }],
    ["prior pointer binding", (plan) => { plan.manifest.expected_prior_pointer_sha256 = "0".repeat(64); }],
    ["run preimage", (plan) => { plan.manifest.run_preimage.cleaner_version = "mutated"; }],
    ["desired pointer", (plan) => { plan.manifest.desired_pointer.catalog_sha256 = "0".repeat(64); }],
    ["desired pointer digest", (plan) => { plan.manifest.desired_pointer_sha256 = "0".repeat(64); }],
    ["registered count", (plan) => { plan.manifest.registered_source_count += 1; }],
    ["artifact manifest order", (plan) => { plan.manifest.artifact_manifest.reverse(); }],
    ["artifact manifest missing", (plan) => { plan.manifest.artifact_manifest.pop(); }],
    ["artifact manifest extra", (plan) => { plan.manifest.artifact_manifest.push({ relative_path: "extra", sha256: "0".repeat(64), size_bytes: 0 }); }],
    ["artifact manifest path", (plan) => { plan.manifest.artifact_manifest[0].relative_path = "../escape"; }],
    ["artifact manifest hash", (plan) => { plan.manifest.artifact_manifest[0].sha256 = "0".repeat(64); }],
    ["artifact manifest size", (plan) => { plan.manifest.artifact_manifest[0].size_bytes += 1; }],
    ["plan artifact order", (plan) => { plan.artifacts.reverse(); }],
    ["plan artifact missing", (plan) => { plan.artifacts.pop(); }],
    ["plan artifact extra", (plan) => { plan.artifacts.push({ relative_path: "extra", sha256: sha256(Buffer.alloc(0)), size_bytes: 0, bytes: Buffer.alloc(0) }); }],
    ["plan artifact path", (plan) => { plan.artifacts[0].relative_path = "../escape"; }],
    ["plan artifact hash", (plan) => { plan.artifacts[0].sha256 = "0".repeat(64); }],
    ["plan artifact size", (plan) => { plan.artifacts[0].size_bytes += 1; }],
    ["plan artifact bytes", (plan) => { plan.artifacts[0].bytes = Buffer.from("wrong"); }],
    ["compiled catalog projection", (plan) => {
      const artifact = plan.artifacts.find(({ relative_path: path }) => path === "catalog/sources.jsonl");
      artifact.bytes = Buffer.concat([artifact.bytes, Buffer.from("x")]);
      artifact.size_bytes = artifact.bytes.length;
      artifact.sha256 = sha256(artifact.bytes);
      const bound = plan.manifest.artifact_manifest.find(({ relative_path: path }) => path === artifact.relative_path);
      bound.size_bytes = artifact.size_bytes;
      bound.sha256 = artifact.sha256;
    }],
    ["compiled report projection", (plan) => {
      const artifact = plan.artifacts.find(({ relative_path: path }) => path === "cleaning-report.json");
      artifact.bytes = canonicalJsonDocumentBytes({ synthetic: true });
      artifact.size_bytes = artifact.bytes.length;
      artifact.sha256 = sha256(artifact.bytes);
      const bound = plan.manifest.artifact_manifest.find(({ relative_path: path }) => path === artifact.relative_path);
      bound.size_bytes = artifact.size_bytes;
      bound.sha256 = artifact.sha256;
    }],
    ["source output binding", (plan) => {
      const artifact = plan.artifacts.find(({ relative_path: path }) => path.startsWith("sources/"));
      artifact.bytes = Buffer.from("different source");
      artifact.size_bytes = artifact.bytes.length;
      artifact.sha256 = sha256(artifact.bytes);
      const bound = plan.manifest.artifact_manifest.find(({ relative_path: path }) => path === artifact.relative_path);
      bound.size_bytes = artifact.size_bytes;
      bound.sha256 = artifact.sha256;
    }]
  ];
}

test("B5 export and exact options reject API drift while fixed runsRoot aliases stage", async (t) => {
  const module = await loadB5Module();
  assert.deepEqual(Object.keys(module), [
    "publishCleaningRun",
    "recoverInterruptedCleaningCommit",
    "stageCleaningRun"
  ]);
  const stageCleaningRun = module.stageCleaningRun;
  assert.equal(typeof stageCleaningRun, "function");

  const rootDir = await makeB5Root(t, "options");
  const plan = makeB5GoldenPlan();
  const valid = b5Options(rootDir, plan);
  let getterCalls = 0;
  const accessorOptions = { rootDir, runsRoot: B5_RUNS_ROOT };
  Object.defineProperty(accessorOptions, "plan", {
    enumerable: true,
    get() {
      getterCalls += 1;
      throw new Error("options accessor must not run");
    }
  });
  const invalidCalls = [
    () => stageCleaningRun(),
    () => stageCleaningRun(null),
    () => stageCleaningRun({ ...valid, extra: true }),
    () => stageCleaningRun({ ...valid, rootDir: "" }),
    () => stageCleaningRun({ ...valid, runsRoot: "" }),
    () => stageCleaningRun({ ...valid, runsRoot: ".local/other" }),
    () => stageCleaningRun(Object.create(valid)),
    () => stageCleaningRun(accessorOptions),
    () => stageCleaningRun(new Proxy(valid, {}))
  ];
  for (const invoke of invalidCalls) await assert.rejects(invoke, TypeError);
  assert.equal(getterCalls, 0);
  assert.deepEqual(await snapshotB5Tree(rootDir), []);

  for (const aliasKind of ["relative", "requested-root-absolute", "real-root-absolute"]) {
    await t.test(aliasKind, async (t) => {
      const container = await makeB5Root(t, `alias-${aliasKind}`);
      const realRoot = join(container, "real");
      const aliasRoot = join(container, "alias");
      await mkdir(realRoot);
      await symlink("real", aliasRoot);
      const canonicalRoot = await realpath(realRoot);
      const runsRoot = aliasKind === "relative"
        ? B5_RUNS_ROOT
        : aliasKind === "requested-root-absolute"
          ? join(aliasRoot, B5_RUNS_ROOT)
          : join(canonicalRoot, B5_RUNS_ROOT);
      const aliasPlan = makeB5GoldenPlan();
      const result = await stageCleaningRun({ rootDir: aliasRoot, runsRoot, plan: aliasPlan });
      assert.deepEqual(result, expectedB5Layout(aliasPlan).success(true));
    });
  }
});

test("B6 publisher is exported from the run store", async () => {
  await loadPublishCleaningRun();
});

test("B6 publisher rejects exact API-shape and staged binding drift before persistent writes", async (t) => {
  const publishCleaningRun = await loadPublishCleaningRun();
  const rootDir = await makeB5Root(t, "b6-validation");
  const stagedRun = makeB6StagedRun();
  const valid = b6Options(rootDir, stagedRun);
  let optionGetterCalls = 0;
  let stagedGetterCalls = 0;
  const accessorOptions = {
    rootDir,
    runsRoot: B5_RUNS_ROOT,
    currentPointer: B6_CURRENT_POINTER
  };
  Object.defineProperty(accessorOptions, "stagedRun", {
    enumerable: true,
    get() {
      optionGetterCalls += 1;
      throw new Error("options accessor must not run");
    }
  });
  const accessorStagedRun = { ...stagedRun };
  Object.defineProperty(accessorStagedRun, "run_sha256", {
    enumerable: true,
    get() {
      stagedGetterCalls += 1;
      throw new Error("staged-run accessor must not run");
    }
  });

  const invalidCalls = [
    () => publishCleaningRun(),
    () => publishCleaningRun(null),
    () => publishCleaningRun({ ...valid, extra: true }),
    () => publishCleaningRun({ ...valid, rootDir: "" }),
    () => publishCleaningRun({ ...valid, runsRoot: ".local/other" }),
    () => publishCleaningRun({ ...valid, currentPointer: ".local/state/other.json" }),
    () => publishCleaningRun(Object.create(valid)),
    () => publishCleaningRun(accessorOptions),
    () => publishCleaningRun(new Proxy(valid, {})),
    () => publishCleaningRun({ ...valid, stagedRun: { ...stagedRun, extra: true } }),
    () => publishCleaningRun({ ...valid, stagedRun: (() => {
      const value = { ...stagedRun };
      delete value.run_sha256;
      return value;
    })() }),
    () => publishCleaningRun({ ...valid, stagedRun: accessorStagedRun }),
    () => publishCleaningRun({ ...valid, stagedRun: new Proxy(stagedRun, {}) })
  ];
  for (const invoke of invalidCalls) await assert.rejects(invoke, TypeError);
  assert.equal(optionGetterCalls, 0);
  assert.equal(stagedGetterCalls, 0);
  assert.deepEqual(await snapshotB5Tree(rootDir), []);

  const bindingMutations = [
    ["plan manifest hash", (value) => { value.plan_manifest_sha256 = "0".repeat(64); }],
    ["run hash", (value) => { value.run_sha256 = "0".repeat(64); }],
    ["staging path", (value) => { value.staging_path = ".local/tmp/cleaning-wrong"; }],
    ["final run path", (value) => { value.final_run_path = `${B5_RUNS_ROOT}/${"0".repeat(64)}`; }],
    ["artifact manifest", (value) => { value.artifact_manifest.reverse(); }],
    ["artifact manifest missing", (value) => { value.artifact_manifest.pop(); }],
    ["artifact manifest hash", (value) => {
      value.artifact_manifest[0].sha256 = "0".repeat(64);
    }],
    ["artifact manifest size", (value) => {
      value.artifact_manifest[0].size_bytes += 1;
    }],
    ["desired pointer hash", (value) => { value.plan_manifest.desired_pointer_sha256 = "0".repeat(64); }]
  ];
  for (const [label, mutate] of bindingMutations) {
    const value = makeB6StagedRun();
    mutate(value);
    assert.deepEqual(
      await publishCleaningRun(b6Options(rootDir, value)),
      b5ExpectedFailure("PLAN_BINDING_MISMATCH"),
      label
    );
    assert.deepEqual(await snapshotB5Tree(rootDir), [], label);
  }

  const wrongCount = makeB6StagedRun();
  wrongCount.plan_manifest.registered_source_count += 1;
  wrongCount.plan_manifest_sha256 = sha256(
    canonicalJsonBytes(wrongCount.plan_manifest)
  );
  assert.deepEqual(
    await publishCleaningRun(b6Options(rootDir, wrongCount)),
    b5ExpectedFailure("PLAN_BINDING_MISMATCH")
  );
  assert.deepEqual(await snapshotB5Tree(rootDir), []);
});

test("B6 staged descriptors remain semantically bound to compiled source, catalog, and report bytes", async (t) => {
  const stageCleaningRun = await loadStageCleaningRun();
  const publishCleaningRun = await loadPublishCleaningRun();
  for (const [artifactKind, selectArtifact] of [
    ["source", (artifact) => artifact.relative_path.startsWith("sources/")],
    ["catalog", (artifact) => artifact.relative_path === "catalog/sources.jsonl"],
    ["report", (artifact) => artifact.relative_path === "cleaning-report.json"]
  ]) {
    await t.test(artifactKind, async (t) => {
      const rootDir = await makeB5Root(t, `b6-semantic-binding-${artifactKind}`);
      const plan = makeB5GoldenPlan();
      const staged = await stageCleaningRun(b5Options(rootDir, plan));
      assert.equal(staged.ok, true);
      const stagedRun = structuredClone(staged.value.staged_run);
      const forgedBytes = Buffer.from(`forged-${artifactKind}\n`, "utf8");
      const outerArtifact = stagedRun.artifact_manifest.find(selectArtifact);
      const manifestArtifact = stagedRun.plan_manifest.artifact_manifest.find(
        selectArtifact
      );
      assert.notEqual(outerArtifact, undefined);
      assert.notEqual(manifestArtifact, undefined);
      for (const artifact of [outerArtifact, manifestArtifact]) {
        artifact.sha256 = sha256(forgedBytes);
        artifact.size_bytes = forgedBytes.length;
      }
      stagedRun.plan_manifest_sha256 = sha256(
        canonicalJsonBytes(stagedRun.plan_manifest)
      );
      stagedRun.staging_path =
        `.local/tmp/cleaning-${stagedRun.plan_manifest_sha256}`;
      await writeFile(
        join(
          rootDir,
          stagedRun.final_run_path,
          ...outerArtifact.relative_path.split("/")
        ),
        forgedBytes
      );
      const before = await snapshotB5Tree(rootDir);

      assert.deepEqual(
        await publishCleaningRun(b6Options(rootDir, stagedRun)),
        b5ExpectedFailure("PLAN_BINDING_MISMATCH"),
        artifactKind
      );
      assert.deepEqual(await snapshotB5Tree(rootDir), before, artifactKind);
    });
  }
});

test("B6 publisher commits initial absence and incremental exact prior with exact durable records", async (t) => {
  const stageCleaningRun = await loadStageCleaningRun();
  const publishCleaningRun = await loadPublishCleaningRun();
  const rootDir = await makeB5Root(t, "b6-basic-publication");
  const initialPlan = makeB5GoldenPlan();
  const incrementalPlan = makeB6IncrementalPlan(initialPlan);

  for (const [expectedKind, plan] of [
    ["published", initialPlan],
    ["published", incrementalPlan]
  ]) {
    const staged = await stageCleaningRun(b5Options(rootDir, plan));
    assert.equal(staged.ok, true);
    const beforeRun = await snapshotB5Tree(join(rootDir, staged.value.staged_run.final_run_path));

    const result = await publishCleaningRun(
      b6Options(rootDir, staged.value.staged_run)
    );

    assert.deepEqual(result, {
      ok: true,
      value: {
        kind: expectedKind,
        plan_manifest_sha256: plan.manifest_sha256,
        run_sha256: plan.manifest.desired_pointer.run_sha256,
        desired_pointer: structuredClone(plan.manifest.desired_pointer),
        registered_source_count: plan.manifest.registered_source_count,
        persistent_writes_occurred: true
      }
    });
    assert.deepEqual(
      await readFile(join(rootDir, B6_CURRENT_POINTER)),
      canonicalJsonDocumentBytes(plan.manifest.desired_pointer)
    );
    assert.deepEqual(
      await snapshotB5Tree(join(rootDir, staged.value.staged_run.final_run_path)),
      beforeRun
    );
    assert.equal(Object.isFrozen(result), true);
    assert.equal(Object.isFrozen(result.value), true);
    assert.equal(Object.isFrozen(result.value.desired_pointer), true);
    assert.deepEqual(Object.keys(result.value).sort(), [
      "desired_pointer",
      "kind",
      "persistent_writes_occurred",
      "plan_manifest_sha256",
      "registered_source_count",
      "run_sha256"
    ]);
  }

  const stateNames = (await readdir(join(rootDir, ".local/state"))).sort();
  assert.deepEqual(stateNames, ["cleaning-transitions", "current-cleaning.json"]);
  const transitionNames = (await readdir(
    join(rootDir, ".local/state/cleaning-transitions")
  )).sort();
  assert.equal(transitionNames.length, 2);
  for (const [index, plan] of [initialPlan, incrementalPlan].entries()) {
    const desiredHash = plan.manifest.desired_pointer_sha256;
    const name = transitionNames.find((candidate) => candidate.endsWith(`-${desiredHash}.json`));
    assert.match(name, new RegExp(`^complete-[0-9a-f]{64}-${desiredHash}\\.json$`));
    const commitLockSha256 = name.slice("complete-".length, "complete-".length + 64);
    const expectedRecord = {
      schema_version: "1.0.0",
      record_kind: "completion",
      commit_lock_sha256: commitLockSha256,
      plan_manifest_sha256: plan.manifest_sha256,
      expected_prior_pointer_sha256: plan.manifest.expected_prior_pointer_sha256,
      desired_pointer_sha256: desiredHash,
      desired_pointer: structuredClone(plan.manifest.desired_pointer)
    };
    assert.deepEqual(
      await readFile(join(rootDir, ".local/state/cleaning-transitions", name)),
      canonicalJsonDocumentBytes(expectedRecord),
      `transition ${index}`
    );
    assert.equal(
      (await lstat(join(rootDir, ".local/state/cleaning-transitions", name))).mode & 0o777,
      0o600
    );
  }
  assert.equal((await lstat(join(rootDir, B6_CURRENT_POINTER))).mode & 0o777, 0o600);
  assert.equal((await lstat(join(rootDir, ".local/state"))).mode & 0o777, 0o700);
  assert.equal(
    (await lstat(join(rootDir, ".local/state/cleaning-transitions"))).mode & 0o777,
    0o700
  );
});

test("B6 empty run publishes registered count zero without exposing artifact bytes", async (t) => {
  const stageCleaningRun = await loadStageCleaningRun();
  const publishCleaningRun = await loadPublishCleaningRun();
  const rootDir = await makeB5Root(t, "b6-empty-run");
  const plan = makeB5EmptyPlan();
  const staged = await stageCleaningRun(b5Options(rootDir, plan));
  const callerStaged = structuredClone(staged.value.staged_run);
  const pending = publishCleaningRun(b6Options(rootDir, callerStaged));
  callerStaged.plan_manifest.registered_source_count = 99;
  callerStaged.artifact_manifest[0].sha256 = "0".repeat(64);
  const result = await pending;
  assert.equal(result.ok, true);
  assert.equal(result.value.kind, "published");
  assert.equal(result.value.registered_source_count, 0);
  assert.equal(result.value.plan_manifest_sha256, plan.manifest_sha256);
  assert.equal(result.value.run_sha256, plan.manifest.desired_pointer.run_sha256);
  assert.equal(Object.isFrozen(result), true);
  assert.equal(Object.isFrozen(result.value), true);
  assert.equal(Object.isFrozen(result.value.desired_pointer), true);
  assert.equal("artifact_manifest" in result.value, false);
  assert.equal("bytes" in result.value, false);
});

test("B6 exact desired publishes a fresh C-bound completion only after full run revalidation", async (t) => {
  const stageCleaningRun = await loadStageCleaningRun();
  const publishCleaningRun = await loadPublishCleaningRun();
  const rootDir = await makeB5Root(t, "b6-already-current");
  const plan = makeB5GoldenPlan();
  const staged = await stageCleaningRun(b5Options(rootDir, plan));
  assert.equal(staged.ok, true);
  const options = b6Options(rootDir, staged.value.staged_run);

  assert.equal((await publishCleaningRun(options)).ok, true);
  const pointerBytes = await readFile(join(rootDir, B6_CURRENT_POINTER));
  const firstTransitions = await readdir(
    join(rootDir, ".local/state/cleaning-transitions")
  );
  assert.equal(firstTransitions.length, 1);

  const second = await publishCleaningRun(options);

  assert.deepEqual(second, {
    ok: true,
    value: {
      kind: "already_current",
      plan_manifest_sha256: plan.manifest_sha256,
      run_sha256: plan.manifest.desired_pointer.run_sha256,
      desired_pointer: structuredClone(plan.manifest.desired_pointer),
      registered_source_count: 1,
      persistent_writes_occurred: true
    }
  });
  assert.deepEqual(await readFile(join(rootDir, B6_CURRENT_POINTER)), pointerBytes);
  const secondTransitions = await readdir(
    join(rootDir, ".local/state/cleaning-transitions")
  );
  assert.equal(secondTransitions.length, 2);
  assert.equal(new Set(secondTransitions).size, 2);
  assert.equal(Object.isFrozen(second), true);
  assert.equal(Object.isFrozen(second.value.desired_pointer), true);

  const sourceArtifact = plan.manifest.artifact_manifest.find((artifact) =>
    artifact.relative_path.startsWith("sources/"));
  const sourcePath = join(
    rootDir,
    staged.value.staged_run.final_run_path,
    sourceArtifact.relative_path
  );
  const originalSource = await readFile(sourcePath);
  await writeFile(sourcePath, Buffer.from("corrupt"));
  const stateBeforeFailure = await snapshotB5Tree(join(rootDir, ".local/state"));

  assert.deepEqual(
    await publishCleaningRun(options),
    b5ExpectedFailure(
      "RUN_CONFLICT",
      `${staged.value.staged_run.final_run_path}/${sourceArtifact.relative_path}`
    )
  );
  assert.deepEqual(
    await snapshotB5Tree(join(rootDir, ".local/state")),
    stateBeforeFailure
  );
  assert.deepEqual(await readFile(join(rootDir, B6_CURRENT_POINTER)), pointerBytes);
  await writeFile(sourcePath, originalSource);
});

test("B6 fresh publication validates the complete immutable run topology and preserves exact wide-mode artifacts", async (t) => {
  const stageCleaningRun = await loadStageCleaningRun();
  const publishCleaningRun = await loadPublishCleaningRun();
  const scenarios = [
    "missing-artifact",
    "extra-entry",
    "artifact-symlink",
    "artifact-fifo",
    "missing-run-directory",
    "required-directory-file",
    "wide-mode-artifact"
  ];
  for (const scenario of scenarios) {
    await t.test(scenario, async (t) => {
      const rootDir = await makeB5Root(t, `b6-run-${scenario}`);
      const plan = makeB5GoldenPlan();
      const staged = await stageCleaningRun(b5Options(rootDir, plan));
      const stagedRun = staged.value.staged_run;
      const source = plan.manifest.artifact_manifest.find((artifact) =>
        artifact.relative_path.startsWith("sources/"));
      const sourceRelative = `${stagedRun.final_run_path}/${source.relative_path}`;
      const sourcePath = join(rootDir, sourceRelative);
      const sourceBytes = await readFile(sourcePath);
      let expectedPath = sourceRelative;
      let externalPath = null;
      if (scenario === "missing-artifact") {
        await unlink(sourcePath);
      } else if (scenario === "extra-entry") {
        expectedPath = `${stagedRun.final_run_path}/unexpected`;
        await writeFile(join(rootDir, expectedPath), Buffer.from("extra"));
      } else if (scenario === "artifact-symlink") {
        externalPath = join(rootDir, "external-run-artifact");
        await writeFile(externalPath, sourceBytes);
        await unlink(sourcePath);
        await symlink(externalPath, sourcePath);
      } else if (scenario === "artifact-fifo") {
        await unlink(sourcePath);
        const fifo = await runBoundedChild("/usr/bin/mkfifo", [sourcePath]);
        assert.equal(fifo.timedOut, false, fifo.stderr);
        assert.equal(fifo.code, 0, fifo.stderr);
      } else if (scenario === "missing-run-directory") {
        expectedPath = stagedRun.final_run_path;
        await rename(
          join(rootDir, stagedRun.final_run_path),
          join(rootDir, `${stagedRun.final_run_path}.moved`)
        );
      } else if (scenario === "required-directory-file") {
        expectedPath = `${stagedRun.final_run_path}/catalog`;
        await rename(
          join(rootDir, expectedPath),
          join(rootDir, `${expectedPath}.saved`)
        );
        await writeFile(join(rootDir, expectedPath), Buffer.from("not a directory"));
      } else {
        await chmod(sourcePath, 0o644);
      }

      const beforeState = await snapshotB5Tree(join(rootDir, ".local"));
      const result = await publishCleaningRun(b6Options(rootDir, stagedRun));
      if (scenario === "wide-mode-artifact") {
        assert.equal(result.ok, true);
        assert.equal(result.value.kind, "published");
        assert.equal((await lstat(sourcePath)).mode & 0o777, 0o644);
      } else {
        assert.deepEqual(result, b5ExpectedFailure("RUN_CONFLICT", expectedPath));
        assert.deepEqual(await snapshotB5Tree(join(rootDir, ".local")), beforeState);
        await assert.rejects(() => lstat(join(rootDir, B6_CURRENT_POINTER)), {
          code: "ENOENT"
        });
      }
      if (externalPath !== null) {
        assert.deepEqual(await readFile(externalPath), sourceBytes);
      }
    });
  }
});

const B6_ALREADY_CURRENT_RUN_RACE_CHILD_SCRIPT = `
import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { join, relative, sep } from "node:path";

const [moduleUrl, rootDir, encodedStagedRun, raceKind, artifactPath] =
  process.argv.slice(1);
const stagedRun = JSON.parse(Buffer.from(encodedStagedRun, "base64").toString("utf8"));
const realRoot = fs.realpathSync(rootDir);
const original = {
  open: fs.promises.open,
  writeFile: fs.promises.writeFile,
  unlink: fs.promises.unlink
};
const conflictPath = raceKind === "extra"
  ? stagedRun.final_run_path + "/unexpected-during-terminal"
  : artifactPath;
let mutated = false;
function repoPath(value) {
  return relative(realRoot, value).split(sep).join("/");
}
fs.promises.open = async (...args) => {
  const path = repoPath(args[0]);
  if (!mutated &&
      /^\\.local\\/state\\/cleaning-transitions\\/\\.complete-/.test(path)) {
    if (raceKind === "extra") {
      await original.writeFile(
        join(realRoot, ...conflictPath.split("/")),
        Buffer.from("extra"),
        { flag: "wx", mode: 0o600 }
      );
    } else {
      await original.unlink(join(realRoot, ...artifactPath.split("/")));
    }
    mutated = true;
  }
  return original.open(...args);
};
syncBuiltinESMExports();

const { publishCleaningRun } = await import(moduleUrl);
const result = await publishCleaningRun({
  rootDir,
  runsRoot: ".local/cleaned/runs",
  currentPointer: ".local/state/current-cleaning.json",
  stagedRun
});
process.stdout.write(JSON.stringify({ result, mutated, conflict_path: conflictPath }));
`;

test("B6 already_current rechecks run topology after terminal publication", async (t) => {
  const stageCleaningRun = await loadStageCleaningRun();
  const publishCleaningRun = await loadPublishCleaningRun();
  for (const raceKind of ["extra", "missing"]) {
    await t.test(raceKind, async (t) => {
      const rootDir = await makeB5Root(t, `b6-already-current-${raceKind}`);
      const plan = makeB5GoldenPlan();
      const staged = await stageCleaningRun(b5Options(rootDir, plan));
      const options = b6Options(rootDir, staged.value.staged_run);
      assert.equal((await publishCleaningRun(options)).ok, true);
      const artifact = plan.manifest.artifact_manifest.find((entry) =>
        entry.relative_path.startsWith("sources/"));
      const artifactPath = `${staged.value.staged_run.final_run_path}/${artifact.relative_path}`;
      const child = await runBoundedChild(process.execPath, [
        "--input-type=module",
        "--eval",
        B6_ALREADY_CURRENT_RUN_RACE_CHILD_SCRIPT,
        B5_MODULE_URL,
        rootDir,
        encodeB6StagedRun(staged.value.staged_run),
        raceKind,
        artifactPath
      ]);
      assert.equal(child.timedOut, false, child.stderr);
      assert.equal(child.code, 0, child.stderr);
      const observed = JSON.parse(child.stdout);
      assert.equal(observed.mutated, true);
      assert.deepEqual(
        observed.result,
        b5ExpectedFailure("RUN_CONFLICT", observed.conflict_path, true)
      );
      assert.notEqual(
        validateB6CanonicalLockForTest(
          await readFile(join(rootDir, ".local/state/cleaning-commit.lock"))
        ),
        null
      );
    });
  }
});

test("B6 valid lock contention is read-only while malformed and unsafe fixed locks fail closed", async (t) => {
  const stageCleaningRun = await loadStageCleaningRun();
  const publishCleaningRun = await loadPublishCleaningRun();

  await t.test("valid lock is detected before a missing transitions directory can be created", async (t) => {
    const rootDir = await makeB5Root(t, "b6-valid-lock-no-transitions");
    const plan = makeB5GoldenPlan();
    const staged = await stageCleaningRun(b5Options(rootDir, plan));
    const stateDir = join(rootDir, ".local/state");
    await mkdir(stateDir, { mode: 0o700 });
    const lockBytes = canonicalJsonDocumentBytes(makeB6CommitLockIntent(plan));
    await writeFile(join(stateDir, "cleaning-commit.lock"), lockBytes, { mode: 0o600 });
    const before = await snapshotB5Tree(stateDir);

    assert.deepEqual(
      await publishCleaningRun(b6Options(rootDir, staged.value.staged_run)),
      b5ExpectedFailure(
        "CLEANING_COMMIT_LOCKED",
        ".local/state/cleaning-commit.lock"
      )
    );
    assert.deepEqual(await snapshotB5Tree(stateDir), before);
    await assert.rejects(
      () => lstat(join(stateDir, "cleaning-transitions")),
      { code: "ENOENT" }
    );
  });

  await t.test("valid canonical lock blocks without pointer or persistent writes", async (t) => {
    const rootDir = await makeB5Root(t, "b6-valid-lock");
    const plan = makeB5GoldenPlan();
    const staged = await stageCleaningRun(b5Options(rootDir, plan));
    const stateDir = join(rootDir, ".local/state");
    await mkdir(join(stateDir, "cleaning-transitions"), {
      recursive: true,
      mode: 0o700
    });
    const lockBytes = canonicalJsonDocumentBytes(makeB6CommitLockIntent(plan));
    await writeFile(join(stateDir, "cleaning-commit.lock"), lockBytes, { mode: 0o600 });
    const before = await snapshotB5Tree(stateDir);

    assert.deepEqual(
      await publishCleaningRun(b6Options(rootDir, staged.value.staged_run)),
      b5ExpectedFailure(
        "CLEANING_COMMIT_LOCKED",
        ".local/state/cleaning-commit.lock"
      )
    );
    assert.deepEqual(await snapshotB5Tree(stateDir), before);
    await assert.rejects(() => lstat(join(rootDir, B6_CURRENT_POINTER)), { code: "ENOENT" });
  });

  for (const mode of [0o1600, 0o2600, 0o4600]) {
    await t.test(
      "valid canonical lock rejects special mode " + mode.toString(8),
      async (t) => {
        const rootDir = await makeB5Root(
          t,
          "b6-valid-lock-special-" + mode.toString(8)
        );
        const plan = makeB5GoldenPlan();
        const staged = await stageCleaningRun(b5Options(rootDir, plan));
        const stateDir = join(rootDir, ".local/state");
        await mkdir(join(stateDir, "cleaning-transitions"), {
          recursive: true,
          mode: 0o700
        });
        const lockPath = join(stateDir, "cleaning-commit.lock");
        await writeFile(
          lockPath,
          canonicalJsonDocumentBytes(makeB6CommitLockIntent(plan)),
          { mode: 0o600 }
        );
        await chmod(lockPath, mode);
        const retainedMode = (await lstat(lockPath)).mode & 0o7777;
        if (retainedMode !== mode) {
          assert.equal(retainedMode, 0o600);
          t.diagnostic(
            "host did not retain requested special file mode " +
              mode.toString(8)
          );
          return;
        }
        const before = await snapshotB5Tree(stateDir);

        assert.deepEqual(
          await publishCleaningRun(b6Options(rootDir, staged.value.staged_run)),
          b5ExpectedFailure(
            "LOCAL_STATE_INVALID",
            ".local/state/cleaning-commit.lock"
          )
        );
        assert.deepEqual(await snapshotB5Tree(stateDir), before);
      }
    );
  }

  await t.test("valid canonical lock outranks a malformed pointer without mutation", async (t) => {
    const rootDir = await makeB5Root(t, "b6-valid-lock-malformed-pointer");
    const plan = makeB5GoldenPlan();
    const staged = await stageCleaningRun(b5Options(rootDir, plan));
    const stateDir = join(rootDir, ".local/state");
    await mkdir(join(stateDir, "cleaning-transitions"), {
      recursive: true,
      mode: 0o700
    });
    await writeFile(
      join(stateDir, "cleaning-commit.lock"),
      canonicalJsonDocumentBytes(makeB6CommitLockIntent(plan)),
      { mode: 0o600 }
    );
    await writeFile(
      join(rootDir, B6_CURRENT_POINTER),
      Buffer.from("{}\n"),
      { mode: 0o600 }
    );
    const before = await snapshotB5Tree(stateDir);

    assert.deepEqual(
      await publishCleaningRun(b6Options(rootDir, staged.value.staged_run)),
      b5ExpectedFailure(
        "CLEANING_COMMIT_LOCKED",
        ".local/state/cleaning-commit.lock"
      )
    );
    assert.deepEqual(await snapshotB5Tree(stateDir), before);
  });

  await t.test("noncanonical lock bytes are local-state invalid, not contention", async (t) => {
    const rootDir = await makeB5Root(t, "b6-wrong-lock");
    const plan = makeB5GoldenPlan();
    const staged = await stageCleaningRun(b5Options(rootDir, plan));
    const stateDir = join(rootDir, ".local/state");
    await mkdir(join(stateDir, "cleaning-transitions"), {
      recursive: true,
      mode: 0o700
    });
    await writeFile(join(stateDir, "cleaning-commit.lock"), Buffer.from("{}\n"), {
      mode: 0o600
    });
    const before = await snapshotB5Tree(stateDir);

    assert.deepEqual(
      await publishCleaningRun(b6Options(rootDir, staged.value.staged_run)),
      b5ExpectedFailure(
        "LOCAL_STATE_INVALID",
        ".local/state/cleaning-commit.lock"
      )
    );
    assert.deepEqual(await snapshotB5Tree(stateDir), before);
  });

  for (const leafKind of ["directory", "symlink"]) {
    await t.test(`${leafKind} lock never mutates an external target`, async (t) => {
      const rootDir = await makeB5Root(t, `b6-${leafKind}-lock`);
      const plan = makeB5GoldenPlan();
      const staged = await stageCleaningRun(b5Options(rootDir, plan));
      const stateDir = join(rootDir, ".local/state");
      await mkdir(join(stateDir, "cleaning-transitions"), {
        recursive: true,
        mode: 0o700
      });
      const lockPath = join(stateDir, "cleaning-commit.lock");
      const externalPath = join(rootDir, "external-lock-target");
      await writeFile(externalPath, Buffer.from("external"));
      if (leafKind === "directory") {
        await mkdir(lockPath);
      } else {
        await symlink(externalPath, lockPath);
      }

      assert.deepEqual(
        await publishCleaningRun(b6Options(rootDir, staged.value.staged_run)),
        b5ExpectedFailure(
          "LOCAL_STATE_INVALID",
          ".local/state/cleaning-commit.lock"
        )
      );
      assert.deepEqual(await readFile(externalPath), Buffer.from("external"));
      assert.equal((await lstat(lockPath)).isDirectory(), leafKind === "directory");
      assert.equal((await lstat(lockPath)).isSymbolicLink(), leafKind === "symlink");
    });
  }
});

test("B6 existing publication directories must retain private 0700 modes", async (t) => {
  const stageCleaningRun = await loadStageCleaningRun();
  const publishCleaningRun = await loadPublishCleaningRun();
  for (const [relativePath, mode] of [
    [".local/state", 0o755],
    [".local/state", 0o777],
    [".local/state", 0o1700],
    [".local/state", 0o2700],
    [".local/state", 0o4700],
    [".local/state/cleaning-transitions", 0o755],
    [".local/state/cleaning-transitions", 0o777],
    [".local/state/cleaning-transitions", 0o1700],
    [".local/state/cleaning-transitions", 0o2700],
    [".local/state/cleaning-transitions", 0o4700]
  ]) {
    await t.test(`${relativePath} ${mode.toString(8)}`, async (t) => {
      const rootDir = await makeB5Root(
        t,
        `b6-directory-mode-${relativePath.split("/").at(-1)}-${mode.toString(8)}`
      );
      const plan = makeB5GoldenPlan();
      const staged = await stageCleaningRun(b5Options(rootDir, plan));
      await prepareB6CrashState(rootDir, "full");
      await chmod(join(rootDir, relativePath), mode);
      const retainedMode =
        (await lstat(join(rootDir, relativePath))).mode & 0o7777;
      if (retainedMode !== mode) {
        assert.equal(retainedMode, 0o700);
        t.diagnostic(
          "host did not retain requested special directory mode " +
            mode.toString(8)
        );
        return;
      }
      const before = await snapshotB5Tree(join(rootDir, ".local/state"));

      assert.deepEqual(
        await publishCleaningRun(b6Options(rootDir, staged.value.staged_run)),
        b5ExpectedFailure("LOCAL_STATE_INVALID", relativePath)
      );
      assert.deepEqual(await snapshotB5Tree(join(rootDir, ".local/state")), before);
      await assert.rejects(() => lstat(join(rootDir, B6_CURRENT_POINTER)), {
        code: "ENOENT"
      });
    });
  }
});

test("B6 stale pointer publishes only exact retirement evidence and releases only its own lock", async (t) => {
  const stageCleaningRun = await loadStageCleaningRun();
  const publishCleaningRun = await loadPublishCleaningRun();

  for (const scenario of ["different-pointer", "incremental-absence"]) {
    await t.test(scenario, async (t) => {
      const rootDir = await makeB5Root(t, `b6-stale-${scenario}`);
      const priorPlan = makeB5GoldenPlan();
      const plan = scenario === "different-pointer"
        ? priorPlan
        : makeB6IncrementalPlan(priorPlan);
      const staged = await stageCleaningRun(b5Options(rootDir, plan));
      assert.equal(staged.ok, true);
      const stateDir = join(rootDir, ".local/state");
      await mkdir(stateDir, { recursive: true, mode: 0o700 });
      let observedBytes = null;
      let pointerIdentity = null;
      if (scenario === "different-pointer") {
        const otherPlan = makeB6IncrementalPlan(priorPlan);
        observedBytes = canonicalJsonDocumentBytes(otherPlan.manifest.desired_pointer);
        await writeFile(join(rootDir, B6_CURRENT_POINTER), observedBytes, { mode: 0o600 });
        const info = await lstat(join(rootDir, B6_CURRENT_POINTER));
        pointerIdentity = { dev: info.dev, ino: info.ino };
      }

      const result = await publishCleaningRun(
        b6Options(rootDir, staged.value.staged_run)
      );

      assert.deepEqual(
        result,
        b5ExpectedFailure(
          "STALE_POINTER_TRANSITION",
          B6_CURRENT_POINTER,
          true
        )
      );
      if (observedBytes === null) {
        await assert.rejects(() => lstat(join(rootDir, B6_CURRENT_POINTER)), {
          code: "ENOENT"
        });
      } else {
        assert.deepEqual(await readFile(join(rootDir, B6_CURRENT_POINTER)), observedBytes);
        const info = await lstat(join(rootDir, B6_CURRENT_POINTER));
        assert.deepEqual({ dev: info.dev, ino: info.ino }, pointerIdentity);
      }
      const stateNames = (await readdir(stateDir)).sort();
      assert.deepEqual(
        stateNames,
        observedBytes === null
          ? ["cleaning-transitions"]
          : ["cleaning-transitions", "current-cleaning.json"]
      );
      const transitionNames = await readdir(join(stateDir, "cleaning-transitions"));
      assert.equal(transitionNames.length, 1);
      const observedHash = observedBytes === null ? null : sha256(observedBytes);
      const observedSuffix = observedHash ?? "absent";
      const name = transitionNames[0];
      assert.match(
        name,
        new RegExp(`^retire-[0-9a-f]{64}-${observedSuffix}\\.json$`)
      );
      const commitLockSha256 = name.slice("retire-".length, "retire-".length + 64);
      assert.deepEqual(
        await readFile(join(stateDir, "cleaning-transitions", name)),
        canonicalJsonDocumentBytes({
          schema_version: "1.0.0",
          record_kind: "retirement",
          plan_manifest_sha256: plan.manifest_sha256,
          commit_lock_sha256: commitLockSha256,
          expected_prior_pointer_sha256: plan.manifest.expected_prior_pointer_sha256,
          desired_pointer_sha256: plan.manifest.desired_pointer_sha256,
          observed_pointer_sha256: observedHash,
          reason: "stale_pointer"
        })
      );
      assert.equal(
        (await lstat(join(stateDir, "cleaning-transitions", name))).mode & 0o777,
        0o600
      );
    });
  }
});

const B6_EXISTING_TERMINAL_CHILD_SCRIPT = `
import crypto from "node:crypto";
import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { join, relative, sep } from "node:path";

const [moduleUrl, rootDir, encodedStagedRun, terminalKind, existingKind] =
  process.argv.slice(1);
const stagedRun = JSON.parse(Buffer.from(encodedStagedRun, "base64").toString("utf8"));
const realRoot = fs.realpathSync(rootDir);
const stateDir = join(realRoot, ".local", "state");
const transitionsDir = join(stateDir, "cleaning-transitions");
const pointerPath = join(stateDir, "current-cleaning.json");
const nonce = "ef".repeat(16);
const { canonicalJsonDocumentBytes } = await import(new URL("./json.mjs", moduleUrl));
const { sha256 } = await import(new URL("./hash.mjs", moduleUrl));
const original = { open: fs.promises.open };

crypto.randomBytes = () => Buffer.from(nonce, "hex");
syncBuiltinESMExports();
const manifest = stagedRun.plan_manifest;
const lockIntent = {
  schema_version: "1.0.0",
  owner_pid: process.pid,
  owner_nonce: nonce,
  plan_manifest: manifest,
  plan_manifest_sha256: stagedRun.plan_manifest_sha256,
  expected_prior_pointer_sha256: manifest.expected_prior_pointer_sha256,
  desired_pointer_sha256: manifest.desired_pointer_sha256,
  desired_pointer: manifest.desired_pointer,
  run_sha256: stagedRun.run_sha256
};
const lockHash = sha256(canonicalJsonDocumentBytes(lockIntent));
let record;
let recordName;
if (terminalKind === "completion") {
  record = {
    schema_version: "1.0.0",
    record_kind: "completion",
    commit_lock_sha256: lockHash,
    plan_manifest_sha256: stagedRun.plan_manifest_sha256,
    expected_prior_pointer_sha256: manifest.expected_prior_pointer_sha256,
    desired_pointer_sha256: manifest.desired_pointer_sha256,
    desired_pointer: manifest.desired_pointer
  };
  recordName = "complete-" + lockHash + "-" +
    manifest.desired_pointer_sha256 + ".json";
} else {
  const pointerBytes = await fs.promises.readFile(pointerPath);
  const observedHash = sha256(pointerBytes);
  record = {
    schema_version: "1.0.0",
    record_kind: "retirement",
    plan_manifest_sha256: stagedRun.plan_manifest_sha256,
    commit_lock_sha256: lockHash,
    expected_prior_pointer_sha256: manifest.expected_prior_pointer_sha256,
    desired_pointer_sha256: manifest.desired_pointer_sha256,
    observed_pointer_sha256: observedHash,
    reason: "stale_pointer"
  };
  recordName = "retire-" + lockHash + "-" + observedHash + ".json";
}
const recordPath = join(transitionsDir, recordName);
const recordBytes = canonicalJsonDocumentBytes(record);
await fs.promises.writeFile(
  recordPath,
  existingKind === "wrong" ? Buffer.from("{}\\n") : recordBytes,
  { flag: "wx", mode: 0o600 }
);
if (existingKind === "mode") fs.chmodSync(recordPath, 0o644);
let replaced = false;
let externalPath = null;
let externalBefore = null;
if (existingKind === "replace") {
  fs.promises.open = async (...args) => {
    const openedPath = args[0];
    const handle = await original.open(...args);
    if (openedPath !== transitionsDir) return handle;
    return new Proxy(handle, {
      get(target, property) {
        if (property === "sync") {
          return async (...methodArgs) => {
            const value = await target.sync(...methodArgs);
            if (!replaced) {
              externalPath = join(realRoot, "external-existing-" + terminalKind);
              await fs.promises.writeFile(externalPath, recordBytes, {
                flag: "wx",
                mode: 0o600
              });
              externalBefore = recordBytes.toString("base64");
              await fs.promises.unlink(recordPath);
              await fs.promises.link(externalPath, recordPath);
              replaced = true;
            }
            return value;
          };
        }
        const member = Reflect.get(target, property, target);
        return typeof member === "function" ? member.bind(target) : member;
      }
    });
  };
  syncBuiltinESMExports();
}

const { publishCleaningRun } = await import(moduleUrl);
const result = await publishCleaningRun({
  rootDir,
  runsRoot: ".local/cleaned/runs",
  currentPointer: ".local/state/current-cleaning.json",
  stagedRun
});
const externalAfter = externalPath === null
  ? null
  : (await fs.promises.readFile(externalPath)).toString("base64");
process.stdout.write(JSON.stringify({
  result,
  record_path: relative(realRoot, recordPath).split(sep).join("/"),
  record_bytes: (await fs.promises.readFile(recordPath)).toString("base64"),
  exact_bytes: recordBytes.toString("base64"),
  replaced,
  external_before: externalBefore,
  external_after: externalAfter,
  lock_exists: fs.existsSync(join(stateDir, "cleaning-commit.lock"))
}));
`;

test("B6 existing C-bound completion and retirement records are exact, mode-safe, and identity-stable", async (t) => {
  const stageCleaningRun = await loadStageCleaningRun();
  for (const terminalKind of ["completion", "retirement"]) {
    for (const existingKind of ["exact", "wrong", "mode", "replace"]) {
      await t.test(`${terminalKind} ${existingKind}`, async (t) => {
        const rootDir = await makeB5Root(
          t,
          `b6-existing-${terminalKind}-${existingKind}`
        );
        const plan = makeB5GoldenPlan();
        const staged = await stageCleaningRun(b5Options(rootDir, plan));
        await prepareB6CrashState(rootDir, "full");
        if (terminalKind === "completion") {
          const first = await (await loadPublishCleaningRun())(
            b6Options(rootDir, staged.value.staged_run)
          );
          assert.equal(first.ok, true);
          assert.equal(first.value.kind, "published");
        } else {
          const otherPlan = makeB6IncrementalPlan(plan);
          await writeFile(
            join(rootDir, B6_CURRENT_POINTER),
            canonicalJsonDocumentBytes(otherPlan.manifest.desired_pointer),
            { mode: 0o600 }
          );
        }
        const child = await runBoundedChild(process.execPath, [
          "--input-type=module",
          "--eval",
          B6_EXISTING_TERMINAL_CHILD_SCRIPT,
          B5_MODULE_URL,
          rootDir,
          encodeB6StagedRun(staged.value.staged_run),
          terminalKind,
          existingKind
        ]);
        assert.equal(child.timedOut, false, child.stderr);
        assert.equal(child.code, 0, child.stderr);
        const observed = JSON.parse(child.stdout);
        if (existingKind === "exact") {
          if (terminalKind === "completion") {
            assert.equal(observed.result.ok, true);
            assert.equal(observed.result.value.kind, "already_current");
          } else {
            assert.deepEqual(
              observed.result,
              b5ExpectedFailure(
                "STALE_POINTER_TRANSITION",
                B6_CURRENT_POINTER,
                true
              )
            );
          }
          assert.equal(observed.record_bytes, observed.exact_bytes);
          assert.equal(observed.lock_exists, false);
        } else {
          assert.deepEqual(
            observed.result,
            b5ExpectedFailure(
              "LOCAL_STATE_INVALID",
              observed.record_path,
              true
            )
          );
          assert.equal(observed.lock_exists, true);
        }
        if (existingKind === "replace") {
          assert.equal(observed.replaced, true);
          assert.equal(observed.external_after, observed.external_before);
        }
      });
    }
  }
});

test("B6 malformed or symlink pointer is local-state invalid and never becomes stale evidence", async (t) => {
  const stageCleaningRun = await loadStageCleaningRun();
  const publishCleaningRun = await loadPublishCleaningRun();

  for (const pointerKind of ["malformed", "symlink"]) {
    await t.test(pointerKind, async (t) => {
      const rootDir = await makeB5Root(t, `b6-${pointerKind}-pointer`);
      const plan = makeB5GoldenPlan();
      const staged = await stageCleaningRun(b5Options(rootDir, plan));
      const stateDir = join(rootDir, ".local/state");
      const transitionsDir = join(stateDir, "cleaning-transitions");
      await mkdir(transitionsDir, { recursive: true, mode: 0o700 });
      const pointerPath = join(rootDir, B6_CURRENT_POINTER);
      const malformedBytes = Buffer.from("{}\n");
      const externalPath = join(rootDir, "external-pointer-target");
      if (pointerKind === "malformed") {
        await writeFile(pointerPath, malformedBytes, { mode: 0o600 });
      } else {
        await writeFile(externalPath, malformedBytes);
        await symlink(externalPath, pointerPath);
      }

      assert.deepEqual(
        await publishCleaningRun(b6Options(rootDir, staged.value.staged_run)),
        b5ExpectedFailure("LOCAL_STATE_INVALID", B6_CURRENT_POINTER, true)
      );
      assert.deepEqual(await readdir(transitionsDir), []);
      if (pointerKind === "malformed") {
        assert.deepEqual(await readFile(pointerPath), malformedBytes);
      } else {
        assert.equal((await lstat(pointerPath)).isSymbolicLink(), true);
        assert.deepEqual(await readFile(externalPath), malformedBytes);
      }
      const lockBytes = await readFile(join(stateDir, "cleaning-commit.lock"));
      assert.notEqual(validateB6CanonicalLockForTest(lockBytes), null);
    });
  }
});

const B6_UNSAFE_PUBLICATION_LEAF_CHILD_SCRIPT = `
import fs from "node:fs";
import { spawnSync } from "node:child_process";
import { syncBuiltinESMExports } from "node:module";
import { dirname, join, relative, sep } from "node:path";

const [moduleUrl, rootDir, encodedStagedRun, targetKind, leafKind, socketSource] =
  process.argv.slice(1);
const stagedRun = JSON.parse(Buffer.from(encodedStagedRun, "base64").toString("utf8"));
const realRoot = fs.realpathSync(rootDir);
const stateDir = join(realRoot, ".local", "state");
const transitionsDir = join(stateDir, "cleaning-transitions");
const fixedLock = join(stateDir, "cleaning-commit.lock");
const fixedPointer = join(stateDir, "current-cleaning.json");
const original = {
  lstat: fs.promises.lstat,
  open: fs.promises.open,
  mkdir: fs.promises.mkdir,
  writeFile: fs.promises.writeFile,
  link: fs.promises.link,
  symlink: fs.promises.symlink,
  readFile: fs.promises.readFile
};
let injected = false;
let injectedPath = null;
let externalPath = null;
let externalBefore = null;

function repoPath(value) {
  return relative(realRoot, value).split(sep).join("/");
}
function matches(value) {
  const path = repoPath(value);
  if (targetKind === "fixed-lock") return path === ".local/state/cleaning-commit.lock";
  if (targetKind === "pointer") return path === ".local/state/current-cleaning.json";
  if (targetKind === "lock-candidate") {
    return /^\\.local\\/state\\/\\.cleaning-commit\\.[0-9]+\\.[0-9a-f]{32}\\.tmp$/.test(path);
  }
  if (targetKind === "pointer-temp") {
    return /^\\.local\\/state\\/\\.current-cleaning\\.[0-9]+\\.[0-9a-f]{32}\\.tmp$/.test(path);
  }
  if (targetKind === "completion-temp") {
    return /^\\.local\\/state\\/cleaning-transitions\\/\\.complete-.*\\.tmp$/.test(path);
  }
  if (targetKind === "retirement-temp") {
    return /^\\.local\\/state\\/cleaning-transitions\\/\\.retire-.*\\.tmp$/.test(path);
  }
  if (targetKind === "completion-record") {
    return /^\\.local\\/state\\/cleaning-transitions\\/complete-[0-9a-f]{64}-[0-9a-f]{64}\\.json$/.test(path);
  }
  if (targetKind === "retirement-record") {
    return /^\\.local\\/state\\/cleaning-transitions\\/retire-[0-9a-f]{64}-(?:[0-9a-f]{64}|absent)\\.json$/.test(path);
  }
  return false;
}
async function injectLeaf(target) {
  await original.mkdir(dirname(target), { recursive: true, mode: 0o700 });
  injectedPath = repoPath(target);
  if (leafKind === "directory") {
    await original.mkdir(target, { mode: 0o700 });
  } else if (leafKind === "fifo") {
    const child = spawnSync("/usr/bin/mkfifo", [target], { encoding: "utf8" });
    if (child.status !== 0) throw new Error("mkfifo failed: " + child.stderr);
  } else if (leafKind === "socket") {
    await original.link(socketSource, target);
  } else {
    externalPath = join(realRoot, "external-" + targetKind + "-" + leafKind);
    const bytes = Buffer.from("external-" + targetKind + "-" + leafKind);
    await original.writeFile(externalPath, bytes, { flag: "wx", mode: 0o600 });
    externalBefore = bytes.toString("base64");
    if (leafKind === "symlink") {
      await original.symlink(externalPath, target);
    } else {
      await original.link(externalPath, target);
    }
  }
  injected = true;
}

if (targetKind === "fixed-lock") await injectLeaf(fixedLock);
if (targetKind === "pointer") await injectLeaf(fixedPointer);
fs.promises.open = async (...args) => {
  if (!injected && (targetKind === "lock-candidate" ||
      targetKind.endsWith("temp")) && matches(args[0])) {
    await injectLeaf(args[0]);
  }
  return original.open(...args);
};
fs.promises.lstat = async (...args) => {
  if (!injected && targetKind.endsWith("record") && matches(args[0])) {
    await injectLeaf(args[0]);
  }
  return original.lstat(...args);
};
syncBuiltinESMExports();

const { publishCleaningRun } = await import(moduleUrl);
const result = await publishCleaningRun({
  rootDir,
  runsRoot: ".local/cleaned/runs",
  currentPointer: ".local/state/current-cleaning.json",
  stagedRun
});
const externalAfter = externalPath === null
  ? null
  : (await original.readFile(externalPath)).toString("base64");
process.stdout.write(JSON.stringify({
  result,
  injected,
  injected_path: injectedPath,
  external_before: externalBefore,
  external_after: externalAfter,
  pointer_exists: fs.existsSync(fixedPointer),
  lock_exists: fs.existsSync(fixedLock)
}));
`;

test("B6 unsafe fixed, candidate-temp, pointer, and transition leaves never block or mutate external targets", async (t) => {
  const stageCleaningRun = await loadStageCleaningRun();
  const targetKinds = [
    "fixed-lock",
    "lock-candidate",
    "pointer",
    "pointer-temp",
    "completion-temp",
    "completion-record",
    "retirement-temp",
    "retirement-record"
  ];
  const leafKinds = ["symlink", "directory", "fifo", "socket", "wrong-bytes"];
  for (const targetKind of targetKinds) {
    for (const leafKind of leafKinds) {
      await t.test(`${targetKind} ${leafKind}`, async (t) => {
        const rootDir = await makeB5Root(t, `b6-unsafe-${targetKind}-${leafKind}`);
        const plan = makeB5GoldenPlan();
        const staged = await stageCleaningRun(b5Options(rootDir, plan));
        await prepareB6CrashState(rootDir, "full");
        if (targetKind.startsWith("retirement")) {
          const otherPlan = makeB6IncrementalPlan(plan);
          await writeFile(
            join(rootDir, B6_CURRENT_POINTER),
            canonicalJsonDocumentBytes(otherPlan.manifest.desired_pointer),
            { mode: 0o600 }
          );
        }
        const socketSource = leafKind === "socket"
          ? await makeB6SocketSource(t)
          : "-";
        const child = await runBoundedChild(process.execPath, [
          "--input-type=module",
          "--eval",
          B6_UNSAFE_PUBLICATION_LEAF_CHILD_SCRIPT,
          B5_MODULE_URL,
          rootDir,
          encodeB6StagedRun(staged.value.staged_run),
          targetKind,
          leafKind,
          socketSource
        ]);
        assert.equal(child.timedOut, false, child.stderr);
        assert.equal(child.code, 0, child.stderr);
        const observed = JSON.parse(child.stdout);
        assert.equal(observed.injected, true, child.stdout);
        assert.deepEqual(
          observed.result,
          b5ExpectedFailure(
            "LOCAL_STATE_INVALID",
            observed.injected_path,
            !["fixed-lock", "lock-candidate"].includes(targetKind)
          )
        );
        assert.equal(observed.external_after, observed.external_before);
      });
    }
  }
});

function encodeB6StagedRun(stagedRun) {
  return Buffer.from(JSON.stringify(stagedRun), "utf8").toString("base64");
}

const B6_IO_FAILURE_CHILD_SCRIPT = `
import crypto from "node:crypto";
import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { relative, sep } from "node:path";

const [
  moduleUrl,
  rootDir,
  encodedStagedRun,
  primaryOperation,
  targetKind,
  occurrenceText,
  closeAlsoText
] = process.argv.slice(1);
const stagedRun = JSON.parse(Buffer.from(encodedStagedRun, "base64").toString("utf8"));
const occurrence = Number(occurrenceText);
const closeAlso = closeAlsoText === "true";
const realRoot = fs.realpathSync(rootDir);
const original = {
  realpathSync: fs.realpathSync,
  lstat: fs.promises.lstat,
  readdir: fs.promises.readdir,
  mkdir: fs.promises.mkdir,
  open: fs.promises.open,
  link: fs.promises.link,
  unlink: fs.promises.unlink,
  rename: fs.promises.rename,
  randomBytes: crypto.randomBytes
};
let matchingCalls = 0;
let primaryTriggered = false;
let closeTriggered = false;
let injectedPath = null;

function repoPath(value) {
  if (typeof value !== "string") return null;
  const path = relative(realRoot, value).split(sep).join("/");
  return path === "" ? null : path;
}
function matches(value) {
  const path = repoPath(value);
  if (targetKind === "@root") return value === rootDir || value === realRoot;
  if (targetKind === "lock-candidate") {
    return /^\\.local\\/state\\/\\.cleaning-commit\\.[0-9]+\\.[0-9a-f]{32}\\.tmp$/.test(path ?? "");
  }
  if (targetKind === "pointer-temp") {
    return /^\\.local\\/state\\/\\.current-cleaning\\.[0-9]+\\.[0-9a-f]{32}\\.tmp$/.test(path ?? "");
  }
  if (targetKind === "completion-temp") {
    return /^\\.local\\/state\\/cleaning-transitions\\/\\.complete-.*\\.json\\.[0-9]+\\.[0-9a-f]{32}\\.tmp$/.test(path ?? "");
  }
  if (targetKind === "completion-record") {
    return /^\\.local\\/state\\/cleaning-transitions\\/complete-[0-9a-f]{64}-[0-9a-f]{64}\\.json$/.test(path ?? "");
  }
  if (targetKind === "retirement-temp") {
    return /^\\.local\\/state\\/cleaning-transitions\\/\\.retire-.*\\.json\\.[0-9]+\\.[0-9a-f]{32}\\.tmp$/.test(path ?? "");
  }
  if (targetKind === "retirement-record") {
    return /^\\.local\\/state\\/cleaning-transitions\\/retire-[0-9a-f]{64}-(?:[0-9a-f]{64}|absent)\\.json$/.test(path ?? "");
  }
  return path === targetKind;
}
function injectedError(operation) {
  const error = new Error("injected " + operation + " failure");
  error.code = "EIO";
  return error;
}
function failPrimary(operation, value) {
  if (primaryTriggered || operation !== primaryOperation || !matches(value)) return;
  matchingCalls += 1;
  if (matchingCalls !== occurrence) return;
  primaryTriggered = true;
  injectedPath = repoPath(value);
  throw injectedError(operation);
}

crypto.randomBytes = () => Buffer.from("ab".repeat(16), "hex");
fs.realpathSync = (...args) => {
  failPrimary("realpath", args[0]);
  return original.realpathSync(...args);
};
for (const operation of ["lstat", "readdir", "mkdir", "unlink"]) {
  fs.promises[operation] = async (...args) => {
    failPrimary(operation, args[0]);
    return original[operation](...args);
  };
}
fs.promises.link = async (...args) => {
  failPrimary("link", args[1]);
  return original.link(...args);
};
fs.promises.rename = async (...args) => {
  failPrimary("rename", args[1]);
  return original.rename(...args);
};
fs.promises.open = async (...args) => {
  failPrimary("open", args[0]);
  const openedPath = args[0];
  const handle = await original.open(...args);
  return new Proxy(handle, {
    get(target, property) {
      if (property === "stat") {
        return async (...methodArgs) => {
          failPrimary("fstat", openedPath);
          return target.stat(...methodArgs);
        };
      }
      if (property === "read" || property === "readFile") {
        return async (...methodArgs) => {
          failPrimary("read", openedPath);
          return target[property](...methodArgs);
        };
      }
      if (property === "write" || property === "writeFile" || property === "writev") {
        return async (...methodArgs) => {
          failPrimary("write", openedPath);
          return target[property](...methodArgs);
        };
      }
      if (property === "sync") {
        return async (...methodArgs) => {
          failPrimary("fsync", openedPath);
          return target.sync(...methodArgs);
        };
      }
      if (property === "close") {
        return async (...methodArgs) => {
          const value = await target.close(...methodArgs);
          if ((primaryOperation === "close" || closeAlso) && matches(openedPath)) {
            closeTriggered = true;
            if (primaryOperation === "close" && !primaryTriggered) {
              matchingCalls += 1;
              if (matchingCalls === occurrence) {
                primaryTriggered = true;
                injectedPath = repoPath(openedPath);
              } else {
                return value;
              }
            }
            throw injectedError("close");
          }
          return value;
        };
      }
      const value = Reflect.get(target, property, target);
      return typeof value === "function" ? value.bind(target) : value;
    }
  });
};
syncBuiltinESMExports();

let result;
let thrown = null;
try {
  const { publishCleaningRun } = await import(moduleUrl);
  result = await publishCleaningRun({
    rootDir,
    runsRoot: ".local/cleaned/runs",
    currentPointer: ".local/state/current-cleaning.json",
    stagedRun
  });
} catch (error) {
  thrown = { name: error?.name, code: error?.code, message: error?.message };
}
process.stdout.write(JSON.stringify({
  result,
  thrown,
  primaryTriggered,
  closeTriggered,
  injectedPath,
  matchingCalls
}));
`;

async function runB6IoFailureChild(
  rootDir,
  stagedRun,
  operation,
  targetKind,
  occurrence = 1,
  closeAlso = false
) {
  const child = await runBoundedChild(process.execPath, [
    "--input-type=module",
    "--eval",
    B6_IO_FAILURE_CHILD_SCRIPT,
    B5_MODULE_URL,
    rootDir,
    encodeB6StagedRun(stagedRun),
    operation,
    targetKind,
    String(occurrence),
    String(closeAlso)
  ]);
  assert.equal(child.timedOut, false, child.stderr);
  assert.equal(child.code, 0, child.stderr);
  const observed = JSON.parse(child.stdout);
  assert.equal(observed.thrown, null, JSON.stringify(observed.thrown));
  assert.equal(
    observed.primaryTriggered,
    true,
    `${operation}/${targetKind}/${occurrence} injection did not trigger: ${child.stdout}`
  );
  return observed;
}

test("B6 injected I/O failures preserve exact operation, path, sticky writes, and primary precedence", async (t) => {
  const stageCleaningRun = await loadStageCleaningRun();
  const scenarios = [
    ["lock candidate open", "open", "lock-candidate", 1, false],
    ["lock candidate write", "write", "lock-candidate", 1, true],
    ["lock candidate fstat", "fstat", "lock-candidate", 1, true],
    ["lock candidate fsync", "fsync", "lock-candidate", 1, true],
    ["lock candidate close", "close", "lock-candidate", 1, true],
    ["fixed lock link", "link", ".local/state/cleaning-commit.lock", 1, true],
    ["post-link state fsync", "fsync", ".local/state", 1, true],
    ["fixed lock proof read", "read", ".local/state/cleaning-commit.lock", 1, true],
    ["lock candidate cleanup", "unlink", "lock-candidate", 1, true],
    ["pointer temp open", "open", "pointer-temp", 1, true],
    ["pointer temp write", "write", "pointer-temp", 1, true],
    ["pointer temp fsync", "fsync", "pointer-temp", 1, true],
    ["pointer rename", "rename", B6_CURRENT_POINTER, 1, true],
    ["completion temp open", "open", "completion-temp", 1, true],
    ["completion temp write", "write", "completion-temp", 1, true],
    ["completion temp fsync", "fsync", "completion-temp", 1, true],
    ["completion link", "link", "completion-record", 1, true],
    ["completion directory fsync", "fsync", ".local/state/cleaning-transitions", 1, true],
    ["completion temp cleanup", "unlink", "completion-temp", 1, true],
    ["fixed lock cleanup", "unlink", ".local/state/cleaning-commit.lock", 1, true],
    ["post-lock-cleanup state fsync", "fsync", ".local/state", 4, true]
  ];

  for (const [label, operation, targetKind, occurrence, sticky] of scenarios) {
    await t.test(label, async (t) => {
      const rootDir = await makeB5Root(t, `b6-io-${label.replaceAll(" ", "-")}`);
      const plan = makeB5GoldenPlan();
      const staged = await stageCleaningRun(b5Options(rootDir, plan));
      await mkdir(join(rootDir, ".local/state/cleaning-transitions"), {
        recursive: true,
        mode: 0o700
      });
      const observed = await runB6IoFailureChild(
        rootDir,
        staged.value.staged_run,
        operation,
        targetKind,
        occurrence
      );
      assert.deepEqual(
        observed.result,
        b5IoFailure(operation, observed.injectedPath, sticky)
      );
    });
  }

  await t.test("write remains primary when candidate close also fails", async (t) => {
    const rootDir = await makeB5Root(t, "b6-io-primary-close");
    const plan = makeB5GoldenPlan();
    const staged = await stageCleaningRun(b5Options(rootDir, plan));
    await mkdir(join(rootDir, ".local/state/cleaning-transitions"), {
      recursive: true,
      mode: 0o700
    });
    const observed = await runB6IoFailureChild(
      rootDir,
      staged.value.staged_run,
      "write",
      "lock-candidate",
      1,
      true
    );
    assert.equal(observed.closeTriggered, true);
    assert.deepEqual(
      observed.result,
      b5IoFailure("write", observed.injectedPath, true)
    );
  });
});

test("B6 publication-directory I/O failures preserve exact path and sticky mkdir semantics", async (t) => {
  const stageCleaningRun = await loadStageCleaningRun();
  const scenarios = [
    ["state mkdir", "mkdir", ".local/state", "none", false],
    ["state parent fsync", "fsync", ".local", "none", true],
    [
      "transitions mkdir",
      "mkdir",
      ".local/state/cleaning-transitions",
      "state-only",
      false
    ],
    [
      "transitions parent fsync",
      "fsync",
      ".local/state",
      "state-only",
      true
    ]
  ];
  for (const [label, operation, target, setupKind, sticky] of scenarios) {
    await t.test(label, async (t) => {
      const rootDir = await makeB5Root(t, `b6-directory-io-${label.replaceAll(" ", "-")}`);
      const plan = makeB5GoldenPlan();
      const staged = await stageCleaningRun(b5Options(rootDir, plan));
      await prepareB6CrashState(rootDir, setupKind);
      const observed = await runB6IoFailureChild(
        rootDir,
        staged.value.staged_run,
        operation,
        target
      );
      assert.deepEqual(
        observed.result,
        b5IoFailure(operation, target, sticky)
      );
    });
  }
});

test("B6 retirement I/O failures cover candidate, record, proof, and cleanup boundaries", async (t) => {
  const stageCleaningRun = await loadStageCleaningRun();
  const scenarios = [
    ["retirement temp open", "open", "retirement-temp", 1],
    ["retirement temp write", "write", "retirement-temp", 1],
    ["retirement temp fstat", "fstat", "retirement-temp", 1],
    ["retirement temp fsync", "fsync", "retirement-temp", 1],
    ["retirement record link", "link", "retirement-record", 1],
    ["retirement directory fsync", "fsync", ".local/state/cleaning-transitions", 1],
    ["retirement record proof", "read", "retirement-record", 1],
    ["retirement temp cleanup", "unlink", "retirement-temp", 1],
    [
      "retirement post-cleanup fsync",
      "fsync",
      ".local/state/cleaning-transitions",
      2
    ]
  ];
  for (const [label, operation, targetKind, occurrence] of scenarios) {
    await t.test(label, async (t) => {
      const rootDir = await makeB5Root(t, `b6-retirement-io-${label.replaceAll(" ", "-")}`);
      const plan = makeB5GoldenPlan();
      const staged = await stageCleaningRun(b5Options(rootDir, plan));
      await prepareB6CrashState(rootDir, "full");
      const otherPlan = makeB6IncrementalPlan(plan);
      await writeFile(
        join(rootDir, B6_CURRENT_POINTER),
        canonicalJsonDocumentBytes(otherPlan.manifest.desired_pointer),
        { mode: 0o600 }
      );
      const observed = await runB6IoFailureChild(
        rootDir,
        staged.value.staged_run,
        operation,
        targetKind,
        occurrence
      );
      assert.deepEqual(
        observed.result,
        b5IoFailure(operation, observed.injectedPath, true)
      );
    });
  }
});

const B6_MALFORMED_LOCK_RACE_CHILD_SCRIPT = `
import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { join } from "node:path";

const [moduleUrl, rootDir, encodedStagedRun] = process.argv.slice(1);
const stagedRun = JSON.parse(Buffer.from(encodedStagedRun, "base64").toString("utf8"));
const realRoot = fs.realpathSync(rootDir);
const lockPath = join(realRoot, ".local", "state", "cleaning-commit.lock");
const originalLink = fs.promises.link;
const originalWriteFile = fs.promises.writeFile;
let injected = false;
fs.promises.link = async (...args) => {
  if (!injected && args[1] === lockPath) {
    injected = true;
    await originalWriteFile(lockPath, Buffer.from("{}\\n"), {
      flag: "wx",
      mode: 0o600
    });
    const error = new Error("synthetic competing malformed lock");
    error.code = "EEXIST";
    throw error;
  }
  return originalLink(...args);
};
syncBuiltinESMExports();

const { publishCleaningRun } = await import(moduleUrl);
const result = await publishCleaningRun({
  rootDir,
  runsRoot: ".local/cleaned/runs",
  currentPointer: ".local/state/current-cleaning.json",
  stagedRun
});
const stateNames = (await fs.promises.readdir(join(realRoot, ".local", "state"))).sort();
process.stdout.write(JSON.stringify({ result, injected, stateNames }));
`;

test("B6 lock-link EEXIST validates the competing fixed bytes before reporting contention", async (t) => {
  const stageCleaningRun = await loadStageCleaningRun();
  const rootDir = await makeB5Root(t, "b6-malformed-lock-race");
  const plan = makeB5GoldenPlan();
  const staged = await stageCleaningRun(b5Options(rootDir, plan));
  await mkdir(join(rootDir, ".local/state/cleaning-transitions"), {
    recursive: true,
    mode: 0o700
  });
  const child = await runBoundedChild(process.execPath, [
    "--input-type=module",
    "--eval",
    B6_MALFORMED_LOCK_RACE_CHILD_SCRIPT,
    B5_MODULE_URL,
    rootDir,
    encodeB6StagedRun(staged.value.staged_run)
  ]);
  assert.equal(child.timedOut, false, child.stderr);
  assert.equal(child.code, 0, child.stderr);
  const observed = JSON.parse(child.stdout);
  assert.equal(observed.injected, true);
  assert.deepEqual(
    observed.result,
    b5ExpectedFailure(
      "LOCAL_STATE_INVALID",
      ".local/state/cleaning-commit.lock",
      true
    )
  );
  assert.deepEqual(observed.stateNames, [
    "cleaning-commit.lock",
    "cleaning-transitions"
  ]);
  assert.deepEqual(
    await readFile(join(rootDir, ".local/state/cleaning-commit.lock")),
    Buffer.from("{}\n")
  );
});

const B6_CRASH_CHILD_SCRIPT = `
import crypto from "node:crypto";
import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { relative, sep } from "node:path";

const [
  moduleUrl,
  rootDir,
  encodedStagedRun,
  crashOperation,
  targetKind,
  occurrenceText
] = process.argv.slice(1);
const stagedRun = JSON.parse(Buffer.from(encodedStagedRun, "base64").toString("utf8"));
const occurrence = Number(occurrenceText);
const realRoot = fs.realpathSync(rootDir);
const original = {
  mkdir: fs.promises.mkdir,
  open: fs.promises.open,
  link: fs.promises.link,
  unlink: fs.promises.unlink,
  rename: fs.promises.rename
};
let matchingCalls = 0;

function repoPath(value) {
  if (typeof value !== "string") return null;
  const path = relative(realRoot, value).split(sep).join("/");
  return path === "" ? null : path;
}
function matches(value) {
  const path = repoPath(value);
  if (targetKind === "lock-candidate") {
    return /^\\.local\\/state\\/\\.cleaning-commit\\.[0-9]+\\.[0-9a-f]{32}\\.tmp$/.test(path ?? "");
  }
  if (targetKind === "pointer-temp") {
    return /^\\.local\\/state\\/\\.current-cleaning\\.[0-9]+\\.[0-9a-f]{32}\\.tmp$/.test(path ?? "");
  }
  if (targetKind === "completion-temp") {
    return /^\\.local\\/state\\/cleaning-transitions\\/\\.complete-.*\\.json\\.[0-9]+\\.[0-9a-f]{32}\\.tmp$/.test(path ?? "");
  }
  if (targetKind === "completion-record") {
    return /^\\.local\\/state\\/cleaning-transitions\\/complete-[0-9a-f]{64}-[0-9a-f]{64}\\.json$/.test(path ?? "");
  }
  if (targetKind === "retirement-temp") {
    return /^\\.local\\/state\\/cleaning-transitions\\/\\.retire-.*\\.json\\.[0-9]+\\.[0-9a-f]{32}\\.tmp$/.test(path ?? "");
  }
  if (targetKind === "retirement-record") {
    return /^\\.local\\/state\\/cleaning-transitions\\/retire-[0-9a-f]{64}-(?:[0-9a-f]{64}|absent)\\.json$/.test(path ?? "");
  }
  return path === targetKind;
}
function crashAfter(operation, value) {
  if (operation !== crashOperation || !matches(value)) return;
  matchingCalls += 1;
  if (matchingCalls === occurrence) process.kill(process.pid, "SIGKILL");
}

crypto.randomBytes = () => Buffer.from("cd".repeat(16), "hex");
for (const operation of ["mkdir", "unlink"]) {
  fs.promises[operation] = async (...args) => {
    const result = await original[operation](...args);
    crashAfter(operation, args[0]);
    return result;
  };
}
fs.promises.link = async (...args) => {
  const result = await original.link(...args);
  crashAfter("link", args[1]);
  return result;
};
fs.promises.rename = async (...args) => {
  const result = await original.rename(...args);
  crashAfter("rename", args[1]);
  return result;
};
fs.promises.open = async (...args) => {
  const openedPath = args[0];
  const handle = await original.open(...args);
  crashAfter("open", openedPath);
  return new Proxy(handle, {
    get(target, property) {
      if (property === "write" || property === "writeFile" || property === "writev") {
        return async (...methodArgs) => {
          const result = await target[property](...methodArgs);
          crashAfter("write", openedPath);
          return result;
        };
      }
      if (property === "sync") {
        return async (...methodArgs) => {
          const result = await target.sync(...methodArgs);
          crashAfter("fsync", openedPath);
          return result;
        };
      }
      if (property === "close") {
        return async (...methodArgs) => {
          const result = await target.close(...methodArgs);
          crashAfter("close", openedPath);
          return result;
        };
      }
      const value = Reflect.get(target, property, target);
      return typeof value === "function" ? value.bind(target) : value;
    }
  });
};
syncBuiltinESMExports();

const { publishCleaningRun } = await import(moduleUrl);
await publishCleaningRun({
  rootDir,
  runsRoot: ".local/cleaned/runs",
  currentPointer: ".local/state/current-cleaning.json",
  stagedRun
});
process.exitCode = 97;
`;

async function runB6CrashChild(
  rootDir,
  stagedRun,
  operation,
  targetKind,
  occurrence = 1
) {
  const child = await runBoundedChild(process.execPath, [
    "--input-type=module",
    "--eval",
    B6_CRASH_CHILD_SCRIPT,
    B5_MODULE_URL,
    rootDir,
    encodeB6StagedRun(stagedRun),
    operation,
    targetKind,
    String(occurrence)
  ]);
  assert.equal(child.timedOut, false, child.stderr);
  assert.equal(child.signal, "SIGKILL", `${operation}/${targetKind}/${occurrence}: ${child.stderr}`);
  return child;
}

async function prepareB6CrashState(rootDir, setupKind) {
  if (setupKind === "none") return;
  await mkdir(join(rootDir, ".local/state"), { mode: 0o700 });
  if (setupKind === "state-only") return;
  await mkdir(join(rootDir, ".local/state/cleaning-transitions"), { mode: 0o700 });
}

test("B6 real child crashes preserve the fixed-lock recovery boundary at every durable publisher step", async (t) => {
  const stageCleaningRun = await loadStageCleaningRun();
  const publishCleaningRun = await loadPublishCleaningRun();
  const scenarios = [
    ["state directory mkdir", "mkdir", ".local/state", 1, "none", "prelock", "absent"],
    ["state parent fsync", "fsync", ".local", 1, "none", "prelock", "absent"],
    ["transitions directory mkdir", "mkdir", ".local/state/cleaning-transitions", 1, "state-only", "prelock", "absent"],
    ["transitions parent fsync", "fsync", ".local/state", 1, "state-only", "prelock", "absent"],
    ["lock candidate create", "open", "lock-candidate", 1, "full", "prelock", "absent"],
    ["lock candidate write", "write", "lock-candidate", 1, "full", "prelock", "absent"],
    ["lock candidate file fsync", "fsync", "lock-candidate", 1, "full", "prelock", "absent"],
    ["fixed lock link", "link", ".local/state/cleaning-commit.lock", 1, "full", "locked", "absent"],
    ["fixed lock directory fsync", "fsync", ".local/state", 1, "full", "locked", "absent"],
    ["lock candidate unlink", "unlink", "lock-candidate", 1, "full", "locked", "absent"],
    ["post-candidate state fsync", "fsync", ".local/state", 2, "full", "locked", "absent"],
    ["pointer temp create", "open", "pointer-temp", 1, "full", "locked", "absent"],
    ["pointer temp write", "write", "pointer-temp", 1, "full", "locked", "absent"],
    ["pointer temp file fsync", "fsync", "pointer-temp", 1, "full", "locked", "absent"],
    ["pointer rename", "rename", B6_CURRENT_POINTER, 1, "full", "locked", "desired"],
    ["post-pointer state fsync", "fsync", ".local/state", 3, "full", "locked", "desired"],
    ["completion temp create", "open", "completion-temp", 1, "full", "locked", "desired"],
    ["completion temp write", "write", "completion-temp", 1, "full", "locked", "desired"],
    ["completion temp file fsync", "fsync", "completion-temp", 1, "full", "locked", "desired"],
    ["completion record link", "link", "completion-record", 1, "full", "locked", "desired"],
    ["completion directory fsync", "fsync", ".local/state/cleaning-transitions", 1, "full", "locked", "desired"],
    ["completion temp unlink", "unlink", "completion-temp", 1, "full", "locked", "desired"],
    ["post-completion transitions fsync", "fsync", ".local/state/cleaning-transitions", 2, "full", "locked", "desired"],
    ["fixed lock unlink", "unlink", ".local/state/cleaning-commit.lock", 1, "full", "postunlock", "desired"],
    ["post-lock state fsync", "fsync", ".local/state", 4, "full", "postunlock", "desired"]
  ];

  for (const [
    label,
    operation,
    targetKind,
    occurrence,
    setupKind,
    recoveryBoundary,
    pointerState
  ] of scenarios) {
    await t.test(label, async (t) => {
      const rootDir = await makeB5Root(t, `b6-crash-${label.replaceAll(" ", "-")}`);
      const plan = makeB5GoldenPlan();
      const staged = await stageCleaningRun(b5Options(rootDir, plan));
      await prepareB6CrashState(rootDir, setupKind);
      await runB6CrashChild(
        rootDir,
        staged.value.staged_run,
        operation,
        targetKind,
        occurrence
      );

      const lockPath = join(rootDir, ".local/state/cleaning-commit.lock");
      const retryOptions = b6Options(rootDir, staged.value.staged_run);
      if (recoveryBoundary === "locked") {
        const lockBytes = await readFile(lockPath);
        assert.notEqual(validateB6CanonicalLockForTest(lockBytes), null);
        assert.deepEqual(
          await publishCleaningRun(retryOptions),
          b5ExpectedFailure(
            "CLEANING_COMMIT_LOCKED",
            ".local/state/cleaning-commit.lock"
          )
        );
        assert.deepEqual(await readFile(lockPath), lockBytes);
      } else {
        await assert.rejects(() => lstat(lockPath), { code: "ENOENT" });
        const retry = await publishCleaningRun(retryOptions);
        assert.equal(retry.ok, true);
        assert.equal(
          retry.value.kind,
          recoveryBoundary === "postunlock" ? "already_current" : "published"
        );
      }

      if (pointerState === "absent" && recoveryBoundary === "locked") {
        await assert.rejects(() => lstat(join(rootDir, B6_CURRENT_POINTER)), {
          code: "ENOENT"
        });
      } else {
        assert.deepEqual(
          await readFile(join(rootDir, B6_CURRENT_POINTER)),
          canonicalJsonDocumentBytes(plan.manifest.desired_pointer)
        );
      }
    });
  }
});

test("B6 stale retirement crashes never mutate pointer and remain locked until explicit recovery", async (t) => {
  const stageCleaningRun = await loadStageCleaningRun();
  const publishCleaningRun = await loadPublishCleaningRun();
  const scenarios = [
    ["retirement temp create", "open", "retirement-temp", 1, "locked"],
    ["retirement temp write", "write", "retirement-temp", 1, "locked"],
    ["retirement temp file fsync", "fsync", "retirement-temp", 1, "locked"],
    ["retirement record link", "link", "retirement-record", 1, "locked"],
    ["retirement directory fsync", "fsync", ".local/state/cleaning-transitions", 1, "locked"],
    ["retirement temp unlink", "unlink", "retirement-temp", 1, "locked"],
    ["post-retirement transitions fsync", "fsync", ".local/state/cleaning-transitions", 2, "locked"],
    ["stale fixed lock unlink", "unlink", ".local/state/cleaning-commit.lock", 1, "postunlock"],
    ["stale post-lock state fsync", "fsync", ".local/state", 3, "postunlock"]
  ];

  for (const [label, operation, targetKind, occurrence, recoveryBoundary] of scenarios) {
    await t.test(label, async (t) => {
      const rootDir = await makeB5Root(t, `b6-stale-crash-${label.replaceAll(" ", "-")}`);
      const plan = makeB5GoldenPlan();
      const staged = await stageCleaningRun(b5Options(rootDir, plan));
      await prepareB6CrashState(rootDir, "full");
      const otherPlan = makeB6IncrementalPlan(plan);
      const observedPointerBytes = canonicalJsonDocumentBytes(
        otherPlan.manifest.desired_pointer
      );
      await writeFile(join(rootDir, B6_CURRENT_POINTER), observedPointerBytes, {
        mode: 0o600
      });
      await runB6CrashChild(
        rootDir,
        staged.value.staged_run,
        operation,
        targetKind,
        occurrence
      );
      assert.deepEqual(
        await readFile(join(rootDir, B6_CURRENT_POINTER)),
        observedPointerBytes
      );

      const retryOptions = b6Options(rootDir, staged.value.staged_run);
      if (recoveryBoundary === "locked") {
        const lockBytes = await readFile(
          join(rootDir, ".local/state/cleaning-commit.lock")
        );
        assert.notEqual(validateB6CanonicalLockForTest(lockBytes), null);
        assert.deepEqual(
          await publishCleaningRun(retryOptions),
          b5ExpectedFailure(
            "CLEANING_COMMIT_LOCKED",
            ".local/state/cleaning-commit.lock"
          )
        );
      } else {
        await assert.rejects(
          () => lstat(join(rootDir, ".local/state/cleaning-commit.lock")),
          { code: "ENOENT" }
        );
        assert.deepEqual(
          await publishCleaningRun(retryOptions),
          b5ExpectedFailure(
            "STALE_POINTER_TRANSITION",
            B6_CURRENT_POINTER,
            true
          )
        );
      }
      assert.deepEqual(
        await readFile(join(rootDir, B6_CURRENT_POINTER)),
        observedPointerBytes
      );
    });
  }
});

const B6_RUN_REPLACEMENT_CHILD_SCRIPT = `
import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { join, relative, sep } from "node:path";

const [moduleUrl, rootDir, encodedStagedRun, artifactPath, encodedArtifactBytes] =
  process.argv.slice(1);
const stagedRun = JSON.parse(Buffer.from(encodedStagedRun, "base64").toString("utf8"));
const artifactBytes = Buffer.from(encodedArtifactBytes, "base64");
const realRoot = fs.realpathSync(rootDir);
const artifactAbsolute = join(realRoot, ...artifactPath.split("/"));
const original = {
  open: fs.promises.open,
  unlink: fs.promises.unlink,
  writeFile: fs.promises.writeFile
};
let replaced = false;
function repoPath(value) {
  return relative(realRoot, value).split(sep).join("/");
}
fs.promises.open = async (...args) => {
  const path = repoPath(args[0]);
  if (!replaced && /^\\.local\\/state\\/\\.current-cleaning\\./.test(path)) {
    await original.unlink(artifactAbsolute);
    await original.writeFile(artifactAbsolute, artifactBytes, { mode: 0o600 });
    replaced = true;
  }
  return original.open(...args);
};
syncBuiltinESMExports();

const { publishCleaningRun } = await import(moduleUrl);
const result = await publishCleaningRun({
  rootDir,
  runsRoot: ".local/cleaned/runs",
  currentPointer: ".local/state/current-cleaning.json",
  stagedRun
});
process.stdout.write(JSON.stringify({ result, replaced }));
`;

const B6_RUN_EXTRA_RACE_CHILD_SCRIPT = `
import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { join, relative, sep } from "node:path";

const [moduleUrl, rootDir, encodedStagedRun] = process.argv.slice(1);
const stagedRun = JSON.parse(Buffer.from(encodedStagedRun, "base64").toString("utf8"));
const realRoot = fs.realpathSync(rootDir);
const extraPath = stagedRun.final_run_path + "/unexpected-after-verification";
const extraAbsolute = join(realRoot, ...extraPath.split("/"));
const original = {
  open: fs.promises.open,
  writeFile: fs.promises.writeFile
};
let inserted = false;
function repoPath(value) {
  return relative(realRoot, value).split(sep).join("/");
}
fs.promises.open = async (...args) => {
  const path = repoPath(args[0]);
  if (!inserted && /^\\.local\\/state\\/\\.current-cleaning\\./.test(path)) {
    await original.writeFile(extraAbsolute, Buffer.from("unexpected"), {
      flag: "wx",
      mode: 0o600
    });
    inserted = true;
  }
  return original.open(...args);
};
syncBuiltinESMExports();

const { publishCleaningRun } = await import(moduleUrl);
const result = await publishCleaningRun({
  rootDir,
  runsRoot: ".local/cleaned/runs",
  currentPointer: ".local/state/current-cleaning.json",
  stagedRun
});
process.stdout.write(JSON.stringify({
  result,
  inserted,
  pointer_exists: fs.existsSync(join(realRoot, ".local/state/current-cleaning.json")),
  extra_path: extraPath
}));
`;

test("B6 pointer rename rechecks the complete run topology after pointer-temp creation", async (t) => {
  const stageCleaningRun = await loadStageCleaningRun();
  const rootDir = await makeB5Root(t, "b6-run-extra-before-pointer");
  const plan = makeB5GoldenPlan();
  const staged = await stageCleaningRun(b5Options(rootDir, plan));
  await prepareB6CrashState(rootDir, "full");
  const child = await runBoundedChild(process.execPath, [
    "--input-type=module",
    "--eval",
    B6_RUN_EXTRA_RACE_CHILD_SCRIPT,
    B5_MODULE_URL,
    rootDir,
    encodeB6StagedRun(staged.value.staged_run)
  ]);
  assert.equal(child.timedOut, false, child.stderr);
  assert.equal(child.code, 0, child.stderr);
  const observed = JSON.parse(child.stdout);
  assert.equal(observed.inserted, true);
  assert.deepEqual(
    observed.result,
    b5ExpectedFailure("RUN_CONFLICT", observed.extra_path, true)
  );
  assert.equal(observed.pointer_exists, false);
});

const B6_PUBLICATION_IDENTITY_RACE_CHILD_SCRIPT = `
import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { join, relative, sep } from "node:path";

const [moduleUrl, rootDir, encodedStagedRun, scenario] = process.argv.slice(1);
const stagedRun = JSON.parse(Buffer.from(encodedStagedRun, "base64").toString("utf8"));
const realRoot = fs.realpathSync(rootDir);
const stateDir = join(realRoot, ".local", "state");
const transitionsDir = join(stateDir, "cleaning-transitions");
const lockPath = join(stateDir, "cleaning-commit.lock");
const pointerPath = join(stateDir, "current-cleaning.json");
const externalPath = join(realRoot, "external-" + scenario);
const artifactPaths = new Set(stagedRun.artifact_manifest.map((artifact) =>
  stagedRun.final_run_path + "/" + artifact.relative_path));
const original = {
  open: fs.promises.open,
  lstat: fs.promises.lstat,
  unlink: fs.promises.unlink,
  link: fs.promises.link,
  writeFile: fs.promises.writeFile,
  readFile: fs.promises.readFile,
  readdir: fs.promises.readdir
};
let replaced = false;
let replacedPath = null;
let externalBytes = null;

function repoPath(value) {
  return relative(realRoot, value).split(sep).join("/");
}
async function pointerTempPath() {
  const names = await original.readdir(stateDir);
  const name = names.find((entry) =>
    /^\\.current-cleaning\\.[0-9]+\\.[0-9a-f]{32}\\.tmp$/.test(entry));
  return name === undefined ? null : join(stateDir, name);
}
async function completionPath() {
  const names = await original.readdir(transitionsDir);
  const name = names.find((entry) =>
    /^complete-[0-9a-f]{64}-[0-9a-f]{64}\\.json$/.test(entry));
  return name === undefined ? null : join(transitionsDir, name);
}
async function completionCount() {
  const names = await original.readdir(transitionsDir);
  return names.filter((entry) =>
    /^complete-[0-9a-f]{64}-[0-9a-f]{64}\\.json$/.test(entry)).length;
}
async function replaceWithExternal(target) {
  const bytes = await original.readFile(target);
  await original.writeFile(externalPath, bytes, { flag: "wx", mode: 0o600 });
  await original.unlink(target);
  await original.link(externalPath, target);
  replaced = true;
  replacedPath = repoPath(target);
  externalBytes = bytes.toString("base64");
}

fs.promises.open = async (...args) => {
  const path = repoPath(args[0]);
  if (!replaced && scenario === "lock" &&
      /^\\.local\\/state\\/\\.current-cleaning\\./.test(path)) {
    await replaceWithExternal(lockPath);
  } else if (!replaced && scenario === "lock-terminal" &&
      /^\\.local\\/state\\/cleaning-transitions\\/\\.complete-/.test(path)) {
    await replaceWithExternal(lockPath);
  } else if (!replaced && scenario === "temp" && artifactPaths.has(path)) {
    const temp = await pointerTempPath();
    if (temp !== null) await replaceWithExternal(temp);
  } else if (!replaced && scenario === "pointer" &&
      /^\\.local\\/state\\/cleaning-transitions\\/\\.complete-/.test(path)) {
    await replaceWithExternal(pointerPath);
  } else if (!replaced && scenario === "transition" && path ===
      ".local/state/cleaning-commit.lock") {
    const completion = await completionPath();
    if (completion !== null) await replaceWithExternal(completion);
  }
  return original.open(...args);
};
fs.promises.lstat = async (...args) => {
  if (!replaced && scenario === "lock-late" &&
      repoPath(args[0]) === ".local/state/current-cleaning.json") {
    const temp = await pointerTempPath();
    if (temp !== null) await replaceWithExternal(lockPath);
  }
  return original.lstat(...args);
};
syncBuiltinESMExports();

const { publishCleaningRun } = await import(moduleUrl);
const result = await publishCleaningRun({
  rootDir,
  runsRoot: ".local/cleaned/runs",
  currentPointer: ".local/state/current-cleaning.json",
  stagedRun
});
const externalAfter = externalBytes === null
  ? null
  : (await original.readFile(externalPath)).toString("base64");
process.stdout.write(JSON.stringify({
  result,
  replaced,
  replaced_path: replacedPath,
  external_bytes: externalBytes,
  external_after: externalAfter,
  pointer_exists: fs.existsSync(pointerPath),
  lock_exists: fs.existsSync(lockPath),
  completion_count: await completionCount()
}));
`;

test("B6 lock, temp, pointer, and transition identity replacements fail closed", async (t) => {
  const stageCleaningRun = await loadStageCleaningRun();
  for (const scenario of [
    "lock",
    "lock-late",
    "lock-terminal",
    "temp",
    "pointer",
    "transition"
  ]) {
    await t.test(scenario, async (t) => {
      const rootDir = await makeB5Root(t, `b6-identity-${scenario}`);
      const plan = makeB5GoldenPlan();
      const staged = await stageCleaningRun(b5Options(rootDir, plan));
      await prepareB6CrashState(rootDir, "full");
      const child = await runBoundedChild(process.execPath, [
        "--input-type=module",
        "--eval",
        B6_PUBLICATION_IDENTITY_RACE_CHILD_SCRIPT,
        B5_MODULE_URL,
        rootDir,
        encodeB6StagedRun(staged.value.staged_run),
        scenario
      ]);
      assert.equal(child.timedOut, false, child.stderr);
      assert.equal(child.code, 0, child.stderr);
      const observed = JSON.parse(child.stdout);
      assert.equal(observed.replaced, true, child.stdout);
      assert.equal(observed.external_after, observed.external_bytes);
      assert.deepEqual(
        observed.result,
        b5ExpectedFailure(
          "LOCAL_STATE_INVALID",
          scenario === "pointer" ? B6_CURRENT_POINTER : observed.replaced_path,
          true
        )
      );
      assert.equal(
        observed.pointer_exists,
        scenario === "pointer" || scenario === "transition" ||
          scenario === "lock-terminal"
      );
      assert.equal(observed.lock_exists, true);
      if (scenario === "lock-terminal") {
        assert.equal(observed.completion_count, 0, child.stdout);
      }
    });
  }
});

const B6_ROOT_REPLACEMENT_CHILD_SCRIPT = `
import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { join } from "node:path";

const [moduleUrl, rootDir, displacedRoot, encodedStagedRun] = process.argv.slice(1);
const stagedRun = JSON.parse(Buffer.from(encodedStagedRun, "base64").toString("utf8"));
const realRoot = fs.realpathSync(rootDir);
const statePath = join(realRoot, ".local", "state");
const original = {
  lstat: fs.promises.lstat,
  rename: fs.promises.rename,
  symlink: fs.promises.symlink
};
let replaced = false;
fs.promises.lstat = async (...args) => {
  if (!replaced && args[0] === statePath) {
    await original.rename(realRoot, displacedRoot);
    await original.symlink(displacedRoot, realRoot);
    replaced = true;
  }
  return original.lstat(...args);
};
syncBuiltinESMExports();

const { publishCleaningRun } = await import(moduleUrl);
const result = await publishCleaningRun({
  rootDir,
  runsRoot: ".local/cleaned/runs",
  currentPointer: ".local/state/current-cleaning.json",
  stagedRun
});
process.stdout.write(JSON.stringify({
  result,
  replaced,
  pointer_exists: fs.existsSync(join(displacedRoot, ".local/state/current-cleaning.json"))
}));
`;

test("B6 canonical root replacement is detected before publication writes", async (t) => {
  const stageCleaningRun = await loadStageCleaningRun();
  const rootDir = await makeB5Root(t, "b6-root-replacement");
  const displacedRoot = `${rootDir}-displaced`;
  t.after(() => rm(displacedRoot, { recursive: true, force: true }));
  const plan = makeB5GoldenPlan();
  const staged = await stageCleaningRun(b5Options(rootDir, plan));
  const before = await snapshotB5Tree(rootDir);
  const child = await runBoundedChild(process.execPath, [
    "--input-type=module",
    "--eval",
    B6_ROOT_REPLACEMENT_CHILD_SCRIPT,
    B5_MODULE_URL,
    rootDir,
    displacedRoot,
    encodeB6StagedRun(staged.value.staged_run)
  ]);
  assert.equal(child.timedOut, false, child.stderr);
  assert.equal(child.code, 0, child.stderr);
  const observed = JSON.parse(child.stdout);
  assert.equal(observed.replaced, true);
  assert.deepEqual(
    observed.result,
    b5ExpectedFailure("LOCAL_STATE_INVALID")
  );
  assert.equal(observed.pointer_exists, false);
  assert.deepEqual(await snapshotB5Tree(displacedRoot), before);
});

test("B6 pointer rename is blocked when a verified run leaf is identity-replaced during temp creation", async (t) => {
  const stageCleaningRun = await loadStageCleaningRun();
  const rootDir = await makeB5Root(t, "b6-run-replacement-before-pointer");
  const plan = makeB5GoldenPlan();
  const staged = await stageCleaningRun(b5Options(rootDir, plan));
  await prepareB6CrashState(rootDir, "full");
  const artifact = plan.manifest.artifact_manifest.find((entry) =>
    entry.relative_path.startsWith("sources/"));
  const artifactPath = `${staged.value.staged_run.final_run_path}/${artifact.relative_path}`;
  const artifactBytes = await readFile(join(rootDir, artifactPath));
  const child = await runBoundedChild(process.execPath, [
    "--input-type=module",
    "--eval",
    B6_RUN_REPLACEMENT_CHILD_SCRIPT,
    B5_MODULE_URL,
    rootDir,
    encodeB6StagedRun(staged.value.staged_run),
    artifactPath,
    artifactBytes.toString("base64")
  ]);
  assert.equal(child.timedOut, false, child.stderr);
  assert.equal(child.code, 0, child.stderr);
  const observed = JSON.parse(child.stdout);
  assert.equal(observed.replaced, true);
  assert.deepEqual(
    observed.result,
    b5ExpectedFailure("RUN_CONFLICT", artifactPath, true)
  );
  await assert.rejects(() => lstat(join(rootDir, B6_CURRENT_POINTER)), {
    code: "ENOENT"
  });
  assert.notEqual(
    validateB6CanonicalLockForTest(
      await readFile(join(rootDir, ".local/state/cleaning-commit.lock"))
    ),
    null
  );
});

test("B5 golden stage persists the independently derived intent, final bytes, modes, and exact tree", async (t) => {
  const stageCleaningRun = await loadStageCleaningRun();
  const rootDir = await makeB5Root(t, "golden");
  const plan = makeB5GoldenPlan();
  const layout = expectedB5Layout(plan);

  const actual = await stageCleaningRun(b5Options(rootDir, plan));

  assert.deepEqual(actual, layout.success(true));
  const persistedIntent = await readFile(join(rootDir, layout.intentPath));
  assert.deepEqual(persistedIntent, layout.intentBytes);
  assert.equal(persistedIntent.at(-1), 0x0a);
  assert.notEqual(persistedIntent.at(-2), 0x0a);
  assert.equal(sha256(persistedIntent), layout.intentSha256);
  await assert.rejects(() => lstat(join(rootDir, layout.intentCandidatePath)), { code: "ENOENT" });

  for (const artifact of layout.artifactIntents) {
    assert.deepEqual(
      await readFile(join(rootDir, artifact.canonical_path)),
      b5ArtifactBytes(plan, artifact.relative_path)
    );
    await assert.rejects(() => lstat(join(rootDir, artifact.temp_path)), { code: "ENOENT" });
    assert.equal((await lstat(join(rootDir, artifact.canonical_path))).mode & 0o777, 0o600);
  }
  assert.equal((await lstat(join(rootDir, layout.intentPath))).mode & 0o777, 0o600);
  for (const directory of [
    ".local",
    ".local/tmp",
    layout.stagingPath,
    ".local/cleaned",
    B5_RUNS_ROOT,
    layout.finalRunPath,
    `${layout.finalRunPath}/catalog`,
    `${layout.finalRunPath}/sources`
  ]) {
    assert.equal((await lstat(join(rootDir, directory))).mode & 0o777, 0o700);
  }
  assert.deepEqual(await listTree(rootDir), [
    ".local",
    ".local/cleaned",
    ".local/cleaned/runs",
    layout.finalRunPath,
    `${layout.finalRunPath}/catalog`,
    `${layout.finalRunPath}/catalog/sources.jsonl`,
    `${layout.finalRunPath}/cleaning-report.json`,
    `${layout.finalRunPath}/sources`,
    `${layout.finalRunPath}/sources/${SOURCE_A}.md`,
    ".local/tmp",
    layout.stagingPath,
    layout.intentPath
  ].sort());
});

test("B5 empty corpus preserves the required zero-byte catalog through temp publication", async (t) => {
  const stageCleaningRun = await loadStageCleaningRun();
  const rootDir = await makeB5Root(t, "empty-corpus");
  const plan = makeB5EmptyPlan();
  const layout = expectedB5Layout(plan);
  const zeroArtifact = layout.artifactIntents.find(({ relative_path: path }) =>
    path === "catalog/sources.jsonl");
  assert.equal(zeroArtifact.size_bytes, 0);
  assert.equal(zeroArtifact.sha256, sha256(Buffer.alloc(0)));

  const actual = await stageCleaningRun(b5Options(rootDir, plan));

  assert.deepEqual(actual, layout.success(true));
  assert.deepEqual(await readFile(join(rootDir, zeroArtifact.canonical_path)), Buffer.alloc(0));
  assert.equal((await stat(join(rootDir, zeroArtifact.canonical_path))).size, 0);
  await assert.rejects(() => lstat(join(rootDir, zeroArtifact.temp_path)), { code: "ENOENT" });

  await t.test("fresh zero-byte catalog canonical links only from its created 0600 temp", async (t) => {
    const probeRoot = await makeB5Root(t, "empty-corpus-link-probe");
    const probePlan = makeB5EmptyPlan();
    const probeLayout = expectedB5Layout(probePlan);
    const probeArtifact = probeLayout.artifactIntents.find(({ relative_path: path }) =>
      path === "catalog/sources.jsonl");
    assert.deepEqual(await snapshotB5Tree(probeRoot), []);

    const observed = await runB5GlobalTempGateChild(probeRoot, probePlan);

    assert.equal(observed.checkedBeforeFirstCanonicalLink, true);
    assert.deepEqual(observed.zeroByteCatalogLinkProbe, {
      triggered: true,
      source_path: probeArtifact.temp_path,
      destination_path: probeArtifact.canonical_path,
      regular: true,
      mode: 0o600,
      size: 0
    });
    assert.deepEqual(observed.result, probeLayout.success(true));
    assert.equal((await stat(join(probeRoot, probeArtifact.canonical_path))).size, 0);
    await assert.rejects(
      () => lstat(join(probeRoot, probeArtifact.temp_path)),
      { code: "ENOENT" }
    );
  });
});

test("B5 plan snapshot rejects every binding mutation without trusting descriptors or caller bytes", async (t) => {
  const stageCleaningRun = await loadStageCleaningRun();
  const mutationsWhoseManifestHashMustStayBroken = new Set([
    "missing plan key",
    "manifest digest"
  ]);
  for (const [label, mutate] of b5PlanMutations()) {
    await t.test(label, async (t) => {
      const rootDir = await makeB5Root(t, `plan-${label.replaceAll(" ", "-")}`);
      const plan = makeB5GoldenPlan();
      mutate(plan);
      if (plan.manifest && !mutationsWhoseManifestHashMustStayBroken.has(label)) {
        refreshB5ManifestHash(plan);
      }
      const before = await snapshotB5Tree(rootDir);
      assert.deepEqual(
        await stageCleaningRun(b5Options(rootDir, plan)),
        b5ExpectedFailure("PLAN_BINDING_MISMATCH")
      );
      assert.deepEqual(await snapshotB5Tree(rootDir), before);
    });
  }

  await t.test("custom iterator is ignored while dense descriptors are copied", async (t) => {
    const rootDir = await makeB5Root(t, "custom-iterator");
    const plan = makeB5GoldenPlan();
    let iteratorCalls = 0;
    Object.defineProperty(plan.artifacts, Symbol.iterator, {
      value() {
        iteratorCalls += 1;
        throw new Error("custom iterator must not run");
      }
    });
    const result = await stageCleaningRun(b5Options(rootDir, plan));
    assert.deepEqual(result, expectedB5Layout(plan).success(true));
    assert.equal(iteratorCalls, 0);
  });

  await t.test("array index accessor is rejected without invocation", async (t) => {
    const rootDir = await makeB5Root(t, "artifact-accessor");
    const plan = makeB5GoldenPlan();
    let getterCalls = 0;
    Object.defineProperty(plan.artifacts, "0", {
      enumerable: true,
      configurable: true,
      get() {
        getterCalls += 1;
        throw new Error("artifact getter must not run");
      }
    });
    assert.deepEqual(
      await stageCleaningRun(b5Options(rootDir, plan)),
      b5ExpectedFailure("PLAN_BINDING_MISMATCH")
    );
    assert.equal(getterCalls, 0);
  });

  await t.test("Proxy plan and Proxy artifact arrays are programmer misuse", async (t) => {
    const rootDir = await makeB5Root(t, "plan-proxies");
    const plan = makeB5GoldenPlan();
    await assert.rejects(
      () => stageCleaningRun(b5Options(rootDir, new Proxy(plan, {}))),
      TypeError
    );
    await assert.rejects(
      () => stageCleaningRun(b5Options(rootDir, {
        ...plan,
        artifacts: new Proxy(plan.artifacts, {})
      })),
      TypeError
    );
  });

  await t.test("post-call Buffer mutation cannot change snapshotted artifact bytes", async (t) => {
    const rootDir = await makeB5Root(t, "post-call-buffer");
    const plan = makeB5GoldenPlan();
    const expectedPlan = cloneB5Plan(plan);
    const pending = stageCleaningRun(b5Options(rootDir, plan));
    plan.artifacts[0].bytes.fill(0x78);
    const result = await pending;
    const layout = expectedB5Layout(expectedPlan);
    assert.deepEqual(result, layout.success(true));
    assert.deepEqual(
      await readFile(join(rootDir, layout.artifactIntents[0].canonical_path)),
      expectedPlan.artifacts[0].bytes
    );
  });

  await t.test("a forged Uint8Array prototype object is a zero-write plan mismatch", async (t) => {
    const rootDir = await makeB5Root(t, "fake-uint8array-bytes");
    const plan = makeB5GoldenPlan();
    plan.artifacts[0].bytes = Object.create(Uint8Array.prototype);
    let result;
    let rejected = null;
    try {
      result = await stageCleaningRun(b5Options(rootDir, plan));
    } catch (error) {
      rejected = error;
    }
    assert.equal(rejected, null);
    assert.deepEqual(result, b5ExpectedFailure("PLAN_BINDING_MISMATCH"));
    assert.deepEqual(await snapshotB5Tree(rootDir), []);
  });
});

test("B5 plan mismatch outranks staging and run conflicts with no persistent write", async (t) => {
  const stageCleaningRun = await loadStageCleaningRun();
  const rootDir = await makeB5Root(t, "plan-priority");
  const plan = makeB5GoldenPlan();
  const layout = expectedB5Layout(plan);
  await writeB5Path(rootDir, `${layout.stagingPath}/unexpected`, Buffer.from("staging conflict"));
  await writeB5Path(rootDir, `${layout.finalRunPath}/unexpected`, Buffer.from("run conflict"));
  plan.manifest_sha256 = "0".repeat(64);
  const before = await snapshotB5Tree(rootDir);

  assert.deepEqual(
    await stageCleaningRun(b5Options(rootDir, plan)),
    b5ExpectedFailure("PLAN_BINDING_MISMATCH")
  );
  assert.deepEqual(await snapshotB5Tree(rootDir), before);

  await t.test("plan mismatch also outranks a nonexistent root realpath failure", async (t) => {
    const container = await makeB5Root(t, "plan-priority-missing-root");
    const missingRoot = join(container, "does-not-exist");
    const invalidPlan = makeB5GoldenPlan();
    invalidPlan.manifest_sha256 = "0".repeat(64);
    assert.deepEqual(
      await stageCleaningRun(b5Options(missingRoot, invalidPlan)),
      b5ExpectedFailure("PLAN_BINDING_MISMATCH")
    );
    assert.deepEqual(await snapshotB5Tree(container), []);
  });
});

const B5_GLOBAL_TEMP_GATE_CHILD_SCRIPT = `
import fs from "node:fs";
import { createHash } from "node:crypto";
import { syncBuiltinESMExports } from "node:module";
import { join, relative, sep } from "node:path";

const [moduleUrl, rootDir, encodedPlan] = process.argv.slice(1);
const serialized = JSON.parse(Buffer.from(encodedPlan, "base64").toString("utf8"));
const plan = {
  manifest: serialized.manifest,
  manifest_sha256: serialized.manifest_sha256,
  artifacts: serialized.artifacts.map((artifact) => ({
    ...artifact,
    bytes: Buffer.from(artifact.bytes, "base64")
  }))
};
const realRoot = await fs.promises.realpath(rootDir);
const runSha256 = plan.manifest.desired_pointer.run_sha256;
const finalRoot = join(realRoot, ".local", "cleaned", "runs", runSha256);
const zeroByteCatalog = plan.artifacts.find((artifact) =>
  artifact.relative_path === "catalog/sources.jsonl" && artifact.size_bytes === 0);
const originalLink = fs.promises.link;
let checkedBeforeFirstCanonicalLink = false;
let zeroByteCatalogLinkProbe = null;
fs.promises.link = async (source, destination) => {
  const sourcePath = String(source);
  const destinationPath = String(destination);
  if (zeroByteCatalog !== undefined &&
      destinationPath === join(finalRoot, zeroByteCatalog.relative_path)) {
    const expectedSource = join(
      finalRoot,
      zeroByteCatalog.relative_path + ".tmp-" + zeroByteCatalog.sha256 + ".partial"
    );
    const sourceStat = await fs.promises.lstat(sourcePath);
    zeroByteCatalogLinkProbe = {
      triggered: true,
      source_path: relative(realRoot, sourcePath).split(sep).join("/"),
      destination_path: relative(realRoot, destinationPath).split(sep).join("/"),
      regular: sourceStat.isFile() && !sourceStat.isSymbolicLink(),
      mode: sourceStat.mode & 0o777,
      size: sourceStat.size
    };
    if (sourcePath !== expectedSource || !zeroByteCatalogLinkProbe.regular ||
        zeroByteCatalogLinkProbe.mode !== 0o600 || zeroByteCatalogLinkProbe.size !== 0) {
      throw new Error("zero-byte canonical was not linked from its exact private temp");
    }
  }
  if (!checkedBeforeFirstCanonicalLink &&
      destinationPath.startsWith(finalRoot + sep) &&
      !destinationPath.endsWith(".partial")) {
    for (const artifact of plan.artifacts) {
      const tempPath = join(
        finalRoot,
        artifact.relative_path + ".tmp-" + artifact.sha256 + ".partial"
      );
      const bytes = await fs.promises.readFile(tempPath);
      const digest = createHash("sha256").update(bytes).digest("hex");
      if (bytes.length !== artifact.size_bytes || digest !== artifact.sha256) {
        throw new Error("canonical link observed before all temps were complete");
      }
    }
    checkedBeforeFirstCanonicalLink = true;
  }
  return originalLink(source, destination);
};
syncBuiltinESMExports();

let result;
try {
  const { stageCleaningRun } = await import(moduleUrl);
  result = await stageCleaningRun({ rootDir, runsRoot: ".local/cleaned/runs", plan });
} finally {
  fs.promises.link = originalLink;
  syncBuiltinESMExports();
}
process.stdout.write(JSON.stringify({
  result,
  checkedBeforeFirstCanonicalLink,
  zeroByteCatalogLinkProbe
}));
`;

async function runB5GlobalTempGateChild(rootDir, plan) {
  const child = await runBoundedChild(process.execPath, [
    "--input-type=module",
    "--eval",
    B5_GLOBAL_TEMP_GATE_CHILD_SCRIPT,
    B5_MODULE_URL,
    rootDir,
    encodeB5Plan(plan)
  ]);
  assert.equal(child.timedOut, false, child.stderr);
  assert.equal(child.code, 0, child.stderr);
  return JSON.parse(child.stdout);
}

const B5_DURABILITY_GATE_CHILD_SCRIPT = `
import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { dirname, relative, sep } from "node:path";

const [moduleUrl, rootDir, encodedPlan] = process.argv.slice(1);
const serialized = JSON.parse(Buffer.from(encodedPlan, "base64").toString("utf8"));
const plan = {
  manifest: serialized.manifest,
  manifest_sha256: serialized.manifest_sha256,
  artifacts: serialized.artifacts.map((artifact) => ({
    ...artifact,
    bytes: Buffer.from(artifact.bytes, "base64")
  }))
};
const realRoot = fs.realpathSync(rootDir);
const original = {
  open: fs.promises.open,
  link: fs.promises.link,
  unlink: fs.promises.unlink
};
const syncedPaths = [];
const linkEvents = [];
const unlinkEvents = [];

function repoPath(value) {
  const rel = relative(realRoot, value);
  return rel === "" ? "." : rel.split(sep).join("/");
}

fs.promises.open = async (...args) => {
  const openedPath = repoPath(args[0]);
  const handle = await original.open(...args);
  return new Proxy(handle, {
    get(target, property) {
      if (property === "sync") {
        return async (...methodArgs) => {
          const value = await target.sync(...methodArgs);
          syncedPaths.push(openedPath);
          return value;
        };
      }
      const value = Reflect.get(target, property, target);
      return typeof value === "function" ? value.bind(target) : value;
    }
  });
};
fs.promises.link = async (...args) => {
  const sourcePath = repoPath(args[0]);
  const destinationPath = repoPath(args[1]);
  linkEvents.push({
    source_path: sourcePath,
    destination_path: destinationPath,
    source_synced_before_link: syncedPaths.includes(sourcePath)
  });
  return original.link(...args);
};
fs.promises.unlink = async (...args) => {
  const path = repoPath(args[0]);
  const parentPath = dirname(path).split(sep).join("/");
  unlinkEvents.push({
    path,
    parent_path: parentPath,
    parent_synced_before_unlink: syncedPaths.includes(parentPath)
  });
  return original.unlink(...args);
};
syncBuiltinESMExports();

let result;
let thrown = null;
try {
  const { stageCleaningRun } = await import(moduleUrl);
  result = await stageCleaningRun({ rootDir, runsRoot: ".local/cleaned/runs", plan });
} catch (error) {
  thrown = { name: error?.name, code: error?.code, message: error?.message };
}
process.stdout.write(JSON.stringify({
  result,
  thrown,
  synced_paths: syncedPaths,
  link_events: linkEvents,
  unlink_events: unlinkEvents
}));
`;

async function runB5DurabilityGateChild(rootDir, plan) {
  const child = await runBoundedChild(process.execPath, [
    "--input-type=module",
    "--eval",
    B5_DURABILITY_GATE_CHILD_SCRIPT,
    B5_MODULE_URL,
    rootDir,
    encodeB5Plan(plan)
  ]);
  assert.equal(child.timedOut, false, child.stderr);
  assert.equal(child.code, 0, child.stderr);
  const observed = JSON.parse(child.stdout);
  assert.equal(observed.thrown, null, JSON.stringify(observed.thrown));
  return observed;
}

const B5_PLAIN_STAGE_CHILD_SCRIPT = `
const [moduleUrl, rootDir, encodedPlan] = process.argv.slice(1);
const serialized = JSON.parse(Buffer.from(encodedPlan, "base64").toString("utf8"));
const plan = {
  manifest: serialized.manifest,
  manifest_sha256: serialized.manifest_sha256,
  artifacts: serialized.artifacts.map((artifact) => ({
    ...artifact,
    bytes: Buffer.from(artifact.bytes, "base64")
  }))
};
let result;
let thrown = null;
try {
  const { stageCleaningRun } = await import(moduleUrl);
  result = await stageCleaningRun({ rootDir, runsRoot: ".local/cleaned/runs", plan });
} catch (error) {
  thrown = { name: error?.name, code: error?.code, message: error?.message };
}
process.stdout.write(JSON.stringify({ result, thrown }));
`;

async function runB5PlainStageChild(rootDir, plan) {
  const child = await runBoundedChild(process.execPath, [
    "--input-type=module",
    "--eval",
    B5_PLAIN_STAGE_CHILD_SCRIPT,
    B5_MODULE_URL,
    rootDir,
    encodeB5Plan(plan)
  ]);
  assert.equal(child.timedOut, false, child.stderr);
  assert.equal(child.code, 0, child.stderr);
  const observed = JSON.parse(child.stdout);
  assert.equal(observed.thrown, null, JSON.stringify(observed.thrown));
  return observed.result;
}

const B5_POST_PREFLIGHT_LEAF_RACE_CHILD_SCRIPT = `
import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { join, relative, sep } from "node:path";

const [
  moduleUrl,
  rootDir,
  encodedPlan,
  triggerPath,
  victimPath,
  intentPath,
  intentCandidatePath,
  mutationKind,
  encodedReplacementBytes
] = process.argv.slice(1);
const serialized = JSON.parse(Buffer.from(encodedPlan, "base64").toString("utf8"));
const plan = {
  manifest: serialized.manifest,
  manifest_sha256: serialized.manifest_sha256,
  artifacts: serialized.artifacts.map((artifact) => ({
    ...artifact,
    bytes: Buffer.from(artifact.bytes, "base64")
  }))
};
const realRoot = fs.realpathSync(rootDir);
const victimAbsolute = join(realRoot, ...victimPath.split("/"));
const original = {
  open: fs.promises.open,
  unlink: fs.promises.unlink,
  writeFile: fs.promises.writeFile,
  lstat: fs.promises.lstat
};
let triggered = false;
let fullProofObserved = false;
let originalVictimInode = null;
let replacementVictimInode = null;
const replacementBytes = encodedReplacementBytes === "-"
  ? null
  : Buffer.from(encodedReplacementBytes, "base64");

function repoPath(value) {
  return typeof value === "string"
    ? relative(realRoot, value).split(sep).join("/")
    : null;
}
function exists(repoPathValue) {
  return fs.existsSync(join(realRoot, ...repoPathValue.split("/")));
}

fs.promises.open = async (...args) => {
  const handle = await original.open(...args);
  if (triggered || repoPath(args[0]) !== triggerPath) return handle;
  let statCalls = 0;
  let readObserved = false;
  return new Proxy(handle, {
    get(target, property) {
      if (property === "stat") {
        return async (...methodArgs) => {
          const value = await target.stat(...methodArgs);
          statCalls += 1;
          return value;
        };
      }
      if (property === "read") {
        return async (...methodArgs) => {
          const value = await target.read(...methodArgs);
          readObserved = true;
          return value;
        };
      }
      if (property === "close") {
        return async (...methodArgs) => {
          const value = await target.close(...methodArgs);
          if (!triggered && statCalls >= 2 && readObserved) {
            fullProofObserved = true;
            originalVictimInode = (await original.lstat(victimAbsolute)).ino;
            await original.unlink(victimAbsolute);
            if (mutationKind === "replace") {
              await original.writeFile(victimAbsolute, replacementBytes, {
                flag: "wx",
                mode: 0o600
              });
              replacementVictimInode = (await original.lstat(victimAbsolute)).ino;
            }
            triggered = true;
          }
          return value;
        };
      }
      const value = Reflect.get(target, property, target);
      return typeof value === "function" ? value.bind(target) : value;
    }
  });
};
syncBuiltinESMExports();

let result;
let thrown = null;
try {
  const { stageCleaningRun } = await import(moduleUrl);
  result = await stageCleaningRun({ rootDir, runsRoot: ".local/cleaned/runs", plan });
} catch (error) {
  thrown = { name: error?.name, code: error?.code, message: error?.message };
} finally {
  fs.promises.open = original.open;
  syncBuiltinESMExports();
}
const runPath = plan.manifest.desired_pointer.run_path;
const tempPaths = plan.artifacts.map((artifact) =>
  runPath + "/" + artifact.relative_path + ".tmp-" + artifact.sha256 + ".partial");
process.stdout.write(JSON.stringify({
  result,
  thrown,
  triggered,
  full_proof_observed: fullProofObserved,
  cleaned_exists: exists(".local/cleaned"),
  victim_exists: exists(victimPath),
  intent_exists: exists(intentPath),
  candidate_exists: exists(intentCandidatePath),
  artifact_temp_exists: tempPaths.some(exists),
  original_victim_inode: originalVictimInode,
  replacement_victim_inode: replacementVictimInode
}));
`;

async function runB5PostPreflightLeafRaceChild(
  rootDir,
  plan,
  layout,
  triggerPath,
  victimPath,
  mutationKind = "unlink",
  replacementBytes = null
) {
  const child = await runBoundedChild(process.execPath, [
    "--input-type=module",
    "--eval",
    B5_POST_PREFLIGHT_LEAF_RACE_CHILD_SCRIPT,
    B5_MODULE_URL,
    rootDir,
    encodeB5Plan(plan),
    triggerPath,
    victimPath,
    layout.intentPath,
    layout.intentCandidatePath,
    mutationKind,
    replacementBytes === null ? "-" : Buffer.from(replacementBytes).toString("base64")
  ]);
  assert.equal(child.timedOut, false, child.stderr);
  assert.equal(child.code, 0, child.stderr);
  const observed = JSON.parse(child.stdout);
  assert.equal(observed.thrown, null, JSON.stringify(observed.thrown));
  assert.equal(observed.triggered, true, "post-preflight leaf race did not trigger");
  assert.equal(observed.full_proof_observed, true);
  return observed;
}

const B5_POST_INTENT_PUBLICATION_ADOPTION_RACE_CHILD_SCRIPT = `
import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { join, relative, sep } from "node:path";

const [
  moduleUrl,
  rootDir,
  encodedPlan,
  intentPath,
  intentCandidatePath,
  victimPath,
  encodedIntentBytes
] = process.argv.slice(1);
const serialized = JSON.parse(Buffer.from(encodedPlan, "base64").toString("utf8"));
const plan = {
  manifest: serialized.manifest,
  manifest_sha256: serialized.manifest_sha256,
  artifacts: serialized.artifacts.map((artifact) => ({
    ...artifact,
    bytes: Buffer.from(artifact.bytes, "base64")
  }))
};
const intentBytes = Buffer.from(encodedIntentBytes, "base64");
const realRoot = fs.realpathSync(rootDir);
const victimAbsolute = join(realRoot, ...victimPath.split("/"));
const original = {
  link: fs.promises.link,
  unlink: fs.promises.unlink,
  lstat: fs.promises.lstat
};
let triggered = false;
let victimInodeBeforeUnlink = null;
let linkedIntentInode = null;

function repoPath(value) {
  return typeof value === "string"
    ? relative(realRoot, value).split(sep).join("/")
    : null;
}
function absolute(repoPathValue) {
  return join(realRoot, ...repoPathValue.split("/"));
}
function exists(repoPathValue) {
  return fs.existsSync(absolute(repoPathValue));
}

fs.promises.link = async (...args) => {
  const value = await original.link(...args);
  if (!triggered && repoPath(args[1]) === intentPath) {
    linkedIntentInode = (await original.lstat(args[1])).ino;
    victimInodeBeforeUnlink = (await original.lstat(victimAbsolute)).ino;
    await original.unlink(victimAbsolute);
    triggered = true;
  }
  return value;
};
syncBuiltinESMExports();

let result;
let thrown = null;
try {
  const { stageCleaningRun } = await import(moduleUrl);
  result = await stageCleaningRun({ rootDir, runsRoot: ".local/cleaned/runs", plan });
} catch (error) {
  thrown = { name: error?.name, code: error?.code, message: error?.message };
} finally {
  fs.promises.link = original.link;
  syncBuiltinESMExports();
}
const runPath = plan.manifest.desired_pointer.run_path;
const tempPaths = plan.artifacts.map((artifact) =>
  runPath + "/" + artifact.relative_path + ".tmp-" + artifact.sha256 + ".partial");
const intentExists = exists(intentPath);
process.stdout.write(JSON.stringify({
  result,
  thrown,
  triggered,
  victim_inode_before_unlink: victimInodeBeforeUnlink,
  linked_intent_inode: linkedIntentInode,
  retained_intent_inode: intentExists ? fs.lstatSync(absolute(intentPath)).ino : null,
  intent_exists: intentExists,
  intent_bytes_match: intentExists &&
    fs.readFileSync(absolute(intentPath)).equals(intentBytes),
  candidate_exists: exists(intentCandidatePath),
  victim_exists: exists(victimPath),
  artifact_temp_exists: tempPaths.some(exists)
}));
`;

async function runB5PostIntentPublicationAdoptionRaceChild(
  rootDir,
  plan,
  layout,
  victimPath
) {
  const child = await runBoundedChild(process.execPath, [
    "--input-type=module",
    "--eval",
    B5_POST_INTENT_PUBLICATION_ADOPTION_RACE_CHILD_SCRIPT,
    B5_MODULE_URL,
    rootDir,
    encodeB5Plan(plan),
    layout.intentPath,
    layout.intentCandidatePath,
    victimPath,
    layout.intentBytes.toString("base64")
  ]);
  assert.equal(child.timedOut, false, child.stderr);
  assert.equal(child.code, 0, child.stderr);
  const observed = JSON.parse(child.stdout);
  assert.equal(observed.thrown, null, JSON.stringify(observed.thrown));
  assert.equal(observed.triggered, true, "post-publication adoption race did not trigger");
  assert.notEqual(observed.victim_inode_before_unlink, null);
  assert.notEqual(observed.linked_intent_inode, null);
  return observed;
}

test("B5 accepted staging states resume absent, exact intent, and intent-candidate prefixes", async (t) => {
  const stageCleaningRun = await loadStageCleaningRun();
  for (const state of [
    "absent",
    "empty-directory",
    "exact-intent",
    "candidate-empty",
    "candidate-prefix",
    "candidate-full"
  ]) {
    await t.test(state, async (t) => {
      const rootDir = await makeB5Root(t, `staging-${state}`);
      const plan = makeB5GoldenPlan();
      const layout = expectedB5Layout(plan);
      if (state === "empty-directory") {
        await mkdir(join(rootDir, layout.stagingPath), { recursive: true });
      } else if (state === "exact-intent") {
        await writeB5Intent(rootDir, layout);
      } else if (state.startsWith("candidate-")) {
        const candidateLength = state === "candidate-empty"
          ? 0
          : state === "candidate-prefix"
            ? Math.max(1, Math.floor(layout.intentBytes.length / 2))
            : layout.intentBytes.length;
        await writeB5Prefix(
          rootDir,
          layout.intentCandidatePath,
          layout.intentBytes,
          candidateLength
        );
      }

      assert.deepEqual(
        await stageCleaningRun(b5Options(rootDir, plan)),
        layout.success(true)
      );
      assert.deepEqual(await readFile(join(rootDir, layout.intentPath)), layout.intentBytes);
      await assert.rejects(
        () => lstat(join(rootDir, layout.intentCandidatePath)),
        { code: "ENOENT" }
      );
      for (const artifact of layout.artifactIntents) {
        assert.deepEqual(
          await readFile(join(rootDir, artifact.canonical_path)),
          b5ArtifactBytes(plan, artifact.relative_path)
        );
      }
    });
  }

  await t.test("a full intent candidate is file-synced again before reuse link", async (t) => {
    const rootDir = await makeB5Root(t, "staging-full-candidate-resync");
    const plan = makeB5GoldenPlan();
    const layout = expectedB5Layout(plan);
    await writeB5Path(rootDir, layout.intentCandidatePath, layout.intentBytes);
    const observed = await runB5DurabilityGateChild(rootDir, plan);
    const intentLink = observed.link_events.find(({ destination_path: path }) =>
      path === layout.intentPath);
    assert.deepEqual(observed.result, layout.success(true));
    assert.equal(intentLink?.source_path, layout.intentCandidatePath);
    assert.equal(intentLink?.source_synced_before_link, true);
  });

  await t.test("an existing intent removed after preflight blocks every final mutation", async (t) => {
    const rootDir = await makeB5Root(t, "staging-intent-removed-post-preflight");
    const plan = makeB5GoldenPlan();
    const layout = expectedB5Layout(plan);
    await writeB5Intent(rootDir, layout);
    const observed = await runB5PostPreflightLeafRaceChild(
      rootDir,
      plan,
      layout,
      layout.intentPath,
      layout.intentPath
    );
    assert.equal(observed.cleaned_exists, false, "final namespace was mutated without intent");
    assert.equal(observed.intent_exists, false);
    assert.deepEqual(
      observed.result,
      b5ExpectedFailure("STAGING_CONFLICT", layout.intentPath)
    );
  });

  await t.test("an exact-byte intent inode replacement after preflight blocks final mutation", async (t) => {
    const rootDir = await makeB5Root(t, "staging-intent-replaced-post-preflight");
    const plan = makeB5GoldenPlan();
    const layout = expectedB5Layout(plan);
    await writeB5Intent(rootDir, layout);
    const observed = await runB5PostPreflightLeafRaceChild(
      rootDir,
      plan,
      layout,
      layout.intentPath,
      layout.intentPath,
      "replace",
      layout.intentBytes
    );
    assert.notEqual(observed.original_victim_inode, observed.replacement_victim_inode);
    assert.equal(observed.cleaned_exists, false, "final namespace was mutated after intent drift");
    assert.equal(observed.intent_exists, true);
    assert.equal(
      (await lstat(join(rootDir, layout.intentPath))).ino,
      observed.replacement_victim_inode
    );
    assert.deepEqual(
      observed.result,
      b5ExpectedFailure("STAGING_CONFLICT", layout.intentPath)
    );
  });
});

test("B5 invalid intent bytes and staging namespace entries fail closed without mutation", async (t) => {
  const stageCleaningRun = await loadStageCleaningRun();
  const plainCases = [
    ["unknown-intent-key", (layout) => ({
      path: layout.intentPath,
      bytes: canonicalJsonDocumentBytes({ ...layout.intent, unknown: true })
    })],
    ["missing-LF", (layout) => ({
      path: layout.intentPath,
      bytes: layout.intentBytes.subarray(0, -1)
    })],
    ["extra-LF", (layout) => ({
      path: layout.intentPath,
      bytes: Buffer.concat([layout.intentBytes, Buffer.from("\n")])
    })],
    ["wrong-intent-bytes", (layout) => ({
      path: layout.intentPath,
      bytes: canonicalJsonDocumentBytes({ wrong: true })
    })],
    ["candidate-wrong-full-bytes", (layout) => {
      const bytes = Buffer.from(layout.intentBytes);
      bytes[Math.floor(bytes.length / 2)] ^= 0x01;
      return { path: layout.intentCandidatePath, bytes };
    }],
    ["candidate-non-prefix-bytes", (layout) => ({
      path: layout.intentCandidatePath,
      bytes: Buffer.from("not-an-intent-prefix")
    })],
    ["wrong-candidate-name", (layout) => ({
      path: `${layout.stagingPath}/intent.json.tmp-${"0".repeat(64)}.partial`,
      bytes: layout.intentBytes
    })],
    ["extra-entry", (layout) => ({
      path: `${layout.stagingPath}/unexpected`,
      bytes: Buffer.from("unexpected")
    })]
  ];
  for (const [label, fixture] of plainCases) {
    await t.test(label, async (t) => {
      const rootDir = await makeB5Root(t, `invalid-staging-${label}`);
      const plan = makeB5GoldenPlan();
      const layout = expectedB5Layout(plan);
      const entry = fixture(layout);
      await writeB5Path(rootDir, entry.path, entry.bytes);
      const before = await snapshotB5Tree(rootDir);
      assert.deepEqual(
        await stageCleaningRun(b5Options(rootDir, plan)),
        b5ExpectedFailure("STAGING_CONFLICT", entry.path)
      );
      assert.deepEqual(await snapshotB5Tree(rootDir), before);
    });
  }

  await t.test("exact intent candidate path is a directory", async (t) => {
    const rootDir = await makeB5Root(t, "candidate-directory");
    const plan = makeB5GoldenPlan();
    const layout = expectedB5Layout(plan);
    await mkdir(join(rootDir, layout.intentCandidatePath), { recursive: true });
    const before = await snapshotB5Tree(rootDir);
    assert.deepEqual(
      await stageCleaningRun(b5Options(rootDir, plan)),
      b5ExpectedFailure("STAGING_CONFLICT", layout.intentCandidatePath)
    );
    assert.deepEqual(await snapshotB5Tree(rootDir), before);
  });

  await t.test("exact intent candidate path is a symlink and external target is unchanged", async (t) => {
    const rootDir = await makeB5Root(t, "candidate-symlink");
    const outsideRoot = await makeB5Root(t, "candidate-symlink-outside");
    const outsidePath = join(outsideRoot, "candidate-target");
    const outsideBytes = Buffer.from("external candidate target");
    await writeFile(outsidePath, outsideBytes);
    const plan = makeB5GoldenPlan();
    const layout = expectedB5Layout(plan);
    await mkdir(dirname(join(rootDir, layout.intentCandidatePath)), { recursive: true });
    await symlink(outsidePath, join(rootDir, layout.intentCandidatePath));
    const before = await snapshotB5Tree(rootDir);
    const outsideBefore = await snapshotB5Tree(outsideRoot);
    assert.deepEqual(
      await stageCleaningRun(b5Options(rootDir, plan)),
      b5ExpectedFailure("STAGING_CONFLICT", layout.intentCandidatePath)
    );
    assert.deepEqual(await snapshotB5Tree(rootDir), before);
    assert.deepEqual(await snapshotB5Tree(outsideRoot), outsideBefore);
    assert.deepEqual(await readFile(outsidePath), outsideBytes);
  });

  await t.test("exact intent candidate FIFO fails without blocking or mutation", async (t) => {
    const rootDir = await makeB5Root(t, "candidate-fifo");
    const plan = makeB5GoldenPlan();
    const layout = expectedB5Layout(plan);
    const absolutePath = join(rootDir, layout.intentCandidatePath);
    await mkdir(dirname(absolutePath), { recursive: true });
    const fifo = await runBoundedChild("/usr/bin/mkfifo", [absolutePath]);
    assert.equal(fifo.timedOut, false, fifo.stderr);
    assert.equal(fifo.code, 0, fifo.stderr);
    const before = await snapshotB5Tree(rootDir);
    assert.deepEqual(
      await runB5PlainStageChild(rootDir, plan),
      b5ExpectedFailure("STAGING_CONFLICT", layout.intentCandidatePath)
    );
    assert.deepEqual(await snapshotB5Tree(rootDir), before);
  });

  await t.test("exact intent candidate socket fails without blocking or mutation", async (t) => {
    const rootDir = await makeB5Root(t, "candidate-socket");
    const plan = makeB5GoldenPlan();
    const layout = expectedB5Layout(plan);
    const absolutePath = join(rootDir, layout.intentCandidatePath);
    await mkdir(dirname(absolutePath), { recursive: true });
    const carrier = await makeB5SocketCarrier(t, absolutePath);
    try {
      const before = await snapshotB5Tree(rootDir);
      const carrierBefore = await snapshotB5Tree(carrier.carrierRoot);
      assert.deepEqual(
        await runB5PlainStageChild(rootDir, plan),
        b5ExpectedFailure("STAGING_CONFLICT", layout.intentCandidatePath)
      );
      assert.deepEqual(await snapshotB5Tree(rootDir), before);
      assert.deepEqual(await snapshotB5Tree(carrier.carrierRoot), carrierBefore);
    } finally {
      await carrier.close();
    }
  });

  await t.test("intent symlink", async (t) => {
    const rootDir = await makeB5Root(t, "intent-symlink");
    const plan = makeB5GoldenPlan();
    const layout = expectedB5Layout(plan);
    await writeB5Path(rootDir, "target-intent", layout.intentBytes);
    await mkdir(dirname(join(rootDir, layout.intentPath)), { recursive: true });
    await symlink("../../../target-intent", join(rootDir, layout.intentPath));
    assert.deepEqual(
      await stageCleaningRun(b5Options(rootDir, plan)),
      b5ExpectedFailure("STAGING_CONFLICT", layout.intentPath)
    );
  });

  await t.test("intent FIFO", async (t) => {
    const rootDir = await makeB5Root(t, "intent-fifo");
    const plan = makeB5GoldenPlan();
    const layout = expectedB5Layout(plan);
    const absolutePath = join(rootDir, layout.intentPath);
    await mkdir(dirname(absolutePath), { recursive: true });
    const child = await runBoundedChild("/usr/bin/mkfifo", [absolutePath]);
    assert.equal(child.code, 0, child.stderr);
    assert.deepEqual(
      await stageCleaningRun(b5Options(rootDir, plan)),
      b5ExpectedFailure("STAGING_CONFLICT", layout.intentPath)
    );
  });

  await t.test("intent socket", async (t) => {
    const rootDir = await makeB5Root(t, "intent-socket");
    const plan = makeB5GoldenPlan();
    const layout = expectedB5Layout(plan);
    const absolutePath = join(rootDir, layout.intentPath);
    await mkdir(dirname(absolutePath), { recursive: true });
    const carrier = await makeB5SocketCarrier(t, absolutePath);
    try {
      const before = await snapshotB5Tree(rootDir);
      const carrierBefore = await snapshotB5Tree(carrier.carrierRoot);
      assert.deepEqual(
        await stageCleaningRun(b5Options(rootDir, plan)),
        b5ExpectedFailure("STAGING_CONFLICT", layout.intentPath)
      );
      assert.deepEqual(await snapshotB5Tree(rootDir), before);
      assert.deepEqual(await snapshotB5Tree(carrier.carrierRoot), carrierBefore);
    } finally {
      await carrier.close();
    }
  });

  await t.test("intent path is a directory", async (t) => {
    const rootDir = await makeB5Root(t, "intent-directory");
    const plan = makeB5GoldenPlan();
    const layout = expectedB5Layout(plan);
    await mkdir(join(rootDir, layout.intentPath), { recursive: true });
    assert.deepEqual(
      await stageCleaningRun(b5Options(rootDir, plan)),
      b5ExpectedFailure("STAGING_CONFLICT", layout.intentPath)
    );
  });
});

test("B5 missing-intent adoption requires a complete exact final run despite candidate durability", async (t) => {
  const stageCleaningRun = await loadStageCleaningRun();

  await t.test("partial final without durable intent is rejected", async (t) => {
    const rootDir = await makeB5Root(t, "partial-no-intent");
    const plan = makeB5GoldenPlan();
    const layout = expectedB5Layout(plan);
    await materializeB5Final(rootDir, plan, layout, 1);
    const before = await snapshotB5Tree(rootDir);
    assert.deepEqual(
      await stageCleaningRun(b5Options(rootDir, plan)),
      b5ExpectedFailure("RUN_CONFLICT", layout.artifactIntents[0].canonical_path)
    );
    assert.deepEqual(await snapshotB5Tree(rootDir), before);
  });

  await t.test("artifact temp without durable intent is rejected", async (t) => {
    const rootDir = await makeB5Root(t, "temp-no-intent");
    const plan = makeB5GoldenPlan();
    const layout = expectedB5Layout(plan);
    const artifact = layout.artifactIntents[0];
    await writeB5Path(rootDir, artifact.temp_path, b5ArtifactBytes(plan, artifact.relative_path));
    const before = await snapshotB5Tree(rootDir);
    assert.deepEqual(
      await stageCleaningRun(b5Options(rootDir, plan)),
      b5ExpectedFailure("RUN_CONFLICT", artifact.temp_path)
    );
    assert.deepEqual(await snapshotB5Tree(rootDir), before);
  });

  for (const candidateState of ["absent", "empty", "prefix", "full"]) {
    await t.test(`complete final adopts candidate ${candidateState}`, async (t) => {
      const rootDir = await makeB5Root(t, `adoption-${candidateState}`);
      const plan = makeB5GoldenPlan();
      const layout = expectedB5Layout(plan);
      await materializeB5Final(rootDir, plan, layout);
      const inodes = new Map();
      for (const artifact of layout.artifactIntents) {
        inodes.set(artifact.canonical_path, (await stat(join(rootDir, artifact.canonical_path))).ino);
      }
      if (candidateState !== "absent") {
        const length = candidateState === "empty"
          ? 0
          : candidateState === "prefix"
            ? Math.max(1, layout.intentBytes.length - 1)
            : layout.intentBytes.length;
        await writeB5Prefix(rootDir, layout.intentCandidatePath, layout.intentBytes, length);
      }

      assert.deepEqual(
        await stageCleaningRun(b5Options(rootDir, plan)),
        layout.success(true)
      );
      assert.deepEqual(await readFile(join(rootDir, layout.intentPath)), layout.intentBytes);
      await assert.rejects(() => lstat(join(rootDir, layout.intentCandidatePath)), { code: "ENOENT" });
      for (const artifact of layout.artifactIntents) {
        assert.equal(
          (await stat(join(rootDir, artifact.canonical_path))).ino,
          inodes.get(artifact.canonical_path)
        );
      }
    });
  }

  await t.test("a full candidate never authorizes partial final state", async (t) => {
    const rootDir = await makeB5Root(t, "candidate-cannot-authorize-partial");
    const plan = makeB5GoldenPlan();
    const layout = expectedB5Layout(plan);
    await writeB5Path(rootDir, layout.intentCandidatePath, layout.intentBytes);
    await materializeB5Final(rootDir, plan, layout, 1);
    const before = await snapshotB5Tree(rootDir);
    assert.deepEqual(
      await stageCleaningRun(b5Options(rootDir, plan)),
      b5ExpectedFailure("RUN_CONFLICT", layout.artifactIntents[0].canonical_path)
    );
    assert.deepEqual(await snapshotB5Tree(rootDir), before);
  });

  await t.test("adoption revalidates the complete final before publishing intent", async (t) => {
    const rootDir = await makeB5Root(t, "adoption-final-broken-post-preflight");
    const plan = makeB5GoldenPlan();
    const layout = expectedB5Layout(plan);
    await mkdir(join(rootDir, layout.stagingPath), { recursive: true });
    await materializeB5Final(rootDir, plan, layout);
    const victim = layout.artifactIntents[0];
    const trigger = layout.artifactIntents.at(-1);
    const observed = await runB5PostPreflightLeafRaceChild(
      rootDir,
      plan,
      layout,
      trigger.canonical_path,
      victim.canonical_path
    );
    assert.deepEqual(
      observed.result,
      b5ExpectedFailure("RUN_CONFLICT", victim.canonical_path)
    );
    assert.equal(observed.victim_exists, false, "adoption repaired an unauthorized final leaf");
    assert.equal(observed.intent_exists, false, "adoption published intent after final drift");
    assert.equal(observed.candidate_exists, false);
    assert.equal(observed.artifact_temp_exists, false);
  });

  await t.test("adoption revalidates the final after publishing a missing intent", async (t) => {
    const rootDir = await makeB5Root(t, "adoption-final-broken-post-publication");
    const plan = makeB5GoldenPlan();
    const layout = expectedB5Layout(plan);
    await materializeB5Final(rootDir, plan, layout);
    const victim = layout.artifactIntents[0];
    const observed = await runB5PostIntentPublicationAdoptionRaceChild(
      rootDir,
      plan,
      layout,
      victim.canonical_path
    );
    assert.equal(observed.intent_exists, true, "published intent was not retained");
    assert.equal(observed.intent_bytes_match, true, "retained intent bytes drifted");
    assert.equal(observed.retained_intent_inode, observed.linked_intent_inode);
    assert.equal(observed.candidate_exists, false, "intent candidate was not cleaned");
    assert.equal(observed.victim_exists, false, "adoption repaired an unauthorized final leaf");
    assert.equal(observed.artifact_temp_exists, false);
    assert.deepEqual(
      observed.result,
      b5ExpectedFailure("RUN_CONFLICT", victim.canonical_path, true)
    );
  });
});

test("B5 artifact temps resume absent, empty, prefix, full, and zero-byte states", async (t) => {
  const stageCleaningRun = await loadStageCleaningRun();
  for (const state of ["absent", "empty", "prefix", "full"]) {
    await t.test(state, async (t) => {
      const rootDir = await makeB5Root(t, `artifact-temp-${state}`);
      const plan = makeB5GoldenPlan();
      const layout = expectedB5Layout(plan);
      const target = layout.artifactIntents[0];
      await writeB5Intent(rootDir, layout);
      await materializeB5Temps(rootDir, plan, layout, Object.fromEntries(
        layout.artifactIntents.map((artifact) => [
          artifact.relative_path,
          artifact.relative_path === target.relative_path ? state : "absent"
        ])
      ));
      assert.deepEqual(
        await stageCleaningRun(b5Options(rootDir, plan)),
        layout.success(true)
      );
      for (const artifact of layout.artifactIntents) {
        assert.deepEqual(
          await readFile(join(rootDir, artifact.canonical_path)),
          b5ArtifactBytes(plan, artifact.relative_path)
        );
        await assert.rejects(() => lstat(join(rootDir, artifact.temp_path)), { code: "ENOENT" });
      }
    });
  }

  await t.test("zero-byte full temp is valid and leaves a zero-byte canonical", async (t) => {
    const rootDir = await makeB5Root(t, "zero-byte-temp");
    const plan = makeB5EmptyPlan();
    const layout = expectedB5Layout(plan);
    const zeroArtifact = layout.artifactIntents.find(({ size_bytes: size }) => size === 0);
    await writeB5Intent(rootDir, layout);
    await writeB5Path(rootDir, zeroArtifact.temp_path, Buffer.alloc(0));
    assert.deepEqual(
      await stageCleaningRun(b5Options(rootDir, plan)),
      layout.success(true)
    );
    assert.equal((await stat(join(rootDir, zeroArtifact.canonical_path))).size, 0);
  });

  await t.test("full artifact temps are file-synced again before reuse links", async (t) => {
    const rootDir = await makeB5Root(t, "artifact-full-temp-resync");
    const plan = makeB5GoldenPlan();
    const layout = expectedB5Layout(plan);
    await writeB5Intent(rootDir, layout);
    await materializeB5Temps(rootDir, plan, layout);
    const observed = await runB5DurabilityGateChild(rootDir, plan);
    const artifactLinks = observed.link_events.filter(({ destination_path: path }) =>
      layout.artifactIntents.some(({ canonical_path: canonicalPath }) =>
        path === canonicalPath));
    assert.deepEqual(observed.result, layout.success(true));
    assert.equal(artifactLinks.length, layout.artifactIntents.length);
    assert.equal(artifactLinks.every(({ source_synced_before_link: synced }) => synced), true);
  });
});

test("B5 global gate completes every missing temp before the first canonical link", async (t) => {
  await loadStageCleaningRun();
  const rootDir = await makeB5Root(t, "global-temp-gate");
  const plan = makeB5GoldenPlan();
  const layout = expectedB5Layout(plan);
  await writeB5Intent(rootDir, layout);
  const observed = await runB5GlobalTempGateChild(rootDir, plan);
  assert.equal(observed.checkedBeforeFirstCanonicalLink, true);
  assert.equal(observed.zeroByteCatalogLinkProbe, null);
  assert.deepEqual(observed.result, layout.success(true));
});

test("B5 canonical publication resumes every prefix and cleans only proven temp residue", async (t) => {
  const stageCleaningRun = await loadStageCleaningRun();
  const artifactCount = makeB5GoldenPlan().artifacts.length;
  for (let prefix = 0; prefix <= artifactCount; prefix += 1) {
    await t.test(`canonical prefix ${prefix}`, async (t) => {
      const rootDir = await makeB5Root(t, `canonical-prefix-${prefix}`);
      const plan = makeB5GoldenPlan();
      const layout = expectedB5Layout(plan);
      await writeB5Intent(rootDir, layout);
      await materializeB5Final(rootDir, plan, layout, prefix);
      const reused = new Map();
      for (const artifact of layout.artifactIntents.slice(0, prefix)) {
        reused.set(artifact.canonical_path, (await stat(join(rootDir, artifact.canonical_path))).ino);
      }
      const result = await stageCleaningRun(b5Options(rootDir, plan));
      assert.deepEqual(result, layout.success(prefix !== artifactCount));
      for (const artifact of layout.artifactIntents) {
        assert.deepEqual(
          await readFile(join(rootDir, artifact.canonical_path)),
          b5ArtifactBytes(plan, artifact.relative_path)
        );
      }
      for (const [path, inode] of reused) {
        assert.equal((await stat(join(rootDir, path))).ino, inode);
      }
    });
  }

  await t.test("exact canonical plus valid residue keeps canonical and unlinks residue", async (t) => {
    const rootDir = await makeB5Root(t, "canonical-residue");
    const plan = makeB5GoldenPlan();
    const layout = expectedB5Layout(plan);
    await writeB5Intent(rootDir, layout);
    await materializeB5Final(rootDir, plan, layout);
    const artifact = layout.artifactIntents[0];
    await writeB5Path(rootDir, artifact.temp_path, b5ArtifactBytes(plan, artifact.relative_path));
    const inode = (await stat(join(rootDir, artifact.canonical_path))).ino;
    assert.deepEqual(
      await stageCleaningRun(b5Options(rootDir, plan)),
      layout.success(true)
    );
    assert.equal((await stat(join(rootDir, artifact.canonical_path))).ino, inode);
    await assert.rejects(() => lstat(join(rootDir, artifact.temp_path)), { code: "ENOENT" });
  });

  await t.test("recognized canonical residue fsyncs its parent before unlink", async (t) => {
    const rootDir = await makeB5Root(t, "canonical-residue-parent-resync");
    const plan = makeB5GoldenPlan();
    const layout = expectedB5Layout(plan);
    await writeB5Intent(rootDir, layout);
    await materializeB5Final(rootDir, plan, layout);
    const artifact = layout.artifactIntents[0];
    await writeB5Path(rootDir, artifact.temp_path, b5ArtifactBytes(plan, artifact.relative_path));
    const observed = await runB5DurabilityGateChild(rootDir, plan);
    const residueUnlink = observed.unlink_events.find(({ path }) => path === artifact.temp_path);
    assert.deepEqual(observed.result, layout.success(true));
    assert.equal(residueUnlink?.parent_path, dirname(artifact.temp_path));
    assert.equal(residueUnlink?.parent_synced_before_unlink, true);
  });
});

test("B5 final conflicts and unsafe ancestors fail closed without overwrite or traversal", async (t) => {
  const stageCleaningRun = await loadStageCleaningRun();
  const regularCases = [
    ["mismatching-canonical", async (rootDir, plan, layout) => {
      await writeB5Intent(rootDir, layout);
      const path = layout.artifactIntents[0].canonical_path;
      await writeB5Path(rootDir, path, Buffer.from("wrong"));
      return path;
    }],
    ["non-prefix-temp", async (rootDir, plan, layout) => {
      await writeB5Intent(rootDir, layout);
      const path = layout.artifactIntents[0].temp_path;
      await writeB5Path(rootDir, path, Buffer.from("not a prefix"));
      return path;
    }],
    ["extra-final-entry", async (rootDir, plan, layout) => {
      await writeB5Intent(rootDir, layout);
      const path = `${layout.finalRunPath}/unexpected`;
      await writeB5Path(rootDir, path, Buffer.from("unexpected"));
      return path;
    }],
    ["canonical-directory", async (rootDir, plan, layout) => {
      await writeB5Intent(rootDir, layout);
      const path = layout.artifactIntents[0].canonical_path;
      await mkdir(join(rootDir, path), { recursive: true });
      return path;
    }],
    ["canonical-symlink", async (rootDir, plan, layout) => {
      await writeB5Intent(rootDir, layout);
      const path = layout.artifactIntents[0].canonical_path;
      const target = `${layout.finalRunPath}/target`;
      await writeB5Path(rootDir, target, Buffer.from("target"));
      await mkdir(dirname(join(rootDir, path)), { recursive: true });
      await symlink("target", join(rootDir, path));
      return path;
    }]
  ];
  for (const [label, setup] of regularCases) {
    await t.test(label, async (t) => {
      const rootDir = await makeB5Root(t, `final-${label}`);
      const plan = makeB5GoldenPlan();
      const layout = expectedB5Layout(plan);
      const path = await setup(rootDir, plan, layout);
      const before = await snapshotB5Tree(rootDir);
      assert.deepEqual(
        await stageCleaningRun(b5Options(rootDir, plan)),
        b5ExpectedFailure("RUN_CONFLICT", path)
      );
      assert.deepEqual(await snapshotB5Tree(rootDir), before);
    });
  }

  await t.test("artifact temp path is a directory", async (t) => {
    const rootDir = await makeB5Root(t, "artifact-temp-directory");
    const plan = makeB5GoldenPlan();
    const layout = expectedB5Layout(plan);
    const path = layout.artifactIntents[0].temp_path;
    await writeB5Intent(rootDir, layout);
    await mkdir(join(rootDir, path), { recursive: true });
    const before = await snapshotB5Tree(rootDir);
    assert.deepEqual(
      await stageCleaningRun(b5Options(rootDir, plan)),
      b5ExpectedFailure("RUN_CONFLICT", path)
    );
    assert.deepEqual(await snapshotB5Tree(rootDir), before);
  });

  await t.test("artifact temp symlink leaves its external target unchanged", async (t) => {
    const rootDir = await makeB5Root(t, "artifact-temp-symlink");
    const outsideRoot = await makeB5Root(t, "artifact-temp-symlink-outside");
    const outsidePath = join(outsideRoot, "artifact-temp-target");
    const outsideBytes = Buffer.from("external artifact temp target");
    await writeFile(outsidePath, outsideBytes);
    const plan = makeB5GoldenPlan();
    const layout = expectedB5Layout(plan);
    const path = layout.artifactIntents[0].temp_path;
    await writeB5Intent(rootDir, layout);
    await mkdir(dirname(join(rootDir, path)), { recursive: true });
    await symlink(outsidePath, join(rootDir, path));
    const before = await snapshotB5Tree(rootDir);
    const outsideBefore = await snapshotB5Tree(outsideRoot);
    assert.deepEqual(
      await stageCleaningRun(b5Options(rootDir, plan)),
      b5ExpectedFailure("RUN_CONFLICT", path)
    );
    assert.deepEqual(await snapshotB5Tree(rootDir), before);
    assert.deepEqual(await snapshotB5Tree(outsideRoot), outsideBefore);
    assert.deepEqual(await readFile(outsidePath), outsideBytes);
  });

  await t.test("artifact temp FIFO fails without blocking or mutation", async (t) => {
    const rootDir = await makeB5Root(t, "artifact-temp-fifo");
    const plan = makeB5GoldenPlan();
    const layout = expectedB5Layout(plan);
    const path = layout.artifactIntents[0].temp_path;
    await writeB5Intent(rootDir, layout);
    const absolutePath = join(rootDir, path);
    await mkdir(dirname(absolutePath), { recursive: true });
    const fifo = await runBoundedChild("/usr/bin/mkfifo", [absolutePath]);
    assert.equal(fifo.timedOut, false, fifo.stderr);
    assert.equal(fifo.code, 0, fifo.stderr);
    const before = await snapshotB5Tree(rootDir);
    assert.deepEqual(
      await runB5PlainStageChild(rootDir, plan),
      b5ExpectedFailure("RUN_CONFLICT", path)
    );
    assert.deepEqual(await snapshotB5Tree(rootDir), before);
  });

  await t.test("artifact temp socket fails without blocking or mutation", async (t) => {
    const rootDir = await makeB5Root(t, "artifact-temp-socket");
    const plan = makeB5GoldenPlan();
    const layout = expectedB5Layout(plan);
    const path = layout.artifactIntents[0].temp_path;
    await writeB5Intent(rootDir, layout);
    const absolutePath = join(rootDir, path);
    await mkdir(dirname(absolutePath), { recursive: true });
    const carrier = await makeB5SocketCarrier(t, absolutePath);
    try {
      const before = await snapshotB5Tree(rootDir);
      const carrierBefore = await snapshotB5Tree(carrier.carrierRoot);
      assert.deepEqual(
        await runB5PlainStageChild(rootDir, plan),
        b5ExpectedFailure("RUN_CONFLICT", path)
      );
      assert.deepEqual(await snapshotB5Tree(rootDir), before);
      assert.deepEqual(await snapshotB5Tree(carrier.carrierRoot), carrierBefore);
    } finally {
      await carrier.close();
    }
  });

  await t.test("canonical FIFO", async (t) => {
    const rootDir = await makeB5Root(t, "canonical-fifo");
    const plan = makeB5GoldenPlan();
    const layout = expectedB5Layout(plan);
    await writeB5Intent(rootDir, layout);
    const path = layout.artifactIntents[0].canonical_path;
    const absolutePath = join(rootDir, path);
    await mkdir(dirname(absolutePath), { recursive: true });
    const child = await runBoundedChild("/usr/bin/mkfifo", [absolutePath]);
    assert.equal(child.code, 0, child.stderr);
    assert.deepEqual(
      await stageCleaningRun(b5Options(rootDir, plan)),
      b5ExpectedFailure("RUN_CONFLICT", path)
    );
  });

  await t.test("canonical socket", async (t) => {
    const rootDir = await makeB5Root(t, "canonical-socket");
    const plan = makeB5GoldenPlan();
    const layout = expectedB5Layout(plan);
    await writeB5Intent(rootDir, layout);
    const path = layout.artifactIntents[0].canonical_path;
    const absolutePath = join(rootDir, path);
    await mkdir(dirname(absolutePath), { recursive: true });
    const carrier = await makeB5SocketCarrier(t, absolutePath);
    try {
      const before = await snapshotB5Tree(rootDir);
      const carrierBefore = await snapshotB5Tree(carrier.carrierRoot);
      assert.deepEqual(
        await stageCleaningRun(b5Options(rootDir, plan)),
        b5ExpectedFailure("RUN_CONFLICT", path)
      );
      assert.deepEqual(await snapshotB5Tree(rootDir), before);
      assert.deepEqual(await snapshotB5Tree(carrier.carrierRoot), carrierBefore);
    } finally {
      await carrier.close();
    }
  });

  await t.test("common ancestor symlink is LOCAL_STATE_INVALID", async (t) => {
    const rootDir = await makeB5Root(t, "ancestor-symlink");
    const outside = await makeB5Root(t, "ancestor-outside");
    await symlink(outside, join(rootDir, ".local"));
    const plan = makeB5GoldenPlan();
    const before = await snapshotB5Tree(rootDir);
    assert.deepEqual(
      await stageCleaningRun(b5Options(rootDir, plan)),
      b5ExpectedFailure("LOCAL_STATE_INVALID", ".local")
    );
    assert.deepEqual(await snapshotB5Tree(rootDir), before);
    assert.deepEqual(await snapshotB5Tree(outside), []);
  });
});

const B5_DIRECTORY_SYNC_IDENTITY_CHILD_SCRIPT = `
import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { join, relative, sep } from "node:path";

const [moduleUrl, rootDir, encodedPlan, targetPath, decoyPath] = process.argv.slice(1);
const serialized = JSON.parse(Buffer.from(encodedPlan, "base64").toString("utf8"));
const plan = {
  manifest: serialized.manifest,
  manifest_sha256: serialized.manifest_sha256,
  artifacts: serialized.artifacts.map((artifact) => ({
    ...artifact,
    bytes: Buffer.from(artifact.bytes, "base64")
  }))
};
const realRoot = fs.realpathSync(rootDir);
const targetAbsolute = join(realRoot, ...targetPath.split("/"));
const original = {
  open: fs.promises.open,
  lstat: fs.promises.lstat
};
let proofJustClosed = false;
let injected = false;
let provenInode = null;
let decoyOpenedInode = null;
let decoySyncCalled = false;
const syncedHandleInodes = [];

function isTarget(value) {
  return typeof value === "string" &&
    relative(realRoot, value).split(sep).join("/") === targetPath;
}

fs.promises.lstat = async (...args) => {
  proofJustClosed = false;
  return original.lstat(...args);
};
fs.promises.open = async (...args) => {
  if (!injected && proofJustClosed && isTarget(args[0])) {
    injected = true;
    proofJustClosed = false;
    const handle = await original.open(decoyPath, args[1]);
    decoyOpenedInode = (await handle.stat()).ino;
    return new Proxy(handle, {
      get(target, property) {
        if (property === "sync") {
          return async (...methodArgs) => {
            decoySyncCalled = true;
            syncedHandleInodes.push((await target.stat()).ino);
            return target.sync(...methodArgs);
          };
        }
        const value = Reflect.get(target, property, target);
        return typeof value === "function" ? value.bind(target) : value;
      }
    });
  }
  const handle = await original.open(...args);
  if (!isTarget(args[0])) return handle;
  let statObserved = false;
  return new Proxy(handle, {
    get(target, property) {
      if (property === "stat") {
        return async (...methodArgs) => {
          const value = await target.stat(...methodArgs);
          statObserved = true;
          provenInode = value.ino;
          return value;
        };
      }
      if (property === "close") {
        return async (...methodArgs) => {
          const value = await target.close(...methodArgs);
          if (statObserved) proofJustClosed = true;
          return value;
        };
      }
      if (property === "sync") {
        return async (...methodArgs) => {
          syncedHandleInodes.push((await target.stat()).ino);
          return target.sync(...methodArgs);
        };
      }
      const value = Reflect.get(target, property, target);
      return typeof value === "function" ? value.bind(target) : value;
    }
  });
};
syncBuiltinESMExports();

let result;
let thrown = null;
try {
  const { stageCleaningRun } = await import(moduleUrl);
  result = await stageCleaningRun({ rootDir, runsRoot: ".local/cleaned/runs", plan });
} catch (error) {
  thrown = { name: error?.name, code: error?.code, message: error?.message };
}
process.stdout.write(JSON.stringify({
  result,
  thrown,
  injected,
  decoy_sync_called: decoySyncCalled,
  proven_inode: provenInode,
  decoy_opened_inode: decoyOpenedInode,
  synced_handle_inodes: syncedHandleInodes,
  target_inode: (await original.lstat(targetAbsolute)).ino
}));
`;

async function runB5DirectorySyncIdentityChild(rootDir, plan, targetPath, decoyPath) {
  const child = await runBoundedChild(process.execPath, [
    "--input-type=module",
    "--eval",
    B5_DIRECTORY_SYNC_IDENTITY_CHILD_SCRIPT,
    B5_MODULE_URL,
    rootDir,
    encodeB5Plan(plan),
    targetPath,
    decoyPath
  ]);
  assert.equal(child.timedOut, false, child.stderr);
  assert.equal(child.code, 0, child.stderr);
  const observed = JSON.parse(child.stdout);
  assert.equal(observed.thrown, null, JSON.stringify(observed.thrown));
  return observed;
}

test("B5 exact completed second call verifies without claiming a persistent write", async (t) => {
  const stageCleaningRun = await loadStageCleaningRun();
  const rootDir = await makeB5Root(t, "second-call");
  const plan = makeB5GoldenPlan();
  const layout = expectedB5Layout(plan);
  assert.deepEqual(await stageCleaningRun(b5Options(rootDir, plan)), layout.success(true));
  const before = await snapshotB5Tree(rootDir);
  assert.deepEqual(await stageCleaningRun(b5Options(rootDir, plan)), layout.success(false));
  assert.deepEqual(await snapshotB5Tree(rootDir), before);

  await t.test("already-staged verification fsyncs staging and final-run roots", async () => {
    const observed = await runB5DurabilityGateChild(rootDir, plan);
    assert.deepEqual(observed.result, layout.success(false));
    assert.equal(observed.synced_paths.includes(layout.stagingPath), true);
    assert.equal(observed.synced_paths.includes(layout.finalRunPath), true);
  });

  await t.test("directory fsync rejects a decoy handle inode despite a stable pathname", async (t) => {
    const decoyRoot = await makeB5Root(t, "directory-sync-decoy");
    const observed = await runB5DirectorySyncIdentityChild(
      rootDir,
      plan,
      layout.stagingPath,
      decoyRoot
    );
    assert.equal(observed.proven_inode, observed.target_inode);
    if (observed.injected) {
      assert.notEqual(observed.decoy_opened_inode, observed.proven_inode);
      assert.equal(
        observed.decoy_sync_called,
        false,
        "the mismatched directory handle must be rejected before fsync"
      );
      assert.deepEqual(
        observed.result,
        b5ExpectedFailure("STAGING_CONFLICT", layout.stagingPath)
      );
    } else {
      assert.equal(observed.synced_handle_inodes.length > 0, true);
      assert.equal(
        observed.synced_handle_inodes.every((inode) => inode === observed.target_inode),
        true
      );
      assert.deepEqual(observed.result, layout.success(false));
    }
  });
});

const B5_TOPOLOGY_RACE_CHILD_SCRIPT = `
import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { dirname, join, relative, sep } from "node:path";

const [
  moduleUrl,
  rootDir,
  encodedPlan,
  raceKind,
  targetPath,
  intentPath,
  encodedIntentBytes,
  outsidePath
] = process.argv.slice(1);
const serialized = JSON.parse(Buffer.from(encodedPlan, "base64").toString("utf8"));
const plan = {
  manifest: serialized.manifest,
  manifest_sha256: serialized.manifest_sha256,
  artifacts: serialized.artifacts.map((artifact) => ({
    ...artifact,
    bytes: Buffer.from(artifact.bytes, "base64")
  }))
};
const intentBytes = Buffer.from(encodedIntentBytes, "base64");
const realRoot = fs.realpathSync(rootDir);
const targetAbsolute = join(realRoot, ...targetPath.split("/"));
const intentAbsolute = join(realRoot, ...intentPath.split("/"));
const original = {
  lstat: fs.promises.lstat,
  readdir: fs.promises.readdir,
  open: fs.promises.open,
  rename: fs.promises.rename,
  mkdir: fs.promises.mkdir,
  writeFile: fs.promises.writeFile,
  readFile: fs.promises.readFile
};
let targetLstatCalls = 0;
let unexpectedReaddirTriggered = false;
let rootReplaced = false;
let parentReaddirSeen = false;
let targetReaddirSeen = false;
let rootProofClosesAfterReaddir = 0;
let leafLstatSeenAfterReaddir = false;
let rootAfterGateTriggered = false;
let originalTargetInode = null;
let replacementTargetInode = null;

function repoPath(value) {
  if (typeof value !== "string") return null;
  return relative(realRoot, value).split(sep).join("/");
}
async function replaceTargetWithExactClone(kind, knownInode = null) {
  originalTargetInode = knownInode ?? (await original.lstat(targetAbsolute)).ino;
  await original.rename(targetAbsolute, outsidePath);
  await original.mkdir(targetAbsolute, { mode: 0o700 });
  if (kind === "nested") {
    const names = await original.readdir(outsidePath);
    for (const name of names) {
      const bytes = await original.readFile(join(outsidePath, name));
      await original.writeFile(join(targetAbsolute, name), bytes, { mode: 0o600 });
    }
  } else {
    await original.writeFile(intentAbsolute, intentBytes, { flag: "wx", mode: 0o600 });
  }
  replacementTargetInode = (await original.lstat(targetAbsolute)).ino;
  rootReplaced = true;
}
fs.promises.readdir = async (...args) => {
  if (raceKind === "unexpected-readdir" && repoPath(args[0]) === targetPath) {
    unexpectedReaddirTriggered = true;
    const error = new Error("unexpected directory must not be traversed");
    error.code = "EIO";
    throw error;
  }
  const value = await original.readdir(...args);
  const path = repoPath(args[0]);
  if (raceKind === "nested-dir-exact-clone" && path === repoPath(dirname(targetAbsolute))) {
    parentReaddirSeen = true;
  }
  if (raceKind === "scan-root-after-before-leaf" && path === targetPath) {
    targetReaddirSeen = true;
  }
  return value;
};
fs.promises.lstat = async (...args) => {
  if (raceKind === "nested-dir-exact-clone" && parentReaddirSeen && !rootReplaced &&
      repoPath(args[0]) === targetPath) {
    const value = await original.lstat(...args);
    await replaceTargetWithExactClone("nested", value.ino);
    return value;
  }
  if (raceKind === "scan-root-after-before-leaf" && targetReaddirSeen &&
      repoPath(args[0]) === intentPath) {
    leafLstatSeenAfterReaddir = true;
  }
  if (raceKind === "scan-root-replace" && repoPath(args[0]) === targetPath) {
    targetLstatCalls += 1;
    if (!rootReplaced && targetLstatCalls === 3) {
      await original.rename(targetAbsolute, outsidePath);
      await original.mkdir(targetAbsolute, { mode: 0o700 });
      await original.mkdir(dirname(intentAbsolute), { recursive: true, mode: 0o700 });
      await original.writeFile(intentAbsolute, intentBytes, { flag: "wx", mode: 0o600 });
      rootReplaced = true;
    }
  }
  return original.lstat(...args);
};
fs.promises.open = async (...args) => {
  const handle = await original.open(...args);
  if (raceKind !== "scan-root-after-before-leaf" || repoPath(args[0]) !== targetPath) {
    return handle;
  }
  let statObserved = false;
  return new Proxy(handle, {
    get(target, property) {
      if (property === "stat") {
        return async (...methodArgs) => {
          const value = await target.stat(...methodArgs);
          statObserved = true;
          return value;
        };
      }
      if (property === "close") {
        return async (...methodArgs) => {
          const value = await target.close(...methodArgs);
          if (statObserved && targetReaddirSeen && !rootReplaced) {
            rootProofClosesAfterReaddir += 1;
            if (leafLstatSeenAfterReaddir) {
              rootAfterGateTriggered = true;
              await replaceTargetWithExactClone("staging");
            }
          }
          return value;
        };
      }
      const value = Reflect.get(target, property, target);
      return typeof value === "function" ? value.bind(target) : value;
    }
  });
};
syncBuiltinESMExports();

let result;
let thrown = null;
try {
  const { stageCleaningRun } = await import(moduleUrl);
  result = await stageCleaningRun({ rootDir, runsRoot: ".local/cleaned/runs", plan });
} catch (error) {
  thrown = { name: error?.name, code: error?.code, message: error?.message };
}
process.stdout.write(JSON.stringify({
  result,
  thrown,
  target_lstat_calls: targetLstatCalls,
  unexpected_readdir_triggered: unexpectedReaddirTriggered,
  root_replaced: rootReplaced,
  root_proof_closes_after_readdir: rootProofClosesAfterReaddir,
  root_after_gate_triggered: rootAfterGateTriggered,
  original_target_inode: originalTargetInode,
  replacement_target_inode: replacementTargetInode
}));
`;

async function runB5TopologyRaceChild(
  rootDir,
  plan,
  raceKind,
  targetPath,
  layout,
  outsidePath
) {
  const child = await runBoundedChild(process.execPath, [
    "--input-type=module",
    "--eval",
    B5_TOPOLOGY_RACE_CHILD_SCRIPT,
    B5_MODULE_URL,
    rootDir,
    encodeB5Plan(plan),
    raceKind,
    targetPath,
    layout.intentPath,
    layout.intentBytes.toString("base64"),
    outsidePath
  ]);
  assert.equal(child.timedOut, false, child.stderr);
  assert.equal(child.code, 0, child.stderr);
  const observed = JSON.parse(child.stdout);
  assert.equal(observed.thrown, null, JSON.stringify(observed.thrown));
  return observed;
}

test("B5 conflict ordering reports staging before final and ASCII-first exact paths", async (t) => {
  const stageCleaningRun = await loadStageCleaningRun();

  await t.test("staging subtree outranks final subtree", async (t) => {
    const rootDir = await makeB5Root(t, "ordering-subtrees");
    const plan = makeB5GoldenPlan();
    const layout = expectedB5Layout(plan);
    const stagingPath = `${layout.stagingPath}/unexpected`;
    await writeB5Path(rootDir, stagingPath, Buffer.from("staging"));
    await writeB5Path(rootDir, `${layout.finalRunPath}/unexpected`, Buffer.from("run"));
    assert.deepEqual(
      await stageCleaningRun(b5Options(rootDir, plan)),
      b5ExpectedFailure("STAGING_CONFLICT", stagingPath)
    );
  });

  await t.test("ASCII-first staging entry fixes exact error path", async (t) => {
    const rootDir = await makeB5Root(t, "ordering-staging-ascii");
    const plan = makeB5GoldenPlan();
    const layout = expectedB5Layout(plan);
    await writeB5Path(rootDir, `${layout.stagingPath}/zzz`, Buffer.from("z"));
    await writeB5Path(rootDir, `${layout.stagingPath}/aaa`, Buffer.from("a"));
    assert.deepEqual(
      await stageCleaningRun(b5Options(rootDir, plan)),
      b5ExpectedFailure("STAGING_CONFLICT", `${layout.stagingPath}/aaa`)
    );
  });

  await t.test("malformed intent outranks a later unexpected staging entry", async (t) => {
    const rootDir = await makeB5Root(t, "ordering-staging-content-before-extra");
    const plan = makeB5GoldenPlan();
    const layout = expectedB5Layout(plan);
    const laterPath = `${layout.stagingPath}/zzz`;
    await writeB5Intent(rootDir, layout, Buffer.from("{"));
    await writeB5Path(rootDir, laterPath, Buffer.from("later staging conflict"));
    const before = await snapshotB5Tree(rootDir);
    assert.equal(layout.intentPath < laterPath, true);
    assert.deepEqual(
      await stageCleaningRun(b5Options(rootDir, plan)),
      b5ExpectedFailure("STAGING_CONFLICT", layout.intentPath)
    );
    assert.deepEqual(await snapshotB5Tree(rootDir), before);
  });

  await t.test("ASCII-first final entry fixes exact error path and null source", async (t) => {
    const rootDir = await makeB5Root(t, "ordering-final-ascii");
    const plan = makeB5GoldenPlan();
    const layout = expectedB5Layout(plan);
    await writeB5Intent(rootDir, layout);
    await writeB5Path(rootDir, `${layout.finalRunPath}/zzz`, Buffer.from("z"));
    await writeB5Path(rootDir, `${layout.finalRunPath}/aaa`, Buffer.from("a"));
    assert.deepEqual(
      await stageCleaningRun(b5Options(rootDir, plan)),
      b5ExpectedFailure("RUN_CONFLICT", `${layout.finalRunPath}/aaa`)
    );
  });

  await t.test("malformed canonical outranks a later unexpected final entry", async (t) => {
    const rootDir = await makeB5Root(t, "ordering-final-content-before-extra");
    const plan = makeB5GoldenPlan();
    const layout = expectedB5Layout(plan);
    const canonical = layout.artifactIntents[0];
    const laterPath = `${layout.finalRunPath}/zzz`;
    await writeB5Intent(rootDir, layout);
    await writeB5Path(
      rootDir,
      canonical.canonical_path,
      Buffer.alloc(canonical.size_bytes, 0x78)
    );
    await writeB5Path(rootDir, laterPath, Buffer.from("later final conflict"));
    const before = await snapshotB5Tree(rootDir);
    assert.equal(canonical.canonical_path < laterPath, true);
    assert.deepEqual(
      await stageCleaningRun(b5Options(rootDir, plan)),
      b5ExpectedFailure("RUN_CONFLICT", canonical.canonical_path)
    );
    assert.deepEqual(await snapshotB5Tree(rootDir), before);
  });

  await t.test("ASCII-first conflict compares complete nested and root paths", async (t) => {
    const rootDir = await makeB5Root(t, "ordering-final-global-ascii");
    const plan = makeB5GoldenPlan();
    const layout = expectedB5Layout(plan);
    await writeB5Intent(rootDir, layout);
    const nestedPath = `${layout.finalRunPath}/catalog/z`;
    const rootPath = `${layout.finalRunPath}/catalog.a`;
    await writeB5Path(rootDir, nestedPath, Buffer.from("nested"));
    await writeB5Path(rootDir, rootPath, Buffer.from("root"));
    assert.equal(rootPath < nestedPath, true);
    assert.deepEqual(
      await stageCleaningRun(b5Options(rootDir, plan)),
      b5ExpectedFailure("RUN_CONFLICT", rootPath)
    );
  });

  await t.test("unexpected staging directory conflicts without recursive traversal", async (t) => {
    const rootDir = await makeB5Root(t, "ordering-unexpected-no-recurse");
    const outsideRoot = await makeB5Root(t, "ordering-unexpected-no-recurse-outside");
    const plan = makeB5GoldenPlan();
    const layout = expectedB5Layout(plan);
    const unexpectedPath = `${layout.stagingPath}/unexpected`;
    await mkdir(join(rootDir, unexpectedPath), { recursive: true });
    const before = await snapshotB5Tree(rootDir);
    const observed = await runB5TopologyRaceChild(
      rootDir,
      plan,
      "unexpected-readdir",
      unexpectedPath,
      layout,
      join(outsideRoot, "unused")
    );
    assert.equal(observed.unexpected_readdir_triggered, false);
    assert.deepEqual(
      observed.result,
      b5ExpectedFailure("STAGING_CONFLICT", unexpectedPath)
    );
    assert.deepEqual(await snapshotB5Tree(rootDir), before);
  });

  await t.test("planned nested directory identity remains bound from lstat through recursion", async (t) => {
    const rootDir = await makeB5Root(t, "ordering-nested-directory-clone");
    const outsideRoot = await makeB5Root(t, "ordering-nested-directory-clone-outside");
    const plan = makeB5GoldenPlan();
    const layout = expectedB5Layout(plan);
    await writeB5Intent(rootDir, layout);
    await materializeB5Final(rootDir, plan, layout);
    const catalogPath = `${layout.finalRunPath}/catalog`;
    const observed = await runB5TopologyRaceChild(
      rootDir,
      plan,
      "nested-dir-exact-clone",
      catalogPath,
      layout,
      join(outsideRoot, "displaced-catalog")
    );
    assert.equal(observed.root_replaced, true);
    assert.notEqual(observed.original_target_inode, observed.replacement_target_inode);
    assert.deepEqual(
      observed.result,
      b5ExpectedFailure("RUN_CONFLICT", catalogPath)
    );
  });

  await t.test("scan root remains bound after root proof and before leaf validation", async (t) => {
    const rootDir = await makeB5Root(t, "ordering-root-after-before-leaf");
    const outsideRoot = await makeB5Root(t, "ordering-root-after-before-leaf-outside");
    const plan = makeB5GoldenPlan();
    const layout = expectedB5Layout(plan);
    await writeB5Intent(rootDir, layout);
    await materializeB5Final(rootDir, plan, layout);
    const observed = await runB5TopologyRaceChild(
      rootDir,
      plan,
      "scan-root-after-before-leaf",
      layout.stagingPath,
      layout,
      join(outsideRoot, "displaced-staging")
    );
    assert.equal(observed.root_replaced, true);
    assert.equal(observed.root_after_gate_triggered, true);
    assert.notEqual(observed.original_target_inode, observed.replacement_target_inode);
    assert.deepEqual(
      observed.result,
      b5ExpectedFailure("STAGING_CONFLICT", layout.stagingPath)
    );
  });

  await t.test("staging scan root identity is bound across the nested walk", async (t) => {
    const rootDir = await makeB5Root(t, "ordering-scan-root-replace");
    const outsideRoot = await makeB5Root(t, "ordering-scan-root-replace-outside");
    const plan = makeB5GoldenPlan();
    const layout = expectedB5Layout(plan);
    await mkdir(join(rootDir, layout.stagingPath), { recursive: true });
    const observed = await runB5TopologyRaceChild(
      rootDir,
      plan,
      "scan-root-replace",
      layout.stagingPath,
      layout,
      join(outsideRoot, "displaced-staging")
    );
    assert.equal(observed.root_replaced, true);
    assert.equal(observed.target_lstat_calls >= 3, true);
    assert.deepEqual(
      observed.result,
      b5ExpectedFailure("STAGING_CONFLICT", layout.stagingPath)
    );
  });
});

const B5_IO_FAILURE_CHILD_SCRIPT = `
import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { relative, sep } from "node:path";

const [moduleUrl, rootDir, encodedPlan, primaryOperation, targetPath, closeAlsoText] =
  process.argv.slice(1);
const serialized = JSON.parse(Buffer.from(encodedPlan, "base64").toString("utf8"));
const plan = {
  manifest: serialized.manifest,
  manifest_sha256: serialized.manifest_sha256,
  artifacts: serialized.artifacts.map((artifact) => ({
    ...artifact,
    bytes: Buffer.from(artifact.bytes, "base64")
  }))
};
const closeAlso = closeAlsoText === "true";
const realRoot = fs.realpathSync(rootDir);
const original = {
  realpathSync: fs.realpathSync,
  realpath: fs.promises.realpath,
  lstat: fs.promises.lstat,
  readdir: fs.promises.readdir,
  mkdir: fs.promises.mkdir,
  open: fs.promises.open,
  readFile: fs.promises.readFile,
  link: fs.promises.link,
  unlink: fs.promises.unlink
};
let primaryTriggered = false;
let closeTriggered = false;

function repoPath(value) {
  if (typeof value !== "string") return null;
  const rel = relative(realRoot, value);
  return rel === "" ? "." : rel.split(sep).join("/");
}
function isTarget(value) {
  if (targetPath === "@root") {
    return value === rootDir || value === realRoot;
  }
  return repoPath(value) === targetPath;
}
function injectedError(operation) {
  const error = new Error("injected " + operation + " failure");
  error.code = "EIO";
  return error;
}
function failPrimary(operation, value) {
  if (!primaryTriggered && primaryOperation === operation && isTarget(value)) {
    primaryTriggered = true;
    throw injectedError(operation);
  }
}

fs.realpathSync = (...args) => {
  failPrimary("realpath", args[0]);
  return original.realpathSync(...args);
};
fs.promises.realpath = async (...args) => {
  failPrimary("realpath", args[0]);
  return original.realpath(...args);
};
for (const operation of ["lstat", "readdir", "mkdir", "unlink"]) {
  fs.promises[operation] = async (...args) => {
    failPrimary(operation, args[0]);
    return original[operation](...args);
  };
}
fs.promises.link = async (...args) => {
  failPrimary("link", args[1]);
  return original.link(...args);
};
fs.promises.readFile = async (...args) => {
  failPrimary("read", args[0]);
  return original.readFile(...args);
};
fs.promises.open = async (...args) => {
  failPrimary("open", args[0]);
  const openedPath = args[0];
  const handle = await original.open(...args);
  return new Proxy(handle, {
    get(target, property) {
      if (property === "stat") {
        return async (...methodArgs) => {
          failPrimary("fstat", openedPath);
          return target.stat(...methodArgs);
        };
      }
      if (property === "read" || property === "readFile") {
        return async (...methodArgs) => {
          failPrimary("read", openedPath);
          return target[property](...methodArgs);
        };
      }
      if (property === "write" || property === "writeFile" || property === "writev") {
        return async (...methodArgs) => {
          failPrimary("write", openedPath);
          return target[property](...methodArgs);
        };
      }
      if (property === "sync") {
        return async (...methodArgs) => {
          failPrimary("fsync", openedPath);
          return target.sync(...methodArgs);
        };
      }
      if (property === "close") {
        return async (...methodArgs) => {
          const value = await target.close(...methodArgs);
          if ((primaryOperation === "close" || closeAlso) && isTarget(openedPath)) {
            closeTriggered = true;
            if (primaryOperation === "close") primaryTriggered = true;
            throw injectedError("close");
          }
          return value;
        };
      }
      const value = Reflect.get(target, property, target);
      return typeof value === "function" ? value.bind(target) : value;
    }
  });
};
syncBuiltinESMExports();

let result;
let thrown = null;
try {
  const { stageCleaningRun } = await import(moduleUrl);
  result = await stageCleaningRun({ rootDir, runsRoot: ".local/cleaned/runs", plan });
} catch (error) {
  thrown = { name: error?.name, code: error?.code, message: error?.message };
}
process.stdout.write(JSON.stringify({ result, thrown, primaryTriggered, closeTriggered }));
`;

async function runB5IoFailureChild(rootDir, plan, operation, targetPath, closeAlso = false) {
  const child = await runBoundedChild(process.execPath, [
    "--input-type=module",
    "--eval",
    B5_IO_FAILURE_CHILD_SCRIPT,
    B5_MODULE_URL,
    rootDir,
    encodeB5Plan(plan),
    operation,
    targetPath,
    String(closeAlso)
  ]);
  assert.equal(child.timedOut, false, child.stderr);
  assert.equal(child.code, 0, child.stderr);
  const observed = JSON.parse(child.stdout);
  assert.equal(observed.thrown, null, JSON.stringify(observed.thrown));
  assert.equal(observed.primaryTriggered, true, `${operation} injection did not trigger`);
  return observed;
}

test("B5 injected I/O failures preserve exact operation, path, sticky write flag, and close precedence", async (t) => {
  await loadStageCleaningRun();
  const scenarios = [
    ["root realpath before mutation", "realpath", "@root", "none", null, false],
    ["ancestor lstat before mutation", "lstat", ".local", "none", ".local", false],
    ["staging readdir before mutation", "readdir", "staging", "empty-staging", "staging", false],
    ["first mkdir before mutation", "mkdir", ".local", "none", ".local", false],
    ["later mkdir after parent creation", "mkdir", "staging", "none", "staging", true],
    ["candidate open after directory creation", "open", "candidate", "none", "candidate", true],
    ["candidate fstat after create", "fstat", "candidate", "none", "candidate", true],
    ["candidate write after create", "write", "candidate", "none", "candidate", true],
    ["candidate fsync after create", "fsync", "candidate", "none", "candidate", true],
    ["intent link after candidate durability", "link", "intent", "none", "intent", true],
    ["candidate unlink after intent publication", "unlink", "candidate", "none", "candidate", true],
    ["intent read before mutation", "read", "intent", "complete", "intent", false],
    ["intent close before mutation", "close", "intent", "complete", "intent", false]
  ];

  for (const [label, operation, targetToken, fixture, expectedPathToken, sticky] of scenarios) {
    await t.test(label, async (t) => {
      const rootDir = await makeB5Root(t, `io-${operation}-${label.replaceAll(" ", "-")}`);
      const plan = makeB5GoldenPlan();
      const layout = expectedB5Layout(plan);
      if (fixture === "empty-staging") {
        await mkdir(join(rootDir, layout.stagingPath), { recursive: true });
      } else if (fixture === "complete") {
        await writeB5Intent(rootDir, layout);
        await materializeB5Final(rootDir, plan, layout);
      }
      const tokenMap = {
        staging: layout.stagingPath,
        candidate: layout.intentCandidatePath,
        intent: layout.intentPath
      };
      const targetPath = tokenMap[targetToken] ?? targetToken;
      const expectedPath = expectedPathToken === null
        ? null
        : tokenMap[expectedPathToken] ?? expectedPathToken;
      const observed = await runB5IoFailureChild(
        rootDir,
        plan,
        operation,
        targetPath
      );
      assert.deepEqual(observed.result, b5IoFailure(operation, expectedPath, sticky));
    });
  }

  await t.test("primary read failure wins over cleanup close failure", async (t) => {
    const rootDir = await makeB5Root(t, "io-close-precedence");
    const plan = makeB5GoldenPlan();
    const layout = expectedB5Layout(plan);
    await writeB5Intent(rootDir, layout);
    await materializeB5Final(rootDir, plan, layout);
    const observed = await runB5IoFailureChild(
      rootDir,
      plan,
      "read",
      layout.intentPath,
      true
    );
    assert.equal(observed.closeTriggered, true);
    assert.deepEqual(observed.result, b5IoFailure("read", layout.intentPath, false));
  });

  await t.test("candidate open failure leaves only the staging directory chain", async (t) => {
    const rootDir = await makeB5Root(t, "io-candidate-open-topology");
    const plan = makeB5GoldenPlan();
    const layout = expectedB5Layout(plan);
    const observed = await runB5IoFailureChild(
      rootDir,
      plan,
      "open",
      layout.intentCandidatePath
    );
    assert.deepEqual(
      observed.result,
      b5IoFailure("open", layout.intentCandidatePath, true)
    );
    assert.deepEqual(await snapshotB5Tree(rootDir), [
      [".local", "directory"],
      [".local/tmp", "directory"],
      [layout.stagingPath, "directory"]
    ]);
  });

  for (const [operation, sticky] of [
    ["lstat", false],
    ["open", false],
    ["fstat", false],
    ["fsync", true],
    ["close", false]
  ]) {
    await t.test(`repo-root ${operation} failure exposes a null path`, async (t) => {
      const rootDir = await makeB5Root(t, `io-root-${operation}-null-path`);
      const plan = makeB5GoldenPlan();
      const observed = await runB5IoFailureChild(
        rootDir,
        plan,
        operation,
        "@root"
      );
      assert.deepEqual(observed.result, b5IoFailure(operation, null, sticky));
    });
  }
});

const B5_CRASH_CHILD_SCRIPT = `
import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { dirname, relative, sep } from "node:path";

const [
  moduleUrl,
  rootDir,
  encodedPlan,
  crashPoint,
  stagingPath,
  intentPath,
  intentCandidatePath,
  finalRunPath
] = process.argv.slice(1);
const serialized = JSON.parse(Buffer.from(encodedPlan, "base64").toString("utf8"));
const plan = {
  manifest: serialized.manifest,
  manifest_sha256: serialized.manifest_sha256,
  artifacts: serialized.artifacts.map((artifact) => ({
    ...artifact,
    bytes: Buffer.from(artifact.bytes, "base64")
  }))
};
const realRoot = fs.realpathSync(rootDir);
const original = {
  mkdir: fs.promises.mkdir,
  open: fs.promises.open,
  link: fs.promises.link,
  unlink: fs.promises.unlink,
  readdir: fs.promises.readdir
};
const canonicalPaths = plan.artifacts.map((artifact) =>
  finalRunPath + "/" + artifact.relative_path);
const tempPaths = plan.artifacts.map((artifact) =>
  finalRunPath + "/" + artifact.relative_path + ".tmp-" + artifact.sha256 + ".partial");
const canonicalParentsAwaitingSync = new Set();
let intentCandidateSyncedThisCall = false;

function repoPath(value) {
  if (typeof value !== "string") return null;
  const rel = relative(realRoot, value);
  return rel === "" ? "." : rel.split(sep).join("/");
}
function crash() {
  process.exit(91);
}
function isArtifactTemp(path) {
  return tempPaths.includes(path);
}
function finalTreeHasOnlyCanonicals() {
  return canonicalPaths.every((path) => fs.existsSync(realRoot + sep + path.split("/").join(sep))) &&
    tempPaths.every((path) => !fs.existsSync(realRoot + sep + path.split("/").join(sep)));
}

fs.promises.mkdir = async (...args) => {
  const value = await original.mkdir(...args);
  if (crashPoint === "directory-creation" && repoPath(args[0]) === stagingPath) crash();
  return value;
};
fs.promises.link = async (...args) => {
  const value = await original.link(...args);
  const destination = repoPath(args[1]);
  if (destination === intentPath && crashPoint === "intent-link") crash();
  if (destination === intentPath && crashPoint === "intent-link-after-source-resync") {
    if (!intentCandidateSyncedThisCall) process.exit(93);
    crash();
  }
  if (canonicalPaths.includes(destination)) {
    canonicalParentsAwaitingSync.add(dirname(destination).split(sep).join("/"));
    if (crashPoint === "canonical-link") crash();
  }
  return value;
};
fs.promises.unlink = async (...args) => {
  const value = await original.unlink(...args);
  const path = repoPath(args[0]);
  if (path === intentCandidatePath && crashPoint === "intent-cleanup") crash();
  if (isArtifactTemp(path) && crashPoint === "artifact-cleanup") crash();
  return value;
};
fs.promises.readdir = async (...args) => {
  const value = await original.readdir(...args);
  if (crashPoint === "final-verification" && repoPath(args[0]) === finalRunPath &&
      finalTreeHasOnlyCanonicals()) crash();
  return value;
};
fs.promises.open = async (...args) => {
  const openedPath = repoPath(args[0]);
  const handle = await original.open(...args);
  return new Proxy(handle, {
    get(target, property) {
      if (property === "write" || property === "writeFile" || property === "writev") {
        return async (...methodArgs) => {
          const value = await target[property](...methodArgs);
          if (openedPath === intentCandidatePath && crashPoint === "intent-write") crash();
          return value;
        };
      }
      if (property === "sync") {
        return async (...methodArgs) => {
          const value = await target.sync(...methodArgs);
          if (openedPath === intentCandidatePath) intentCandidateSyncedThisCall = true;
          if (openedPath === intentCandidatePath && crashPoint === "intent-sync") crash();
          if (openedPath === stagingPath && crashPoint === "intent-dir-sync" &&
              fs.existsSync(realRoot + sep + intentPath.split("/").join(sep))) crash();
          if (isArtifactTemp(openedPath) && crashPoint === "artifact-sync") crash();
          if (crashPoint === "canonical-parent-sync" &&
              canonicalParentsAwaitingSync.has(openedPath)) crash();
          return value;
        };
      }
      const value = Reflect.get(target, property, target);
      return typeof value === "function" ? value.bind(target) : value;
    }
  });
};
syncBuiltinESMExports();

const { stageCleaningRun } = await import(moduleUrl);
await stageCleaningRun({ rootDir, runsRoot: ".local/cleaned/runs", plan });
process.stderr.write("crash point was not reached: " + crashPoint);
process.exit(92);
`;

async function runB5CrashChild(rootDir, plan, layout, crashPoint) {
  return runBoundedChild(process.execPath, [
    "--input-type=module",
    "--eval",
    B5_CRASH_CHILD_SCRIPT,
    B5_MODULE_URL,
    rootDir,
    encodeB5Plan(plan),
    crashPoint,
    layout.stagingPath,
    layout.intentPath,
    layout.intentCandidatePath,
    layout.finalRunPath
  ]);
}

test("B5 real child-process crashes resume every durable ordinary, adoption, artifact, and verification boundary", async (t) => {
  const stageCleaningRun = await loadStageCleaningRun();
  const scenarios = [
    ["directory creation", "directory-creation", "none", true],
    ["ordinary intent candidate sync", "intent-sync", "candidate-prefix", true],
    ["ordinary intent link", "intent-link", "candidate-full", true],
    ["ordinary intent directory sync", "intent-dir-sync", "candidate-full", true],
    ["ordinary intent candidate cleanup", "intent-cleanup", "candidate-full", true],
    ["adoption intent candidate write", "intent-write", "adoption-empty", true],
    ["adoption intent candidate sync", "intent-sync", "adoption-prefix", true],
    ["adoption intent link", "intent-link", "adoption-full", true],
    ["adoption intent directory sync", "intent-dir-sync", "adoption-full", true],
    ["adoption intent candidate cleanup", "intent-cleanup", "adoption-full", false],
    ["artifact temp sync", "artifact-sync", "intent-only", true],
    ["canonical link", "canonical-link", "full-temps", true],
    ["canonical parent sync", "canonical-parent-sync", "full-temps", true],
    ["artifact temp cleanup", "artifact-cleanup", "full-temps", true],
    ["final verification", "final-verification", "full-temps", false]
  ];

  for (const [label, crashPoint, fixture, retryWrites] of scenarios) {
    await t.test(label, async (t) => {
      const rootDir = await makeB5Root(t, `crash-${label.replaceAll(" ", "-")}`);
      const plan = makeB5GoldenPlan();
      const layout = expectedB5Layout(plan);
      if (fixture === "candidate-prefix") {
        await writeB5Prefix(
          rootDir,
          layout.intentCandidatePath,
          layout.intentBytes,
          Math.max(1, layout.intentBytes.length - 1)
        );
      } else if (fixture === "candidate-full") {
        await writeB5Path(rootDir, layout.intentCandidatePath, layout.intentBytes);
      } else if (fixture.startsWith("adoption-")) {
        await materializeB5Final(rootDir, plan, layout);
        const candidateState = fixture.slice("adoption-".length);
        const length = candidateState === "empty"
          ? 0
          : candidateState === "prefix"
            ? Math.max(1, layout.intentBytes.length - 1)
            : layout.intentBytes.length;
        await writeB5Prefix(rootDir, layout.intentCandidatePath, layout.intentBytes, length);
      } else if (fixture === "intent-only") {
        await writeB5Intent(rootDir, layout);
      } else if (fixture === "full-temps") {
        await writeB5Intent(rootDir, layout);
        await materializeB5Temps(rootDir, plan, layout);
      }

      const child = await runB5CrashChild(rootDir, plan, layout, crashPoint);
      assert.equal(child.timedOut, false, child.stderr);
      assert.equal(child.signal, null, child.stderr);
      assert.equal(child.code, 91, child.stderr);

      assert.deepEqual(
        await stageCleaningRun(b5Options(rootDir, plan)),
        layout.success(retryWrites)
      );
      assert.deepEqual(await readFile(join(rootDir, layout.intentPath)), layout.intentBytes);
      await assert.rejects(() => lstat(join(rootDir, layout.intentCandidatePath)), { code: "ENOENT" });
      for (const artifact of layout.artifactIntents) {
        assert.deepEqual(
          await readFile(join(rootDir, artifact.canonical_path)),
          b5ArtifactBytes(plan, artifact.relative_path)
        );
        await assert.rejects(() => lstat(join(rootDir, artifact.temp_path)), { code: "ENOENT" });
      }
      const stable = await snapshotB5Tree(rootDir);
      assert.deepEqual(
        await stageCleaningRun(b5Options(rootDir, plan)),
        layout.success(false)
      );
      assert.deepEqual(await snapshotB5Tree(rootDir), stable);
    });
  }

  await t.test("repeated crashes resync a full adoption candidate before the post-link crash", async (t) => {
    const rootDir = await makeB5Root(t, "crash-repeated-intent-resync");
    const plan = makeB5GoldenPlan();
    const layout = expectedB5Layout(plan);
    await materializeB5Final(rootDir, plan, layout);

    const first = await runB5CrashChild(rootDir, plan, layout, "intent-write");
    assert.equal(first.timedOut, false, first.stderr);
    assert.equal(first.signal, null, first.stderr);
    assert.equal(first.code, 91, first.stderr);
    assert.deepEqual(
      await readFile(join(rootDir, layout.intentCandidatePath)),
      layout.intentBytes
    );

    const second = await runB5CrashChild(
      rootDir,
      plan,
      layout,
      "intent-link-after-source-resync"
    );
    assert.equal(second.timedOut, false, second.stderr);
    assert.equal(second.signal, null, second.stderr);

    assert.deepEqual(
      await stageCleaningRun(b5Options(rootDir, plan)),
      layout.success(true)
    );
    assert.equal(second.code, 91, second.stderr);
    assert.deepEqual(await readFile(join(rootDir, layout.intentPath)), layout.intentBytes);
    await assert.rejects(
      () => lstat(join(rootDir, layout.intentCandidatePath)),
      { code: "ENOENT" }
    );
  });
});

const B5_IDENTITY_RACE_CHILD_SCRIPT = `
import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { basename, dirname, join, relative, sep } from "node:path";

const [
  moduleUrl,
  rootDir,
  encodedPlan,
  raceKind,
  targetPath,
  parentPath,
  outsidePath
] = process.argv.slice(1);
const serialized = JSON.parse(Buffer.from(encodedPlan, "base64").toString("utf8"));
const plan = {
  manifest: serialized.manifest,
  manifest_sha256: serialized.manifest_sha256,
  artifacts: serialized.artifacts.map((artifact) => ({
    ...artifact,
    bytes: Buffer.from(artifact.bytes, "base64")
  }))
};
const realRoot = fs.realpathSync(rootDir);
const targetAbsolute = join(realRoot, ...targetPath.split("/"));
const parentAbsolute = join(realRoot, ...parentPath.split("/"));
const originalOpen = fs.promises.open;
let swapped = false;

function repoPath(value) {
  if (typeof value !== "string") return null;
  return relative(realRoot, value).split(sep).join("/");
}
fs.promises.open = async (...args) => {
  if (!swapped && repoPath(args[0]) === targetPath) {
    swapped = true;
    if (raceKind === "leaf") {
      await fs.promises.unlink(targetAbsolute);
      await fs.promises.symlink(outsidePath, targetAbsolute);
    } else {
      const bytes = await fs.promises.readFile(targetAbsolute);
      const displaced = parentAbsolute + ".identity-displaced";
      await fs.promises.rename(parentAbsolute, displaced);
      await fs.promises.mkdir(parentAbsolute, { mode: 0o700 });
      await fs.promises.writeFile(
        join(parentAbsolute, basename(targetAbsolute)),
        bytes,
        { mode: 0o600 }
      );
    }
  }
  return originalOpen(...args);
};
syncBuiltinESMExports();

let result;
let thrown = null;
try {
  const { stageCleaningRun } = await import(moduleUrl);
  result = await stageCleaningRun({ rootDir, runsRoot: ".local/cleaned/runs", plan });
} catch (error) {
  thrown = { name: error?.name, code: error?.code, message: error?.message };
}
process.stdout.write(JSON.stringify({ result, thrown, swapped }));
`;

async function runB5IdentityRaceChild(
  rootDir,
  plan,
  raceKind,
  targetPath,
  parentPath,
  outsidePath
) {
  const child = await runBoundedChild(process.execPath, [
    "--input-type=module",
    "--eval",
    B5_IDENTITY_RACE_CHILD_SCRIPT,
    B5_MODULE_URL,
    rootDir,
    encodeB5Plan(plan),
    raceKind,
    targetPath,
    parentPath,
    outsidePath
  ]);
  assert.equal(child.timedOut, false, child.stderr);
  assert.equal(child.code, 0, child.stderr);
  const observed = JSON.parse(child.stdout);
  assert.equal(observed.thrown, null, JSON.stringify(observed.thrown));
  assert.equal(observed.swapped, true, `${raceKind} identity replacement did not trigger`);
  return observed.result;
}

const B5_CHILD_OPERATION_IDENTITY_CHILD_SCRIPT = `
import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { join, relative, sep } from "node:path";

const [
  moduleUrl,
  rootDir,
  encodedPlan,
  raceKind,
  targetPath,
  parentPath,
  encodedExactBytes,
  outsidePath
] = process.argv.slice(1);
const serialized = JSON.parse(Buffer.from(encodedPlan, "base64").toString("utf8"));
const plan = {
  manifest: serialized.manifest,
  manifest_sha256: serialized.manifest_sha256,
  artifacts: serialized.artifacts.map((artifact) => ({
    ...artifact,
    bytes: Buffer.from(artifact.bytes, "base64")
  }))
};
const exactBytes = Buffer.from(encodedExactBytes, "base64");
const realRoot = fs.realpathSync(rootDir);
const targetAbsolute = join(realRoot, ...targetPath.split("/"));
const parentAbsolute = join(realRoot, ...parentPath.split("/"));
const original = {
  open: fs.promises.open,
  link: fs.promises.link,
  unlink: fs.promises.unlink,
  rename: fs.promises.rename,
  mkdir: fs.promises.mkdir,
  writeFile: fs.promises.writeFile,
  lstat: fs.promises.lstat
};
let swapped = false;
let createdInode = null;
let provenSourceInode = null;
let replacementInode = null;
let originalParentInode = null;
let replacementParentInode = null;
let replacementLeafAbsent = null;
let originalLeafInode = null;
let linkedDestinationInode = null;
let linkPublished = false;
let linkPublicationSyncObserved = false;

function repoPath(value) {
  if (typeof value !== "string") return null;
  return relative(realRoot, value).split(sep).join("/");
}
async function replaceExactLeaf(path, backupPath) {
  await original.rename(path, backupPath);
  await original.unlink(backupPath);
  await original.writeFile(path, exactBytes, { flag: "wx", mode: 0o600 });
  replacementInode = (await original.lstat(path)).ino;
}
async function replaceExactLeafKeepingOriginal() {
  originalLeafInode = (await original.lstat(targetAbsolute)).ino;
  await original.link(targetAbsolute, outsidePath);
  await original.unlink(targetAbsolute);
  await original.writeFile(targetAbsolute, exactBytes, { flag: "wx", mode: 0o600 });
  replacementInode = (await original.lstat(targetAbsolute)).ino;
  swapped = true;
}

fs.promises.open = async (...args) => {
  const handle = await original.open(...args);
  if (!swapped && raceKind === "create" && repoPath(args[0]) === targetPath &&
      (args[1] & fs.constants.O_CREAT) !== 0) {
    createdInode = (await handle.stat()).ino;
    await original.link(targetAbsolute, outsidePath);
    await replaceExactLeaf(targetAbsolute, targetAbsolute + ".created-handle");
    swapped = true;
  }
  if ((raceKind === "unlink-leaf-sync" || raceKind === "linked-cleanup-sync") &&
      repoPath(args[0]) === parentPath) {
    return new Proxy(handle, {
      get(target, property) {
        if (property === "sync") {
          return async (...methodArgs) => {
            if (raceKind === "unlink-leaf-sync" && !swapped) {
              await replaceExactLeafKeepingOriginal();
            } else if (raceKind === "linked-cleanup-sync" && linkPublished && !swapped) {
              const sourceStillPresent = fs.existsSync(targetAbsolute);
              if (!linkPublicationSyncObserved) {
                linkPublicationSyncObserved = true;
              } else if (sourceStillPresent) {
                await replaceExactLeafKeepingOriginal();
              }
            }
            return target.sync(...methodArgs);
          };
        }
        const value = Reflect.get(target, property, target);
        return typeof value === "function" ? value.bind(target) : value;
      }
    });
  }
  return handle;
};
fs.promises.link = async (...args) => {
  if (!swapped && raceKind === "link" && repoPath(args[0]) === targetPath) {
    provenSourceInode = (await original.lstat(args[0])).ino;
    await replaceExactLeaf(args[0], args[0] + ".proven-source");
    swapped = true;
  }
  const value = await original.link(...args);
  if (raceKind === "linked-cleanup-sync" && repoPath(args[0]) === targetPath) {
    linkPublished = true;
    linkedDestinationInode = (await original.lstat(args[1])).ino;
  }
  return value;
};
fs.promises.unlink = async (...args) => {
  if (!swapped && raceKind === "unlink-parent" && repoPath(args[0]) === targetPath) {
    originalParentInode = (await original.lstat(parentAbsolute)).ino;
    await original.rename(parentAbsolute, outsidePath);
    await original.mkdir(parentAbsolute, { mode: 0o700 });
    replacementParentInode = (await original.lstat(parentAbsolute)).ino;
    await original.writeFile(targetAbsolute, exactBytes, { flag: "wx", mode: 0o600 });
    swapped = true;
    const value = await original.unlink(...args);
    try {
      await original.lstat(targetAbsolute);
      replacementLeafAbsent = false;
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
      replacementLeafAbsent = true;
    }
    return value;
  }
  return original.unlink(...args);
};
syncBuiltinESMExports();

let result;
let thrown = null;
try {
  const { stageCleaningRun } = await import(moduleUrl);
  result = await stageCleaningRun({ rootDir, runsRoot: ".local/cleaned/runs", plan });
} catch (error) {
  thrown = { name: error?.name, code: error?.code, message: error?.message };
}
if (raceKind === "unlink-leaf-sync" || raceKind === "linked-cleanup-sync") {
  try {
    await original.lstat(targetAbsolute);
    replacementLeafAbsent = false;
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
    replacementLeafAbsent = true;
  }
}
process.stdout.write(JSON.stringify({
  result,
  thrown,
  swapped,
  created_inode: createdInode,
  proven_source_inode: provenSourceInode,
  replacement_inode: replacementInode,
  original_parent_inode: originalParentInode,
  replacement_parent_inode: replacementParentInode,
  replacement_leaf_absent: replacementLeafAbsent,
  original_leaf_inode: originalLeafInode,
  linked_destination_inode: linkedDestinationInode,
  link_publication_sync_observed: linkPublicationSyncObserved
}));
`;

async function runB5ChildOperationIdentityChild(
  rootDir,
  plan,
  raceKind,
  targetPath,
  parentPath,
  exactBytes,
  outsidePath
) {
  const child = await runBoundedChild(process.execPath, [
    "--input-type=module",
    "--eval",
    B5_CHILD_OPERATION_IDENTITY_CHILD_SCRIPT,
    B5_MODULE_URL,
    rootDir,
    encodeB5Plan(plan),
    raceKind,
    targetPath,
    parentPath,
    Buffer.from(exactBytes).toString("base64"),
    outsidePath
  ]);
  assert.equal(child.timedOut, false, child.stderr);
  assert.equal(child.code, 0, child.stderr);
  const observed = JSON.parse(child.stdout);
  assert.equal(observed.thrown, null, JSON.stringify(observed.thrown));
  if (raceKind !== "linked-cleanup-sync") {
    assert.equal(observed.swapped, true, `${raceKind} child-operation replacement did not trigger`);
  }
  return observed;
}

const B5_POST_PREFLIGHT_STATE_CONTINUITY_CHILD_SCRIPT = `
import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { basename, dirname, join, relative, sep } from "node:path";

const [moduleUrl, rootDir, encodedPlan, encodedConfig] = process.argv.slice(1);
const serialized = JSON.parse(Buffer.from(encodedPlan, "base64").toString("utf8"));
const plan = {
  manifest: serialized.manifest,
  manifest_sha256: serialized.manifest_sha256,
  artifacts: serialized.artifacts.map((artifact) => ({
    ...artifact,
    bytes: Buffer.from(artifact.bytes, "base64")
  }))
};
const config = JSON.parse(Buffer.from(encodedConfig, "base64").toString("utf8"));
const replacementBytes = Buffer.from(config.replacement_bytes, "base64");
const expectedLeafPaths = new Set(config.expected_leaf_paths);
const expectedDirectoryPaths = new Set(config.expected_directory_paths);
const realRoot = fs.realpathSync(rootDir);
const targetAbsolute = join(realRoot, ...config.target_path.split("/"));
const targetParentPath = dirname(config.target_path).split("\\\\").join("/");
const original = {
  open: fs.promises.open,
  lstat: fs.promises.lstat,
  readdir: fs.promises.readdir,
  readFile: fs.promises.readFile,
  writeFile: fs.promises.writeFile,
  mkdir: fs.promises.mkdir,
  link: fs.promises.link,
  unlink: fs.promises.unlink
};
const targetExistedInitially = fs.existsSync(targetAbsolute);
const provenLeafPaths = new Set();
const scannedDirectoryPaths = new Set();
const postGateDirectoryProofs = new Set();
let targetAbsentFromScan = false;
let finalRootAbsenceObserved = false;
let mutationBeforeHook = false;
let fullPreflightObserved = false;
let hookTriggered = false;
let originalTargetInode = null;
let replacementTargetInode = null;
let targetAbsentImmediatelyBeforeMutation = null;
let treeAfterHook = null;

function repoPath(value) {
  if (typeof value !== "string") return null;
  return relative(realRoot, value).split(sep).join("/");
}
function absolute(repoPathValue) {
  return repoPathValue === ""
    ? realRoot
    : join(realRoot, ...repoPathValue.split("/"));
}
function allObserved(expected, observed) {
  return [...expected].every((path) => observed.has(path));
}
function semanticGateReady() {
  return allObserved(expectedLeafPaths, provenLeafPaths) &&
    allObserved(expectedDirectoryPaths, scannedDirectoryPaths) &&
    (!config.require_final_absence || finalRootAbsenceObserved) &&
    (!config.require_target_absence || targetAbsentFromScan);
}
async function snapshotTree() {
  const entries = [];
  async function visit(relativePath) {
    const names = await original.readdir(absolute(relativePath));
    names.sort();
    for (const name of names) {
      const child = relativePath === "" ? name : relativePath + "/" + name;
      const info = await original.lstat(absolute(child));
      if (info.isDirectory()) {
        entries.push([child, "directory"]);
        await visit(child);
      } else if (info.isFile()) {
        entries.push([
          child,
          "file",
          (await original.readFile(absolute(child))).toString("base64")
        ]);
      } else if (info.isSymbolicLink()) {
        entries.push([child, "symlink"]);
      } else {
        entries.push([child, "other"]);
      }
    }
  }
  await visit("");
  return entries;
}
async function mutateTarget() {
  if (hookTriggered) return;
  fullPreflightObserved = true;
  if (config.mutation_kind === "replace") {
    const before = await original.lstat(targetAbsolute);
    originalTargetInode = before.ino;
    await original.link(targetAbsolute, config.outside_path);
    await original.unlink(targetAbsolute);
  } else {
    try {
      await original.lstat(targetAbsolute);
      targetAbsentImmediatelyBeforeMutation = false;
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
      targetAbsentImmediatelyBeforeMutation = true;
    }
    if (!targetAbsentImmediatelyBeforeMutation) {
      throw new Error("target appeared before the controlled post-preflight mutation");
    }
  }
  await original.writeFile(targetAbsolute, replacementBytes, {
    flag: "wx",
    mode: 0o600
  });
  replacementTargetInode = (await original.lstat(targetAbsolute)).ino;
  hookTriggered = true;
  treeAfterHook = await snapshotTree();
}

fs.promises.lstat = async (...args) => {
  try {
    return await original.lstat(...args);
  } catch (error) {
    if (!hookTriggered && error?.code === "ENOENT" &&
        repoPath(args[0]) === config.final_run_path) {
      finalRootAbsenceObserved = true;
    }
    throw error;
  }
};
fs.promises.readdir = async (...args) => {
  const names = await original.readdir(...args);
  const path = repoPath(args[0]);
  if (!hookTriggered && expectedDirectoryPaths.has(path)) {
    scannedDirectoryPaths.add(path);
  }
  if (!hookTriggered && config.require_target_absence && path === targetParentPath &&
      !names.includes(basename(config.target_path))) {
    targetAbsentFromScan = true;
  }
  return names;
};
fs.promises.mkdir = async (...args) => {
  if (!hookTriggered) mutationBeforeHook = true;
  return original.mkdir(...args);
};
fs.promises.link = async (...args) => {
  if (!hookTriggered) mutationBeforeHook = true;
  return original.link(...args);
};
fs.promises.unlink = async (...args) => {
  if (!hookTriggered) mutationBeforeHook = true;
  return original.unlink(...args);
};
fs.promises.writeFile = async (...args) => {
  if (!hookTriggered) mutationBeforeHook = true;
  return original.writeFile(...args);
};
fs.promises.open = async (...args) => {
  const flags = args[1];
  if (!hookTriggered && typeof flags === "number" &&
      (flags & fs.constants.O_CREAT) !== 0) {
    mutationBeforeHook = true;
  }
  const handle = await original.open(...args);
  const openedPath = repoPath(args[0]);
  const watchesLeaf = expectedLeafPaths.has(openedPath);
  const watchesDirectory = expectedDirectoryPaths.has(openedPath) &&
    typeof flags === "number" && (flags & fs.constants.O_DIRECTORY) !== 0;
  if (!watchesLeaf && !watchesDirectory) return handle;
  let statCalls = 0;
  let readObserved = false;
  return new Proxy(handle, {
    get(target, property) {
      if (property === "stat") {
        return async (...methodArgs) => {
          const value = await target.stat(...methodArgs);
          statCalls += 1;
          return value;
        };
      }
      if (property === "read") {
        return async (...methodArgs) => {
          const value = await target.read(...methodArgs);
          readObserved = true;
          return value;
        };
      }
      if (property === "close") {
        return async (...methodArgs) => {
          const value = await target.close(...methodArgs);
          if (!hookTriggered && watchesLeaf && statCalls >= 2 && readObserved) {
            provenLeafPaths.add(openedPath);
          }
          if (!hookTriggered && watchesDirectory && statCalls >= 1 &&
              semanticGateReady()) {
            postGateDirectoryProofs.add(openedPath);
            if (allObserved(expectedDirectoryPaths, postGateDirectoryProofs)) {
              await mutateTarget();
            }
          }
          return value;
        };
      }
      const value = Reflect.get(target, property, target);
      return typeof value === "function" ? value.bind(target) : value;
    }
  });
};
syncBuiltinESMExports();

let result;
let thrown = null;
try {
  const { stageCleaningRun } = await import(moduleUrl);
  result = await stageCleaningRun({ rootDir, runsRoot: ".local/cleaned/runs", plan });
} catch (error) {
  thrown = { name: error?.name, code: error?.code, message: error?.message };
} finally {
  fs.promises.open = original.open;
  fs.promises.lstat = original.lstat;
  fs.promises.readdir = original.readdir;
  fs.promises.writeFile = original.writeFile;
  fs.promises.mkdir = original.mkdir;
  fs.promises.link = original.link;
  fs.promises.unlink = original.unlink;
  syncBuiltinESMExports();
}
const treeAfterRun = await snapshotTree();
let targetExistsAfter = true;
let targetInodeAfter = null;
let targetBytesMatchAfter = false;
try {
  const targetAfter = await original.lstat(targetAbsolute);
  targetInodeAfter = targetAfter.ino;
  targetBytesMatchAfter = targetAfter.isFile() &&
    (await original.readFile(targetAbsolute)).equals(replacementBytes);
} catch (error) {
  if (error?.code !== "ENOENT") throw error;
  targetExistsAfter = false;
}
process.stdout.write(JSON.stringify({
  result,
  thrown,
  hook_triggered: hookTriggered,
  full_preflight_observed: fullPreflightObserved,
  mutation_before_hook: mutationBeforeHook,
  target_existed_initially: targetExistedInitially,
  target_absent_from_scan: targetAbsentFromScan,
  final_root_absence_observed: finalRootAbsenceObserved,
  target_absent_immediately_before_mutation: targetAbsentImmediatelyBeforeMutation,
  original_target_inode: originalTargetInode,
  replacement_target_inode: replacementTargetInode,
  target_exists_after: targetExistsAfter,
  target_inode_after: targetInodeAfter,
  target_bytes_match_after: targetBytesMatchAfter,
  intent_exists: fs.existsSync(absolute(config.intent_path)),
  candidate_exists: fs.existsSync(absolute(config.intent_candidate_path)),
  proven_leaf_paths: [...provenLeafPaths].sort(),
  scanned_directory_paths: [...scannedDirectoryPaths].sort(),
  post_gate_directory_proofs: [...postGateDirectoryProofs].sort(),
  tree_after_hook: treeAfterHook,
  tree_after_run: treeAfterRun
}));
`;

async function runB5PostPreflightStateContinuityChild(rootDir, plan, config) {
  const encodedConfig = Buffer.from(JSON.stringify({
    ...config,
    replacement_bytes: Buffer.from(config.replacementBytes).toString("base64")
  }), "utf8").toString("base64");
  const child = await runBoundedChild(process.execPath, [
    "--input-type=module",
    "--eval",
    B5_POST_PREFLIGHT_STATE_CONTINUITY_CHILD_SCRIPT,
    B5_MODULE_URL,
    rootDir,
    encodeB5Plan(plan),
    encodedConfig
  ]);
  assert.equal(child.timedOut, false, child.stderr);
  assert.equal(child.code, 0, child.stderr);
  const observed = JSON.parse(child.stdout);
  assert.equal(observed.thrown, null, JSON.stringify(observed.thrown));
  assert.equal(observed.hook_triggered, true, "post-preflight continuity hook did not trigger");
  assert.equal(observed.full_preflight_observed, true);
  assert.equal(observed.mutation_before_hook, false, "production mutated before the hook");
  assert.deepEqual(observed.proven_leaf_paths, [...config.expected_leaf_paths].sort());
  assert.deepEqual(
    observed.scanned_directory_paths,
    [...config.expected_directory_paths].sort()
  );
  assert.deepEqual(
    observed.post_gate_directory_proofs,
    [...config.expected_directory_paths].sort()
  );
  if (config.mutation_kind === "replace") {
    assert.equal(observed.target_existed_initially, true);
    assert.notEqual(observed.original_target_inode, observed.replacement_target_inode);
  } else {
    assert.equal(observed.target_existed_initially, false);
    assert.equal(observed.target_absent_from_scan, true);
    assert.equal(observed.target_absent_immediately_before_mutation, true);
    assert.equal(observed.original_target_inode, null);
    assert.notEqual(observed.replacement_target_inode, null);
  }
  return observed;
}

const B5_FIXED_ANCESTOR_CONTINUITY_CHILD_SCRIPT = `
import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { join, relative, sep } from "node:path";

const [moduleUrl, rootDir, encodedPlan, encodedConfig] = process.argv.slice(1);
const serialized = JSON.parse(Buffer.from(encodedPlan, "base64").toString("utf8"));
const plan = {
  manifest: serialized.manifest,
  manifest_sha256: serialized.manifest_sha256,
  artifacts: serialized.artifacts.map((artifact) => ({
    ...artifact,
    bytes: Buffer.from(artifact.bytes, "base64")
  }))
};
const config = JSON.parse(Buffer.from(encodedConfig, "base64").toString("utf8"));
const expectedLeafPaths = new Set(config.expected_leaf_paths);
const expectedDirectoryPaths = new Set(config.expected_directory_paths);
const realRoot = fs.realpathSync(rootDir);
const ancestorAbsolute = join(realRoot, ...config.ancestor_path.split("/"));
const leafParentAbsolute = join(realRoot, ...config.leaf_parent_path.split("/"));
const movedAncestorAbsolute = config.moved_ancestor_path;
const leafParentSuffix = relative(ancestorAbsolute, leafParentAbsolute);
if (leafParentSuffix === "" || leafParentSuffix === ".." ||
    leafParentSuffix.startsWith(".." + sep)) {
  throw new Error("leaf parent must be a strict descendant of the replaced ancestor");
}
const movedLeafParentAbsolute = join(movedAncestorAbsolute, leafParentSuffix);
const original = {
  open: fs.promises.open,
  lstat: fs.promises.lstat,
  readdir: fs.promises.readdir,
  readFile: fs.promises.readFile,
  readlink: fs.promises.readlink,
  writeFile: fs.promises.writeFile,
  mkdir: fs.promises.mkdir,
  link: fs.promises.link,
  unlink: fs.promises.unlink,
  rename: fs.promises.rename,
  symlink: fs.promises.symlink
};
const provenLeafPaths = new Set();
const scannedDirectoryPaths = new Set();
const postGateDirectoryProofs = new Set();
let finalRootAbsenceObserved = false;
let fullPreflightObserved = false;
let ancestorEnsureProofObserved = false;
let productionMutationBeforeHook = false;
let hookTriggered = false;
let ensureProofAncestorIdentity = null;
let oldAncestorIdentity = null;
let movedAncestorIdentityAtHook = null;
let replacementSymlinkIdentityAtHook = null;
let leafParentIdentityBefore = null;
let leafParentIdentityAfterHook = null;
let movedLeafParentIdentityAtHook = null;
let rootTreeAfterHook = null;
let outsideTreeAfterHook = null;
let plannedLeafPathsAfterHook = null;

function repoPath(value) {
  if (typeof value !== "string") return null;
  return relative(realRoot, value).split(sep).join("/");
}
function absolute(repoPathValue) {
  return repoPathValue === ""
    ? realRoot
    : join(realRoot, ...repoPathValue.split("/"));
}
function identity(stat) {
  return { dev: stat.dev, ino: stat.ino };
}
function allObserved(expected, observed) {
  return [...expected].every((path) => observed.has(path));
}
function preflightGateReady() {
  return allObserved(expectedLeafPaths, provenLeafPaths) &&
    allObserved(expectedDirectoryPaths, scannedDirectoryPaths) &&
    (!config.require_final_absence || finalRootAbsenceObserved);
}
async function snapshotTree(baseRoot) {
  const entries = [];
  async function visit(relativePath) {
    const baseAbsolute = relativePath === ""
      ? baseRoot
      : join(baseRoot, ...relativePath.split("/"));
    const names = await original.readdir(baseAbsolute);
    names.sort();
    for (const name of names) {
      const child = relativePath === "" ? name : relativePath + "/" + name;
      const childAbsolute = join(baseRoot, ...child.split("/"));
      const info = await original.lstat(childAbsolute);
      if (info.isDirectory()) {
        entries.push([child, "directory"]);
        await visit(child);
      } else if (info.isFile()) {
        entries.push([
          child,
          "file",
          (await original.readFile(childAbsolute)).toString("base64")
        ]);
      } else if (info.isSymbolicLink()) {
        entries.push([child, "symlink", await original.readlink(childAbsolute)]);
      } else {
        entries.push([child, "other"]);
      }
    }
  }
  await visit("");
  return entries;
}
async function presentPlannedLeafPaths() {
  const present = [];
  for (const path of config.planned_leaf_paths) {
    try {
      await original.lstat(absolute(path));
      present.push(path);
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
    }
  }
  return present.sort();
}
async function replaceAncestor() {
  if (hookTriggered) return;
  const ancestorBefore = await original.lstat(ancestorAbsolute);
  const leafParentBefore = await original.lstat(leafParentAbsolute);
  if (!ancestorBefore.isDirectory() || ancestorBefore.isSymbolicLink() ||
      !leafParentBefore.isDirectory() || leafParentBefore.isSymbolicLink()) {
    throw new Error("fixed-ancestor fixture was not a directory chain");
  }
  oldAncestorIdentity = identity(ancestorBefore);
  leafParentIdentityBefore = identity(leafParentBefore);
  await original.rename(ancestorAbsolute, movedAncestorAbsolute);
  movedAncestorIdentityAtHook = identity(await original.lstat(movedAncestorAbsolute));
  await original.symlink(movedAncestorAbsolute, ancestorAbsolute, "dir");
  const replacement = await original.lstat(ancestorAbsolute);
  if (!replacement.isSymbolicLink()) {
    throw new Error("fixed ancestor replacement was not a symlink");
  }
  replacementSymlinkIdentityAtHook = identity(replacement);
  leafParentIdentityAfterHook = identity(await original.lstat(leafParentAbsolute));
  movedLeafParentIdentityAtHook = identity(
    await original.lstat(movedLeafParentAbsolute)
  );
  hookTriggered = true;
  rootTreeAfterHook = await snapshotTree(realRoot);
  outsideTreeAfterHook = await snapshotTree(config.outside_root);
  plannedLeafPathsAfterHook = await presentPlannedLeafPaths();
}

fs.promises.lstat = async (...args) => {
  try {
    return await original.lstat(...args);
  } catch (error) {
    if (!hookTriggered && error?.code === "ENOENT" &&
        repoPath(args[0]) === config.final_run_path) {
      finalRootAbsenceObserved = true;
    }
    throw error;
  }
};
fs.promises.readdir = async (...args) => {
  const names = await original.readdir(...args);
  const path = repoPath(args[0]);
  if (!hookTriggered && expectedDirectoryPaths.has(path)) {
    scannedDirectoryPaths.add(path);
  }
  return names;
};
for (const operation of ["mkdir", "link", "unlink", "rename", "symlink", "writeFile"]) {
  fs.promises[operation] = async (...args) => {
    if (!hookTriggered) productionMutationBeforeHook = true;
    return original[operation](...args);
  };
}
fs.promises.open = async (...args) => {
  const flags = args[1];
  if (!hookTriggered && typeof flags === "number" &&
      (flags & fs.constants.O_CREAT) !== 0) {
    productionMutationBeforeHook = true;
  }
  const handle = await original.open(...args);
  const openedPath = repoPath(args[0]);
  const watchesLeaf = expectedLeafPaths.has(openedPath);
  const isDirectoryHandle = typeof flags === "number" &&
    (flags & fs.constants.O_DIRECTORY) !== 0;
  const watchesPreflightDirectory = expectedDirectoryPaths.has(openedPath) &&
    isDirectoryHandle;
  const watchesAncestor = openedPath === config.ancestor_path && isDirectoryHandle;
  if (!watchesLeaf && !watchesPreflightDirectory && !watchesAncestor) return handle;
  let statCalls = 0;
  let readObserved = false;
  let lastStatIdentity = null;
  return new Proxy(handle, {
    get(target, property) {
      if (property === "stat") {
        return async (...methodArgs) => {
          const value = await target.stat(...methodArgs);
          statCalls += 1;
          lastStatIdentity = identity(value);
          return value;
        };
      }
      if (property === "read") {
        return async (...methodArgs) => {
          const value = await target.read(...methodArgs);
          readObserved = true;
          return value;
        };
      }
      if (property === "close") {
        return async (...methodArgs) => {
          const value = await target.close(...methodArgs);
          if (!hookTriggered && watchesLeaf && statCalls >= 2 && readObserved) {
            provenLeafPaths.add(openedPath);
          }
          if (!hookTriggered && watchesPreflightDirectory && statCalls >= 1 &&
              preflightGateReady()) {
            postGateDirectoryProofs.add(openedPath);
            if (allObserved(expectedDirectoryPaths, postGateDirectoryProofs)) {
              fullPreflightObserved = true;
            }
          }
          if (!hookTriggered && fullPreflightObserved && watchesAncestor &&
              statCalls >= 1) {
            ancestorEnsureProofObserved = true;
            ensureProofAncestorIdentity = lastStatIdentity;
            await replaceAncestor();
          }
          return value;
        };
      }
      const value = Reflect.get(target, property, target);
      return typeof value === "function" ? value.bind(target) : value;
    }
  });
};
syncBuiltinESMExports();

let result;
let thrown = null;
try {
  const { stageCleaningRun } = await import(moduleUrl);
  result = await stageCleaningRun({ rootDir, runsRoot: ".local/cleaned/runs", plan });
} catch (error) {
  thrown = { name: error?.name, code: error?.code, message: error?.message };
} finally {
  fs.promises.open = original.open;
  fs.promises.lstat = original.lstat;
  fs.promises.readdir = original.readdir;
  for (const operation of ["mkdir", "link", "unlink", "rename", "symlink", "writeFile"]) {
    fs.promises[operation] = original[operation];
  }
  syncBuiltinESMExports();
}
const rootTreeAfterRun = await snapshotTree(realRoot);
const outsideTreeAfterRun = await snapshotTree(config.outside_root);
const plannedLeafPathsAfterRun = await presentPlannedLeafPaths();
const movedAncestorIdentityAfterRun = identity(
  await original.lstat(movedAncestorAbsolute)
);
const replacementSymlinkIdentityAfterRun = identity(
  await original.lstat(ancestorAbsolute)
);
const leafParentIdentityAfterRun = identity(
  await original.lstat(leafParentAbsolute)
);
const movedLeafParentIdentityAfterRun = identity(
  await original.lstat(movedLeafParentAbsolute)
);
process.stdout.write(JSON.stringify({
  result,
  thrown,
  hook_triggered: hookTriggered,
  full_preflight_observed: fullPreflightObserved,
  ancestor_ensure_proof_observed: ancestorEnsureProofObserved,
  production_mutation_before_hook: productionMutationBeforeHook,
  final_root_absence_observed: finalRootAbsenceObserved,
  ensure_proof_ancestor_identity: ensureProofAncestorIdentity,
  old_ancestor_identity: oldAncestorIdentity,
  moved_ancestor_identity_at_hook: movedAncestorIdentityAtHook,
  replacement_symlink_identity_at_hook: replacementSymlinkIdentityAtHook,
  moved_ancestor_identity_after_run: movedAncestorIdentityAfterRun,
  replacement_symlink_identity_after_run: replacementSymlinkIdentityAfterRun,
  leaf_parent_identity_before: leafParentIdentityBefore,
  leaf_parent_identity_after_hook: leafParentIdentityAfterHook,
  moved_leaf_parent_identity_at_hook: movedLeafParentIdentityAtHook,
  leaf_parent_identity_after_run: leafParentIdentityAfterRun,
  moved_leaf_parent_identity_after_run: movedLeafParentIdentityAfterRun,
  proven_leaf_paths: [...provenLeafPaths].sort(),
  scanned_directory_paths: [...scannedDirectoryPaths].sort(),
  post_gate_directory_proofs: [...postGateDirectoryProofs].sort(),
  planned_leaf_paths_after_hook: plannedLeafPathsAfterHook,
  planned_leaf_paths_after_run: plannedLeafPathsAfterRun,
  root_tree_after_hook: rootTreeAfterHook,
  root_tree_after_run: rootTreeAfterRun,
  outside_tree_after_hook: outsideTreeAfterHook,
  outside_tree_after_run: outsideTreeAfterRun
}));
`;

async function runB5FixedAncestorContinuityChild(rootDir, plan, config) {
  const child = await runBoundedChild(process.execPath, [
    "--input-type=module",
    "--eval",
    B5_FIXED_ANCESTOR_CONTINUITY_CHILD_SCRIPT,
    B5_MODULE_URL,
    rootDir,
    encodeB5Plan(plan),
    Buffer.from(JSON.stringify(config), "utf8").toString("base64")
  ]);
  assert.equal(child.timedOut, false, child.stderr);
  assert.equal(child.code, 0, child.stderr);
  const observed = JSON.parse(child.stdout);
  assert.equal(observed.thrown, null, JSON.stringify(observed.thrown));
  assert.equal(observed.hook_triggered, true, "fixed-ancestor hook did not trigger");
  assert.equal(observed.full_preflight_observed, true);
  assert.equal(observed.ancestor_ensure_proof_observed, true);
  assert.equal(observed.production_mutation_before_hook, false);
  assert.deepEqual(observed.proven_leaf_paths, [...config.expected_leaf_paths].sort());
  assert.deepEqual(
    observed.scanned_directory_paths,
    [...config.expected_directory_paths].sort()
  );
  assert.deepEqual(
    observed.post_gate_directory_proofs,
    [...config.expected_directory_paths].sort()
  );
  assert.deepEqual(
    observed.ensure_proof_ancestor_identity,
    observed.old_ancestor_identity
  );
  assert.deepEqual(
    observed.old_ancestor_identity,
    observed.moved_ancestor_identity_at_hook
  );
  assert.notDeepEqual(
    observed.old_ancestor_identity,
    observed.replacement_symlink_identity_at_hook
  );
  assert.deepEqual(
    observed.leaf_parent_identity_before,
    observed.leaf_parent_identity_after_hook
  );
  assert.deepEqual(
    observed.leaf_parent_identity_before,
    observed.moved_leaf_parent_identity_at_hook
  );
  return observed;
}

test("B5 root alias anchoring and parent or leaf identity replacements cannot redirect writes", async (t) => {
  const stageCleaningRun = await loadStageCleaningRun();

  await t.test("retargeting the caller root alias after invocation cannot move staging", async (t) => {
    const container = await makeB5Root(t, "root-retarget");
    const realRoot = join(container, "real");
    const otherRoot = join(container, "other");
    const aliasRoot = join(container, "alias");
    await mkdir(realRoot);
    await mkdir(otherRoot);
    await symlink("real", aliasRoot);
    const plan = makeB5GoldenPlan();
    const layout = expectedB5Layout(plan);
    const pending = stageCleaningRun({
      rootDir: aliasRoot,
      runsRoot: join(aliasRoot, B5_RUNS_ROOT),
      plan
    });
    await unlink(aliasRoot);
    await symlink("other", aliasRoot);
    assert.deepEqual(await pending, layout.success(true));
    assert.deepEqual(await readFile(join(realRoot, layout.intentPath)), layout.intentBytes);
    assert.deepEqual(await snapshotB5Tree(otherRoot), []);
  });

  for (const raceKind of ["leaf", "parent"]) {
    await t.test(`${raceKind} replacement between proof and open fails closed`, async (t) => {
      const rootDir = await makeB5Root(t, `identity-${raceKind}`);
      const outsideRoot = await makeB5Root(t, `identity-${raceKind}-outside`);
      const outsidePath = join(outsideRoot, "outside.bin");
      const outsideBytes = Buffer.from("must remain unchanged");
      await writeFile(outsidePath, outsideBytes);
      const plan = makeB5GoldenPlan();
      const layout = expectedB5Layout(plan);
      await writeB5Intent(rootDir, layout);
      const artifact = layout.artifactIntents[0];
      await writeB5Path(
        rootDir,
        artifact.temp_path,
        b5ArtifactBytes(plan, artifact.relative_path)
      );
      const parentPath = dirname(artifact.temp_path).split("\\").join("/");
      const expectedPath = raceKind === "leaf" ? artifact.temp_path : parentPath;
      assert.deepEqual(
        await runB5IdentityRaceChild(
          rootDir,
          plan,
          raceKind,
          artifact.temp_path,
          parentPath,
          outsidePath
        ),
        b5ExpectedFailure("RUN_CONFLICT", expectedPath)
      );
      assert.deepEqual(await readFile(outsidePath), outsideBytes);
    });
  }

  await t.test("created handle remains bound to the candidate pathname inode", async (t) => {
    const rootDir = await makeB5Root(t, "identity-create-handle-path");
    const outsideRoot = await makeB5Root(t, "identity-create-handle-path-outside");
    const plan = makeB5GoldenPlan();
    const layout = expectedB5Layout(plan);
    const parentPath = dirname(layout.intentCandidatePath).split("\\").join("/");
    const observed = await runB5ChildOperationIdentityChild(
      rootDir,
      plan,
      "create",
      layout.intentCandidatePath,
      parentPath,
      layout.intentBytes,
      join(outsideRoot, "created-handle-anchor")
    );
    assert.notEqual(observed.created_inode, observed.replacement_inode);
    assert.deepEqual(
      observed.result,
      b5ExpectedFailure("STAGING_CONFLICT", layout.intentCandidatePath, true)
    );
  });

  await t.test("link detects an exact-byte source inode replacement", async (t) => {
    const rootDir = await makeB5Root(t, "identity-link-source");
    const outsideRoot = await makeB5Root(t, "identity-link-source-outside");
    const plan = makeB5GoldenPlan();
    const layout = expectedB5Layout(plan);
    await writeB5Path(rootDir, layout.intentCandidatePath, layout.intentBytes);
    const parentPath = dirname(layout.intentCandidatePath).split("\\").join("/");
    const observed = await runB5ChildOperationIdentityChild(
      rootDir,
      plan,
      "link",
      layout.intentCandidatePath,
      parentPath,
      layout.intentBytes,
      join(outsideRoot, "unused")
    );
    assert.notEqual(observed.proven_source_inode, observed.replacement_inode);
    assert.deepEqual(
      observed.result,
      b5ExpectedFailure("STAGING_CONFLICT", layout.intentCandidatePath, true)
    );
  });

  await t.test("unlink detects replacement of the proven artifact parent", async (t) => {
    const rootDir = await makeB5Root(t, "identity-unlink-parent");
    const outsideRoot = await makeB5Root(t, "identity-unlink-parent-outside");
    const plan = makeB5GoldenPlan();
    const layout = expectedB5Layout(plan);
    await writeB5Intent(rootDir, layout);
    await materializeB5Final(rootDir, plan, layout);
    const artifact = layout.artifactIntents[0];
    const bytes = b5ArtifactBytes(plan, artifact.relative_path);
    await writeB5Path(rootDir, artifact.temp_path, bytes);
    const parentPath = dirname(artifact.temp_path).split("\\").join("/");
    const observed = await runB5ChildOperationIdentityChild(
      rootDir,
      plan,
      "unlink-parent",
      artifact.temp_path,
      parentPath,
      bytes,
      join(outsideRoot, "displaced-parent")
    );
    assert.notEqual(observed.original_parent_inode, observed.replacement_parent_inode);
    assert.equal(observed.replacement_leaf_absent, true);
    assert.deepEqual(
      observed.result,
      b5ExpectedFailure("RUN_CONFLICT", parentPath, true)
    );
  });

  await t.test("unlink preserves an exact-byte replacement introduced during parent fsync", async (t) => {
    const rootDir = await makeB5Root(t, "identity-unlink-leaf-parent-sync");
    const outsideRoot = await makeB5Root(t, "identity-unlink-leaf-parent-sync-outside");
    const plan = makeB5GoldenPlan();
    const layout = expectedB5Layout(plan);
    await writeB5Intent(rootDir, layout);
    await materializeB5Final(rootDir, plan, layout);
    const artifact = layout.artifactIntents[0];
    const bytes = b5ArtifactBytes(plan, artifact.relative_path);
    await writeB5Path(rootDir, artifact.temp_path, bytes);
    const parentPath = dirname(artifact.temp_path).split("\\").join("/");
    const observed = await runB5ChildOperationIdentityChild(
      rootDir,
      plan,
      "unlink-leaf-sync",
      artifact.temp_path,
      parentPath,
      bytes,
      join(outsideRoot, "proven-residue")
    );
    assert.notEqual(observed.original_leaf_inode, observed.replacement_inode);
    assert.equal(observed.replacement_leaf_absent, false);
    assert.equal((await lstat(join(rootDir, artifact.temp_path))).ino, observed.replacement_inode);
    assert.deepEqual(
      observed.result,
      b5ExpectedFailure("RUN_CONFLICT", artifact.temp_path)
    );
  });

  await t.test("hard-link cleanup remains bound to the linked inode across parent fsync", async (t) => {
    const rootDir = await makeB5Root(t, "identity-linked-cleanup-parent-sync");
    const outsideRoot = await makeB5Root(t, "identity-linked-cleanup-parent-sync-outside");
    const plan = makeB5GoldenPlan();
    const layout = expectedB5Layout(plan);
    await writeB5Path(rootDir, layout.intentCandidatePath, layout.intentBytes);
    const parentPath = dirname(layout.intentCandidatePath).split("\\").join("/");
    const observed = await runB5ChildOperationIdentityChild(
      rootDir,
      plan,
      "linked-cleanup-sync",
      layout.intentCandidatePath,
      parentPath,
      layout.intentBytes,
      join(outsideRoot, "linked-candidate")
    );
    assert.equal(observed.link_publication_sync_observed, true);
    assert.equal(
      (await lstat(join(rootDir, layout.intentPath))).ino,
      observed.linked_destination_inode
    );
    if (observed.swapped) {
      assert.equal(observed.linked_destination_inode, observed.original_leaf_inode);
      assert.notEqual(observed.original_leaf_inode, observed.replacement_inode);
      assert.equal(observed.replacement_leaf_absent, false);
      assert.equal(
        (await lstat(join(rootDir, layout.intentCandidatePath))).ino,
        observed.replacement_inode
      );
      assert.deepEqual(
        observed.result,
        b5ExpectedFailure("STAGING_CONFLICT", layout.intentCandidatePath, true)
      );
    } else {
      assert.equal(observed.replacement_inode, null);
      assert.equal(observed.replacement_leaf_absent, true);
      assert.deepEqual(observed.result, layout.success(true));
    }
  });

  await t.test("exact intent candidate identity remains continuous after preflight", async (t) => {
    const rootDir = await makeB5Root(t, "continuity-candidate-present");
    const outsideRoot = await makeB5Root(t, "continuity-candidate-present-outside");
    const plan = makeB5GoldenPlan();
    const layout = expectedB5Layout(plan);
    await writeB5Path(rootDir, layout.intentCandidatePath, layout.intentBytes);
    const observed = await runB5PostPreflightStateContinuityChild(rootDir, plan, {
      target_path: layout.intentCandidatePath,
      mutation_kind: "replace",
      replacementBytes: layout.intentBytes,
      outside_path: join(outsideRoot, "original-candidate"),
      expected_leaf_paths: [layout.intentCandidatePath],
      expected_directory_paths: [layout.stagingPath],
      require_final_absence: true,
      require_target_absence: false,
      final_run_path: layout.finalRunPath,
      intent_path: layout.intentPath,
      intent_candidate_path: layout.intentCandidatePath
    });
    assert.notEqual(observed.original_target_inode, observed.replacement_target_inode);
    assert.equal(observed.target_exists_after, true, "replacement candidate was removed");
    assert.equal(observed.target_inode_after, observed.replacement_target_inode);
    assert.equal(observed.target_bytes_match_after, true);
    assert.equal(observed.intent_exists, false, "intent was published after candidate drift");
    assert.equal(observed.candidate_exists, true);
    assert.deepEqual(observed.tree_after_run, observed.tree_after_hook);
    assert.deepEqual(
      observed.result,
      b5ExpectedFailure("STAGING_CONFLICT", layout.intentCandidatePath)
    );
  });

  await t.test("an intent candidate appearing after an absent preflight remains unclaimed", async (t) => {
    const rootDir = await makeB5Root(t, "continuity-candidate-absent");
    const plan = makeB5GoldenPlan();
    const layout = expectedB5Layout(plan);
    await mkdir(join(rootDir, layout.stagingPath), { recursive: true });
    const observed = await runB5PostPreflightStateContinuityChild(rootDir, plan, {
      target_path: layout.intentCandidatePath,
      mutation_kind: "create",
      replacementBytes: layout.intentBytes,
      outside_path: null,
      expected_leaf_paths: [],
      expected_directory_paths: [layout.stagingPath],
      require_final_absence: true,
      require_target_absence: true,
      final_run_path: layout.finalRunPath,
      intent_path: layout.intentPath,
      intent_candidate_path: layout.intentCandidatePath
    });
    assert.equal(observed.final_root_absence_observed, true);
    assert.equal(observed.target_exists_after, true, "appearing candidate was removed");
    assert.equal(observed.target_inode_after, observed.replacement_target_inode);
    assert.equal(observed.target_bytes_match_after, true);
    assert.equal(observed.intent_exists, false, "intent was published from an unknown candidate");
    assert.equal(observed.candidate_exists, true);
    assert.deepEqual(observed.tree_after_run, observed.tree_after_hook);
    assert.deepEqual(
      observed.result,
      b5ExpectedFailure("STAGING_CONFLICT", layout.intentCandidatePath)
    );
  });

  await t.test("exact canonical identity remains continuous after preflight", async (t) => {
    const rootDir = await makeB5Root(t, "continuity-canonical-present");
    const outsideRoot = await makeB5Root(t, "continuity-canonical-present-outside");
    const plan = makeB5GoldenPlan();
    const layout = expectedB5Layout(plan);
    const artifact = layout.artifactIntents[0];
    const bytes = b5ArtifactBytes(plan, artifact.relative_path);
    await writeB5Intent(rootDir, layout);
    await mkdir(join(rootDir, layout.finalRunPath, "catalog"), { recursive: true });
    await mkdir(join(rootDir, layout.finalRunPath, "sources"), { recursive: true });
    await writeB5Path(rootDir, artifact.canonical_path, bytes);
    const expectedDirectories = [
      layout.stagingPath,
      layout.finalRunPath,
      `${layout.finalRunPath}/catalog`,
      `${layout.finalRunPath}/sources`
    ];
    const observed = await runB5PostPreflightStateContinuityChild(rootDir, plan, {
      target_path: artifact.canonical_path,
      mutation_kind: "replace",
      replacementBytes: bytes,
      outside_path: join(outsideRoot, "original-canonical"),
      expected_leaf_paths: [layout.intentPath, artifact.canonical_path],
      expected_directory_paths: expectedDirectories,
      require_final_absence: false,
      require_target_absence: false,
      final_run_path: layout.finalRunPath,
      intent_path: layout.intentPath,
      intent_candidate_path: layout.intentCandidatePath
    });
    assert.notEqual(observed.original_target_inode, observed.replacement_target_inode);
    assert.equal(observed.target_exists_after, true);
    assert.equal(observed.target_inode_after, observed.replacement_target_inode);
    assert.equal(observed.target_bytes_match_after, true);
    assert.equal(observed.intent_exists, true);
    assert.deepEqual(observed.tree_after_run, observed.tree_after_hook);
    assert.deepEqual(
      observed.result,
      b5ExpectedFailure("RUN_CONFLICT", artifact.canonical_path)
    );
  });

  await t.test("a canonical appearing after an absent preflight remains unclaimed", async (t) => {
    const rootDir = await makeB5Root(t, "continuity-canonical-absent");
    const plan = makeB5GoldenPlan();
    const layout = expectedB5Layout(plan);
    const sentinel = layout.artifactIntents[0];
    const artifact = layout.artifactIntents[1];
    const bytes = b5ArtifactBytes(plan, artifact.relative_path);
    await writeB5Intent(rootDir, layout);
    await mkdir(join(rootDir, layout.finalRunPath, "catalog"), { recursive: true });
    await mkdir(join(rootDir, layout.finalRunPath, "sources"), { recursive: true });
    await writeB5Path(
      rootDir,
      sentinel.canonical_path,
      b5ArtifactBytes(plan, sentinel.relative_path)
    );
    const expectedDirectories = [
      layout.stagingPath,
      layout.finalRunPath,
      `${layout.finalRunPath}/catalog`,
      `${layout.finalRunPath}/sources`
    ];
    const observed = await runB5PostPreflightStateContinuityChild(rootDir, plan, {
      target_path: artifact.canonical_path,
      mutation_kind: "create",
      replacementBytes: bytes,
      outside_path: null,
      expected_leaf_paths: [layout.intentPath, sentinel.canonical_path],
      expected_directory_paths: expectedDirectories,
      require_final_absence: false,
      require_target_absence: true,
      final_run_path: layout.finalRunPath,
      intent_path: layout.intentPath,
      intent_candidate_path: layout.intentCandidatePath
    });
    assert.equal(observed.target_exists_after, true);
    assert.equal(observed.target_inode_after, observed.replacement_target_inode);
    assert.equal(observed.target_bytes_match_after, true);
    assert.equal(observed.intent_exists, true);
    assert.deepEqual(observed.tree_after_run, observed.tree_after_hook);
    assert.deepEqual(
      observed.result,
      b5ExpectedFailure("RUN_CONFLICT", artifact.canonical_path)
    );
  });

  await t.test("prefix artifact temp identity remains continuous after preflight", async (t) => {
    const rootDir = await makeB5Root(t, "continuity-temp-present");
    const outsideRoot = await makeB5Root(t, "continuity-temp-present-outside");
    const plan = makeB5GoldenPlan();
    const layout = expectedB5Layout(plan);
    const artifact = layout.artifactIntents[0];
    const planned = b5ArtifactBytes(plan, artifact.relative_path);
    const prefix = planned.subarray(0, Math.max(1, planned.length - 1));
    await writeB5Intent(rootDir, layout);
    await mkdir(join(rootDir, layout.finalRunPath, "catalog"), { recursive: true });
    await mkdir(join(rootDir, layout.finalRunPath, "sources"), { recursive: true });
    await writeB5Path(rootDir, artifact.temp_path, prefix);
    const expectedDirectories = [
      layout.stagingPath,
      layout.finalRunPath,
      `${layout.finalRunPath}/catalog`,
      `${layout.finalRunPath}/sources`
    ];
    const observed = await runB5PostPreflightStateContinuityChild(rootDir, plan, {
      target_path: artifact.temp_path,
      mutation_kind: "replace",
      replacementBytes: prefix,
      outside_path: join(outsideRoot, "original-temp"),
      expected_leaf_paths: [layout.intentPath, artifact.temp_path],
      expected_directory_paths: expectedDirectories,
      require_final_absence: false,
      require_target_absence: false,
      final_run_path: layout.finalRunPath,
      intent_path: layout.intentPath,
      intent_candidate_path: layout.intentCandidatePath
    });
    assert.notEqual(observed.original_target_inode, observed.replacement_target_inode);
    assert.equal(observed.target_exists_after, true, "replacement temp was unlinked");
    assert.equal(observed.target_inode_after, observed.replacement_target_inode);
    assert.equal(observed.target_bytes_match_after, true);
    assert.equal(observed.intent_exists, true);
    assert.deepEqual(observed.tree_after_run, observed.tree_after_hook);
    assert.deepEqual(
      observed.result,
      b5ExpectedFailure("RUN_CONFLICT", artifact.temp_path)
    );
  });

  await t.test("a full artifact temp appearing after an absent preflight remains unclaimed", async (t) => {
    const rootDir = await makeB5Root(t, "continuity-temp-absent");
    const plan = makeB5GoldenPlan();
    const layout = expectedB5Layout(plan);
    const sentinel = layout.artifactIntents[0];
    const artifact = layout.artifactIntents[1];
    const bytes = b5ArtifactBytes(plan, artifact.relative_path);
    await writeB5Intent(rootDir, layout);
    await mkdir(join(rootDir, layout.finalRunPath, "catalog"), { recursive: true });
    await mkdir(join(rootDir, layout.finalRunPath, "sources"), { recursive: true });
    await writeB5Path(
      rootDir,
      sentinel.canonical_path,
      b5ArtifactBytes(plan, sentinel.relative_path)
    );
    const expectedDirectories = [
      layout.stagingPath,
      layout.finalRunPath,
      `${layout.finalRunPath}/catalog`,
      `${layout.finalRunPath}/sources`
    ];
    const observed = await runB5PostPreflightStateContinuityChild(rootDir, plan, {
      target_path: artifact.temp_path,
      mutation_kind: "create",
      replacementBytes: bytes,
      outside_path: null,
      expected_leaf_paths: [layout.intentPath, sentinel.canonical_path],
      expected_directory_paths: expectedDirectories,
      require_final_absence: false,
      require_target_absence: true,
      final_run_path: layout.finalRunPath,
      intent_path: layout.intentPath,
      intent_candidate_path: layout.intentCandidatePath
    });
    assert.equal(observed.target_exists_after, true, "appearing temp was unlinked");
    assert.equal(observed.target_inode_after, observed.replacement_target_inode);
    assert.equal(observed.target_bytes_match_after, true);
    assert.equal(observed.intent_exists, true);
    assert.deepEqual(observed.tree_after_run, observed.tree_after_hook);
    assert.deepEqual(
      observed.result,
      b5ExpectedFailure("RUN_CONFLICT", artifact.temp_path)
    );
  });

  await t.test("the fixed .local ancestor remains bound after its ensure proof", async (t) => {
    const rootDir = await makeB5Root(t, "fixed-ancestor-local");
    const outsideRoot = await makeB5Root(t, "fixed-ancestor-local-outside");
    const plan = makeB5GoldenPlan();
    const layout = expectedB5Layout(plan);
    await mkdir(join(rootDir, layout.stagingPath), { recursive: true });
    const plannedLeafPaths = [
      layout.intentPath,
      layout.intentCandidatePath,
      ...layout.artifactIntents.flatMap((artifact) => [
        artifact.canonical_path,
        artifact.temp_path
      ])
    ];
    const observed = await runB5FixedAncestorContinuityChild(rootDir, plan, {
      ancestor_path: ".local",
      moved_ancestor_path: join(outsideRoot, "moved-local"),
      outside_root: outsideRoot,
      leaf_parent_path: layout.stagingPath,
      expected_leaf_paths: [],
      expected_directory_paths: [layout.stagingPath],
      require_final_absence: true,
      final_run_path: layout.finalRunPath,
      planned_leaf_paths: plannedLeafPaths
    });
    assert.equal(observed.final_root_absence_observed, true);
    assert.deepEqual(
      observed.moved_ancestor_identity_after_run,
      observed.old_ancestor_identity
    );
    assert.deepEqual(
      observed.replacement_symlink_identity_after_run,
      observed.replacement_symlink_identity_at_hook
    );
    assert.deepEqual(
      observed.leaf_parent_identity_after_run,
      observed.leaf_parent_identity_before
    );
    assert.deepEqual(
      observed.moved_leaf_parent_identity_after_run,
      observed.leaf_parent_identity_before
    );
    assert.deepEqual(
      observed.planned_leaf_paths_after_run,
      observed.planned_leaf_paths_after_hook
    );
    assert.deepEqual(observed.root_tree_after_run, observed.root_tree_after_hook);
    assert.deepEqual(observed.outside_tree_after_run, observed.outside_tree_after_hook);
    assert.deepEqual(
      observed.result,
      b5ExpectedFailure("LOCAL_STATE_INVALID", ".local")
    );
  });

  await t.test("the fixed .local/tmp ancestor remains bound after its ensure proof", async (t) => {
    const rootDir = await makeB5Root(t, "fixed-ancestor-local-tmp");
    const outsideRoot = await makeB5Root(t, "fixed-ancestor-local-tmp-outside");
    const plan = makeB5GoldenPlan();
    const layout = expectedB5Layout(plan);
    await mkdir(join(rootDir, layout.stagingPath), { recursive: true });
    const plannedLeafPaths = [
      layout.intentPath,
      layout.intentCandidatePath,
      ...layout.artifactIntents.flatMap((artifact) => [
        artifact.canonical_path,
        artifact.temp_path
      ])
    ];
    const observed = await runB5FixedAncestorContinuityChild(rootDir, plan, {
      ancestor_path: ".local/tmp",
      moved_ancestor_path: join(outsideRoot, "moved-tmp"),
      outside_root: outsideRoot,
      leaf_parent_path: layout.stagingPath,
      expected_leaf_paths: [],
      expected_directory_paths: [layout.stagingPath],
      require_final_absence: true,
      final_run_path: layout.finalRunPath,
      planned_leaf_paths: plannedLeafPaths
    });
    assert.equal(observed.final_root_absence_observed, true);
    assert.deepEqual(
      observed.moved_ancestor_identity_after_run,
      observed.old_ancestor_identity
    );
    assert.deepEqual(
      observed.replacement_symlink_identity_after_run,
      observed.replacement_symlink_identity_at_hook
    );
    assert.deepEqual(
      observed.leaf_parent_identity_after_run,
      observed.leaf_parent_identity_before
    );
    assert.deepEqual(
      observed.moved_leaf_parent_identity_after_run,
      observed.leaf_parent_identity_before
    );
    assert.deepEqual(
      observed.planned_leaf_paths_after_run,
      observed.planned_leaf_paths_after_hook
    );
    assert.deepEqual(observed.root_tree_after_run, observed.root_tree_after_hook);
    assert.deepEqual(observed.outside_tree_after_run, observed.outside_tree_after_hook);
    assert.deepEqual(
      observed.result,
      b5ExpectedFailure("LOCAL_STATE_INVALID", ".local/tmp")
    );
  });

  await t.test("the fixed .local/cleaned ancestor remains bound after its ensure proof", async (t) => {
    const rootDir = await makeB5Root(t, "fixed-ancestor-local-cleaned");
    const outsideRoot = await makeB5Root(t, "fixed-ancestor-local-cleaned-outside");
    const plan = makeB5GoldenPlan();
    const layout = expectedB5Layout(plan);
    await writeB5Intent(rootDir, layout);
    await mkdir(join(rootDir, layout.finalRunPath, "catalog"), { recursive: true });
    await mkdir(join(rootDir, layout.finalRunPath, "sources"), { recursive: true });
    const expectedDirectories = [
      layout.stagingPath,
      layout.finalRunPath,
      `${layout.finalRunPath}/catalog`,
      `${layout.finalRunPath}/sources`
    ];
    const plannedLeafPaths = [
      layout.intentPath,
      layout.intentCandidatePath,
      ...layout.artifactIntents.flatMap((artifact) => [
        artifact.canonical_path,
        artifact.temp_path
      ])
    ];
    const observed = await runB5FixedAncestorContinuityChild(rootDir, plan, {
      ancestor_path: ".local/cleaned",
      moved_ancestor_path: join(outsideRoot, "moved-cleaned"),
      outside_root: outsideRoot,
      leaf_parent_path: `${layout.finalRunPath}/catalog`,
      expected_leaf_paths: [layout.intentPath],
      expected_directory_paths: expectedDirectories,
      require_final_absence: false,
      final_run_path: layout.finalRunPath,
      planned_leaf_paths: plannedLeafPaths
    });
    assert.deepEqual(
      observed.moved_ancestor_identity_after_run,
      observed.old_ancestor_identity
    );
    assert.deepEqual(
      observed.replacement_symlink_identity_after_run,
      observed.replacement_symlink_identity_at_hook
    );
    assert.deepEqual(
      observed.leaf_parent_identity_after_run,
      observed.leaf_parent_identity_before
    );
    assert.deepEqual(
      observed.moved_leaf_parent_identity_after_run,
      observed.leaf_parent_identity_before
    );
    assert.deepEqual(
      observed.planned_leaf_paths_after_run,
      observed.planned_leaf_paths_after_hook
    );
    assert.deepEqual(observed.root_tree_after_run, observed.root_tree_after_hook);
    assert.deepEqual(observed.outside_tree_after_run, observed.outside_tree_after_hook);
    assert.deepEqual(
      observed.result,
      b5ExpectedFailure("LOCAL_STATE_INVALID", ".local/cleaned")
    );
  });

  await t.test("the fixed .local/cleaned/runs ancestor remains bound after its ensure proof", async (t) => {
    const rootDir = await makeB5Root(t, "fixed-ancestor-runs");
    const outsideRoot = await makeB5Root(t, "fixed-ancestor-runs-outside");
    const plan = makeB5GoldenPlan();
    const layout = expectedB5Layout(plan);
    await writeB5Intent(rootDir, layout);
    await mkdir(join(rootDir, layout.finalRunPath, "catalog"), { recursive: true });
    await mkdir(join(rootDir, layout.finalRunPath, "sources"), { recursive: true });
    const expectedDirectories = [
      layout.stagingPath,
      layout.finalRunPath,
      `${layout.finalRunPath}/catalog`,
      `${layout.finalRunPath}/sources`
    ];
    const plannedLeafPaths = [
      layout.intentPath,
      layout.intentCandidatePath,
      ...layout.artifactIntents.flatMap((artifact) => [
        artifact.canonical_path,
        artifact.temp_path
      ])
    ];
    const observed = await runB5FixedAncestorContinuityChild(rootDir, plan, {
      ancestor_path: B5_RUNS_ROOT,
      moved_ancestor_path: join(outsideRoot, "moved-runs"),
      outside_root: outsideRoot,
      leaf_parent_path: `${layout.finalRunPath}/catalog`,
      expected_leaf_paths: [layout.intentPath],
      expected_directory_paths: expectedDirectories,
      require_final_absence: false,
      final_run_path: layout.finalRunPath,
      planned_leaf_paths: plannedLeafPaths
    });
    assert.deepEqual(
      observed.moved_ancestor_identity_after_run,
      observed.old_ancestor_identity
    );
    assert.deepEqual(
      observed.replacement_symlink_identity_after_run,
      observed.replacement_symlink_identity_at_hook
    );
    assert.deepEqual(
      observed.leaf_parent_identity_after_run,
      observed.leaf_parent_identity_before
    );
    assert.deepEqual(
      observed.moved_leaf_parent_identity_after_run,
      observed.leaf_parent_identity_before
    );
    assert.deepEqual(
      observed.planned_leaf_paths_after_run,
      observed.planned_leaf_paths_after_hook
    );
    assert.deepEqual(observed.root_tree_after_run, observed.root_tree_after_hook);
    assert.deepEqual(observed.outside_tree_after_run, observed.outside_tree_after_hook);
    assert.deepEqual(
      observed.result,
      b5ExpectedFailure("LOCAL_STATE_INVALID", B5_RUNS_ROOT)
    );
  });
});

function assertB5DeepFrozenWithoutBytes(value, seen = new Set()) {
  if (value === null || typeof value !== "object" || seen.has(value)) return;
  seen.add(value);
  assert.equal(Buffer.isBuffer(value), false, "success result must not expose artifact bytes");
  assert.equal(Object.isFrozen(value), true);
  for (const key of Reflect.ownKeys(value)) {
    assert.notEqual(key, "bytes", "success result must not expose a bytes field");
    assertB5DeepFrozenWithoutBytes(value[key], seen);
  }
}

test("B5 success value is exact, detached, recursively frozen, and contains no artifact bytes", async (t) => {
  const stageCleaningRun = await loadStageCleaningRun();
  const rootDir = await makeB5Root(t, "frozen-detached");
  const plan = makeB5GoldenPlan();
  const expectedPlan = cloneB5Plan(plan);
  const layout = expectedB5Layout(expectedPlan);
  const pending = stageCleaningRun(b5Options(rootDir, plan));
  plan.manifest.run_preimage.cleaner_version = "caller mutation after invocation";
  plan.manifest.artifact_manifest[0].relative_path = "caller-mutated";
  plan.artifacts[0].bytes.fill(0x78);
  const result = await pending;

  assert.deepEqual(result, layout.success(true));
  assert.deepEqual(Object.keys(result), ["ok", "value"]);
  assert.deepEqual(Object.keys(result.value), [
    "kind",
    "staged_run",
    "persistent_writes_occurred"
  ]);
  assert.deepEqual(Object.keys(result.value.staged_run), [
    "plan_manifest",
    "plan_manifest_sha256",
    "run_sha256",
    "staging_path",
    "final_run_path",
    "artifact_manifest"
  ]);
  assert.notEqual(result.value.staged_run.plan_manifest, plan.manifest);
  assert.notEqual(
    result.value.staged_run.artifact_manifest,
    plan.manifest.artifact_manifest
  );
  assert.equal("artifacts" in result.value.staged_run, false);
  assertB5DeepFrozenWithoutBytes(result);
  assert.throws(() => {
    result.value.staged_run.plan_manifest.state_mode = "mutated";
  }, TypeError);
  assert.throws(() => {
    result.value.staged_run.artifact_manifest.push({});
  }, TypeError);
});

test("B5 caller orchestration serializes staging and makes no overlapping-process safety claim", async (t) => {
  const stageCleaningRun = await loadStageCleaningRun();
  const rootDir = await makeB5Root(t, "serialized-orchestration");
  const plan = makeB5GoldenPlan();
  const layout = expectedB5Layout(plan);
  let tail = Promise.resolve();
  let active = 0;
  let maximumActive = 0;
  function enqueueSerializedStage() {
    const operation = tail.then(async () => {
      active += 1;
      maximumActive = Math.max(maximumActive, active);
      try {
        return await stageCleaningRun(b5Options(rootDir, plan));
      } finally {
        active -= 1;
      }
    });
    tail = operation.then(() => undefined, () => undefined);
    return operation;
  }

  // This is the B6/B7 caller boundary: these tests intentionally do not call
  // stageCleaningRun concurrently or infer cross-process overlap safety.
  const first = enqueueSerializedStage();
  const second = enqueueSerializedStage();
  assert.deepEqual(await first, layout.success(true));
  assert.deepEqual(await second, layout.success(false));
  assert.equal(maximumActive, 1);
});

const B6_FINAL_GATE_ROOT_BOUNDARY_CHILD_SCRIPT = [
  'import fs from "node:fs";',
  'import { syncBuiltinESMExports } from "node:module";',
  'import { join, relative, sep } from "node:path";',
  '',
  'const [moduleUrl, rootDir, encodedStagedRun, scenario, encodedReplacement, encodedDesired] = process.argv.slice(1);',
  'const stagedRun = JSON.parse(Buffer.from(encodedStagedRun, "base64").toString("utf8"));',
  'const replacementBytes = Buffer.from(encodedReplacement, "base64");',
  'const desiredBytes = Buffer.from(encodedDesired, "base64");',
  'const realRoot = fs.realpathSync(rootDir);',
  'const stateDir = join(realRoot, ".local", "state");',
  'const transitionsDir = join(stateDir, "cleaning-transitions");',
  'const pointerPath = join(stateDir, "current-cleaning.json");',
  'const lockPath = join(stateDir, "cleaning-commit.lock");',
  'const externalPath = join(realRoot, "external-final-gate-" + scenario);',
  'const original = {',
  '  open: fs.promises.open,',
  '  writeFile: fs.promises.writeFile,',
  '  readFile: fs.promises.readFile,',
  '  unlink: fs.promises.unlink,',
  '  link: fs.promises.link',
  '};',
  'let triggered = false;',
  'let replacedPath = null;',
  'let externalBefore = null;',
  'let pointerTempSynced = false;',
  'let terminalLinked = false;',
  'let terminalRecordSynced = false;',
  'let terminalCandidate = null;',
  'let terminalCandidateCleaned = false;',
  'let terminalCleanupDurable = false;',
  '',
  'function names(path) {',
  '  try { return fs.readdirSync(path); } catch { return []; }',
  '}',
  'function pointerTempPath() {',
  '  const name = names(stateDir).find((entry) =>',
  '    entry.startsWith(".current-cleaning.") && entry.endsWith(".tmp"));',
  '  return name === undefined ? null : join(stateDir, name);',
  '}',
  'function terminalCandidatePath() {',
  '  const name = names(transitionsDir).find((entry) =>',
  '    entry.startsWith(".complete-") && entry.endsWith(".tmp"));',
  '  return name === undefined ? null : join(transitionsDir, name);',
  '}',
  'function completionPath() {',
  '  const name = names(transitionsDir).find((entry) =>',
  '    entry.startsWith("complete-") && entry.endsWith(".json"));',
  '  return name === undefined ? null : join(transitionsDir, name);',
  '}',
  'function repoPath(path) {',
  '  return relative(realRoot, path).split(sep).join("/");',
  '}',
  'async function replaceLeaf(path, bytes) {',
  '  await original.writeFile(externalPath, bytes, { flag: "wx", mode: 0o600 });',
  '  externalBefore = bytes.toString("base64");',
  '  await original.unlink(path);',
  '  await original.link(externalPath, path);',
  '  triggered = true;',
  '  replacedPath = repoPath(path);',
  '}',
  '',
  'fs.promises.open = async (...args) => {',
  '  const openedPath = String(args[0]);',
  '  const handle = await original.open(...args);',
  '  if (!triggered && openedPath === realRoot) {',
  '    if (scenario === "pointer" && pointerTempSynced) {',
  '      await replaceLeaf(pointerPath, replacementBytes);',
  '    } else if (scenario === "candidate" && terminalRecordSynced &&',
  '        terminalCandidate !== null && fs.existsSync(terminalCandidate)) {',
  '      await replaceLeaf(',
  '        terminalCandidate,',
  '        await original.readFile(terminalCandidate)',
  '      );',
  '    } else if (scenario === "release" && terminalCleanupDurable &&',
  '        fs.existsSync(lockPath)) {',
  '      await replaceLeaf(lockPath, replacementBytes);',
  '    }',
  '  }',
  '  if (openedPath !== pointerTempPath() && openedPath !== transitionsDir) {',
  '    return handle;',
  '  }',
  '  return new Proxy(handle, {',
  '    get(target, property) {',
  '      if (property === "sync") {',
  '        return async (...methodArgs) => {',
  '          const value = await target.sync(...methodArgs);',
  '          if (openedPath === pointerTempPath()) pointerTempSynced = true;',
  '          if (openedPath === transitionsDir && terminalLinked) {',
  '            if (terminalCandidateCleaned) {',
  '              terminalCleanupDurable = true;',
  '            } else if (terminalCandidate !== null &&',
  '                fs.existsSync(terminalCandidate)) {',
  '              terminalRecordSynced = true;',
  '            }',
  '          }',
  '          return value;',
  '        };',
  '      }',
  '      const member = Reflect.get(target, property, target);',
  '      return typeof member === "function" ? member.bind(target) : member;',
  '    }',
  '  });',
  '};',
  'fs.promises.link = async (...args) => {',
  '  const value = await original.link(...args);',
  '  const destination = String(args[1]);',
  '  if (destination.startsWith(join(transitionsDir, "complete-")) &&',
  '      destination.endsWith(".json")) {',
  '    terminalLinked = true;',
  '    terminalCandidate = String(args[0]);',
  '  }',
  '  return value;',
  '};',
  'fs.promises.unlink = async (...args) => {',
  '  const value = await original.unlink(...args);',
  '  if (terminalCandidate !== null && String(args[0]) === terminalCandidate) {',
  '    terminalCandidateCleaned = true;',
  '  }',
  '  return value;',
  '};',
  'syncBuiltinESMExports();',
  '',
  'const { publishCleaningRun } = await import(moduleUrl);',
  'const result = await publishCleaningRun({',
  '  rootDir,',
  '  runsRoot: ".local/cleaned/runs",',
  '  currentPointer: ".local/state/current-cleaning.json",',
  '  stagedRun',
  '});',
  'const externalAfter = externalBefore === null',
  '  ? null',
  '  : (await original.readFile(externalPath)).toString("base64");',
  'const replacedAbsolutePath = replacedPath === null',
  '  ? null',
  '  : join(realRoot, ...replacedPath.split("/"));',
  'process.stdout.write(JSON.stringify({',
  '  result,',
  '  triggered,',
  '  replaced_path: replacedPath,',
  '  external_before: externalBefore,',
  '  external_after: externalAfter,',
  '  replaced_path_exists: replacedAbsolutePath === null',
  '    ? null',
  '    : fs.existsSync(replacedAbsolutePath),',
  '  pointer_after: fs.existsSync(pointerPath)',
  '    ? (await original.readFile(pointerPath)).toString("base64")',
  '    : null,',
  '  desired_bytes: desiredBytes.toString("base64"),',
  '  replacement_bytes: replacementBytes.toString("base64"),',
  '  lock_exists: fs.existsSync(lockPath),',
  '  lock_after: fs.existsSync(lockPath)',
  '    ? (await original.readFile(lockPath)).toString("base64")',
  '    : null',
  '}));'
].join("\n");

test("B6 rename and unlink final gates reprove targets after the root ancestor pass", async (t) => {
  const stageCleaningRun = await loadStageCleaningRun();
  const publishCleaningRun = await loadPublishCleaningRun();
  for (const scenario of ["pointer", "candidate", "release"]) {
    await t.test(scenario, async (t) => {
      const rootDir = await makeB5Root(t, "b6-final-gate-" + scenario);
      let plan;
      if (scenario === "pointer") {
        const initialPlan = makeB5GoldenPlan();
        const initial = await stageCleaningRun(b5Options(rootDir, initialPlan));
        assert.equal(initial.ok, true);
        assert.equal(
          (await publishCleaningRun(
            b6Options(rootDir, initial.value.staged_run)
          )).ok,
          true
        );
        plan = makeB6IncrementalPlan(initialPlan);
      } else {
        plan = makeB5GoldenPlan();
      }
      const staged = await stageCleaningRun(b5Options(rootDir, plan));
      assert.equal(staged.ok, true);
      const replacementBytes = scenario === "pointer"
        ? canonicalJsonDocumentBytes(makeB5EmptyPlan().manifest.desired_pointer)
        : scenario === "release"
          ? canonicalJsonDocumentBytes(
            makeB6CommitLockIntent(plan, 515151, "9".repeat(32))
          )
          : Buffer.alloc(0);
      const desiredBytes = canonicalJsonDocumentBytes(
        plan.manifest.desired_pointer
      );
      const child = await runBoundedChild(process.execPath, [
        "--input-type=module",
        "--eval",
        B6_FINAL_GATE_ROOT_BOUNDARY_CHILD_SCRIPT,
        B5_MODULE_URL,
        rootDir,
        encodeB6StagedRun(staged.value.staged_run),
        scenario,
        replacementBytes.toString("base64"),
        desiredBytes.toString("base64")
      ]);
      assert.equal(child.timedOut, false, child.stderr);
      assert.equal(child.code, 0, child.stderr);
      const observed = JSON.parse(child.stdout);
      assert.equal(observed.triggered, true, child.stdout);
      assert.equal(observed.external_after, observed.external_before);
      assert.equal(observed.lock_exists, true, child.stdout);
      if (scenario === "pointer") {
        assert.deepEqual(
          observed.result,
          b5ExpectedFailure(
            "STALE_POINTER_TRANSITION",
            B6_CURRENT_POINTER,
            true
          )
        );
        assert.equal(observed.pointer_after, observed.replacement_bytes);
      } else {
        assert.deepEqual(
          observed.result,
          b5ExpectedFailure(
            "LOCAL_STATE_INVALID",
            scenario === "candidate"
              ? observed.replaced_path
              : ".local/state/cleaning-commit.lock",
            true
          )
        );
        assert.equal(observed.pointer_after, observed.desired_bytes);
        assert.equal(observed.replaced_path_exists, true);
        if (scenario === "release") {
          assert.equal(observed.lock_after, observed.replacement_bytes);
        }
      }
    });
  }
});

const B7_CONFIRMATION = "RECOVER_INTERRUPTED_CLEANING_COMMIT";

function b7Options(rootDir, confirmation = B7_CONFIRMATION) {
  return { rootDir, confirmation };
}

function b7NoUnresolvedTargetResult() {
  return {
    ok: true,
    value: {
      kind: "no_unresolved_target",
      selected_target_commit_lock_sha256: null,
      current_fixed_commit_lock_sha256: null,
      active_lease_path: null,
      final_pointer: null,
      transition_record_path: null,
      commit_lock_cleanup: "already_absent",
      persistent_writes_occurred: false
    }
  };
}

test("B7 recovery entry is the only new exact run-store export", async () => {
  await loadRecoverInterruptedCleaningCommit();
});

test("B7 recovery rejects every non-exact option shape and type before filesystem access", async (t) => {
  const recoverInterruptedCleaningCommit =
    await loadRecoverInterruptedCleaningCommit();
  const container = await makeB5Root(t, "b7-options");
  const unavailableRoot = join(container, "must-not-be-resolved");
  const valid = b7Options(unavailableRoot);
  let rootGetterCalls = 0;
  let confirmationGetterCalls = 0;
  const rootAccessor = { confirmation: B7_CONFIRMATION };
  Object.defineProperty(rootAccessor, "rootDir", {
    enumerable: true,
    get() {
      rootGetterCalls += 1;
      throw new Error("rootDir accessor must not run");
    }
  });
  const confirmationAccessor = { rootDir: unavailableRoot };
  Object.defineProperty(confirmationAccessor, "confirmation", {
    enumerable: true,
    get() {
      confirmationGetterCalls += 1;
      throw new Error("confirmation accessor must not run");
    }
  });
  class RecoveryOptions {
    constructor() {
      this.rootDir = unavailableRoot;
      this.confirmation = B7_CONFIRMATION;
    }
  }
  const trackedProxy = makeTrackedProxy(valid);
  const withSymbol = { ...valid };
  withSymbol[Symbol("extra")] = true;
  const missingRoot = { ...valid };
  delete missingRoot.rootDir;
  const missingConfirmation = { ...valid };
  delete missingConfirmation.confirmation;

  const invalidCalls = [
    () => recoverInterruptedCleaningCommit(),
    () => recoverInterruptedCleaningCommit(null),
    () => recoverInterruptedCleaningCommit([]),
    () => recoverInterruptedCleaningCommit(new RecoveryOptions()),
    () => recoverInterruptedCleaningCommit(Object.create(valid)),
    () => recoverInterruptedCleaningCommit({ ...valid, extra: true }),
    () => recoverInterruptedCleaningCommit(withSymbol),
    () => recoverInterruptedCleaningCommit(missingRoot),
    () => recoverInterruptedCleaningCommit(missingConfirmation),
    () => recoverInterruptedCleaningCommit(rootAccessor),
    () => recoverInterruptedCleaningCommit(confirmationAccessor),
    () => recoverInterruptedCleaningCommit(trackedProxy.value),
    () => recoverInterruptedCleaningCommit({ ...valid, rootDir: "" }),
    () => recoverInterruptedCleaningCommit({ ...valid, rootDir: 1 }),
    () => recoverInterruptedCleaningCommit({ ...valid, confirmation: null })
  ];
  for (const invoke of invalidCalls) await assert.rejects(invoke, TypeError);
  assert.equal(rootGetterCalls, 0);
  assert.equal(confirmationGetterCalls, 0);
  assert.equal(trackedProxy.getTrapCalls(), 0);
  assert.deepEqual(await snapshotB5Tree(container), []);
});

test("B7 wrong recovery confirmation is exact, frozen, and never traverses state", async (t) => {
  const recoverInterruptedCleaningCommit =
    await loadRecoverInterruptedCleaningCommit();
  const container = await makeB5Root(t, "b7-confirmation");
  const unavailableRoot = join(container, "must-not-be-resolved");

  for (const confirmation of ["", "RECOVER_INTERRUPTED_CLEANING_COMMIT ", "wrong"]) {
    const result = await recoverInterruptedCleaningCommit(
      b7Options(unavailableRoot, confirmation)
    );
    assert.deepEqual(
      result,
      b5ExpectedFailure("RECOVERY_CONFIRMATION_REQUIRED")
    );
    assertB5DeepFrozenWithoutBytes(result);
  }
  assert.deepEqual(await snapshotB5Tree(container), []);
});

test("B7 confirmed recovery maps unavailable root to exact zero-write realpath I/O failure", async (t) => {
  const recoverInterruptedCleaningCommit =
    await loadRecoverInterruptedCleaningCommit();
  const container = await makeB5Root(t, "b7-realpath-failure");
  const unavailableRoot = join(container, "missing-root");

  const result = await recoverInterruptedCleaningCommit(b7Options(unavailableRoot));

  assert.deepEqual(result, b5IoFailure("realpath", null, false));
  assertB5DeepFrozenWithoutBytes(result);
  assert.deepEqual(await snapshotB5Tree(container), []);
});

test("B7 confirmed no-lock no-history recovery anchors root synchronously and returns exact frozen success", async (t) => {
  const recoverInterruptedCleaningCommit =
    await loadRecoverInterruptedCleaningCommit();
  const container = await makeB5Root(t, "b7-no-history");
  const realRoot = join(container, "real");
  const replacementRoot = join(container, "replacement");
  const aliasRoot = join(container, "alias");
  await mkdir(join(realRoot, ".local", "state"), {
    recursive: true,
    mode: 0o700
  });
  await mkdir(replacementRoot, { mode: 0o700 });
  await symlink("real", aliasRoot);
  const before = await snapshotB5Tree(realRoot);

  const pending = recoverInterruptedCleaningCommit(b7Options(aliasRoot));
  await unlink(aliasRoot);
  await symlink("replacement", aliasRoot);
  const result = await pending;

  assert.deepEqual(result, b7NoUnresolvedTargetResult());
  assert.deepEqual(Object.keys(result.value), [
    "kind",
    "selected_target_commit_lock_sha256",
    "current_fixed_commit_lock_sha256",
    "active_lease_path",
    "final_pointer",
    "transition_record_path",
    "commit_lock_cleanup",
    "persistent_writes_occurred"
  ]);
  assertB5DeepFrozenWithoutBytes(result);
  assert.deepEqual(await snapshotB5Tree(realRoot), before);
  assert.deepEqual(await snapshotB5Tree(replacementRoot), []);
});

const B7_FIXED_COMMIT_LOCK = ".local/state/cleaning-commit.lock";

async function makeB7StagedRoot(t, label) {
  const stageCleaningRun = await loadStageCleaningRun();
  const rootDir = await makeB5Root(t, label);
  const plan = makeB5GoldenPlan();
  const staged = await stageCleaningRun(b5Options(rootDir, plan));
  assert.equal(staged.ok, true);
  await mkdir(join(rootDir, ".local", "state"), {
    recursive: true,
    mode: 0o700
  });
  return { rootDir, plan, stagedRun: staged.value.staged_run };
}

async function writeB7FixedLock(rootDir, intent, mode = 0o600) {
  const bytes = Buffer.isBuffer(intent)
    ? Buffer.from(intent)
    : canonicalJsonDocumentBytes(intent);
  const lockPath = join(rootDir, B7_FIXED_COMMIT_LOCK);
  await writeFile(lockPath, bytes, { mode });
  await chmod(lockPath, mode);
  assert.equal((await lstat(lockPath)).mode & 0o7777, mode);
  return bytes;
}

async function requireB7ExactModeOrSkip(t, absolutePath, expectedMode) {
  const retainedMode = (await lstat(absolutePath)).mode & 0o7777;
  if (retainedMode === expectedMode) return true;
  t.skip(
    `host did not retain requested mode ${expectedMode.toString(8)}; ` +
      `observed ${retainedMode.toString(8)}`
  );
  return false;
}

const B7_RECOVERY_CHILD_SCRIPT = `
const [moduleUrl, rootDir, confirmation] = process.argv.slice(1);
const { recoverInterruptedCleaningCommit } = await import(moduleUrl);
const result = await recoverInterruptedCleaningCommit({ rootDir, confirmation });
process.stdout.write(JSON.stringify(result));
`;

const B7_KILL_GATE_CHILD_SCRIPT = `
import { syncBuiltinESMExports } from "node:module";

const [moduleUrl, rootDir, confirmation, mode] = process.argv.slice(1);
const originalKill = process.kill;
const calls = [];
process.kill = (pid, signal) => {
  calls.push([pid, signal]);
  if (mode === "success") return true;
  const error = new Error("synthetic process.kill " + mode);
  error.code = mode;
  throw error;
};
syncBuiltinESMExports();
let result;
try {
  const { recoverInterruptedCleaningCommit } = await import(moduleUrl);
  result = await recoverInterruptedCleaningCommit({ rootDir, confirmation });
} finally {
  process.kill = originalKill;
  syncBuiltinESMExports();
}
process.stdout.write(JSON.stringify({ result, calls }));
`;

const B7_LOCK_IDENTITY_REPLACEMENT_CHILD_SCRIPT = `
import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { join } from "node:path";

const [moduleUrl, rootDir, confirmation, movedPath, sentinelPath] =
  process.argv.slice(1);
const realRoot = fs.realpathSync(rootDir);
const lockPath = join(realRoot, ".local", "state", "cleaning-commit.lock");
const lockBytes = await fs.promises.readFile(lockPath);
const sentinelBefore = await fs.promises.readFile(sentinelPath);
const originalOpen = fs.promises.open;
const originalRename = fs.promises.rename;
const originalWriteFile = fs.promises.writeFile;
let triggered = false;
fs.promises.open = async (...args) => {
  if (!triggered && args[0] === lockPath) {
    triggered = true;
    await originalRename(lockPath, movedPath);
    await originalWriteFile(lockPath, lockBytes, { flag: "wx", mode: 0o600 });
  }
  return originalOpen(...args);
};
syncBuiltinESMExports();
let result;
try {
  const { recoverInterruptedCleaningCommit } = await import(moduleUrl);
  result = await recoverInterruptedCleaningCommit({ rootDir, confirmation });
} finally {
  fs.promises.open = originalOpen;
  syncBuiltinESMExports();
}
process.stdout.write(JSON.stringify({
  result,
  triggered,
  lock_after: (await fs.promises.readFile(lockPath)).toString("base64"),
  moved_after: fs.existsSync(movedPath)
    ? (await fs.promises.readFile(movedPath)).toString("base64")
    : null,
  sentinel_before: sentinelBefore.toString("base64"),
  sentinel_after: (await fs.promises.readFile(sentinelPath)).toString("base64")
}));
`;

const B7_NO_HISTORY_FSYNC_CHILD_SCRIPT = `
import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { join } from "node:path";

const [moduleUrl, rootDir, confirmation, mode] = process.argv.slice(1);
const realRoot = fs.realpathSync(rootDir);
const statePath = join(realRoot, ".local", "state");
const original = {
  open: fs.promises.open,
  mkdir: fs.promises.mkdir,
  writeFile: fs.promises.writeFile,
  link: fs.promises.link,
  unlink: fs.promises.unlink,
  rename: fs.promises.rename
};
const stateSyncPaths = [];
const mutatingCalls = [];
for (const name of ["mkdir", "writeFile", "link", "unlink", "rename"]) {
  fs.promises[name] = async (...args) => {
    mutatingCalls.push([name, String(args[0])]);
    return original[name](...args);
  };
}
fs.promises.open = async (...args) => {
  const [path, flags] = args;
  const numericFlags = typeof flags === "number" ? flags : 0;
  if ((numericFlags & (fs.constants.O_WRONLY | fs.constants.O_RDWR |
      fs.constants.O_CREAT | fs.constants.O_TRUNC | fs.constants.O_APPEND)) !== 0 ||
      (typeof flags === "string" && /[wax+]/.test(flags))) {
    mutatingCalls.push(["open", String(path)]);
  }
  const handle = await original.open(...args);
  if (path !== statePath) return handle;
  return new Proxy(handle, {
    get(target, property) {
      if (property === "sync") {
        return async () => {
          stateSyncPaths.push(".local/state");
          if (mode === "fail") {
            const error = new Error("synthetic state directory fsync failure");
            error.code = "EIO";
            throw error;
          }
          return target.sync();
        };
      }
      if (property === "write" || property === "writeFile") {
        return async (...writeArgs) => {
          mutatingCalls.push([String(property), statePath]);
          return target[property](...writeArgs);
        };
      }
      const value = Reflect.get(target, property, target);
      return typeof value === "function" ? value.bind(target) : value;
    }
  });
};
syncBuiltinESMExports();
let result;
try {
  const { recoverInterruptedCleaningCommit } = await import(moduleUrl);
  result = await recoverInterruptedCleaningCommit({ rootDir, confirmation });
} finally {
  Object.assign(fs.promises, original);
  syncBuiltinESMExports();
}
process.stdout.write(JSON.stringify({
  result,
  state_sync_paths: stateSyncPaths,
  mutating_calls: mutatingCalls
}));
`;

test("B7 no-history success performs the exact state-directory fsync with no mutating syscall", async (t) => {
  const rootDir = await makeB5Root(t, "b7-no-history-fsync");
  await mkdir(join(rootDir, ".local", "state"), {
    recursive: true,
    mode: 0o700
  });
  const before = await snapshotB5Tree(rootDir);

  for (const mode of ["trace", "fail"]) {
    await t.test(mode, async () => {
      const child = await runBoundedChild(process.execPath, [
        "--input-type=module",
        "--eval",
        B7_NO_HISTORY_FSYNC_CHILD_SCRIPT,
        B5_MODULE_URL,
        rootDir,
        B7_CONFIRMATION,
        mode
      ]);
      assert.equal(child.timedOut, false, child.stderr);
      assert.equal(child.code, 0, child.stderr);
      const observed = JSON.parse(child.stdout);
      assert.deepEqual(observed.state_sync_paths, [".local/state"]);
      assert.deepEqual(observed.mutating_calls, []);
      assert.deepEqual(
        observed.result,
        mode === "trace"
          ? b7NoUnresolvedTargetResult()
          : b5IoFailure("fsync", ".local/state", false)
      );
      assert.deepEqual(await snapshotB5Tree(rootDir), before);
    });
  }
});

test("B7 valid fixed lock verifies the complete desired run before live owner zero-write return", async (t) => {
  const recoverInterruptedCleaningCommit =
    await loadRecoverInterruptedCleaningCommit();
  const { rootDir, plan } = await makeB7StagedRoot(t, "b7-live-owner");
  const lockBytes = await writeB7FixedLock(
    rootDir,
    makeB6CommitLockIntent(plan, process.pid, "a".repeat(32))
  );
  const before = await snapshotB5Tree(rootDir);

  const result = await recoverInterruptedCleaningCommit(b7Options(rootDir));

  assert.deepEqual(
    result,
    b5ExpectedFailure("RECOVERY_OWNER_ALIVE", B7_FIXED_COMMIT_LOCK)
  );
  assertB5DeepFrozenWithoutBytes(result);
  assert.deepEqual(await readFile(join(rootDir, B7_FIXED_COMMIT_LOCK)), lockBytes);
  assert.deepEqual(await snapshotB5Tree(rootDir), before);
});

test("B7 desired immutable run failure outranks the original-owner liveness gate", async (t) => {
  const recoverInterruptedCleaningCommit =
    await loadRecoverInterruptedCleaningCommit();
  const { rootDir, plan } = await makeB7StagedRoot(t, "b7-run-before-owner");
  await writeB7FixedLock(
    rootDir,
    makeB6CommitLockIntent(plan, process.pid, "b".repeat(32))
  );
  const missingArtifact = plan.manifest.artifact_manifest[0];
  const missingPath = `${plan.manifest.desired_pointer.run_path}/${missingArtifact.relative_path}`;
  await unlink(join(rootDir, missingPath));
  const before = await snapshotB5Tree(rootDir);

  const result = await recoverInterruptedCleaningCommit(b7Options(rootDir));

  assert.deepEqual(result, b5ExpectedFailure("RUN_CONFLICT", missingPath));
  assert.deepEqual(await snapshotB5Tree(rootDir), before);
});

test("B7 process.kill success and EPERM are alive while ESRCH enters recovery and other errors fail closed", async (t) => {
  const ownerPid = 424242;
  for (const mode of ["success", "EPERM", "ESRCH", "EINVAL"]) {
    await t.test(mode, async (t) => {
      const { rootDir, plan } = await makeB7StagedRoot(t, `b7-kill-${mode}`);
      const fixedBytes = await writeB7FixedLock(
        rootDir,
        makeB6CommitLockIntent(plan, ownerPid, "c".repeat(32))
      );
      const before = await snapshotB5Tree(rootDir);
      const child = await runBoundedChild(process.execPath, [
        "--input-type=module",
        "--eval",
        B7_KILL_GATE_CHILD_SCRIPT,
        B5_MODULE_URL,
        rootDir,
        B7_CONFIRMATION,
        mode
      ]);
      assert.equal(child.timedOut, false, child.stderr);
      assert.equal(child.code, 0, child.stderr);
      const observed = JSON.parse(child.stdout);
      assert.deepEqual(
        observed.calls,
        mode === "ESRCH"
          ? [[ownerPid, 0], [ownerPid, 0], [ownerPid, 0]]
          : [[ownerPid, 0]]
      );
      if (mode === "success" || mode === "EPERM") {
        assert.deepEqual(
          observed.result,
          b5ExpectedFailure("RECOVERY_OWNER_ALIVE", B7_FIXED_COMMIT_LOCK)
        );
        assert.deepEqual(await snapshotB5Tree(rootDir), before);
      } else if (mode === "ESRCH") {
        const currentC = sha256(fixedBytes);
        const targetDir = `${B7_RECOVERY_LEASES_ROOT}/${currentC}`;
        const completion = makeB7CompletionTerminalFixture(plan, currentC);
        assert.deepEqual(
          observed.result,
          {
            ok: true,
            value: {
              kind: "recovered",
              selected_target_commit_lock_sha256: currentC,
              current_fixed_commit_lock_sha256: currentC,
              active_lease_path:
                `${B7_RECOVERY_LEASES_ROOT}/${currentC}/lease-root.json`,
              final_pointer: plan.manifest.desired_pointer,
              transition_record_path: completion.path,
              commit_lock_cleanup: "unlinked_and_fsynced",
              persistent_writes_occurred: true
            }
          }
        );
        assert.deepEqual(
          await readFile(join(rootDir, `${targetDir}/target.json`)),
          makeB7RecoveryTargetFixture(fixedBytes).bytes
        );
        assert.deepEqual(
          await readFile(join(rootDir, completion.path)),
          completion.bytes
        );
        await assert.rejects(
          () => lstat(join(rootDir, B7_FIXED_COMMIT_LOCK)),
          { code: "ENOENT" }
        );
        assert.deepEqual(
          await readFile(join(rootDir, B6_CURRENT_POINTER)),
          canonicalJsonDocumentBytes(plan.manifest.desired_pointer)
        );
        assert.equal(
          (await lstat(join(rootDir, `${targetDir}/lease-root.json`))).isFile(),
          true
        );
        assert.notDeepEqual(await snapshotB5Tree(rootDir), before);
      } else {
        assert.equal(observed.result.ok, false);
        assert.notEqual(observed.result.error.code, "RECOVERY_OWNER_ALIVE");
        assert.equal(observed.result.error.persistent_writes_occurred, false);
        assert.deepEqual(await snapshotB5Tree(rootDir), before);
      }
    });
  }
});

test("B7 malformed, unsafe, and nonregular fixed locks fail closed without traversal or mutation", async (t) => {
  const recoverInterruptedCleaningCommit =
    await loadRecoverInterruptedCleaningCommit();
  const cases = [
    ["missing-LF", async ({ rootDir, plan }) => {
      const bytes = canonicalJsonDocumentBytes(makeB6CommitLockIntent(plan));
      await writeB7FixedLock(rootDir, bytes.subarray(0, -1));
    }],
    ["extra-LF", async ({ rootDir, plan }) => {
      const bytes = canonicalJsonDocumentBytes(makeB6CommitLockIntent(plan));
      await writeB7FixedLock(rootDir, Buffer.concat([bytes, Buffer.from("\n")]))
    }],
    ["wrong-binding", async ({ rootDir, plan }) => {
      const intent = makeB6CommitLockIntent(plan);
      intent.desired_pointer_sha256 = "0".repeat(64);
      await writeB7FixedLock(rootDir, intent);
    }],
    ["mode-1600", async ({ rootDir, plan, t }) => {
      await writeB7FixedLock(rootDir, makeB6CommitLockIntent(plan));
      const lockPath = join(rootDir, B7_FIXED_COMMIT_LOCK);
      await chmod(lockPath, 0o1600);
      if (!(await requireB7ExactModeOrSkip(t, lockPath, 0o1600))) {
        return { skipped: true };
      }
    }],
    ["mode-2600", async ({ rootDir, plan, t }) => {
      await writeB7FixedLock(rootDir, makeB6CommitLockIntent(plan));
      const lockPath = join(rootDir, B7_FIXED_COMMIT_LOCK);
      await chmod(lockPath, 0o2600);
      if (!(await requireB7ExactModeOrSkip(t, lockPath, 0o2600))) {
        return { skipped: true };
      }
    }],
    ["mode-4600", async ({ rootDir, plan, t }) => {
      await writeB7FixedLock(rootDir, makeB6CommitLockIntent(plan));
      const lockPath = join(rootDir, B7_FIXED_COMMIT_LOCK);
      await chmod(lockPath, 0o4600);
      if (!(await requireB7ExactModeOrSkip(t, lockPath, 0o4600))) {
        return { skipped: true };
      }
    }],
    ["symlink", async ({ rootDir, plan, t }) => {
      const externalRoot = await makeB5Root(t, "b7-lock-symlink-external");
      const externalPath = join(externalRoot, "lock-target");
      const externalBytes = canonicalJsonDocumentBytes(makeB6CommitLockIntent(plan));
      await writeFile(externalPath, externalBytes, { mode: 0o600 });
      await symlink(externalPath, join(rootDir, B7_FIXED_COMMIT_LOCK));
      return { externalPath, externalBytes };
    }],
    ["directory", async ({ rootDir }) => {
      await mkdir(join(rootDir, B7_FIXED_COMMIT_LOCK), { mode: 0o700 });
    }],
    ["FIFO", async ({ rootDir }) => {
      const fifo = await runBoundedChild("/usr/bin/mkfifo", [
        join(rootDir, B7_FIXED_COMMIT_LOCK)
      ]);
      assert.equal(fifo.timedOut, false, fifo.stderr);
      assert.equal(fifo.code, 0, fifo.stderr);
    }],
    ["socket", async ({ rootDir, t }) => {
      const server = createServer();
      await new Promise((resolve, reject) => {
        server.once("error", reject);
        server.listen(join(rootDir, B7_FIXED_COMMIT_LOCK), resolve);
      });
      t.after(() => new Promise((resolve, reject) => {
        server.close((error) => error === undefined ? resolve() : reject(error));
      }));
    }]
  ];

  for (const [label, setup] of cases) {
    await t.test(label, async (t) => {
      const fixture = await makeB7StagedRoot(
        t,
        label === "socket" ? "s" : `b7-unsafe-lock-${label}`
      );
      const setupResult = await setup({ ...fixture, t });
      if (setupResult?.skipped === true) return;
      const before = await snapshotB5Tree(fixture.rootDir);
      const bounded = label === "FIFO" || label === "socket";
      let result;
      if (bounded) {
        const child = await runBoundedChild(process.execPath, [
          "--input-type=module",
          "--eval",
          B7_RECOVERY_CHILD_SCRIPT,
          B5_MODULE_URL,
          fixture.rootDir,
          B7_CONFIRMATION
        ]);
        assert.equal(child.timedOut, false, child.stderr);
        assert.equal(child.code, 0, child.stderr);
        result = JSON.parse(child.stdout);
      } else {
        result = await recoverInterruptedCleaningCommit(
          b7Options(fixture.rootDir)
        );
      }
      assert.deepEqual(
        result,
        b5ExpectedFailure("LOCAL_STATE_INVALID", B7_FIXED_COMMIT_LOCK)
      );
      if (setupResult?.externalPath !== undefined) {
        assert.deepEqual(
          await readFile(setupResult.externalPath),
          setupResult.externalBytes
        );
      }
      assert.deepEqual(await snapshotB5Tree(fixture.rootDir), before);
    });
  }
});

test("B7 same-byte fixed-lock identity replacement fails closed and preserves external state", async (t) => {
  const { rootDir, plan } = await makeB7StagedRoot(t, "b7-lock-replacement");
  const lockBytes = await writeB7FixedLock(
    rootDir,
    makeB6CommitLockIntent(plan, process.pid, "d".repeat(32))
  );
  const externalRoot = await makeB5Root(t, "b7-lock-replacement-external");
  const movedPath = join(externalRoot, "moved-lock");
  const sentinelPath = join(externalRoot, "sentinel");
  await writeFile(sentinelPath, "untouched", { mode: 0o600 });
  const before = await snapshotB5Tree(rootDir);

  const child = await runBoundedChild(process.execPath, [
    "--input-type=module",
    "--eval",
    B7_LOCK_IDENTITY_REPLACEMENT_CHILD_SCRIPT,
    B5_MODULE_URL,
    rootDir,
    B7_CONFIRMATION,
    movedPath,
    sentinelPath
  ]);
  assert.equal(child.timedOut, false, child.stderr);
  assert.equal(child.code, 0, child.stderr);
  const observed = JSON.parse(child.stdout);
  assert.equal(observed.triggered, true);
  assert.deepEqual(
    observed.result,
    b5ExpectedFailure("LOCAL_STATE_INVALID", B7_FIXED_COMMIT_LOCK)
  );
  assert.equal(observed.lock_after, lockBytes.toString("base64"));
  assert.equal(observed.moved_after, lockBytes.toString("base64"));
  assert.equal(observed.sentinel_after, observed.sentinel_before);
  assert.deepEqual(await snapshotB5Tree(rootDir), before);
});

const B7_RECOVERY_LEASES_ROOT = ".local/state/cleaning-recovery-leases";

function makeB7RecoveryTargetFixture(lockBytes, overrides = {}) {
  const targetCommitLockSha256 = sha256(lockBytes);
  const value = {
    schema_version: "1.0.0",
    record_kind: "recovery_target",
    target_commit_lock_sha256: targetCommitLockSha256,
    target_commit_lock_bytes_base64: lockBytes.toString("base64"),
    ...overrides
  };
  return { value, bytes: canonicalJsonDocumentBytes(value) };
}

function makeB7RecoveryLeaseFixture({
  targetCommitLockSha256,
  previousLeaseSha256,
  generation,
  ownerPid,
  ownerNonce
}, overrides = {}) {
  const value = {
    schema_version: "1.0.0",
    record_kind: "recovery_lease",
    target_commit_lock_sha256: targetCommitLockSha256,
    previous_lease_sha256: previousLeaseSha256,
    generation,
    owner_pid: ownerPid,
    owner_nonce: ownerNonce,
    ...overrides
  };
  const bytes = canonicalJsonDocumentBytes(value);
  return { value, bytes, sha256: sha256(bytes) };
}

function makeB7DecodableNoncanonicalBase64(bytes) {
  const canonical = bytes.toString("base64");
  const candidates = [
    canonical.replace(/=+$/, ""),
    `${canonical}=`,
    `${canonical.slice(0, 4)}\n${canonical.slice(4)}`
  ];
  for (const candidate of candidates) {
    const decoded = Buffer.from(candidate, "base64");
    if (candidate !== canonical && decoded.equals(bytes) &&
        decoded.toString("base64") === canonical) {
      return candidate;
    }
  }
  assert.fail("unable to construct a decodable noncanonical base64 fixture");
}

test("B7 recovery target and lease fixture bytes match hand-written golden literals", () => {
  const lockBytes = Buffer.from("fixed-lock-golden\n");
  const targetC =
    "6d4a8e64e36469aa886bf7fe0aad9f0c52ac287d2c8e69a76037c89f907cc0ff";
  const targetGolden = Buffer.from(
    '{"record_kind":"recovery_target","schema_version":"1.0.0",' +
      '"target_commit_lock_bytes_base64":"Zml4ZWQtbG9jay1nb2xkZW4K",' +
      '"target_commit_lock_sha256":' +
      '"6d4a8e64e36469aa886bf7fe0aad9f0c52ac287d2c8e69a76037c89f907cc0ff"}\n'
  );
  const leaseGolden = Buffer.from(
    '{"generation":0,"owner_nonce":"11111111111111111111111111111111",' +
      '"owner_pid":424242,"previous_lease_sha256":null,' +
      '"record_kind":"recovery_lease","schema_version":"1.0.0",' +
      '"target_commit_lock_sha256":' +
      '"6d4a8e64e36469aa886bf7fe0aad9f0c52ac287d2c8e69a76037c89f907cc0ff"}\n'
  );

  assert.equal(sha256(lockBytes), targetC);
  assert.deepEqual(
    makeB7RecoveryTargetFixture(lockBytes).bytes,
    targetGolden
  );
  assert.deepEqual(
    makeB7RecoveryLeaseFixture({
      targetCommitLockSha256: targetC,
      previousLeaseSha256: null,
      generation: 0,
      ownerPid: 424242,
      ownerNonce: "1".repeat(32)
    }).bytes,
    leaseGolden
  );
  assert.equal(sha256(targetGolden),
    "fa11058daf0441780401eb6d94f262efebe1579407178f1791df5c2ac90a150e");
  assert.equal(sha256(leaseGolden),
    "a7588d987d7aa17236e2764d7c15dd8ad2c37d2dc263076d74ea87be1e66da6a");
});

async function writeB7PrivatePath(rootDir, relativePath, bytes, mode = 0o600) {
  const absolutePath = join(rootDir, relativePath);
  await mkdir(dirname(absolutePath), { recursive: true, mode: 0o700 });
  await writeFile(absolutePath, bytes, { mode });
  await chmod(absolutePath, mode);
  assert.equal((await lstat(absolutePath)).mode & 0o7777, mode);
  return absolutePath;
}

async function makeB7CurrentRecoveryFixture(t, label) {
  const fixture = await makeB7StagedRoot(t, label);
  const currentIntent = makeB6CommitLockIntent(
    fixture.plan,
    process.pid,
    "e".repeat(32)
  );
  const currentLockBytes = await writeB7FixedLock(
    fixture.rootDir,
    currentIntent
  );
  return {
    ...fixture,
    currentIntent,
    currentLockBytes,
    currentC: sha256(currentLockBytes)
  };
}

async function materializeB7RecoveryPrefix(
  rootDir,
  targetC,
  lockBytes,
  prefix
) {
  const targetDir = `${B7_RECOVERY_LEASES_ROOT}/${targetC}`;
  await mkdir(join(rootDir, targetDir), { recursive: true, mode: 0o700 });
  await chmod(join(rootDir, B7_RECOVERY_LEASES_ROOT), 0o700);
  await chmod(join(rootDir, targetDir), 0o700);
  if (prefix === "empty") return { targetDir };

  const target = makeB7RecoveryTargetFixture(lockBytes);
  if (prefix === "target-temp-only") {
    await writeB7PrivatePath(
      rootDir,
      `${targetDir}/.target.333333.${"3".repeat(32)}.tmp`,
      target.bytes.subarray(0, Math.floor(target.bytes.length / 2))
    );
    return { targetDir, target };
  }
  await writeB7PrivatePath(rootDir, `${targetDir}/target.json`, target.bytes);
  if (prefix === "target-only") return { targetDir, target };

  const rootLease = makeB7RecoveryLeaseFixture({
    targetCommitLockSha256: targetC,
    previousLeaseSha256: null,
    generation: 0,
    ownerPid: 444444,
    ownerNonce: "4".repeat(32)
  });
  await writeB7PrivatePath(
    rootDir,
    `${targetDir}/lease-root.json`,
    rootLease.bytes
  );
  const childLease = makeB7RecoveryLeaseFixture({
    targetCommitLockSha256: targetC,
    previousLeaseSha256: rootLease.sha256,
    generation: 1,
    ownerPid: 555555,
    ownerNonce: "5".repeat(32)
  });
  await writeB7PrivatePath(
    rootDir,
    `${targetDir}/lease-after-${rootLease.sha256}.json`,
    childLease.bytes
  );
  if (prefix === "root-chain") {
    await writeB7PrivatePath(
      rootDir,
      `${targetDir}/.lease-${childLease.sha256}.666666.${"6".repeat(32)}.tmp`,
      Buffer.alloc(0)
    );
    return { targetDir, target, rootLease, childLease };
  }
  const grandchildLease = makeB7RecoveryLeaseFixture({
    targetCommitLockSha256: targetC,
    previousLeaseSha256: childLease.sha256,
    generation: 2,
    ownerPid: 666666,
    ownerNonce: "6".repeat(32)
  });
  await writeB7PrivatePath(
    rootDir,
    `${targetDir}/lease-after-${childLease.sha256}.json`,
    grandchildLease.bytes
  );
  await writeB7PrivatePath(
    rootDir,
    `${targetDir}/.lease-${grandchildLease.sha256}.777777.${"7".repeat(32)}.tmp`,
    Buffer.alloc(0)
  );
  return { targetDir, target, rootLease, childLease, grandchildLease };
}

test("B7 current prefixes are read-only while identical historical prefixes are unresolved", async (t) => {
  const recoverInterruptedCleaningCommit =
    await loadRecoverInterruptedCleaningCommit();
  for (const prefix of [
    "empty",
    "target-temp-only",
    "target-only",
    "root-chain",
    "multi-generation"
  ]) {
    await t.test(`current ${prefix}`, async (t) => {
      const fixture = await makeB7CurrentRecoveryFixture(
        t,
        `b7-b2a-current-${prefix}`
      );
      await materializeB7RecoveryPrefix(
        fixture.rootDir,
        fixture.currentC,
        fixture.currentLockBytes,
        prefix
      );
      const before = await snapshotB5Tree(fixture.rootDir);

      const result = await recoverInterruptedCleaningCommit(
        b7Options(fixture.rootDir)
      );

      assert.deepEqual(
        result,
        b5ExpectedFailure("RECOVERY_OWNER_ALIVE", B7_FIXED_COMMIT_LOCK)
      );
      assert.deepEqual(await snapshotB5Tree(fixture.rootDir), before);
    });

    await t.test(`historical ${prefix}`, async (t) => {
      const fixture = await makeB7CurrentRecoveryFixture(
        t,
        `b7-b2a-history-${prefix}`
      );
      const historicalLockBytes = canonicalJsonDocumentBytes(
        makeB6CommitLockIntent(fixture.plan, process.pid, "f".repeat(32))
      );
      const historicalC = sha256(historicalLockBytes);
      assert.notEqual(historicalC, fixture.currentC);
      const historical = await materializeB7RecoveryPrefix(
        fixture.rootDir,
        historicalC,
        historicalLockBytes,
        prefix
      );
      const before = await snapshotB5Tree(fixture.rootDir);

      const result = await recoverInterruptedCleaningCommit(
        b7Options(fixture.rootDir)
      );

      assert.deepEqual(
        result,
        b5ExpectedFailure("RECOVERY_UNRESOLVED_TARGET", historical.targetDir)
      );
      assert.deepEqual(await snapshotB5Tree(fixture.rootDir), before);
    });
  }
});

test("B7 fixed-lock absence gives no partial exemption and reports the ASCII-first target", async (t) => {
  const recoverInterruptedCleaningCommit =
    await loadRecoverInterruptedCleaningCommit();
  const { rootDir } = await makeB7StagedRoot(t, "b7-b2a-fixed-absent");
  const firstC = `${"0".repeat(63)}1`;
  const secondC = "f".repeat(64);
  await mkdir(join(rootDir, B7_RECOVERY_LEASES_ROOT, secondC), {
    recursive: true,
    mode: 0o700
  });
  await mkdir(join(rootDir, B7_RECOVERY_LEASES_ROOT, firstC), {
    mode: 0o700
  });
  const before = await snapshotB5Tree(rootDir);

  const result = await recoverInterruptedCleaningCommit(b7Options(rootDir));

  assert.deepEqual(
    result,
    b5ExpectedFailure(
      "RECOVERY_UNRESOLVED_TARGET",
      `${B7_RECOVERY_LEASES_ROOT}/${firstC}`
    )
  );
  assert.deepEqual(await snapshotB5Tree(rootDir), before);
});

test("B7 historical missing-target candidates keep incomplete content opaque", async (t) => {
  const recoverInterruptedCleaningCommit =
    await loadRecoverInterruptedCleaningCommit();
  const cases = [
    {
      label: "canonical-partial",
      bytesKind: "canonical-partial"
    },
    {
      label: "arbitrary-garbage",
      bytesKind: "garbage"
    },
    {
      label: "terminal-looking-invalid-base64",
      bytesKind: "terminal-invalid-base64"
    },
    {
      label: "invalid-utf8",
      bytesKind: "invalid-utf8"
    }
  ];
  for (const testCase of cases) {
    const { label, bytesKind } = testCase;
    await t.test(label, async (t) => {
      const fixture = await makeB7CurrentRecoveryFixture(
        t,
        `b7-b2a-history-target-candidate-${label}`
      );
      const historicalLockBytes = canonicalJsonDocumentBytes(
        makeB6CommitLockIntent(fixture.plan, process.pid, "9".repeat(32))
      );
      const historicalC = sha256(historicalLockBytes);
      assert.notEqual(historicalC, fixture.currentC);
      const targetDir = `${B7_RECOVERY_LEASES_ROOT}/${historicalC}`;
      await mkdir(join(fixture.rootDir, targetDir), {
        recursive: true,
        mode: 0o700
      });
      await chmod(join(fixture.rootDir, B7_RECOVERY_LEASES_ROOT), 0o700);
      await chmod(join(fixture.rootDir, targetDir), 0o700);
      const candidatePath =
        `${targetDir}/.target.333333.${"3".repeat(32)}.tmp`;
      const target = makeB7RecoveryTargetFixture(historicalLockBytes);
      let candidateBytes;
      if (bytesKind === "canonical-partial") {
        candidateBytes = target.bytes.subarray(0, Math.floor(target.bytes.length / 2));
        assert.equal(
          target.bytes.subarray(0, candidateBytes.length).equals(candidateBytes),
          true
        );
      } else if (bytesKind === "terminal-invalid-base64") {
        const base64Start = target.bytes.indexOf(
          Buffer.from(historicalLockBytes.toString("base64"))
        );
        assert.notEqual(base64Start, -1);
        candidateBytes = Buffer.concat([
          target.bytes.subarray(0, base64Start),
          Buffer.from("eA==")
        ]);
      } else if (bytesKind === "invalid-utf8") {
        candidateBytes = Buffer.concat([
          target.bytes.subarray(0, 8),
          Buffer.from([0xc3, 0x28])
        ]);
        assert.throws(() => new TextDecoder("utf-8", { fatal: true })
          .decode(candidateBytes));
      } else {
        candidateBytes = Buffer.from(
          "arbitrary historical target candidate garbage"
        );
      }
      await writeB7PrivatePath(
        fixture.rootDir,
        candidatePath,
        candidateBytes
      );
      const before = await snapshotB5Tree(fixture.rootDir);

      const result = await recoverInterruptedCleaningCommit(
        b7Options(fixture.rootDir)
      );

      assert.deepEqual(
        result,
        b5ExpectedFailure("RECOVERY_UNRESOLVED_TARGET", targetDir)
      );
      assert.deepEqual(await snapshotB5Tree(fixture.rootDir), before);
    });
  }
});

test("B7 ASCII-first historical unresolved target outranks later malformed topology", async (t) => {
  const recoverInterruptedCleaningCommit =
    await loadRecoverInterruptedCleaningCommit();
  for (const malformedKind of ["target", "lease"]) {
    await t.test(`later-malformed-${malformedKind}`, async (t) => {
      const fixture = await makeB7StagedRoot(
        t,
        `b7-b2a-first-unresolved-${malformedKind}`
      );
      const laterLockBytes = canonicalJsonDocumentBytes(
        makeB6CommitLockIntent(fixture.plan, process.pid, "8".repeat(32))
      );
      const firstC = "0".repeat(64);
      const laterC = sha256(laterLockBytes);
      assert.equal(firstC < laterC, true);
      const first = await materializeB7RecoveryPrefix(
        fixture.rootDir,
        firstC,
        Buffer.from("unused"),
        "empty"
      );
      const laterDir = `${B7_RECOVERY_LEASES_ROOT}/${laterC}`;
      await mkdir(join(fixture.rootDir, laterDir), {
        recursive: true,
        mode: 0o700
      });
      await chmod(join(fixture.rootDir, laterDir), 0o700);
      if (malformedKind === "target") {
        await writeB7PrivatePath(
          fixture.rootDir,
          `${laterDir}/target.json`,
          Buffer.from("{}\n")
        );
      } else {
        const target = makeB7RecoveryTargetFixture(laterLockBytes);
        await writeB7PrivatePath(
          fixture.rootDir,
          `${laterDir}/target.json`,
          target.bytes
        );
        const malformedLease = makeB7RecoveryLeaseFixture({
          targetCommitLockSha256: laterC,
          previousLeaseSha256: null,
          generation: 1,
          ownerPid: 818181,
          ownerNonce: "8".repeat(32)
        });
        await writeB7PrivatePath(
          fixture.rootDir,
          `${laterDir}/lease-root.json`,
          malformedLease.bytes
        );
      }
      const before = await snapshotB5Tree(fixture.rootDir);

      const result = await recoverInterruptedCleaningCommit(
        b7Options(fixture.rootDir)
      );

      assert.deepEqual(
        result,
        b5ExpectedFailure("RECOVERY_UNRESOLVED_TARGET", first.targetDir)
      );
      assert.deepEqual(await snapshotB5Tree(fixture.rootDir), before);
    });
  }
});

test("B7 recovery target enforces canonical LF, base64, hash, field, directory, and fixed-lock binding", async (t) => {
  const recoverInterruptedCleaningCommit =
    await loadRecoverInterruptedCleaningCommit();
  const cases = [
    ["missing-LF", ({ target }) => ({
      bytes: target.bytes.subarray(0, -1)
    })],
    ["extra-LF", ({ target }) => ({
      bytes: Buffer.concat([target.bytes, Buffer.from("\n")])
    })],
    ["invalid-base64", ({ target }) => {
      target.value.target_commit_lock_bytes_base64 = "***";
      return { bytes: canonicalJsonDocumentBytes(target.value) };
    }],
    ["decodable-noncanonical-base64", ({ target, fixture }) => {
      target.value.target_commit_lock_bytes_base64 =
        makeB7DecodableNoncanonicalBase64(fixture.currentLockBytes);
      return { bytes: canonicalJsonDocumentBytes(target.value) };
    }],
    ["wrong-directory-name", ({ target, fixture }) => {
      const directoryC = "0".repeat(64);
      assert.notEqual(directoryC, fixture.currentC);
      return { directoryC, bytes: target.bytes };
    }],
    ["wrong-C-field", ({ target }) => {
      target.value.target_commit_lock_sha256 = "0".repeat(64);
      return { bytes: canonicalJsonDocumentBytes(target.value) };
    }],
    ["wrong-fixed-bytes", ({ target, fixture }) => {
      const otherBytes = canonicalJsonDocumentBytes(
        makeB6CommitLockIntent(fixture.plan, process.pid, "a".repeat(32))
      );
      assert.notDeepEqual(otherBytes, fixture.currentLockBytes);
      target.value.target_commit_lock_bytes_base64 = otherBytes.toString("base64");
      target.value.target_commit_lock_sha256 = fixture.currentC;
      return { bytes: canonicalJsonDocumentBytes(target.value) };
    }],
    ["unknown-key", ({ target }) => {
      target.value.extra = true;
      return { bytes: canonicalJsonDocumentBytes(target.value) };
    }]
  ];

  for (const [label, build] of cases) {
    await t.test(label, async (t) => {
      const fixture = await makeB7CurrentRecoveryFixture(
        t,
        `b7-b2a-target-${label}`
      );
      const target = makeB7RecoveryTargetFixture(fixture.currentLockBytes);
      const built = build({ target, fixture });
      const directoryC = built.directoryC ?? fixture.currentC;
      const targetDir = `${B7_RECOVERY_LEASES_ROOT}/${directoryC}`;
      await mkdir(join(fixture.rootDir, targetDir), {
        recursive: true,
        mode: 0o700
      });
      const targetPath = `${targetDir}/target.json`;
      await writeB7PrivatePath(
        fixture.rootDir,
        targetPath,
        built.bytes
      );
      const before = await snapshotB5Tree(fixture.rootDir);

      const result = await recoverInterruptedCleaningCommit(
        b7Options(fixture.rootDir)
      );

      assert.deepEqual(
        result,
        b5ExpectedFailure("LOCAL_STATE_INVALID", targetPath)
      );
      assert.deepEqual(await snapshotB5Tree(fixture.rootDir), before);
    });
  }
});

test("B7 current target candidate and target documents require exact private regular prefixes", async (t) => {
  const cases = [
    ["target-mode", async (fixture, targetDir, targetPath, t) => {
      const target = makeB7RecoveryTargetFixture(fixture.currentLockBytes);
      const absolutePath = await writeB7PrivatePath(
        fixture.rootDir,
        targetPath,
        target.bytes
      );
      await chmod(absolutePath, 0o1600);
      if (!(await requireB7ExactModeOrSkip(t, absolutePath, 0o1600))) {
        return null;
      }
      return targetPath;
    }],
    ["target-symlink", async (fixture, _targetDir, targetPath, t) => {
      const external = await makeB5Root(t, "b7-target-leaf-external");
      const externalPath = join(external, "target.json");
      const externalBytes = Buffer.from("external-target-referent");
      await writeFile(externalPath, externalBytes, { mode: 0o600 });
      await symlink(externalPath, join(fixture.rootDir, targetPath));
      return { expectedPath: targetPath, externalPath, externalBytes };
    }],
    ["target-directory", async (fixture, _targetDir, targetPath) => {
      await mkdir(join(fixture.rootDir, targetPath), { mode: 0o700 });
      return targetPath;
    }],
    ["target-FIFO", async (fixture, _targetDir, targetPath) => {
      const fifo = await runBoundedChild("/usr/bin/mkfifo", [
        join(fixture.rootDir, targetPath)
      ]);
      assert.equal(fifo.timedOut, false, fifo.stderr);
      assert.equal(fifo.code, 0, fifo.stderr);
      return targetPath;
    }],
    ["target-socket", async (fixture, _targetDir, targetPath, t) => {
      await makeB5SocketCarrier(t, join(fixture.rootDir, targetPath));
      return targetPath;
    }],
    ["target-candidate-prefix", async (fixture, targetDir) => {
      const candidate = `${targetDir}/.target.808080.${"8".repeat(32)}.tmp`;
      await writeB7PrivatePath(
        fixture.rootDir,
        candidate,
        Buffer.from("not-a-valid-prefix")
      );
      return candidate;
    }],
    ["lease-candidate-anchor", async (fixture, targetDir) => {
      const target = makeB7RecoveryTargetFixture(fixture.currentLockBytes);
      await writeB7PrivatePath(
        fixture.rootDir,
        `${targetDir}/target.json`,
        target.bytes
      );
      const candidate = `${targetDir}/.lease-${"0".repeat(64)}.808081.${"8".repeat(32)}.tmp`;
      await writeB7PrivatePath(fixture.rootDir, candidate, Buffer.alloc(0));
      return candidate;
    }]
  ];

  for (const [label, setup] of cases) {
    await t.test(label, async (t) => {
      const fixture = await makeB7CurrentRecoveryFixture(
        t,
        `b7-b2a-target-leaf-${label}`
      );
      const targetDir = `${B7_RECOVERY_LEASES_ROOT}/${fixture.currentC}`;
      await mkdir(join(fixture.rootDir, targetDir), {
        recursive: true,
        mode: 0o700
      });
      const targetPath = `${targetDir}/target.json`;
      const setupResult = await setup(fixture, targetDir, targetPath, t);
      if (setupResult === null) return;
      const expectedPath = typeof setupResult === "string"
        ? setupResult
        : setupResult.expectedPath;
      const before = await snapshotB5Tree(fixture.rootDir);
      const child = await runBoundedChild(process.execPath, [
        "--input-type=module",
        "--eval",
        B7_RECOVERY_CHILD_SCRIPT,
        B5_MODULE_URL,
        fixture.rootDir,
        B7_CONFIRMATION
      ]);
      assert.equal(child.timedOut, false, child.stderr);
      assert.equal(child.code, 0, child.stderr);
      assert.deepEqual(
        JSON.parse(child.stdout),
        b5ExpectedFailure("LOCAL_STATE_INVALID", expectedPath)
      );
      if (typeof setupResult !== "string" &&
          setupResult.externalPath !== undefined) {
        assert.deepEqual(
          await readFile(setupResult.externalPath),
          setupResult.externalBytes
        );
      }
      assert.deepEqual(await snapshotB5Tree(fixture.rootDir), before);
    });
  }
});

test("B7 recovery namespace rejects ASCII-first unknown entries and unsafe roots or target directories", async (t) => {
  const recoverInterruptedCleaningCommit =
    await loadRecoverInterruptedCleaningCommit();
  const cases = [
    ["unknown-order", async (fixture) => {
      await mkdir(join(fixture.rootDir, B7_RECOVERY_LEASES_ROOT, "a-unknown"), {
        recursive: true,
        mode: 0o700
      });
      await mkdir(join(fixture.rootDir, B7_RECOVERY_LEASES_ROOT, "Z-unknown"), {
        mode: 0o700
      });
      return `${B7_RECOVERY_LEASES_ROOT}/Z-unknown`;
    }],
    ["uppercase-target", async (fixture) => {
      const name = "A".repeat(64);
      await mkdir(join(fixture.rootDir, B7_RECOVERY_LEASES_ROOT, name), {
        recursive: true,
        mode: 0o700
      });
      return `${B7_RECOVERY_LEASES_ROOT}/${name}`;
    }],
    ["root-mode", async (fixture, t) => {
      await mkdir(join(fixture.rootDir, B7_RECOVERY_LEASES_ROOT), {
        recursive: true,
        mode: 0o700
      });
      const absolutePath = join(fixture.rootDir, B7_RECOVERY_LEASES_ROOT);
      await chmod(absolutePath, 0o1700);
      if (!(await requireB7ExactModeOrSkip(t, absolutePath, 0o1700))) {
        return null;
      }
      return B7_RECOVERY_LEASES_ROOT;
    }],
    ["root-symlink", async (fixture, t) => {
      const external = await makeB5Root(t, "b7-recovery-root-external");
      const sentinelPath = join(external, "sentinel");
      const sentinelBytes = Buffer.from("recovery-root-external-untouched");
      await writeFile(sentinelPath, sentinelBytes, { mode: 0o600 });
      await symlink(external, join(fixture.rootDir, B7_RECOVERY_LEASES_ROOT));
      return {
        expectedPath: B7_RECOVERY_LEASES_ROOT,
        externalPath: sentinelPath,
        externalBytes: sentinelBytes
      };
    }],
    ["root-file", async (fixture) => {
      await writeB7PrivatePath(
        fixture.rootDir,
        B7_RECOVERY_LEASES_ROOT,
        Buffer.from("not a directory")
      );
      return B7_RECOVERY_LEASES_ROOT;
    }],
    ["root-FIFO", async (fixture) => {
      const absolutePath = join(fixture.rootDir, B7_RECOVERY_LEASES_ROOT);
      const fifo = await runBoundedChild("/usr/bin/mkfifo", [absolutePath]);
      assert.equal(fifo.timedOut, false, fifo.stderr);
      assert.equal(fifo.code, 0, fifo.stderr);
      return B7_RECOVERY_LEASES_ROOT;
    }],
    ["root-socket", async (fixture, t) => {
      await makeB5SocketCarrier(
        t,
        join(fixture.rootDir, B7_RECOVERY_LEASES_ROOT)
      );
      return B7_RECOVERY_LEASES_ROOT;
    }],
    ["target-mode", async (fixture, t) => {
      const path = `${B7_RECOVERY_LEASES_ROOT}/${fixture.currentC}`;
      await mkdir(join(fixture.rootDir, path), { recursive: true, mode: 0o700 });
      const absolutePath = join(fixture.rootDir, path);
      await chmod(absolutePath, 0o2700);
      if (!(await requireB7ExactModeOrSkip(t, absolutePath, 0o2700))) {
        return null;
      }
      return path;
    }],
    ["target-symlink", async (fixture, t) => {
      const external = await makeB5Root(t, "b7-target-dir-external");
      await mkdir(join(fixture.rootDir, B7_RECOVERY_LEASES_ROOT), {
        recursive: true,
        mode: 0o700
      });
      const path = `${B7_RECOVERY_LEASES_ROOT}/${fixture.currentC}`;
      const sentinelPath = join(external, "sentinel");
      const sentinelBytes = Buffer.from("target-dir-external-untouched");
      await writeFile(sentinelPath, sentinelBytes, { mode: 0o600 });
      await symlink(external, join(fixture.rootDir, path));
      return {
        expectedPath: path,
        externalPath: sentinelPath,
        externalBytes: sentinelBytes
      };
    }],
    ["target-file", async (fixture) => {
      const path = `${B7_RECOVERY_LEASES_ROOT}/${fixture.currentC}`;
      await writeB7PrivatePath(fixture.rootDir, path, Buffer.from("file"));
      return path;
    }],
    ["target-FIFO", async (fixture) => {
      await mkdir(join(fixture.rootDir, B7_RECOVERY_LEASES_ROOT), {
        recursive: true,
        mode: 0o700
      });
      const path = `${B7_RECOVERY_LEASES_ROOT}/${fixture.currentC}`;
      const fifo = await runBoundedChild("/usr/bin/mkfifo", [join(fixture.rootDir, path)]);
      assert.equal(fifo.timedOut, false, fifo.stderr);
      assert.equal(fifo.code, 0, fifo.stderr);
      return path;
    }],
    ["target-socket", async (fixture, t) => {
      await mkdir(join(fixture.rootDir, B7_RECOVERY_LEASES_ROOT), {
        recursive: true,
        mode: 0o700
      });
      const path = `${B7_RECOVERY_LEASES_ROOT}/${fixture.currentC}`;
      await makeB5SocketCarrier(t, join(fixture.rootDir, path));
      return path;
    }]
  ];

  for (const [label, setup] of cases) {
    await t.test(label, async (t) => {
      const fixture = await makeB7CurrentRecoveryFixture(t, `b7-b2a-ns-${label}`);
      const setupResult = await setup(fixture, t);
      if (setupResult === null) return;
      const expectedPath = typeof setupResult === "string"
        ? setupResult
        : setupResult.expectedPath;
      const before = await snapshotB5Tree(fixture.rootDir);
      const child = await runBoundedChild(process.execPath, [
        "--input-type=module",
        "--eval",
        B7_RECOVERY_CHILD_SCRIPT,
        B5_MODULE_URL,
        fixture.rootDir,
        B7_CONFIRMATION
      ]);
      assert.equal(child.timedOut, false, child.stderr);
      assert.equal(child.code, 0, child.stderr);
      assert.deepEqual(
        JSON.parse(child.stdout),
        b5ExpectedFailure("LOCAL_STATE_INVALID", expectedPath)
      );
      if (typeof setupResult !== "string" &&
          setupResult.externalPath !== undefined) {
        assert.deepEqual(
          await readFile(setupResult.externalPath),
          setupResult.externalBytes
        );
      }
      assert.deepEqual(await snapshotB5Tree(fixture.rootDir), before);
    });
  }
});

test("B7 lease chain rejects missing root, malformed nodes, forks, special modes, and nonregular leaves", async (t) => {
  const recoverInterruptedCleaningCommit =
    await loadRecoverInterruptedCleaningCommit();
  async function writeRootLease(fixture, targetDir, ownerNonce = "7".repeat(32)) {
    const rootLease = makeB7RecoveryLeaseFixture({
      targetCommitLockSha256: fixture.currentC,
      previousLeaseSha256: null,
      generation: 0,
      ownerPid: 700000,
      ownerNonce
    });
    await writeB7PrivatePath(
      fixture.rootDir,
      `${targetDir}/lease-root.json`,
      rootLease.bytes
    );
    return rootLease;
  }
  const cases = [
    ["missing-root", async (fixture, targetDir) => {
      const child = makeB7RecoveryLeaseFixture({
        targetCommitLockSha256: fixture.currentC,
        previousLeaseSha256: "0".repeat(64),
        generation: 1,
        ownerPid: 700001,
        ownerNonce: "7".repeat(32)
      });
      const path = `${targetDir}/lease-after-${"0".repeat(64)}.json`;
      await writeB7PrivatePath(fixture.rootDir, path, child.bytes);
      return ["LOCAL_STATE_INVALID", targetDir];
    }],
    ["malformed-root", async (fixture, targetDir) => {
      const rootLease = makeB7RecoveryLeaseFixture({
        targetCommitLockSha256: fixture.currentC,
        previousLeaseSha256: null,
        generation: 1,
        ownerPid: 700002,
        ownerNonce: "7".repeat(32)
      });
      const path = `${targetDir}/lease-root.json`;
      await writeB7PrivatePath(fixture.rootDir, path, rootLease.bytes);
      return ["LOCAL_STATE_INVALID", path];
    }],
    ["child-wrong-C", async (fixture, targetDir) => {
      const rootLease = await writeRootLease(fixture, targetDir);
      const child = makeB7RecoveryLeaseFixture({
        targetCommitLockSha256: "0".repeat(64),
        previousLeaseSha256: rootLease.sha256,
        generation: 1,
        ownerPid: 700010,
        ownerNonce: "a".repeat(32)
      });
      const path = `${targetDir}/lease-after-${rootLease.sha256}.json`;
      await writeB7PrivatePath(fixture.rootDir, path, child.bytes);
      return ["LOCAL_STATE_INVALID", path];
    }],
    ["child-wrong-previous-field", async (fixture, targetDir) => {
      const rootLease = await writeRootLease(fixture, targetDir);
      const child = makeB7RecoveryLeaseFixture({
        targetCommitLockSha256: fixture.currentC,
        previousLeaseSha256: "0".repeat(64),
        generation: 1,
        ownerPid: 700011,
        ownerNonce: "b".repeat(32)
      });
      const path = `${targetDir}/lease-after-${rootLease.sha256}.json`;
      await writeB7PrivatePath(fixture.rootDir, path, child.bytes);
      return ["LOCAL_STATE_INVALID", path];
    }],
    ["child-wrong-generation", async (fixture, targetDir) => {
      const rootLease = await writeRootLease(fixture, targetDir);
      const child = makeB7RecoveryLeaseFixture({
        targetCommitLockSha256: fixture.currentC,
        previousLeaseSha256: rootLease.sha256,
        generation: 2,
        ownerPid: 700012,
        ownerNonce: "c".repeat(32)
      });
      const path = `${targetDir}/lease-after-${rootLease.sha256}.json`;
      await writeB7PrivatePath(fixture.rootDir, path, child.bytes);
      return ["LOCAL_STATE_INVALID", path];
    }],
    ["correct-name-wrong-parent-hash-content", async (fixture, targetDir) => {
      const namedParent = makeB7RecoveryLeaseFixture({
        targetCommitLockSha256: fixture.currentC,
        previousLeaseSha256: null,
        generation: 0,
        ownerPid: 700013,
        ownerNonce: "d".repeat(32)
      });
      const actualParent = await writeRootLease(
        fixture,
        targetDir,
        "e".repeat(32)
      );
      assert.notEqual(namedParent.sha256, actualParent.sha256);
      const child = makeB7RecoveryLeaseFixture({
        targetCommitLockSha256: fixture.currentC,
        previousLeaseSha256: namedParent.sha256,
        generation: 1,
        ownerPid: 700014,
        ownerNonce: "f".repeat(32)
      });
      await writeB7PrivatePath(
        fixture.rootDir,
        `${targetDir}/lease-after-${namedParent.sha256}.json`,
        child.bytes
      );
      return ["RECOVERY_TARGET_AMBIGUOUS", targetDir];
    }],
    ["alternate-child-name", async (fixture, targetDir) => {
      const rootLease = await writeRootLease(fixture, targetDir);
      const child = makeB7RecoveryLeaseFixture({
        targetCommitLockSha256: fixture.currentC,
        previousLeaseSha256: rootLease.sha256,
        generation: 1,
        ownerPid: 700015,
        ownerNonce: "1".repeat(32)
      });
      await writeB7PrivatePath(
        fixture.rootDir,
        `${targetDir}/lease-after-${"0".repeat(64)}.json`,
        child.bytes
      );
      return ["RECOVERY_TARGET_AMBIGUOUS", targetDir];
    }],
    ["unexpected-child-name", async (fixture, targetDir) => {
      const rootLease = await writeRootLease(fixture, targetDir);
      const child = makeB7RecoveryLeaseFixture({
        targetCommitLockSha256: fixture.currentC,
        previousLeaseSha256: rootLease.sha256,
        generation: 1,
        ownerPid: 700016,
        ownerNonce: "2".repeat(32)
      });
      const path = `${targetDir}/lease-after-${rootLease.sha256}.copy.json`;
      await writeB7PrivatePath(fixture.rootDir, path, child.bytes);
      return ["LOCAL_STATE_INVALID", path];
    }],
    ["fork", async (fixture, targetDir) => {
      const chain = await materializeB7RecoveryPrefix(
        fixture.rootDir,
        fixture.currentC,
        fixture.currentLockBytes,
        "root-chain"
      );
      const alternatePrevious = "0".repeat(64);
      const alternate = makeB7RecoveryLeaseFixture({
        targetCommitLockSha256: fixture.currentC,
        previousLeaseSha256: alternatePrevious,
        generation: chain.childLease.value.generation + 1,
        ownerPid: 700003,
        ownerNonce: "7".repeat(32)
      });
      await writeB7PrivatePath(
        fixture.rootDir,
        `${targetDir}/lease-after-${alternatePrevious}.json`,
        alternate.bytes
      );
      return ["RECOVERY_TARGET_AMBIGUOUS", targetDir];
    }],
    ["root-mode", async (fixture, targetDir, t) => {
      const rootLease = makeB7RecoveryLeaseFixture({
        targetCommitLockSha256: fixture.currentC,
        previousLeaseSha256: null,
        generation: 0,
        ownerPid: 700004,
        ownerNonce: "7".repeat(32)
      });
      const path = `${targetDir}/lease-root.json`;
      const absolutePath = await writeB7PrivatePath(
        fixture.rootDir,
        path,
        rootLease.bytes
      );
      await chmod(absolutePath, 0o1600);
      if (!(await requireB7ExactModeOrSkip(t, absolutePath, 0o1600))) {
        return null;
      }
      return ["LOCAL_STATE_INVALID", path];
    }],
    ["root-symlink", async (fixture, targetDir, t) => {
      const external = await makeB5Root(t, "b7-lease-symlink-external");
      const externalPath = join(external, "lease");
      const externalBytes = Buffer.from("external-lease-referent");
      await writeFile(externalPath, externalBytes, { mode: 0o600 });
      const path = `${targetDir}/lease-root.json`;
      await symlink(externalPath, join(fixture.rootDir, path));
      return {
        code: "LOCAL_STATE_INVALID",
        expectedPath: path,
        externalPath,
        externalBytes
      };
    }],
    ["root-FIFO", async (fixture, targetDir) => {
      const path = `${targetDir}/lease-root.json`;
      const fifo = await runBoundedChild("/usr/bin/mkfifo", [join(fixture.rootDir, path)]);
      assert.equal(fifo.timedOut, false, fifo.stderr);
      assert.equal(fifo.code, 0, fifo.stderr);
      return ["LOCAL_STATE_INVALID", path];
    }],
    ["root-socket", async (fixture, targetDir, t) => {
      const path = `${targetDir}/lease-root.json`;
      await makeB5SocketCarrier(t, join(fixture.rootDir, path));
      return ["LOCAL_STATE_INVALID", path];
    }]
  ];

  for (const [label, setup] of cases) {
    await t.test(label, async (t) => {
      const fixture = await makeB7CurrentRecoveryFixture(t, `b7-b2a-lease-${label}`);
      const target = await materializeB7RecoveryPrefix(
        fixture.rootDir,
        fixture.currentC,
        fixture.currentLockBytes,
        "target-only"
      );
      const setupResult = await setup(fixture, target.targetDir, t);
      if (setupResult === null) return;
      const code = Array.isArray(setupResult)
        ? setupResult[0]
        : setupResult.code;
      const expectedPath = Array.isArray(setupResult)
        ? setupResult[1]
        : setupResult.expectedPath;
      const before = await snapshotB5Tree(fixture.rootDir);
      const child = await runBoundedChild(process.execPath, [
        "--input-type=module",
        "--eval",
        B7_RECOVERY_CHILD_SCRIPT,
        B5_MODULE_URL,
        fixture.rootDir,
        B7_CONFIRMATION
      ]);
      assert.equal(child.timedOut, false, child.stderr);
      assert.equal(child.code, 0, child.stderr);
      assert.deepEqual(
        JSON.parse(child.stdout),
        b5ExpectedFailure(code, expectedPath)
      );
      if (!Array.isArray(setupResult) &&
          setupResult.externalPath !== undefined) {
        assert.deepEqual(
          await readFile(setupResult.externalPath),
          setupResult.externalBytes
        );
      }
      assert.deepEqual(await snapshotB5Tree(fixture.rootDir), before);
    });
  }
});

const B7_READ_ONLY_SCAN_CHILD_SCRIPT = `
import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";

const [moduleUrl, rootDir, confirmation] = process.argv.slice(1);
const promiseMutationNames = [
  "appendFile", "chmod", "chown", "copyFile", "cp", "lchown", "link",
  "lutimes", "mkdir", "mkdtemp", "rename", "rm", "rmdir", "symlink",
  "truncate", "unlink", "utimes", "writeFile"
].filter((name) => typeof fs.promises[name] === "function");
const original = { open: fs.promises.open };
for (const name of promiseMutationNames) original[name] = fs.promises[name];
const writes = [];
const fsyncs = [];
for (const name of promiseMutationNames) {
  fs.promises[name] = async (...args) => {
    writes.push([name, String(args[0])]);
    const error = new Error("synthetic mutating fs.promises call");
    error.code = "SYNTHETIC_MUTATION";
    throw error;
  };
}
fs.promises.open = async (...args) => {
  const [path, flags] = args;
  const numericFlags = typeof flags === "number" ? flags : 0;
  if ((numericFlags & (fs.constants.O_WRONLY | fs.constants.O_RDWR |
      fs.constants.O_CREAT | fs.constants.O_TRUNC | fs.constants.O_APPEND)) !== 0 ||
      (typeof flags === "string" && /[wax+]/.test(flags))) {
    writes.push(["open", String(path)]);
    const error = new Error("synthetic mutating open");
    error.code = "SYNTHETIC_MUTATION";
    throw error;
  }
  const handle = await original.open(...args);
  return new Proxy(handle, {
    get(target, property) {
      if (property === "sync" || property === "datasync") {
        return async () => {
          fsyncs.push([String(property), String(path)]);
          const error = new Error("synthetic FileHandle sync");
          error.code = "SYNTHETIC_FSYNC";
          throw error;
        };
      }
      if (["appendFile", "chmod", "chown", "truncate", "utimes", "write",
          "writeFile"].includes(property)) {
        return async () => {
          writes.push([String(property), String(path)]);
          const error = new Error("synthetic mutating FileHandle call");
          error.code = "SYNTHETIC_MUTATION";
          throw error;
        };
      }
      const value = Reflect.get(target, property, target);
      return typeof value === "function" ? value.bind(target) : value;
    }
  });
};
syncBuiltinESMExports();
let result;
try {
  const { recoverInterruptedCleaningCommit } = await import(moduleUrl);
  result = await recoverInterruptedCleaningCommit({ rootDir, confirmation });
} finally {
  Object.assign(fs.promises, original);
  syncBuiltinESMExports();
}
process.stdout.write(JSON.stringify({ result, writes, fsyncs }));
`;

const B7_RECOVERY_ROOT_REPLACEMENT_CHILD_SCRIPT = `
import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { join } from "node:path";

const [moduleUrl, rootDir, confirmation, movedPath, sentinelPath] =
  process.argv.slice(1);
const realRoot = fs.realpathSync(rootDir);
const recoveryRoot = join(realRoot, ".local", "state", "cleaning-recovery-leases");
const originalReaddir = fs.promises.readdir;
const originalRename = fs.promises.rename;
const originalMkdir = fs.promises.mkdir;
const sentinelBefore = await fs.promises.readFile(sentinelPath);
let triggered = false;
fs.promises.readdir = async (...args) => {
  const value = await originalReaddir(...args);
  if (!triggered && args[0] === recoveryRoot) {
    triggered = true;
    await originalRename(recoveryRoot, movedPath);
    await originalMkdir(recoveryRoot, { mode: 0o700 });
  }
  return value;
};
syncBuiltinESMExports();
let result;
try {
  const { recoverInterruptedCleaningCommit } = await import(moduleUrl);
  result = await recoverInterruptedCleaningCommit({ rootDir, confirmation });
} finally {
  fs.promises.readdir = originalReaddir;
  syncBuiltinESMExports();
}
process.stdout.write(JSON.stringify({
  result,
  triggered,
  sentinel_before: sentinelBefore.toString("base64"),
  sentinel_after: (await fs.promises.readFile(sentinelPath)).toString("base64"),
  moved_exists: fs.existsSync(movedPath),
  replacement_exists: fs.existsSync(recoveryRoot)
}));
`;

const B7_FIXED_LOCK_SCAN_REPLACEMENT_CHILD_SCRIPT = `
import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { join } from "node:path";

const [moduleUrl, rootDir, confirmation, movedPath, sentinelPath] =
  process.argv.slice(1);
const realRoot = fs.realpathSync(rootDir);
const recoveryRoot = join(realRoot, ".local", "state", "cleaning-recovery-leases");
const fixedLock = join(realRoot, ".local", "state", "cleaning-commit.lock");
const lockBytes = await fs.promises.readFile(fixedLock);
const lockStatBefore = await fs.promises.lstat(fixedLock);
const sentinelBefore = await fs.promises.readFile(sentinelPath);
const originalReaddir = fs.promises.readdir;
const originalRename = fs.promises.rename;
const originalWriteFile = fs.promises.writeFile;
const originalChmod = fs.promises.chmod;
let triggered = false;
fs.promises.readdir = async (...args) => {
  const value = await originalReaddir(...args);
  if (!triggered && args[0] === recoveryRoot) {
    triggered = true;
    await originalRename(fixedLock, movedPath);
    await originalWriteFile(fixedLock, lockBytes, { flag: "wx", mode: 0o600 });
    await originalChmod(fixedLock, 0o600);
  }
  return value;
};
syncBuiltinESMExports();
let result;
try {
  const { recoverInterruptedCleaningCommit } = await import(moduleUrl);
  result = await recoverInterruptedCleaningCommit({ rootDir, confirmation });
} finally {
  fs.promises.readdir = originalReaddir;
  syncBuiltinESMExports();
}
const replacementStat = await fs.promises.lstat(fixedLock);
const movedStat = await fs.promises.lstat(movedPath);
process.stdout.write(JSON.stringify({
  result,
  triggered,
  lock_before_identity: [lockStatBefore.dev, lockStatBefore.ino],
  replacement_identity: [replacementStat.dev, replacementStat.ino],
  moved_identity: [movedStat.dev, movedStat.ino],
  fixed_after: (await fs.promises.readFile(fixedLock)).toString("base64"),
  moved_after: (await fs.promises.readFile(movedPath)).toString("base64"),
  sentinel_before: sentinelBefore.toString("base64"),
  sentinel_after: (await fs.promises.readFile(sentinelPath)).toString("base64")
}));
`;

const B7_DIRECTORY_IDENTITY_REPLACEMENT_CHILD_SCRIPT = `
import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { join } from "node:path";

const [moduleUrl, rootDir, confirmation, relativeDirectory, movedPath,
  sentinelPath] = process.argv.slice(1);
const realRoot = fs.realpathSync(rootDir);
const directoryPath = join(realRoot, relativeDirectory);
const originalReaddir = fs.promises.readdir;
const originalRename = fs.promises.rename;
const originalMkdir = fs.promises.mkdir;
const sentinelBefore = await fs.promises.readFile(sentinelPath);
let triggered = false;
fs.promises.readdir = async (...args) => {
  const value = await originalReaddir(...args);
  if (!triggered && args[0] === directoryPath) {
    triggered = true;
    await originalRename(directoryPath, movedPath);
    await originalMkdir(directoryPath, { mode: 0o700 });
  }
  return value;
};
syncBuiltinESMExports();
let result;
try {
  const { recoverInterruptedCleaningCommit } = await import(moduleUrl);
  result = await recoverInterruptedCleaningCommit({ rootDir, confirmation });
} finally {
  fs.promises.readdir = originalReaddir;
  syncBuiltinESMExports();
}
process.stdout.write(JSON.stringify({
  result,
  triggered,
  sentinel_before: sentinelBefore.toString("base64"),
  sentinel_after: (await fs.promises.readFile(sentinelPath)).toString("base64"),
  moved_exists: fs.existsSync(movedPath),
  replacement_exists: fs.existsSync(directoryPath)
}));
`;

const B7_LEAF_IDENTITY_REPLACEMENT_CHILD_SCRIPT = `
import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { join } from "node:path";

const [moduleUrl, rootDir, confirmation, relativeLeaf, movedPath,
  sentinelPath] = process.argv.slice(1);
const realRoot = fs.realpathSync(rootDir);
const leafPath = join(realRoot, relativeLeaf);
const leafBytes = await fs.promises.readFile(leafPath);
const sentinelBefore = await fs.promises.readFile(sentinelPath);
const originalOpen = fs.promises.open;
const originalRename = fs.promises.rename;
const originalWriteFile = fs.promises.writeFile;
let triggered = false;
fs.promises.open = async (...args) => {
  if (!triggered && args[0] === leafPath) {
    triggered = true;
    await originalRename(leafPath, movedPath);
    await originalWriteFile(leafPath, leafBytes, { flag: "wx", mode: 0o600 });
  }
  return originalOpen(...args);
};
syncBuiltinESMExports();
let result;
try {
  const { recoverInterruptedCleaningCommit } = await import(moduleUrl);
  result = await recoverInterruptedCleaningCommit({ rootDir, confirmation });
} finally {
  fs.promises.open = originalOpen;
  syncBuiltinESMExports();
}
process.stdout.write(JSON.stringify({
  result,
  triggered,
  leaf_after: (await fs.promises.readFile(leafPath)).toString("base64"),
  moved_after: fs.existsSync(movedPath)
    ? (await fs.promises.readFile(movedPath)).toString("base64")
    : null,
  sentinel_before: sentinelBefore.toString("base64"),
  sentinel_after: (await fs.promises.readFile(sentinelPath)).toString("base64")
}));
`;

test("B7 recognized recovery candidates reject special, nonregular, and symlink leaves", async (t) => {
  const cases = [
    ["target-candidate-special-mode", async (fixture, targetDir, t) => {
      const target = makeB7RecoveryTargetFixture(fixture.currentLockBytes);
      const path = `${targetDir}/.target.810001.${"1".repeat(32)}.tmp`;
      const absolutePath = await writeB7PrivatePath(
        fixture.rootDir,
        path,
        target.bytes.subarray(0, Math.floor(target.bytes.length / 2))
      );
      await chmod(absolutePath, 0o2600);
      if (!(await requireB7ExactModeOrSkip(t, absolutePath, 0o2600))) {
        return null;
      }
      return { expectedPath: path, checks: [] };
    }],
    ["lease-candidate-symlink", async (fixture, targetDir, t) => {
      const ownerPid = 810002;
      const ownerNonce = "2".repeat(32);
      const lease = makeB7RecoveryLeaseFixture({
        targetCommitLockSha256: fixture.currentC,
        previousLeaseSha256: null,
        generation: 0,
        ownerPid,
        ownerNonce
      });
      const path = `${targetDir}/.lease-root.${ownerPid}.${ownerNonce}.tmp`;
      const externalRoot = await makeB5Root(t, "b7-candidate-symlink-external");
      const externalPath = join(externalRoot, "candidate");
      const externalBytes = lease.bytes.subarray(
        0,
        Math.floor(lease.bytes.length / 2)
      );
      const sentinelPath = join(externalRoot, "sentinel");
      const sentinelBytes = Buffer.from("candidate-symlink-sentinel");
      await writeFile(externalPath, externalBytes, { mode: 0o600 });
      await writeFile(sentinelPath, sentinelBytes, { mode: 0o600 });
      await symlink(externalPath, join(fixture.rootDir, path));
      return {
        expectedPath: path,
        checks: [
          [externalPath, externalBytes],
          [sentinelPath, sentinelBytes]
        ]
      };
    }],
    ["target-candidate-FIFO", async (fixture, targetDir) => {
      const path = `${targetDir}/.target.810003.${"3".repeat(32)}.tmp`;
      const fifo = await runBoundedChild("/usr/bin/mkfifo", [
        join(fixture.rootDir, path)
      ]);
      assert.equal(fifo.timedOut, false, fifo.stderr);
      assert.equal(fifo.code, 0, fifo.stderr);
      return { expectedPath: path, checks: [] };
    }],
    ["lease-candidate-socket", async (fixture, targetDir, t) => {
      const path = `${targetDir}/.lease-root.810004.${"4".repeat(32)}.tmp`;
      await makeB5SocketCarrier(t, join(fixture.rootDir, path));
      return { expectedPath: path, checks: [] };
    }]
  ];

  for (const [label, setup] of cases) {
    await t.test(label, async (t) => {
      const fixture = await makeB7CurrentRecoveryFixture(
        t,
        `b7-b2a-candidate-${label}`
      );
      const target = await materializeB7RecoveryPrefix(
        fixture.rootDir,
        fixture.currentC,
        fixture.currentLockBytes,
        "target-only"
      );
      const setupResult = await setup(fixture, target.targetDir, t);
      if (setupResult === null) return;
      const before = await snapshotB5Tree(fixture.rootDir);
      const child = await runBoundedChild(process.execPath, [
        "--input-type=module",
        "--eval",
        B7_RECOVERY_CHILD_SCRIPT,
        B5_MODULE_URL,
        fixture.rootDir,
        B7_CONFIRMATION
      ]);
      assert.equal(child.timedOut, false, child.stderr);
      assert.equal(child.code, 0, child.stderr);
      assert.deepEqual(
        JSON.parse(child.stdout),
        b5ExpectedFailure("LOCAL_STATE_INVALID", setupResult.expectedPath)
      );
      for (const [externalPath, externalBytes] of setupResult.checks) {
        assert.deepEqual(await readFile(externalPath), externalBytes);
      }
      assert.deepEqual(await snapshotB5Tree(fixture.rootDir), before);
    });
  }
});

test("B7 recognized target candidate same-byte inode replacement fails closed", async (t) => {
  const fixture = await makeB7CurrentRecoveryFixture(
    t,
    "b7-b2a-candidate-identity"
  );
  const target = await materializeB7RecoveryPrefix(
    fixture.rootDir,
    fixture.currentC,
    fixture.currentLockBytes,
    "target-only"
  );
  const targetFixture = makeB7RecoveryTargetFixture(fixture.currentLockBytes);
  const candidatePath =
    `${target.targetDir}/.target.810005.${"5".repeat(32)}.tmp`;
  await writeB7PrivatePath(
    fixture.rootDir,
    candidatePath,
    targetFixture.bytes.subarray(0, Math.floor(targetFixture.bytes.length / 2))
  );
  const externalRoot = await makeB5Root(t, "b7-candidate-identity-external");
  const movedPath = join(externalRoot, "moved-candidate");
  const sentinelPath = join(externalRoot, "sentinel");
  await writeFile(sentinelPath, "untouched", { mode: 0o600 });
  const before = await snapshotB5Tree(fixture.rootDir);

  const child = await runBoundedChild(process.execPath, [
    "--input-type=module",
    "--eval",
    B7_LEAF_IDENTITY_REPLACEMENT_CHILD_SCRIPT,
    B5_MODULE_URL,
    fixture.rootDir,
    B7_CONFIRMATION,
    candidatePath,
    movedPath,
    sentinelPath
  ]);
  assert.equal(child.timedOut, false, child.stderr);
  assert.equal(child.code, 0, child.stderr);
  const observed = JSON.parse(child.stdout);
  assert.equal(observed.triggered, true);
  assert.deepEqual(
    observed.result,
    b5ExpectedFailure("LOCAL_STATE_INVALID", candidatePath)
  );
  assert.equal(observed.leaf_after, observed.moved_after);
  assert.equal(observed.sentinel_after, observed.sentinel_before);
  assert.deepEqual(await snapshotB5Tree(fixture.rootDir), before);
});

test("B7 owner-alive recovery scan performs no mutation or repair fsync", async (t) => {
  const fixture = await makeB7CurrentRecoveryFixture(t, "b7-b2a-read-only");
  await materializeB7RecoveryPrefix(
    fixture.rootDir,
    fixture.currentC,
    fixture.currentLockBytes,
    "root-chain"
  );
  const before = await snapshotB5Tree(fixture.rootDir);

  const child = await runBoundedChild(process.execPath, [
    "--input-type=module",
    "--eval",
    B7_READ_ONLY_SCAN_CHILD_SCRIPT,
    B5_MODULE_URL,
    fixture.rootDir,
    B7_CONFIRMATION
  ]);
  assert.equal(child.timedOut, false, child.stderr);
  assert.equal(child.code, 0, child.stderr);
  const observed = JSON.parse(child.stdout);
  assert.deepEqual(
    observed.result,
    b5ExpectedFailure("RECOVERY_OWNER_ALIVE", B7_FIXED_COMMIT_LOCK)
  );
  assert.deepEqual(observed.writes, []);
  assert.deepEqual(observed.fsyncs, []);
  assert.deepEqual(await snapshotB5Tree(fixture.rootDir), before);
});

test("B7 recovery-root identity replacement after readdir fails closed without external mutation", async (t) => {
  const fixture = await makeB7CurrentRecoveryFixture(t, "b7-b2a-root-replace");
  await materializeB7RecoveryPrefix(
    fixture.rootDir,
    fixture.currentC,
    fixture.currentLockBytes,
    "empty"
  );
  const externalRoot = await makeB5Root(t, "b7-b2a-root-replace-external");
  const movedPath = join(externalRoot, "moved-recovery-root");
  const sentinelPath = join(externalRoot, "sentinel");
  await writeFile(sentinelPath, "untouched", { mode: 0o600 });

  const child = await runBoundedChild(process.execPath, [
    "--input-type=module",
    "--eval",
    B7_RECOVERY_ROOT_REPLACEMENT_CHILD_SCRIPT,
    B5_MODULE_URL,
    fixture.rootDir,
    B7_CONFIRMATION,
    movedPath,
    sentinelPath
  ]);
  assert.equal(child.timedOut, false, child.stderr);
  assert.equal(child.code, 0, child.stderr);
  const observed = JSON.parse(child.stdout);
  assert.equal(observed.triggered, true);
  assert.deepEqual(
    observed.result,
    b5ExpectedFailure("LOCAL_STATE_INVALID", B7_RECOVERY_LEASES_ROOT)
  );
  assert.equal(observed.sentinel_after, observed.sentinel_before);
  assert.equal(observed.moved_exists, true);
  assert.equal(observed.replacement_exists, true);
});

test("B7 fixed-lock identity drift during namespace failure outranks the stale scan conclusion", async (t) => {
  for (const namespaceFailure of ["unresolved", "malformed"]) {
    await t.test(namespaceFailure, async (t) => {
      const fixture = await makeB7CurrentRecoveryFixture(
        t,
        `b7-b2a-fixed-scan-replace-${namespaceFailure}`
      );
      if (namespaceFailure === "unresolved") {
        const historicalLockBytes = canonicalJsonDocumentBytes(
          makeB6CommitLockIntent(fixture.plan, process.pid, "7".repeat(32))
        );
        const historicalC = sha256(historicalLockBytes);
        assert.notEqual(historicalC, fixture.currentC);
        await materializeB7RecoveryPrefix(
          fixture.rootDir,
          historicalC,
          historicalLockBytes,
          "empty"
        );
      } else {
        const malformedPath = `${B7_RECOVERY_LEASES_ROOT}/A-malformed`;
        await mkdir(join(fixture.rootDir, malformedPath), {
          recursive: true,
          mode: 0o700
        });
        await chmod(join(fixture.rootDir, B7_RECOVERY_LEASES_ROOT), 0o700);
        await chmod(join(fixture.rootDir, malformedPath), 0o700);
      }
      const externalRoot = await makeB5Root(
        t,
        `b7-fixed-scan-replace-external-${namespaceFailure}`
      );
      const movedPath = join(externalRoot, "moved-fixed-lock");
      const sentinelPath = join(externalRoot, "sentinel");
      await writeFile(sentinelPath, "untouched", { mode: 0o600 });
      const before = await snapshotB5Tree(fixture.rootDir);

      const child = await runBoundedChild(process.execPath, [
        "--input-type=module",
        "--eval",
        B7_FIXED_LOCK_SCAN_REPLACEMENT_CHILD_SCRIPT,
        B5_MODULE_URL,
        fixture.rootDir,
        B7_CONFIRMATION,
        movedPath,
        sentinelPath
      ]);
      assert.equal(child.timedOut, false, child.stderr);
      assert.equal(child.code, 0, child.stderr);
      const observed = JSON.parse(child.stdout);
      const expectedLockBase64 = fixture.currentLockBytes.toString("base64");
      assert.equal(observed.triggered, true);
      assert.deepEqual(
        observed.result,
        b5ExpectedFailure("LOCAL_STATE_INVALID", B7_FIXED_COMMIT_LOCK)
      );
      assert.equal(observed.fixed_after, expectedLockBase64);
      assert.equal(observed.moved_after, expectedLockBase64);
      assert.deepEqual(
        observed.moved_identity,
        observed.lock_before_identity
      );
      assert.notDeepEqual(
        observed.replacement_identity,
        observed.lock_before_identity
      );
      assert.equal(observed.sentinel_after, observed.sentinel_before);
      assert.deepEqual(await snapshotB5Tree(fixture.rootDir), before);
    });
  }
});

test("B7 recovery target-directory identity replacement after readdir fails closed", async (t) => {
  const fixture = await makeB7CurrentRecoveryFixture(
    t,
    "b7-b2a-target-dir-replace"
  );
  const target = await materializeB7RecoveryPrefix(
    fixture.rootDir,
    fixture.currentC,
    fixture.currentLockBytes,
    "empty"
  );
  const externalRoot = await makeB5Root(t, "b7-target-dir-replace-external");
  const movedPath = join(externalRoot, "moved-target-directory");
  const sentinelPath = join(externalRoot, "sentinel");
  await writeFile(sentinelPath, "untouched", { mode: 0o600 });

  const child = await runBoundedChild(process.execPath, [
    "--input-type=module",
    "--eval",
    B7_DIRECTORY_IDENTITY_REPLACEMENT_CHILD_SCRIPT,
    B5_MODULE_URL,
    fixture.rootDir,
    B7_CONFIRMATION,
    target.targetDir,
    movedPath,
    sentinelPath
  ]);
  assert.equal(child.timedOut, false, child.stderr);
  assert.equal(child.code, 0, child.stderr);
  const observed = JSON.parse(child.stdout);
  assert.equal(observed.triggered, true);
  assert.deepEqual(
    observed.result,
    b5ExpectedFailure("LOCAL_STATE_INVALID", target.targetDir)
  );
  assert.equal(observed.sentinel_after, observed.sentinel_before);
  assert.equal(observed.moved_exists, true);
  assert.equal(observed.replacement_exists, true);
});

test("B7 target and root-lease same-byte inode replacements fail closed", async (t) => {
  const cases = [
    ["target.json", "target-only", (materialized) =>
      `${materialized.targetDir}/target.json`],
    ["lease-root.json", "root-chain", (materialized) =>
      `${materialized.targetDir}/lease-root.json`]
  ];
  for (const [label, prefix, leafPathFor] of cases) {
    await t.test(label, async (t) => {
      const fixture = await makeB7CurrentRecoveryFixture(
        t,
        `b7-b2a-leaf-replace-${label}`
      );
      const materialized = await materializeB7RecoveryPrefix(
        fixture.rootDir,
        fixture.currentC,
        fixture.currentLockBytes,
        prefix
      );
      const leafPath = leafPathFor(materialized);
      const externalRoot = await makeB5Root(t, `b7-${label}-replace-external`);
      const movedPath = join(externalRoot, `moved-${label}`);
      const sentinelPath = join(externalRoot, "sentinel");
      await writeFile(sentinelPath, "untouched", { mode: 0o600 });
      const before = await snapshotB5Tree(fixture.rootDir);

      const child = await runBoundedChild(process.execPath, [
        "--input-type=module",
        "--eval",
        B7_LEAF_IDENTITY_REPLACEMENT_CHILD_SCRIPT,
        B5_MODULE_URL,
        fixture.rootDir,
        B7_CONFIRMATION,
        leafPath,
        movedPath,
        sentinelPath
      ]);
      assert.equal(child.timedOut, false, child.stderr);
      assert.equal(child.code, 0, child.stderr);
      const observed = JSON.parse(child.stdout);
      assert.equal(observed.triggered, true);
      assert.deepEqual(
        observed.result,
        b5ExpectedFailure("LOCAL_STATE_INVALID", leafPath)
      );
      assert.equal(observed.leaf_after, observed.moved_after);
      assert.equal(observed.sentinel_after, observed.sentinel_before);
      assert.deepEqual(await snapshotB5Tree(fixture.rootDir), before);
    });
  }
});

const B7_TRANSITIONS_DIRECTORY = ".local/state/cleaning-transitions";

function makeB7CompletionTerminalFixture(
  plan,
  commitLockSha256,
  {
    desiredSuffix = plan.manifest.desired_pointer_sha256,
    recordOverrides = {}
  } = {}
) {
  const value = {
    schema_version: "1.0.0",
    record_kind: "completion",
    commit_lock_sha256: commitLockSha256,
    plan_manifest_sha256: plan.manifest_sha256,
    expected_prior_pointer_sha256:
      plan.manifest.expected_prior_pointer_sha256,
    desired_pointer_sha256: plan.manifest.desired_pointer_sha256,
    desired_pointer: structuredClone(plan.manifest.desired_pointer),
    ...recordOverrides
  };
  const name = `complete-${commitLockSha256}-${desiredSuffix}.json`;
  return {
    value,
    bytes: canonicalJsonDocumentBytes(value),
    name,
    path: `${B7_TRANSITIONS_DIRECTORY}/${name}`
  };
}

function makeB7RetirementTerminalFixture(
  plan,
  commitLockSha256,
  observedPointerSha256,
  {
    observedSuffix = observedPointerSha256 ?? "absent",
    recordOverrides = {}
  } = {}
) {
  const value = {
    schema_version: "1.0.0",
    record_kind: "retirement",
    plan_manifest_sha256: plan.manifest_sha256,
    commit_lock_sha256: commitLockSha256,
    expected_prior_pointer_sha256:
      plan.manifest.expected_prior_pointer_sha256,
    desired_pointer_sha256: plan.manifest.desired_pointer_sha256,
    observed_pointer_sha256: observedPointerSha256,
    reason: "stale_pointer",
    ...recordOverrides
  };
  const name = `retire-${commitLockSha256}-${observedSuffix}.json`;
  return {
    value,
    bytes: canonicalJsonDocumentBytes(value),
    name,
    path: `${B7_TRANSITIONS_DIRECTORY}/${name}`
  };
}

async function writeB7TerminalFixture(
  rootDir,
  terminal,
  bytes = terminal.bytes,
  mode = 0o600
) {
  await mkdir(join(rootDir, B7_TRANSITIONS_DIRECTORY), {
    recursive: true,
    mode: 0o700
  });
  await chmod(join(rootDir, B7_TRANSITIONS_DIRECTORY), 0o700);
  await writeB7PrivatePath(rootDir, terminal.path, bytes, mode);
}

async function makeB7HistoricalTerminalTarget(
  rootDir,
  plan,
  ownerNonce,
  prefix = "root-chain"
) {
  const lockBytes = canonicalJsonDocumentBytes(
    makeB6CommitLockIntent(plan, process.pid, ownerNonce)
  );
  const commitLockSha256 = sha256(lockBytes);
  const materialized = await materializeB7RecoveryPrefix(
    rootDir,
    commitLockSha256,
    lockBytes,
    prefix
  );
  return { ...materialized, lockBytes, commitLockSha256 };
}

async function runB7ReadOnlyRecoveryChild(rootDir) {
  const child = await runBoundedChild(process.execPath, [
    "--input-type=module",
    "--eval",
    B7_READ_ONLY_SCAN_CHILD_SCRIPT,
    B5_MODULE_URL,
    rootDir,
    B7_CONFIRMATION
  ]);
  assert.equal(child.timedOut, false, child.stderr);
  assert.equal(child.code, 0, child.stderr);
  return JSON.parse(child.stdout);
}

const B7_TRANSITION_DIRECTORY_REPLACEMENT_CHILD_SCRIPT = `
import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { join } from "node:path";

const [moduleUrl, rootDir, confirmation, relativeDirectory, movedPath,
  sentinelPath] = process.argv.slice(1);
const realRoot = fs.realpathSync(rootDir);
const directoryPath = join(realRoot, relativeDirectory);
const originalReaddir = fs.promises.readdir;
const originalRename = fs.promises.rename;
const originalMkdir = fs.promises.mkdir;
const originalReadFile = fs.promises.readFile;
const originalWriteFile = fs.promises.writeFile;
const originalChmod = fs.promises.chmod;
const sentinelBefore = await originalReadFile(sentinelPath);
let triggered = false;
fs.promises.readdir = async (...args) => {
  const value = await originalReaddir(...args);
  if (!triggered && args[0] === directoryPath) {
    triggered = true;
    await originalRename(directoryPath, movedPath);
    await originalMkdir(directoryPath, { mode: 0o700 });
    await originalChmod(directoryPath, 0o700);
    for (const name of value) {
      const bytes = await originalReadFile(join(movedPath, name));
      await originalWriteFile(join(directoryPath, name), bytes, {
        flag: "wx",
        mode: 0o600
      });
      await originalChmod(join(directoryPath, name), 0o600);
    }
  }
  return value;
};
syncBuiltinESMExports();
let result;
try {
  const { recoverInterruptedCleaningCommit } = await import(moduleUrl);
  result = await recoverInterruptedCleaningCommit({ rootDir, confirmation });
} finally {
  fs.promises.readdir = originalReaddir;
  syncBuiltinESMExports();
}
process.stdout.write(JSON.stringify({
  result,
  triggered,
  sentinel_before: sentinelBefore.toString("base64"),
  sentinel_after: (await originalReadFile(sentinelPath)).toString("base64")
}));
`;

test("B7 historical C-bound terminal resolves exact completion and retirement only", async (t) => {
  const recoverInterruptedCleaningCommit =
    await loadRecoverInterruptedCleaningCommit();

  for (const outcome of [
    { label: "completion", kind: "completion" },
    { label: "retirement-absent", kind: "retirement", observed: null },
    {
      label: "retirement-observed",
      kind: "retirement",
      observed: sha256(Buffer.from("observed historical pointer\n"))
    }
  ]) {
    await t.test(`exact ${outcome.label}`, async (t) => {
      const fixture = await makeB7StagedRoot(
        t,
        `b7-b2b-historical-${outcome.label}`
      );
      const target = await makeB7HistoricalTerminalTarget(
        fixture.rootDir,
        fixture.plan,
        "1".repeat(32)
      );
      const terminal = outcome.kind === "completion"
        ? makeB7CompletionTerminalFixture(
          fixture.plan,
          target.commitLockSha256
        )
        : makeB7RetirementTerminalFixture(
          fixture.plan,
          target.commitLockSha256,
          outcome.observed
        );
      await writeB7TerminalFixture(fixture.rootDir, terminal);
      const before = await snapshotB5Tree(fixture.rootDir);

      assert.deepEqual(
        await recoverInterruptedCleaningCommit(b7Options(fixture.rootDir)),
        b7NoUnresolvedTargetResult()
      );
      assert.deepEqual(await snapshotB5Tree(fixture.rootDir), before);
    });
  }

  await t.test("valid target and root chain without C terminal is unresolved", async (t) => {
    const fixture = await makeB7StagedRoot(
      t,
      "b7-b2b-historical-terminal-absent"
    );
    const target = await makeB7HistoricalTerminalTarget(
      fixture.rootDir,
      fixture.plan,
      "2".repeat(32)
    );
    const before = await snapshotB5Tree(fixture.rootDir);

    assert.deepEqual(
      await recoverInterruptedCleaningCommit(b7Options(fixture.rootDir)),
      b5ExpectedFailure("RECOVERY_UNRESOLVED_TARGET", target.targetDir)
    );
    assert.deepEqual(await snapshotB5Tree(fixture.rootDir), before);
  });

  for (const conflict of ["completion-and-retirement", "two-retirements"]) {
    await t.test(conflict, async (t) => {
      const fixture = await makeB7StagedRoot(
        t,
        `b7-b2b-historical-${conflict}`
      );
      const target = await makeB7HistoricalTerminalTarget(
        fixture.rootDir,
        fixture.plan,
        "3".repeat(32)
      );
      const first = conflict === "completion-and-retirement"
        ? makeB7CompletionTerminalFixture(
          fixture.plan,
          target.commitLockSha256
        )
        : makeB7RetirementTerminalFixture(
          fixture.plan,
          target.commitLockSha256,
          sha256(Buffer.from("first observed pointer\n"))
        );
      const second = makeB7RetirementTerminalFixture(
        fixture.plan,
        target.commitLockSha256,
        sha256(Buffer.from("second observed pointer\n"))
      );
      await writeB7TerminalFixture(fixture.rootDir, first);
      await writeB7TerminalFixture(fixture.rootDir, second);
      const before = await snapshotB5Tree(fixture.rootDir);

      assert.deepEqual(
        await recoverInterruptedCleaningCommit(b7Options(fixture.rootDir)),
        b5ExpectedFailure("RECOVERY_TARGET_AMBIGUOUS", target.targetDir)
      );
      assert.deepEqual(await snapshotB5Tree(fixture.rootDir), before);
    });
  }

  for (const mismatch of [
    "noncanonical-bytes",
    "wrong-plan-binding",
    "wrong-desired-binding",
    "filename-record-suffix"
  ]) {
    await t.test(mismatch, async (t) => {
      const fixture = await makeB7StagedRoot(
        t,
        `b7-b2b-historical-${mismatch}`
      );
      const target = await makeB7HistoricalTerminalTarget(
        fixture.rootDir,
        fixture.plan,
        "4".repeat(32)
      );
      let terminal;
      let bytes;
      if (mismatch === "filename-record-suffix") {
        const recordObserved = sha256(Buffer.from("record observed pointer\n"));
        terminal = makeB7RetirementTerminalFixture(
          fixture.plan,
          target.commitLockSha256,
          recordObserved,
          {
            observedSuffix: sha256(Buffer.from("filename observed pointer\n"))
          }
        );
        bytes = terminal.bytes;
      } else {
        terminal = makeB7CompletionTerminalFixture(
          fixture.plan,
          target.commitLockSha256,
          {
            recordOverrides: mismatch === "wrong-plan-binding"
              ? { plan_manifest_sha256: "0".repeat(64) }
              : mismatch === "wrong-desired-binding"
                ? { desired_pointer_sha256: "0".repeat(64) }
                : {}
          }
        );
        bytes = mismatch === "noncanonical-bytes"
          ? Buffer.from(`${JSON.stringify(terminal.value)}\n`)
          : terminal.bytes;
        if (mismatch === "noncanonical-bytes") {
          assert.equal(bytes.equals(terminal.bytes), false);
        }
      }
      await writeB7TerminalFixture(fixture.rootDir, terminal, bytes);
      const before = await snapshotB5Tree(fixture.rootDir);

      assert.deepEqual(
        await recoverInterruptedCleaningCommit(b7Options(fixture.rootDir)),
        b5ExpectedFailure("RECOVERY_TARGET_AMBIGUOUS", target.targetDir)
      );
      assert.deepEqual(await snapshotB5Tree(fixture.rootDir), before);
    });
  }

  for (const unsafeKind of ["wrong-mode", "symlink", "fifo", "socket"]) {
    await t.test(unsafeKind, async (t) => {
      const fixture = await makeB7StagedRoot(
        t,
        `b7-b2b-historical-terminal-${unsafeKind}`
      );
      const target = await makeB7HistoricalTerminalTarget(
        fixture.rootDir,
        fixture.plan,
        "5".repeat(32)
      );
      const terminal = makeB7CompletionTerminalFixture(
        fixture.plan,
        target.commitLockSha256
      );
      await mkdir(join(fixture.rootDir, B7_TRANSITIONS_DIRECTORY), {
        recursive: true,
        mode: 0o700
      });
      await chmod(join(fixture.rootDir, B7_TRANSITIONS_DIRECTORY), 0o700);
      const absoluteTerminal = join(fixture.rootDir, terminal.path);
      let externalPath = null;
      let externalBytes = null;
      let server = null;
      if (unsafeKind === "wrong-mode") {
        await writeB7PrivatePath(
          fixture.rootDir,
          terminal.path,
          terminal.bytes,
          0o640
        );
      } else if (unsafeKind === "symlink") {
        const externalRoot = await makeB5Root(
          t,
          "b7-b2b-historical-terminal-symlink-external"
        );
        externalPath = join(externalRoot, "terminal-referent");
        externalBytes = Buffer.from("external terminal referent\n");
        await writeFile(externalPath, externalBytes, { mode: 0o600 });
        await symlink(externalPath, absoluteTerminal);
      } else if (unsafeKind === "fifo") {
        const child = await runBoundedChild("/usr/bin/mkfifo", [absoluteTerminal]);
        assert.equal(child.timedOut, false, child.stderr);
        assert.equal(child.code, 0, child.stderr);
      } else {
        const shortSocketRoot = await mkdtemp(join(tmpdir(), "b7s-"));
        const shortSocketPath = join(shortSocketRoot, "s");
        server = createServer();
        await new Promise((resolvePromise, rejectPromise) => {
          server.once("error", rejectPromise);
          server.listen(shortSocketPath, resolvePromise);
        });
        await rename(shortSocketPath, absoluteTerminal);
        t.after(async () => {
          await new Promise((resolvePromise) => server.close(resolvePromise));
          await rm(shortSocketRoot, { recursive: true, force: true });
        });
      }
      const before = await snapshotB5Tree(fixture.rootDir);

      assert.deepEqual(
        await recoverInterruptedCleaningCommit(b7Options(fixture.rootDir)),
        b5ExpectedFailure("LOCAL_STATE_INVALID", terminal.path)
      );
      if (externalPath !== null) {
        assert.deepEqual(await readFile(externalPath), externalBytes);
      }
      assert.deepEqual(await snapshotB5Tree(fixture.rootDir), before);
    });
  }
});

test("B7 same-plan terminal isolation resolves each exact C independently", async (t) => {
  const recoverInterruptedCleaningCommit =
    await loadRecoverInterruptedCleaningCommit();
  const fixture = await makeB7StagedRoot(t, "b7-b2b-same-plan-isolation");
  const attemptA = await makeB7HistoricalTerminalTarget(
    fixture.rootDir,
    fixture.plan,
    "a".repeat(32)
  );
  const attemptB = await makeB7HistoricalTerminalTarget(
    fixture.rootDir,
    fixture.plan,
    "b".repeat(32)
  );
  assert.notEqual(attemptA.commitLockSha256, attemptB.commitLockSha256);
  const completionA = makeB7CompletionTerminalFixture(
    fixture.plan,
    attemptA.commitLockSha256
  );
  const retirementB = makeB7RetirementTerminalFixture(
    fixture.plan,
    attemptB.commitLockSha256,
    null
  );
  await writeB7TerminalFixture(fixture.rootDir, completionA);
  await writeB7TerminalFixture(fixture.rootDir, retirementB);

  const otherC = "f".repeat(64);
  assert.notEqual(otherC, attemptA.commitLockSha256);
  assert.notEqual(otherC, attemptB.commitLockSha256);
  await writeB7TerminalFixture(
    fixture.rootDir,
    makeB7CompletionTerminalFixture(fixture.plan, otherC)
  );
  const before = await snapshotB5Tree(fixture.rootDir);

  assert.deepEqual(
    await recoverInterruptedCleaningCommit(b7Options(fixture.rootDir)),
    b7NoUnresolvedTargetResult()
  );
  assert.deepEqual(await snapshotB5Tree(fixture.rootDir), before);
});

test("B7 current C-bound terminal is exact or absent before owner-alive", async (t) => {
  const recoverInterruptedCleaningCommit =
    await loadRecoverInterruptedCleaningCommit();

  await t.test("historical exact completion precedes current owner-alive", async (t) => {
    const fixture = await makeB7CurrentRecoveryFixture(
      t,
      "b7-b2b-historical-before-current"
    );
    const historical = await makeB7HistoricalTerminalTarget(
      fixture.rootDir,
      fixture.plan,
      "c".repeat(32)
    );
    assert.notEqual(historical.commitLockSha256, fixture.currentC);
    await writeB7TerminalFixture(
      fixture.rootDir,
      makeB7CompletionTerminalFixture(
        fixture.plan,
        historical.commitLockSha256
      )
    );
    await materializeB7RecoveryPrefix(
      fixture.rootDir,
      fixture.currentC,
      fixture.currentLockBytes,
      "root-chain"
    );
    const before = await snapshotB5Tree(fixture.rootDir);

    const observed = await runB7ReadOnlyRecoveryChild(fixture.rootDir);
    assert.deepEqual(
      observed.result,
      b5ExpectedFailure("RECOVERY_OWNER_ALIVE", B7_FIXED_COMMIT_LOCK)
    );
    assert.deepEqual(observed.writes, []);
    assert.deepEqual(observed.fsyncs, []);
    assert.deepEqual(await snapshotB5Tree(fixture.rootDir), before);
  });

  await t.test("historical missing terminal outranks current owner-alive", async (t) => {
    const fixture = await makeB7CurrentRecoveryFixture(
      t,
      "b7-b2b-historical-missing-before-current"
    );
    const historical = await makeB7HistoricalTerminalTarget(
      fixture.rootDir,
      fixture.plan,
      "d".repeat(32)
    );
    await materializeB7RecoveryPrefix(
      fixture.rootDir,
      fixture.currentC,
      fixture.currentLockBytes,
      "root-chain"
    );
    const before = await snapshotB5Tree(fixture.rootDir);

    assert.deepEqual(
      await recoverInterruptedCleaningCommit(b7Options(fixture.rootDir)),
      b5ExpectedFailure(
        "RECOVERY_UNRESOLVED_TARGET",
        historical.targetDir
      )
    );
    assert.deepEqual(await snapshotB5Tree(fixture.rootDir), before);
  });

  await t.test("exact current completion stays read-only before owner-alive", async (t) => {
    const fixture = await makeB7CurrentRecoveryFixture(
      t,
      "b7-b2b-current-exact-terminal"
    );
    await materializeB7RecoveryPrefix(
      fixture.rootDir,
      fixture.currentC,
      fixture.currentLockBytes,
      "root-chain"
    );
    await writeB7TerminalFixture(
      fixture.rootDir,
      makeB7CompletionTerminalFixture(fixture.plan, fixture.currentC)
    );
    const before = await snapshotB5Tree(fixture.rootDir);

    const observed = await runB7ReadOnlyRecoveryChild(fixture.rootDir);
    assert.deepEqual(
      observed.result,
      b5ExpectedFailure("RECOVERY_OWNER_ALIVE", B7_FIXED_COMMIT_LOCK)
    );
    assert.deepEqual(observed.writes, []);
    assert.deepEqual(observed.fsyncs, []);
    assert.deepEqual(await snapshotB5Tree(fixture.rootDir), before);
  });

  for (const malformed of ["wrong-bytes", "multiple", "wrong-mode"]) {
    await t.test(`${malformed} outranks owner-alive`, async (t) => {
      const fixture = await makeB7CurrentRecoveryFixture(
        t,
        `b7-b2b-current-${malformed}`
      );
      const current = await materializeB7RecoveryPrefix(
        fixture.rootDir,
        fixture.currentC,
        fixture.currentLockBytes,
        "root-chain"
      );
      const completion = makeB7CompletionTerminalFixture(
        fixture.plan,
        fixture.currentC
      );
      if (malformed === "wrong-bytes") {
        await writeB7TerminalFixture(
          fixture.rootDir,
          completion,
          canonicalJsonDocumentBytes({
            ...completion.value,
            plan_manifest_sha256: "0".repeat(64)
          })
        );
      } else {
        await writeB7TerminalFixture(
          fixture.rootDir,
          completion,
          completion.bytes,
          malformed === "wrong-mode" ? 0o640 : 0o600
        );
        if (malformed === "multiple") {
          await writeB7TerminalFixture(
            fixture.rootDir,
            makeB7RetirementTerminalFixture(
              fixture.plan,
              fixture.currentC,
              null
            )
          );
        }
      }
      const before = await snapshotB5Tree(fixture.rootDir);
      const expectedPath = malformed === "wrong-mode"
        ? completion.path
        : current.targetDir;
      const expectedCode = malformed === "wrong-mode"
        ? "LOCAL_STATE_INVALID"
        : "RECOVERY_TARGET_AMBIGUOUS";

      const observed = await runB7ReadOnlyRecoveryChild(fixture.rootDir);
      assert.deepEqual(
        observed.result,
        b5ExpectedFailure(expectedCode, expectedPath)
      );
      assert.deepEqual(observed.writes, []);
      assert.deepEqual(observed.fsyncs, []);
      assert.deepEqual(await snapshotB5Tree(fixture.rootDir), before);
    });
  }

  for (const replacement of ["directory", "leaf"]) {
    await t.test(`transition ${replacement} identity replacement`, async (t) => {
      const fixture = await makeB7CurrentRecoveryFixture(
        t,
        `b7-b2b-transition-${replacement}-replacement`
      );
      const current = await materializeB7RecoveryPrefix(
        fixture.rootDir,
        fixture.currentC,
        fixture.currentLockBytes,
        "root-chain"
      );
      const completion = makeB7CompletionTerminalFixture(
        fixture.plan,
        fixture.currentC
      );
      await writeB7TerminalFixture(fixture.rootDir, completion);
      const externalRoot = await makeB5Root(
        t,
        `b7-b2b-transition-${replacement}-external`
      );
      const movedPath = join(externalRoot, `moved-${replacement}`);
      const sentinelPath = join(externalRoot, "sentinel");
      await writeFile(sentinelPath, "untouched", { mode: 0o600 });
      const before = await snapshotB5Tree(fixture.rootDir);
      const script = replacement === "directory"
        ? B7_TRANSITION_DIRECTORY_REPLACEMENT_CHILD_SCRIPT
        : B7_LEAF_IDENTITY_REPLACEMENT_CHILD_SCRIPT;
      const relativePath = replacement === "directory"
        ? B7_TRANSITIONS_DIRECTORY
        : completion.path;
      const child = await runBoundedChild(process.execPath, [
        "--input-type=module",
        "--eval",
        script,
        B5_MODULE_URL,
        fixture.rootDir,
        B7_CONFIRMATION,
        relativePath,
        movedPath,
        sentinelPath
      ]);
      assert.equal(child.timedOut, false, child.stderr);
      assert.equal(child.code, 0, child.stderr);
      const observed = JSON.parse(child.stdout);
      assert.equal(observed.triggered, true);
      assert.deepEqual(
        observed.result,
        b5ExpectedFailure("LOCAL_STATE_INVALID", relativePath)
      );
      assert.equal(observed.sentinel_after, observed.sentinel_before);
      assert.deepEqual(await snapshotB5Tree(fixture.rootDir), before);
      assert.equal(current.targetDir.endsWith(fixture.currentC), true);
    });
  }
});

function makeB7HistoricalLockAfter(plan, lowerBoundC) {
  for (let ordinal = 1; ordinal < 10000; ordinal += 1) {
    const ownerNonce = ordinal.toString(16).padStart(32, "0");
    const lockBytes = canonicalJsonDocumentBytes(
      makeB6CommitLockIntent(plan, process.pid, ownerNonce)
    );
    const commitLockSha256 = sha256(lockBytes);
    if (commitLockSha256 > lowerBoundC) {
      return { ownerNonce, lockBytes, commitLockSha256 };
    }
  }
  assert.fail("unable to construct an ASCII-later historical target");
}

function makeB7HistoricalLockBefore(plan, upperBoundC) {
  for (let ordinal = 1; ordinal < 10000; ordinal += 1) {
    const ownerNonce = ordinal.toString(16).padStart(32, "0");
    const lockBytes = canonicalJsonDocumentBytes(
      makeB6CommitLockIntent(plan, process.pid, ownerNonce)
    );
    const commitLockSha256 = sha256(lockBytes);
    if (commitLockSha256 < upperBoundC) {
      return { ownerNonce, lockBytes, commitLockSha256 };
    }
  }
  assert.fail("unable to construct an ASCII-earlier historical target");
}

async function makeB7CurrentFirstRaceFixture(t, label) {
  const fixture = await makeB7CurrentRecoveryFixture(t, label);
  const historicalLock = makeB7HistoricalLockAfter(
    fixture.plan,
    fixture.currentC
  );
  await materializeB7RecoveryPrefix(
    fixture.rootDir,
    fixture.currentC,
    fixture.currentLockBytes,
    "root-chain"
  );
  const historical = await materializeB7RecoveryPrefix(
    fixture.rootDir,
    historicalLock.commitLockSha256,
    historicalLock.lockBytes,
    "root-chain"
  );
  const targetNames = (await readdir(
    join(fixture.rootDir, B7_RECOVERY_LEASES_ROOT)
  )).sort();
  assert.deepEqual(targetNames, [
    fixture.currentC,
    historicalLock.commitLockSha256
  ]);
  return {
    ...fixture,
    historical: {
      ...historical,
      ...historicalLock
    }
  };
}

const B7_TRANSITIONS_SNAPSHOT_RACE_CHILD_SCRIPT = `
import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { join, relative, sep } from "node:path";

const [moduleUrl, rootDir, confirmation, mode, secondTargetRelative,
  injectedRelative, injectedBytesBase64, sentinelPath] = process.argv.slice(1);
const realRoot = fs.realpathSync(rootDir);
const transitionsPath = join(
  realRoot,
  ".local",
  "state",
  "cleaning-transitions"
);
const secondTargetPath = join(realRoot, ...secondTargetRelative.split("/"));
const injectedPath = join(realRoot, ...injectedRelative.split("/"));
const injectedBytes = Buffer.from(injectedBytesBase64, "base64");
const sentinelBefore = fs.readFileSync(sentinelPath);
const mutationNames = [
  "appendFile", "chmod", "chown", "copyFile", "cp", "lchown", "link",
  "lutimes", "mkdir", "mkdtemp", "rename", "rm", "rmdir", "symlink",
  "truncate", "unlink", "utimes", "writeFile"
].filter((name) => typeof fs.promises[name] === "function");
const original = {
  open: fs.promises.open,
  lstat: fs.promises.lstat,
  readdir: fs.promises.readdir
};
for (const name of mutationNames) original[name] = fs.promises[name];
const writes = [];
const fsyncs = [];
let triggered = false;
let transitionsLstatCount = 0;
let treeAfterHook = null;

function snapshotTree() {
  const entries = [];
  function visit(absoluteDirectory) {
    const names = fs.readdirSync(absoluteDirectory).sort();
    for (const name of names) {
      const absolutePath = join(absoluteDirectory, name);
      const repoPath = relative(realRoot, absolutePath).split(sep).join("/");
      const stat = fs.lstatSync(absolutePath);
      if (stat.isDirectory() && !stat.isSymbolicLink()) {
        entries.push([repoPath, "directory"]);
        visit(absolutePath);
      } else if (stat.isFile() && !stat.isSymbolicLink()) {
        entries.push([
          repoPath,
          "file",
          fs.readFileSync(absolutePath).toString("base64")
        ]);
      } else if (stat.isSymbolicLink()) {
        entries.push([repoPath, "symlink", fs.readlinkSync(absolutePath)]);
      } else {
        entries.push([repoPath, "other"]);
      }
    }
  }
  visit(realRoot);
  return entries;
}

async function injectTransition() {
  if (mode === "absent-to-present") {
    await original.mkdir(transitionsPath, { mode: 0o700 });
    await original.chmod(transitionsPath, 0o700);
  }
  await original.writeFile(injectedPath, injectedBytes, {
    flag: "wx",
    mode: 0o600
  });
  await original.chmod(injectedPath, 0o600);
  triggered = true;
  treeAfterHook = snapshotTree();
}

for (const name of mutationNames) {
  fs.promises[name] = async (...args) => {
    writes.push([name, String(args[0])]);
    const error = new Error("synthetic production mutation");
    error.code = "SYNTHETIC_MUTATION";
    throw error;
  };
}
fs.promises.open = async (...args) => {
  const [path, flags] = args;
  const numericFlags = typeof flags === "number" ? flags : 0;
  if ((numericFlags & (fs.constants.O_WRONLY | fs.constants.O_RDWR |
      fs.constants.O_CREAT | fs.constants.O_TRUNC | fs.constants.O_APPEND)) !== 0 ||
      (typeof flags === "string" && /[wax+]/.test(flags))) {
    writes.push(["open", String(path)]);
    const error = new Error("synthetic mutating open");
    error.code = "SYNTHETIC_MUTATION";
    throw error;
  }
  const handle = await original.open(...args);
  return new Proxy(handle, {
    get(target, property) {
      if (property === "sync" || property === "datasync") {
        return async () => {
          fsyncs.push([String(property), String(path)]);
          const error = new Error("synthetic fsync");
          error.code = "SYNTHETIC_FSYNC";
          throw error;
        };
      }
      const value = Reflect.get(target, property, target);
      return typeof value === "function" ? value.bind(target) : value;
    }
  });
};
fs.promises.lstat = async (...args) => {
  if (mode === "absent-to-present" && args[0] === transitionsPath) {
    transitionsLstatCount += 1;
    if (!triggered && transitionsLstatCount === 2) {
      await injectTransition();
    }
  }
  return original.lstat(...args);
};
fs.promises.readdir = async (...args) => {
  const value = await original.readdir(...args);
  if (mode === "names-drift" && !triggered && args[0] === secondTargetPath) {
    await injectTransition();
  }
  return value;
};
syncBuiltinESMExports();
let result;
try {
  const { recoverInterruptedCleaningCommit } = await import(moduleUrl);
  result = await recoverInterruptedCleaningCommit({ rootDir, confirmation });
} finally {
  Object.assign(fs.promises, original);
  syncBuiltinESMExports();
}
process.stdout.write(JSON.stringify({
  result,
  triggered,
  writes,
  fsyncs,
  tree_after_hook: treeAfterHook,
  tree_after_run: snapshotTree(),
  sentinel_before: sentinelBefore.toString("base64"),
  sentinel_after: fs.readFileSync(sentinelPath).toString("base64")
}));
`;

async function runB7TransitionsSnapshotRaceChild({
  rootDir,
  mode,
  secondTargetPath,
  injectedTerminal,
  sentinelPath
}) {
  const child = await runBoundedChild(process.execPath, [
    "--input-type=module",
    "--eval",
    B7_TRANSITIONS_SNAPSHOT_RACE_CHILD_SCRIPT,
    B5_MODULE_URL,
    rootDir,
    B7_CONFIRMATION,
    mode,
    secondTargetPath,
    injectedTerminal.path,
    injectedTerminal.bytes.toString("base64"),
    sentinelPath
  ]);
  assert.equal(child.timedOut, false, child.stderr);
  assert.equal(child.code, 0, child.stderr);
  return JSON.parse(child.stdout);
}

test("B7 transitions first snapshot rejects cross-target absent-to-present and names drift", async (t) => {
  for (const mode of ["absent-to-present", "names-drift"]) {
    await t.test(mode, async (t) => {
      const fixture = await makeB7CurrentFirstRaceFixture(
        t,
        `b7-b2b-fix1-${mode}`
      );
      const historicalTerminal = makeB7CompletionTerminalFixture(
        fixture.plan,
        fixture.historical.commitLockSha256
      );
      let injectedTerminal = historicalTerminal;
      let expectedPath = B7_TRANSITIONS_DIRECTORY;
      if (mode === "names-drift") {
        await writeB7TerminalFixture(
          fixture.rootDir,
          makeB7CompletionTerminalFixture(
            fixture.plan,
            fixture.currentC
          )
        );
        await writeB7TerminalFixture(
          fixture.rootDir,
          historicalTerminal
        );
        const otherC = "f".repeat(64);
        assert.notEqual(otherC, fixture.currentC);
        assert.notEqual(otherC, fixture.historical.commitLockSha256);
        injectedTerminal = makeB7CompletionTerminalFixture(
          fixture.plan,
          otherC
        );
        expectedPath = injectedTerminal.path;
      }
      const externalRoot = await makeB5Root(
        t,
        `b7-b2b-fix1-${mode}-external`
      );
      const sentinelPath = join(externalRoot, "sentinel");
      await writeFile(sentinelPath, "untouched", { mode: 0o600 });

      const observed = await runB7TransitionsSnapshotRaceChild({
        rootDir: fixture.rootDir,
        mode,
        secondTargetPath: fixture.historical.targetDir,
        injectedTerminal,
        sentinelPath
      });

      assert.equal(observed.triggered, true);
      assert.deepEqual(
        observed.result,
        b5ExpectedFailure("LOCAL_STATE_INVALID", expectedPath)
      );
      assert.deepEqual(observed.writes, []);
      assert.deepEqual(observed.fsyncs, []);
      assert.deepEqual(observed.tree_after_run, observed.tree_after_hook);
      assert.equal(observed.sentinel_after, observed.sentinel_before);
    });
  }
});

test("B7 cross-layout C-bound terminal uses historical target layout before current owner-alive", async (t) => {
  const stageCleaningRun = await loadStageCleaningRun();
  const fixture = await makeB7StagedRoot(t, "b7-b2b-fix1-cross-layout");
  const historicalPlan = fixture.plan;
  const currentPlan = makeB5EmptyPlan();
  assert.notEqual(
    historicalPlan.manifest_sha256,
    currentPlan.manifest_sha256
  );
  assert.notEqual(
    historicalPlan.manifest.desired_pointer_sha256,
    currentPlan.manifest.desired_pointer_sha256
  );
  const currentStaged = await stageCleaningRun(
    b5Options(fixture.rootDir, currentPlan)
  );
  assert.equal(currentStaged.ok, true);
  const currentLockBytes = await writeB7FixedLock(
    fixture.rootDir,
    makeB6CommitLockIntent(currentPlan, process.pid, "8".repeat(32))
  );
  const currentC = sha256(currentLockBytes);
  const historical = await makeB7HistoricalTerminalTarget(
    fixture.rootDir,
    historicalPlan,
    "7".repeat(32)
  );
  await materializeB7RecoveryPrefix(
    fixture.rootDir,
    currentC,
    currentLockBytes,
    "root-chain"
  );
  await writeB7TerminalFixture(
    fixture.rootDir,
    makeB7CompletionTerminalFixture(
      historicalPlan,
      historical.commitLockSha256
    )
  );
  const before = await snapshotB5Tree(fixture.rootDir);

  const observed = await runB7ReadOnlyRecoveryChild(fixture.rootDir);
  assert.deepEqual(
    observed.result,
    b5ExpectedFailure("RECOVERY_OWNER_ALIVE", B7_FIXED_COMMIT_LOCK)
  );
  assert.deepEqual(observed.writes, []);
  assert.deepEqual(observed.fsyncs, []);
  assert.deepEqual(await snapshotB5Tree(fixture.rootDir), before);
});

const B7_C_STALE_RECOVERY_CHILD_SCRIPT = `
import crypto from "node:crypto";
import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { basename } from "node:path";

const [moduleUrl, rootDir, confirmation, deadOwnerPidText, encodedConfig] =
  process.argv.slice(1);
const deadOwnerPid = Number(deadOwnerPidText);
const config = encodedConfig === undefined
  ? { liveness: {} }
  : JSON.parse(Buffer.from(encodedConfig, "base64").toString("utf8"));
const originalKill = process.kill;
const originalRandomBytes = crypto.randomBytes;
const originalLink = fs.promises.link;
const originalWriteFile = fs.promises.writeFile;
const originalUnlink = fs.promises.unlink;
const originalOpen = fs.promises.open;
const originalMkdir = fs.promises.mkdir;
const originalLstat = fs.promises.lstat;
const originalReaddir = fs.promises.readdir;
const originalRename = fs.promises.rename;
const killCalls = [];
const killCounts = new Map();
const ioEvents = [];
let winnerInjected = false;
let mkdirWinnerInjected = false;
let chainReplaced = false;
let leaseCandidateCreated = false;
let prelinkProofObserved = false;
let candidateNodeLstatCount = 0;
let candidateNodeReplaced = false;
let candidateProbeComplete = false;
let publicationCandidatePath = null;
let leasePublicationCandidatePath = null;
let publicationCandidateReplaced = false;
let canonicalLinkAttempted = false;
const canonicalLinkDestinations = [];
let prelinkReplacementInjected = false;
let destinationWinnerInjected = false;
let otherLeaseCandidateInjected = false;
let createdRecoveryDirectory = null;
let createdDirectoryReplaced = false;
let fixedUnlinkProofHookTriggered = false;
let activeSuccessorPath = null;
let terminalPublicationDurable = false;
let postTerminalDurabilityLstatCount = 0;
process.kill = (pid, signal) => {
  killCalls.push([pid, signal]);
  if (signal !== 0) {
    const error = new Error("unexpected synthetic liveness probe");
    error.code = "EINVAL";
    throw error;
  }
  const sequence = config.liveness_sequence?.[String(pid)];
  const sequenceIndex = killCounts.get(pid) ?? 0;
  killCounts.set(pid, sequenceIndex + 1);
  const configured = Array.isArray(sequence)
    ? sequence[Math.min(sequenceIndex, sequence.length - 1)]
    : config.liveness[String(pid)];
  const mode = configured ?? (pid === deadOwnerPid ? "ESRCH" : "EINVAL");
  if (mode === "success") return true;
  if (pid === config.replace_candidate_owner_pid && mode === "ESRCH") {
    candidateProbeComplete = true;
  }
  const error = new Error("synthetic recovery owner " + mode);
  error.code = mode;
  throw error;
};
crypto.randomBytes = (size) => Buffer.from("a".repeat(size * 2), "hex");
fs.promises.mkdir = async (...args) => {
  const path = String(args[0]);
  if (config.recovery_mkdir_error_code !== undefined &&
      path.endsWith("/.local/state/cleaning-recovery-leases")) {
    const error = new Error("synthetic recovery mkdir topology failure");
    error.code = config.recovery_mkdir_error_code;
    throw error;
  }
  if (config.failure === "recovery-mkdir" &&
      path.endsWith("/.local/state/cleaning-recovery-leases")) {
    const error = new Error("synthetic recovery mkdir failure");
    error.code = "EIO";
    throw error;
  }
  if (!mkdirWinnerInjected &&
      config.inject_mkdir_eexist_suffix !== undefined &&
      path.endsWith(config.inject_mkdir_eexist_suffix)) {
    mkdirWinnerInjected = true;
    await originalMkdir(path, { mode: 0o700 });
    fs.chmodSync(path, config.inject_mkdir_mode ?? 0o700);
    ioEvents.push(["mkdir-eexist", path]);
  }
  const result = await originalMkdir(...args);
  ioEvents.push(["mkdir", path]);
  if (config.track_created_directory_suffix !== undefined &&
      path.endsWith(config.track_created_directory_suffix)) {
    createdRecoveryDirectory = path;
  }
  return result;
};
fs.promises.writeFile = async (...args) => {
  const path = String(args[0]);
  if (path.includes("/.lease-")) leaseCandidateCreated = true;
  return originalWriteFile(...args);
};
fs.promises.lstat = async (...args) => {
  const path = String(args[0]);
  if (!fixedUnlinkProofHookTriggered &&
      (config.replace_at_fixed_unlink_proof_path !== undefined ||
        config.inject_successor_at_fixed_unlink_proof === true) &&
      path.includes("/.local/state/cleaning-transitions/retire-") &&
      !path.includes("/cleaning-transitions/.retire-") &&
      fs.existsSync(path) && terminalPublicationDurable) {
    postTerminalDurabilityLstatCount += 1;
    if (postTerminalDurabilityLstatCount === 4) {
      fixedUnlinkProofHookTriggered = true;
      if (config.replace_at_fixed_unlink_proof_path !== undefined) {
        const replacedPath =
          rootDir + "/" + config.replace_at_fixed_unlink_proof_path;
        const bytes = fs.readFileSync(replacedPath);
        await originalUnlink(replacedPath);
        await originalWriteFile(replacedPath, bytes, {
          flag: "wx",
          mode: 0o600
        });
      }
      if (config.inject_successor_at_fixed_unlink_proof === true) {
        const leasesRoot = rootDir + "/.local/state/cleaning-recovery-leases";
        const targetName = fs.readdirSync(leasesRoot)[0];
        const targetDirectory = leasesRoot + "/" + targetName;
        const activeName = fs.readdirSync(targetDirectory).find((name) => {
          if (!name.startsWith("lease-") || !name.endsWith(".json")) {
            return false;
          }
          const value = JSON.parse(fs.readFileSync(targetDirectory + "/" + name));
          return value.owner_pid === process.pid &&
            value.owner_nonce === "a".repeat(32);
        });
        const activeBytes = fs.readFileSync(targetDirectory + "/" + activeName);
        const active = JSON.parse(activeBytes);
        const activeSha256 = crypto.createHash("sha256")
          .update(activeBytes)
          .digest("hex");
        activeSuccessorPath =
          ".local/state/cleaning-recovery-leases/" + targetName +
          "/lease-after-" + activeSha256 + ".json";
        const successor = {
          generation: active.generation + 1,
          owner_nonce: "8".repeat(32),
          owner_pid: 939999,
          previous_lease_sha256: activeSha256,
          record_kind: "recovery_lease",
          schema_version: "1.0.0",
          target_commit_lock_sha256: targetName
        };
        await originalWriteFile(
          rootDir + "/" + activeSuccessorPath,
          Buffer.from(JSON.stringify(successor) + "\\n"),
          { flag: "wx", mode: 0o600 }
        );
      }
    }
  }
  if (leaseCandidateCreated &&
      Array.isArray(config.required_prelink_paths) &&
      config.required_prelink_paths.some((repoPath) =>
        path.endsWith("/" + repoPath))) {
    config.observed_prelink_paths ??= [];
    const relative = config.required_prelink_paths.find((repoPath) =>
      path.endsWith("/" + repoPath));
    if (!config.observed_prelink_paths.includes(relative)) {
      config.observed_prelink_paths.push(relative);
    }
  }
  if (candidateProbeComplete &&
      config.replace_candidate_node_path !== undefined &&
      path.endsWith("/" + config.replace_candidate_node_path)) {
    candidateNodeLstatCount += 1;
    if (!candidateNodeReplaced && candidateNodeLstatCount === 4) {
      candidateNodeReplaced = true;
      const bytes = fs.readFileSync(path);
      await originalUnlink(path);
      await originalWriteFile(path, bytes, { flag: "wx", mode: 0o600 });
    }
  }
  return originalLstat(...args);
};
fs.promises.readdir = async (...args) => {
  const path = String(args[0]);
  if (!publicationCandidateReplaced &&
      config.replace_publication_candidate === true &&
      publicationCandidatePath !== null &&
      publicationCandidatePath.includes(path + "/.target.")) {
    publicationCandidateReplaced = true;
    const bytes = fs.readFileSync(publicationCandidatePath);
    await originalUnlink(publicationCandidatePath);
    await originalWriteFile(publicationCandidatePath, bytes, {
      flag: "wx",
      mode: 0o600
    });
  }
  if (!otherLeaseCandidateInjected &&
      config.inject_other_lease_candidate !== undefined &&
      leasePublicationCandidatePath !== null &&
      leasePublicationCandidatePath.startsWith(path + "/.lease-")) {
    otherLeaseCandidateInjected = true;
    const value = JSON.parse(fs.readFileSync(leasePublicationCandidatePath));
    value.owner_pid = config.inject_other_lease_candidate.owner_pid;
    value.owner_nonce = config.inject_other_lease_candidate.owner_nonce;
    await originalWriteFile(
      rootDir + "/" + config.inject_other_lease_candidate.path,
      Buffer.from(JSON.stringify(value) + "\\n"),
      { flag: "wx", mode: 0o600 }
    );
  }
  return originalReaddir(...args);
};
fs.promises.link = async (...args) => {
  const source = String(args[0]);
  const destination = String(args[1]);
  ioEvents.push(["link", source, destination]);
  if (destination.endsWith("/target.json") ||
      destination.endsWith("/lease-root.json") ||
      destination.includes("/lease-after-")) {
    canonicalLinkAttempted = true;
    canonicalLinkDestinations.push(destination);
  }
  if (!prelinkReplacementInjected &&
      config.replace_before_link_path !== undefined &&
      config.replace_on_link_destination !== undefined &&
      destination.endsWith("/" + config.replace_on_link_destination)) {
    prelinkReplacementInjected = true;
    const replacedPath = rootDir + "/" + config.replace_before_link_path;
    const bytes = fs.readFileSync(replacedPath);
    await originalUnlink(replacedPath);
    await originalWriteFile(replacedPath, bytes, {
      flag: "wx",
      mode: 0o600
    });
  }
  if (!destinationWinnerInjected &&
      config.inject_destination_before_link !== undefined &&
      destination.endsWith("/" + config.inject_destination_before_link)) {
    destinationWinnerInjected = true;
    await originalWriteFile(destination, fs.readFileSync(source), {
      flag: "wx",
      mode: 0o600
    });
  }
  if (!destinationWinnerInjected &&
      config.inject_destination_winner !== undefined &&
      destination.endsWith("/" + config.inject_destination_winner.path)) {
    destinationWinnerInjected = true;
    const winner = JSON.parse(fs.readFileSync(source));
    winner.owner_pid = config.inject_destination_winner.owner_pid;
    winner.owner_nonce = config.inject_destination_winner.owner_nonce;
    await originalWriteFile(
      destination,
      Buffer.from(JSON.stringify(winner) + "\\n"),
      { flag: "wx", mode: 0o600 }
    );
  }
  if (leaseCandidateCreated &&
      Array.isArray(config.required_prelink_paths) &&
      (destination.endsWith("/lease-root.json") ||
        destination.includes("/lease-after-"))) {
    prelinkProofObserved = config.required_prelink_paths.every((repoPath) =>
      config.observed_prelink_paths?.includes(repoPath));
  }
  if (!winnerInjected && config.inject_root_winner !== undefined &&
      destination.endsWith("/lease-root.json")) {
    winnerInjected = true;
    const winner = config.inject_root_winner;
    const targetC = basename(destination.slice(0, -"/lease-root.json".length));
    const bytes = winner.malformed === true
      ? Buffer.from("{}\\n")
      : Buffer.from(JSON.stringify({
        generation: 0,
        owner_nonce: winner.owner_nonce,
        owner_pid: winner.owner_pid,
        previous_lease_sha256: null,
        record_kind: "recovery_lease",
        schema_version: "1.0.0",
        target_commit_lock_sha256: targetC
      }) + "\\n");
    await originalWriteFile(destination, bytes, { flag: "wx", mode: 0o600 });
  }
  if (config.failure === "terminal-link" &&
      destination.includes("/cleaning-transitions/retire-")) {
    const error = new Error("synthetic terminal link failure");
    error.code = "EIO";
    throw error;
  }
  if (config.failure === "lease-link" &&
      (destination.endsWith("/lease-root.json") ||
        destination.includes("/lease-after-"))) {
    const error = new Error("synthetic lease link failure");
    error.code = "EIO";
    throw error;
  }
  return originalLink(...args);
};
fs.promises.unlink = async (...args) => {
  const path = String(args[0]);
  ioEvents.push(["unlink", path]);
  if (config.failure === "fixed-unlink" &&
      path.endsWith("/.local/state/cleaning-commit.lock")) {
    const error = new Error("synthetic fixed unlink failure");
    error.code = "EIO";
    throw error;
  }
  if (config.failure === "lease-candidate-unlink" &&
      path.includes("/.lease-") && path.endsWith(".tmp")) {
    const error = new Error("synthetic lease candidate unlink failure");
    error.code = "EIO";
    throw error;
  }
  return originalUnlink(...args);
};
fs.promises.open = async (...args) => {
  const path = String(args[0]);
  const flags = args[1];
  if ((typeof flags === "number" && (flags & fs.constants.O_CREAT) !== 0) ||
      (typeof flags === "string" && /[wax+]/.test(flags))) {
    ioEvents.push(["open", path, flags, args[2] ?? null]);
  }
  if (path.includes("/.lease-")) {
    leaseCandidateCreated = true;
    leasePublicationCandidatePath = path;
  }
  if (path.includes("/.target.") && path.endsWith(".tmp")) {
    publicationCandidatePath = path;
  }
  if (!chainReplaced && config.replace_chain_path !== undefined &&
      path.includes("/cleaning-transitions/.retire-")) {
    chainReplaced = true;
    const replacedPath = rootDir + "/" + config.replace_chain_path;
    const bytes = fs.readFileSync(replacedPath);
    await originalUnlink(replacedPath);
    await originalWriteFile(replacedPath, bytes, {
      flag: "wx",
      mode: 0o600
    });
  }
  const handle = await originalOpen(...args);
  return new Proxy(handle, {
    get(target, property) {
      if (property === "sync") {
        return async (...methodArgs) => {
          ioEvents.push(["fsync", path]);
          if (config.failure === "recovery-eexist-parent-fsync" &&
              mkdirWinnerInjected && path.endsWith("/.local/state")) {
            const error = new Error("synthetic recovery parent fsync failure");
            error.code = "EIO";
            throw error;
          }
          if (!createdDirectoryReplaced &&
              createdRecoveryDirectory !== null &&
              config.replace_created_directory_on_parent_fsync !== undefined &&
              path.endsWith(
                config.replace_created_directory_on_parent_fsync.parent_suffix
              )) {
            try {
              createdDirectoryReplaced = true;
              await originalRename(
                createdRecoveryDirectory,
                config.replace_created_directory_on_parent_fsync.moved_path
              );
              await originalMkdir(createdRecoveryDirectory, { mode: 0o700 });
            } catch (error) {
              ioEvents.push(["hook-error", error?.code ?? String(error)]);
              throw error;
            }
          }
          if (config.failure === "post-unlink-state-fsync" &&
              path.endsWith("/.local/state") &&
              !fs.existsSync(path + "/cleaning-commit.lock")) {
            const error = new Error("synthetic post-unlink state fsync failure");
            error.code = "EIO";
            throw error;
          }
          if (config.failure === "lease-candidate-fsync" &&
              path.includes("/.lease-") && path.endsWith(".tmp")) {
            const error = new Error("synthetic lease candidate fsync failure");
            error.code = "EIO";
            throw error;
          }
          if (config.failure === "terminal-directory-fsync" &&
              path.endsWith("/.local/state/cleaning-transitions") &&
              fs.readdirSync(path).some((name) => name.startsWith("retire-"))) {
            const error = new Error("synthetic terminal directory fsync failure");
            error.code = "EIO";
            throw error;
          }
          const result = await target.sync(...methodArgs);
          if (path.endsWith("/.local/state/cleaning-transitions") &&
              fs.readdirSync(path).some((name) => name.startsWith("retire-")) &&
              !fs.readdirSync(path).some((name) =>
                name.startsWith(".retire-") && name.endsWith(".tmp"))) {
            terminalPublicationDurable = true;
          }
          return result;
        };
      }
      if (property === "write") {
        return async (...methodArgs) => {
          ioEvents.push(["write", path]);
          return target.write(...methodArgs);
        };
      }
      const value = Reflect.get(target, property, target);
      return typeof value === "function" ? value.bind(target) : value;
    }
  });
};
syncBuiltinESMExports();
let result;
try {
  const { recoverInterruptedCleaningCommit } = await import(moduleUrl);
  result = await recoverInterruptedCleaningCommit({ rootDir, confirmation });
} finally {
  process.kill = originalKill;
  crypto.randomBytes = originalRandomBytes;
  fs.promises.link = originalLink;
  fs.promises.writeFile = originalWriteFile;
  fs.promises.unlink = originalUnlink;
  fs.promises.open = originalOpen;
  fs.promises.mkdir = originalMkdir;
  fs.promises.lstat = originalLstat;
  fs.promises.readdir = originalReaddir;
  syncBuiltinESMExports();
}
process.stdout.write(JSON.stringify({
  result,
  child_pid: process.pid,
  kill_calls: killCalls,
  winner_injected: winnerInjected,
  mkdir_winner_injected: mkdirWinnerInjected,
  chain_replaced: chainReplaced,
  prelink_proof_observed: prelinkProofObserved,
  candidate_node_replaced: candidateNodeReplaced,
  publication_candidate_replaced: publicationCandidateReplaced,
  canonical_link_attempted: canonicalLinkAttempted,
  canonical_link_destinations: canonicalLinkDestinations,
  prelink_replacement_injected: prelinkReplacementInjected,
  destination_winner_injected: destinationWinnerInjected,
  other_lease_candidate_injected: otherLeaseCandidateInjected,
  created_directory_replaced: createdDirectoryReplaced,
  fixed_unlink_proof_hook_triggered: fixedUnlinkProofHookTriggered,
  active_successor_path: activeSuccessorPath,
  post_terminal_durability_lstat_count: postTerminalDurabilityLstatCount,
  io_events: ioEvents
}));
`;

async function runB7CStaleRecoveryChild(
  rootDir,
  deadOwnerPid,
  liveness = {},
  extraConfig = {}
) {
  const encodedConfig = Buffer.from(JSON.stringify({
    liveness,
    ...extraConfig
  }))
    .toString("base64");
  const child = await runBoundedChild(process.execPath, [
    "--input-type=module",
    "--eval",
    B7_C_STALE_RECOVERY_CHILD_SCRIPT,
    B5_MODULE_URL,
    rootDir,
    B7_CONFIRMATION,
    String(deadOwnerPid),
    encodedConfig
  ]);
  assert.equal(child.timedOut, false, child.stderr);
  assert.equal(child.code, 0, child.stderr);
  return JSON.parse(child.stdout);
}

async function makeB7CStaleFixture(t, label, deadOwnerPid) {
  const fixture = await makeB7StagedRoot(t, label);
  const fixedBytes = await writeB7FixedLock(
    fixture.rootDir,
    makeB6CommitLockIntent(fixture.plan, deadOwnerPid, "9".repeat(32))
  );
  const stalePlan = makeB6IncrementalPlan(fixture.plan);
  const stalePointer = structuredClone(stalePlan.manifest.desired_pointer);
  const stalePointerBytes = canonicalJsonDocumentBytes(stalePointer);
  const pointerPath = join(fixture.rootDir, B6_CURRENT_POINTER);
  await writeFile(pointerPath, stalePointerBytes, { mode: 0o600 });
  await chmod(pointerPath, 0o600);
  return {
    ...fixture,
    fixedBytes,
    currentC: sha256(fixedBytes),
    stalePointer,
    stalePointerBytes,
    pointerPath
  };
}

async function materializeB7CTwoLeaseChain(
  fixture,
  rootOwnerPid,
  tipOwnerPid
) {
  const target = await materializeB7RecoveryPrefix(
    fixture.rootDir,
    fixture.currentC,
    fixture.fixedBytes,
    "target-only"
  );
  const rootLease = makeB7RecoveryLeaseFixture({
    targetCommitLockSha256: fixture.currentC,
    previousLeaseSha256: null,
    generation: 0,
    ownerPid: rootOwnerPid,
    ownerNonce: "b".repeat(32)
  });
  const rootPath = `${target.targetDir}/lease-root.json`;
  await writeB7PrivatePath(fixture.rootDir, rootPath, rootLease.bytes);
  const tipLease = makeB7RecoveryLeaseFixture({
    targetCommitLockSha256: fixture.currentC,
    previousLeaseSha256: rootLease.sha256,
    generation: 1,
    ownerPid: tipOwnerPid,
    ownerNonce: "c".repeat(32)
  });
  const tipPath =
    `${target.targetDir}/lease-after-${rootLease.sha256}.json`;
  await writeB7PrivatePath(fixture.rootDir, tipPath, tipLease.bytes);
  return { ...target, rootLease, rootPath, tipLease, tipPath };
}

async function materializeB7CThreeLeaseChain(
  fixture,
  rootOwnerPid,
  intermediateOwnerPid,
  tipOwnerPid
) {
  const chain = await materializeB7CTwoLeaseChain(
    fixture,
    rootOwnerPid,
    intermediateOwnerPid
  );
  const tipLease = makeB7RecoveryLeaseFixture({
    targetCommitLockSha256: fixture.currentC,
    previousLeaseSha256: chain.tipLease.sha256,
    generation: 2,
    ownerPid: tipOwnerPid,
    ownerNonce: "d".repeat(32)
  });
  const tipPath =
    `${chain.targetDir}/lease-after-${chain.tipLease.sha256}.json`;
  await writeB7PrivatePath(fixture.rootDir, tipPath, tipLease.bytes);
  return {
    ...chain,
    intermediateLease: chain.tipLease,
    intermediatePath: chain.tipPath,
    tipLease,
    tipPath
  };
}

test("B7 C absent-root stale recovery publishes target root retirement and cleans fixed lock", async (t) => {
  const fixture = await makeB7StagedRoot(t, "b7-c-stale-absent-root");
  const deadOwnerPid = 930001;
  const fixedBytes = await writeB7FixedLock(
    fixture.rootDir,
    makeB6CommitLockIntent(
      fixture.plan,
      deadOwnerPid,
      "9".repeat(32)
    )
  );
  const currentC = sha256(fixedBytes);
  const stalePlan = makeB6IncrementalPlan(fixture.plan);
  const stalePointer = structuredClone(stalePlan.manifest.desired_pointer);
  const stalePointerBytes = canonicalJsonDocumentBytes(stalePointer);
  const pointerPath = join(fixture.rootDir, B6_CURRENT_POINTER);
  await writeFile(pointerPath, stalePointerBytes, { mode: 0o600 });
  await chmod(pointerPath, 0o600);
  const pointerBefore = await lstat(pointerPath);

  const child = await runBoundedChild(process.execPath, [
    "--input-type=module",
    "--eval",
    B7_C_STALE_RECOVERY_CHILD_SCRIPT,
    B5_MODULE_URL,
    fixture.rootDir,
    B7_CONFIRMATION,
    String(deadOwnerPid)
  ]);
  assert.equal(child.timedOut, false, child.stderr);
  assert.equal(child.code, 0, child.stderr);
  const observed = JSON.parse(child.stdout);
  const targetDir = `${B7_RECOVERY_LEASES_ROOT}/${currentC}`;
  const targetPath = `${targetDir}/target.json`;
  const activeLeasePath = `${targetDir}/lease-root.json`;
  const observedPointerSha256 = sha256(stalePointerBytes);
  const retirement = makeB7RetirementTerminalFixture(
    fixture.plan,
    currentC,
    observedPointerSha256
  );
  const expectedRootLease = makeB7RecoveryLeaseFixture({
    targetCommitLockSha256: currentC,
    previousLeaseSha256: null,
    generation: 0,
    ownerPid: observed.child_pid,
    ownerNonce: "a".repeat(32)
  });

  assert.deepEqual(observed.result, {
    ok: true,
    value: {
      kind: "stale_lock_retired",
      selected_target_commit_lock_sha256: currentC,
      current_fixed_commit_lock_sha256: currentC,
      active_lease_path: activeLeasePath,
      final_pointer: stalePointer,
      transition_record_path: retirement.path,
      commit_lock_cleanup: "unlinked_and_fsynced",
      persistent_writes_occurred: true
    }
  });
  assert.deepEqual(observed.kill_calls, [
    [deadOwnerPid, 0],
    [deadOwnerPid, 0],
    [deadOwnerPid, 0]
  ]);
  assert.deepEqual(
    await readFile(join(fixture.rootDir, targetPath)),
    makeB7RecoveryTargetFixture(fixedBytes).bytes
  );
  assert.deepEqual(
    await readFile(join(fixture.rootDir, activeLeasePath)),
    expectedRootLease.bytes
  );
  assert.deepEqual(
    await readFile(join(fixture.rootDir, retirement.path)),
    retirement.bytes
  );
  assert.deepEqual(await readFile(pointerPath), stalePointerBytes);
  const pointerAfter = await lstat(pointerPath);
  assert.deepEqual(
    [pointerAfter.dev, pointerAfter.ino],
    [pointerBefore.dev, pointerBefore.ino]
  );
  await assert.rejects(
    () => lstat(join(fixture.rootDir, B7_FIXED_COMMIT_LOCK)),
    { code: "ENOENT" }
  );
});

test("B7 C target-only reuse preserves target inode and publishes generation zero", async (t) => {
  const deadOwnerPid = 930011;
  const fixture = await makeB7CStaleFixture(
    t,
    "b7-c-target-only",
    deadOwnerPid
  );
  const materialized = await materializeB7RecoveryPrefix(
    fixture.rootDir,
    fixture.currentC,
    fixture.fixedBytes,
    "target-only"
  );
  const targetPath = `${materialized.targetDir}/target.json`;
  const targetBefore = await lstat(join(fixture.rootDir, targetPath));

  const observed = await runB7CStaleRecoveryChild(
    fixture.rootDir,
    deadOwnerPid
  );
  const activeLeasePath = `${materialized.targetDir}/lease-root.json`;
  const expectedLease = makeB7RecoveryLeaseFixture({
    targetCommitLockSha256: fixture.currentC,
    previousLeaseSha256: null,
    generation: 0,
    ownerPid: observed.child_pid,
    ownerNonce: "a".repeat(32)
  });

  assert.equal(observed.result.ok, true);
  assert.equal(observed.result.value.kind, "stale_lock_retired");
  assert.equal(observed.result.value.active_lease_path, activeLeasePath);
  assert.deepEqual(
    await readFile(join(fixture.rootDir, activeLeasePath)),
    expectedLease.bytes
  );
  const targetAfter = await lstat(join(fixture.rootDir, targetPath));
  assert.deepEqual(
    [targetAfter.dev, targetAfter.ino],
    [targetBefore.dev, targetBefore.ino]
  );
  assert.deepEqual(await readFile(fixture.pointerPath), fixture.stalePointerBytes);
});

test("B7 C dead tip appends one successor while live and EPERM tips are zero-write locked", async (t) => {
  for (const mode of ["ESRCH", "success", "EPERM"]) {
    await t.test(mode, async (t) => {
      const deadOwnerPid = 930020;
      const tipOwnerPid = 930021;
      const fixture = await makeB7CStaleFixture(
        t,
        `b7-c-tip-${mode}`,
        deadOwnerPid
      );
      const target = await materializeB7RecoveryPrefix(
        fixture.rootDir,
        fixture.currentC,
        fixture.fixedBytes,
        "target-only"
      );
      const rootLease = makeB7RecoveryLeaseFixture({
        targetCommitLockSha256: fixture.currentC,
        previousLeaseSha256: null,
        generation: 0,
        ownerPid: tipOwnerPid,
        ownerNonce: "b".repeat(32)
      });
      const rootPath = `${target.targetDir}/lease-root.json`;
      await writeB7PrivatePath(fixture.rootDir, rootPath, rootLease.bytes);
      const before = await snapshotB5Tree(fixture.rootDir);

      const observed = await runB7CStaleRecoveryChild(
        fixture.rootDir,
        deadOwnerPid,
        { [tipOwnerPid]: mode }
      );

      if (mode === "ESRCH") {
        const childPath =
          `${target.targetDir}/lease-after-${rootLease.sha256}.json`;
        const expectedChild = makeB7RecoveryLeaseFixture({
          targetCommitLockSha256: fixture.currentC,
          previousLeaseSha256: rootLease.sha256,
          generation: 1,
          ownerPid: observed.child_pid,
          ownerNonce: "a".repeat(32)
        });
        assert.equal(observed.result.ok, true);
        assert.equal(observed.result.value.kind, "stale_lock_retired");
        assert.equal(observed.result.value.active_lease_path, childPath);
        assert.deepEqual(
          await readFile(join(fixture.rootDir, childPath)),
          expectedChild.bytes
        );
        assert.deepEqual(
          await readFile(join(fixture.rootDir, rootPath)),
          rootLease.bytes
        );
      } else {
        assert.deepEqual(
          observed.result,
          b5ExpectedFailure("CLEANING_RECOVERY_LOCKED", rootPath)
        );
        assert.deepEqual(await snapshotB5Tree(fixture.rootDir), before);
      }
      assert.deepEqual(await readFile(fixture.pointerPath), fixture.stalePointerBytes);
    });
  }
});

test("B7 C candidate liveness and dead cleanup cover target and root node outcomes", async (t) => {
  for (const candidateKind of ["target", "lease-root"]) {
    for (const mode of ["success", "EPERM", "EINVAL"]) {
      await t.test(`${candidateKind} ${mode}`, async (t) => {
        const deadOwnerPid = 930030;
        const candidateOwnerPid = 930031;
        const fixture = await makeB7CStaleFixture(
          t,
          `b7-c-${candidateKind}-${mode}`,
          deadOwnerPid
        );
        const target = await materializeB7RecoveryPrefix(
          fixture.rootDir,
          fixture.currentC,
          fixture.fixedBytes,
          candidateKind === "target" ? "empty" : "target-only"
        );
        const expectedBytes = candidateKind === "target"
          ? makeB7RecoveryTargetFixture(fixture.fixedBytes).bytes
          : makeB7RecoveryLeaseFixture({
            targetCommitLockSha256: fixture.currentC,
            previousLeaseSha256: null,
            generation: 0,
            ownerPid: candidateOwnerPid,
            ownerNonce: "c".repeat(32)
          }).bytes;
        const candidatePath = candidateKind === "target"
          ? `${target.targetDir}/.target.${candidateOwnerPid}.${"c".repeat(32)}.tmp`
          : `${target.targetDir}/.lease-root.${candidateOwnerPid}.${"c".repeat(32)}.tmp`;
        await writeB7PrivatePath(
          fixture.rootDir,
          candidatePath,
          expectedBytes
        );
        const before = await snapshotB5Tree(fixture.rootDir);

        const observed = await runB7CStaleRecoveryChild(
          fixture.rootDir,
          deadOwnerPid,
          { [candidateOwnerPid]: mode }
        );

        assert.deepEqual(
          observed.result,
          mode === "EINVAL"
            ? b5ExpectedFailure("LOCAL_STATE_INVALID", candidatePath)
            : b5ExpectedFailure("CLEANING_RECOVERY_LOCKED", candidatePath)
        );
        assert.deepEqual(await snapshotB5Tree(fixture.rootDir), before);
      });
    }

    for (const nodeState of ["absent", "same-inode", "different-inode"]) {
      await t.test(`${candidateKind} dead ${nodeState}`, async (t) => {
        const deadOwnerPid = 930040;
        const candidateOwnerPid = 930041;
        const fixture = await makeB7CStaleFixture(
          t,
          `b7-c-${candidateKind}-dead-${nodeState}`,
          deadOwnerPid
        );
        const target = await materializeB7RecoveryPrefix(
          fixture.rootDir,
          fixture.currentC,
          fixture.fixedBytes,
          candidateKind === "target" ? "empty" : "target-only"
        );
        const nodePath = candidateKind === "target"
          ? `${target.targetDir}/target.json`
          : `${target.targetDir}/lease-root.json`;
        const nodeFixture = candidateKind === "target"
          ? makeB7RecoveryTargetFixture(fixture.fixedBytes)
          : makeB7RecoveryLeaseFixture({
            targetCommitLockSha256: fixture.currentC,
            previousLeaseSha256: null,
            generation: 0,
            ownerPid: candidateOwnerPid,
            ownerNonce: "d".repeat(32)
          });
        const candidatePath = candidateKind === "target"
          ? `${target.targetDir}/.target.${candidateOwnerPid}.${"d".repeat(32)}.tmp`
          : `${target.targetDir}/.lease-root.${candidateOwnerPid}.${"d".repeat(32)}.tmp`;
        if (nodeState === "same-inode") {
          await writeB7PrivatePath(
            fixture.rootDir,
            nodePath,
            nodeFixture.bytes
          );
          await link(
            join(fixture.rootDir, nodePath),
            join(fixture.rootDir, candidatePath)
          );
        } else {
          if (nodeState === "different-inode") {
            await writeB7PrivatePath(
              fixture.rootDir,
              nodePath,
              nodeFixture.bytes
            );
          }
          await writeB7PrivatePath(
            fixture.rootDir,
            candidatePath,
            nodeFixture.bytes
          );
        }
        const nodeBefore = nodeState === "absent"
          ? null
          : await lstat(join(fixture.rootDir, nodePath));

        const observed = await runB7CStaleRecoveryChild(
          fixture.rootDir,
          deadOwnerPid,
          { [candidateOwnerPid]: "ESRCH" }
        );

        assert.equal(observed.result.ok, true);
        assert.equal(observed.result.value.kind, "stale_lock_retired");
        await assert.rejects(
          () => lstat(join(fixture.rootDir, candidatePath)),
          { code: "ENOENT" }
        );
        const retainedNodeBytes = candidateKind === "lease-root" &&
            nodeState === "absent"
          ? makeB7RecoveryLeaseFixture({
            targetCommitLockSha256: fixture.currentC,
            previousLeaseSha256: null,
            generation: 0,
            ownerPid: observed.child_pid,
            ownerNonce: "a".repeat(32)
          }).bytes
          : nodeFixture.bytes;
        assert.deepEqual(
          await readFile(join(fixture.rootDir, nodePath)),
          retainedNodeBytes
        );
        if (nodeBefore !== null) {
          const nodeAfter = await lstat(join(fixture.rootDir, nodePath));
          assert.deepEqual(
            [nodeAfter.dev, nodeAfter.ino],
            [nodeBefore.dev, nodeBefore.ino]
          );
        }
        assert.deepEqual(
          await readFile(fixture.pointerPath),
          fixture.stalePointerBytes
        );
      });
    }
  }
});

test("B7 C no-clobber root loser validates exact winner and rejects malformed winner", async (t) => {
  for (const malformed of [false, true]) {
    await t.test(malformed ? "malformed" : "exact-live", async (t) => {
      const deadOwnerPid = 930050;
      const winnerOwnerPid = 930051;
      const fixture = await makeB7CStaleFixture(
        t,
        `b7-c-root-winner-${malformed ? "malformed" : "exact"}`,
        deadOwnerPid
      );
      const winnerNonce = "e".repeat(32);
      const observed = await runB7CStaleRecoveryChild(
        fixture.rootDir,
        deadOwnerPid,
        { [winnerOwnerPid]: "success" },
        {
          inject_root_winner: {
            malformed,
            owner_pid: winnerOwnerPid,
            owner_nonce: winnerNonce
          }
        }
      );
      const targetDir = `${B7_RECOVERY_LEASES_ROOT}/${fixture.currentC}`;
      const rootPath = `${targetDir}/lease-root.json`;

      assert.equal(observed.winner_injected, true);
      assert.deepEqual(
        observed.result,
        b5ExpectedFailure(
          malformed ? "LOCAL_STATE_INVALID" : "CLEANING_RECOVERY_LOCKED",
          rootPath,
          true
        )
      );
      const names = (await readdir(join(fixture.rootDir, targetDir))).sort();
      assert.equal(names.filter((name) => name === "lease-root.json").length, 1);
      assert.equal(
        names.some((name) =>
          name === `.lease-root.${observed.child_pid}.${"a".repeat(32)}.tmp`),
        malformed
      );
      if (!malformed) {
        assert.deepEqual(
          await readFile(join(fixture.rootDir, rootPath)),
          makeB7RecoveryLeaseFixture({
            targetCommitLockSha256: fixture.currentC,
            previousLeaseSha256: null,
            generation: 0,
            ownerPid: winnerOwnerPid,
            ownerNonce: winnerNonce
          }).bytes
        );
      }
      assert.deepEqual(await readFile(fixture.pointerPath), fixture.stalePointerBytes);
      assert.deepEqual(
        await readFile(join(fixture.rootDir, B7_FIXED_COMMIT_LOCK)),
        fixture.fixedBytes
      );
    });
  }
});

test("B7 C resolved historical C1 stays immutable while dead fixed C2 retires", async (t) => {
  const deadOwnerPid = 930060;
  const fixture = await makeB7CStaleFixture(
    t,
    "b7-c-historical-isolation",
    deadOwnerPid
  );
  const historical = await makeB7HistoricalTerminalTarget(
    fixture.rootDir,
    fixture.plan,
    "f".repeat(32)
  );
  assert.notEqual(historical.commitLockSha256, fixture.currentC);
  const historicalTerminal = makeB7CompletionTerminalFixture(
    fixture.plan,
    historical.commitLockSha256
  );
  await writeB7TerminalFixture(fixture.rootDir, historicalTerminal);
  const historicalAbsolute = join(fixture.rootDir, historical.targetDir);
  const historicalBefore = await snapshotB5Tree(historicalAbsolute);
  const historicalTargetBefore = await lstat(
    join(historicalAbsolute, "target.json")
  );
  const historicalRootBefore = await lstat(
    join(historicalAbsolute, "lease-root.json")
  );

  const observed = await runB7CStaleRecoveryChild(
    fixture.rootDir,
    deadOwnerPid
  );

  assert.equal(observed.result.ok, true);
  assert.equal(observed.result.value.kind, "stale_lock_retired");
  assert.equal(
    observed.result.value.selected_target_commit_lock_sha256,
    fixture.currentC
  );
  assert.match(
    observed.result.value.active_lease_path,
    new RegExp(`/${fixture.currentC}/`)
  );
  assert.match(
    observed.result.value.transition_record_path,
    new RegExp(`retire-${fixture.currentC}-`)
  );
  assert.deepEqual(
    await snapshotB5Tree(historicalAbsolute),
    historicalBefore
  );
  const historicalTargetAfter = await lstat(
    join(historicalAbsolute, "target.json")
  );
  const historicalRootAfter = await lstat(
    join(historicalAbsolute, "lease-root.json")
  );
  assert.deepEqual(
    [historicalTargetAfter.dev, historicalTargetAfter.ino],
    [historicalTargetBefore.dev, historicalTargetBefore.ino]
  );
  assert.deepEqual(
    [historicalRootAfter.dev, historicalRootAfter.ino],
    [historicalRootBefore.dev, historicalRootBefore.ino]
  );
  assert.deepEqual(
    await readFile(join(fixture.rootDir, historicalTerminal.path)),
    historicalTerminal.bytes
  );
});

test("B7 C recovery mkdir EEXIST reopens exact winner without following unsafe state", async (t) => {
  for (const scenario of ["root-safe", "target-safe", "target-unsafe-mode"]) {
    await t.test(scenario, async (t) => {
      const deadOwnerPid = 930070;
      const fixture = await makeB7CStaleFixture(
        t,
        `b7-c-mkdir-${scenario}`,
        deadOwnerPid
      );
      const rootSuffix = `/${B7_RECOVERY_LEASES_ROOT}`;
      const targetSuffix = `${rootSuffix}/${fixture.currentC}`;
      const unsafe = scenario === "target-unsafe-mode";
      const observed = await runB7CStaleRecoveryChild(
        fixture.rootDir,
        deadOwnerPid,
        {},
        {
          inject_mkdir_eexist_suffix:
            scenario === "root-safe" ? rootSuffix : targetSuffix,
          inject_mkdir_mode: unsafe ? 0o755 : 0o700
        }
      );

      assert.equal(observed.mkdir_winner_injected, true);
      if (unsafe) {
        assert.deepEqual(
          observed.result,
          b5ExpectedFailure(
            "LOCAL_STATE_INVALID",
            `${B7_RECOVERY_LEASES_ROOT}/${fixture.currentC}`,
            true
          )
        );
      } else {
        assert.equal(observed.result.ok, true);
        assert.equal(observed.result.value.kind, "stale_lock_retired");
      }
      assert.deepEqual(await readFile(fixture.pointerPath), fixture.stalePointerBytes);
    });
  }
});

test("B7 C target prelink binds the exact source candidate before canonical publication", async (t) => {
  const deadOwnerPid = 930075;
  const fixture = await makeB7CStaleFixture(
    t,
    "b7-c-target-source-proof",
    deadOwnerPid
  );
  const observed = await runB7CStaleRecoveryChild(
    fixture.rootDir,
    deadOwnerPid,
    {},
    { replace_publication_candidate: true }
  );
  const targetDir = `${B7_RECOVERY_LEASES_ROOT}/${fixture.currentC}`;
  const targetPath = `${targetDir}/target.json`;
  const candidatePath =
    `${targetDir}/.target.${observed.child_pid}.${"a".repeat(32)}.tmp`;

  assert.equal(observed.publication_candidate_replaced, true);
  assert.equal(observed.canonical_link_attempted, false);
  assert.deepEqual(
    observed.result,
    b5ExpectedFailure("LOCAL_STATE_INVALID", candidatePath, true)
  );
  await assert.rejects(
    () => lstat(join(fixture.rootDir, targetPath)),
    { code: "ENOENT" }
  );
  assert.deepEqual(
    await readFile(join(fixture.rootDir, candidatePath)),
    makeB7RecoveryTargetFixture(fixture.fixedBytes).bytes
  );
});

test("B7 C root and successor hard-links reprove exact target full chain and destination absent", async (t) => {
  await t.test("root", async (t) => {
    const deadOwnerPid = 930080;
    const fixture = await makeB7CStaleFixture(t, "b7-c-root-proof", deadOwnerPid);
    const target = await materializeB7RecoveryPrefix(
      fixture.rootDir,
      fixture.currentC,
      fixture.fixedBytes,
      "target-only"
    );
    const required = [
      `${target.targetDir}/target.json`,
      `${target.targetDir}/lease-root.json`
    ];
    const observed = await runB7CStaleRecoveryChild(
      fixture.rootDir,
      deadOwnerPid,
      {},
      { required_prelink_paths: required }
    );
    assert.equal(observed.result.ok, true);
    assert.equal(observed.prelink_proof_observed, true);
  });

  await t.test("successor", async (t) => {
    const deadOwnerPid = 930081;
    const rootOwnerPid = 930082;
    const tipOwnerPid = 930083;
    const fixture = await makeB7CStaleFixture(
      t,
      "b7-c-successor-proof",
      deadOwnerPid
    );
    const chain = await materializeB7CTwoLeaseChain(
      fixture,
      rootOwnerPid,
      tipOwnerPid
    );
    const successorPath =
      `${chain.targetDir}/lease-after-${chain.tipLease.sha256}.json`;
    const required = [
      `${chain.targetDir}/target.json`,
      chain.rootPath,
      chain.tipPath,
      successorPath
    ];
    const observed = await runB7CStaleRecoveryChild(
      fixture.rootDir,
      deadOwnerPid,
      { [tipOwnerPid]: "ESRCH" },
      { required_prelink_paths: required }
    );
    assert.equal(observed.result.ok, true);
    assert.equal(observed.prelink_proof_observed, true);
    assert.equal(
      observed.kill_calls.filter(([pid]) => pid === tipOwnerPid).length >= 2,
      true
    );
  });
});

test("B7 C active authority rejects same-byte intermediate lease replacement", async (t) => {
  const deadOwnerPid = 930090;
  const rootOwnerPid = 930091;
  const tipOwnerPid = 930092;
  const fixture = await makeB7CStaleFixture(
    t,
    "b7-c-chain-replacement",
    deadOwnerPid
  );
  const chain = await materializeB7CTwoLeaseChain(
    fixture,
    rootOwnerPid,
    tipOwnerPid
  );
  const observed = await runB7CStaleRecoveryChild(
    fixture.rootDir,
    deadOwnerPid,
    { [tipOwnerPid]: "ESRCH" },
    { replace_chain_path: chain.rootPath }
  );

  assert.equal(observed.chain_replaced, true);
  assert.deepEqual(
    observed.result,
    b5ExpectedFailure(
      "LOCAL_STATE_INVALID",
      chain.rootPath,
      true
    )
  );
  assert.deepEqual(
    await readFile(join(fixture.rootDir, B7_FIXED_COMMIT_LOCK)),
    fixture.fixedBytes
  );
  assert.deepEqual(await readFile(fixture.pointerPath), fixture.stalePointerBytes);
});

test("B7 C fix1 postlink proof rejects target and every lease-chain inode replacement", async (t) => {
  for (const replacement of ["target", "root", "intermediate", "tip"]) {
    await t.test(replacement, async (t) => {
      const deadOwnerPid = 932001;
      const fixture = await makeB7CStaleFixture(
        t,
        `b7-c-fix1-postlink-${replacement}`,
        deadOwnerPid
      );
      let destinationPath;
      let replacementPath;
      let liveness = {};
      if (replacement === "target") {
        const target = await materializeB7RecoveryPrefix(
          fixture.rootDir,
          fixture.currentC,
          fixture.fixedBytes,
          "target-only"
        );
        destinationPath = `${target.targetDir}/lease-root.json`;
        replacementPath = `${target.targetDir}/target.json`;
      } else {
        const tipOwnerPid = 932004;
        const chain = await materializeB7CThreeLeaseChain(
          fixture,
          932002,
          932003,
          tipOwnerPid
        );
        destinationPath =
          `${chain.targetDir}/lease-after-${chain.tipLease.sha256}.json`;
        replacementPath = replacement === "root"
          ? chain.rootPath
          : replacement === "intermediate"
            ? chain.intermediatePath
            : chain.tipPath;
        liveness = { [tipOwnerPid]: "ESRCH" };
      }
      const observed = await runB7CStaleRecoveryChild(
        fixture.rootDir,
        deadOwnerPid,
        liveness,
        {
          replace_before_link_path: replacementPath,
          replace_on_link_destination: destinationPath
        }
      );

      assert.equal(observed.prelink_replacement_injected, true);
      assert.deepEqual(
        observed.result,
        b5ExpectedFailure("LOCAL_STATE_INVALID", replacementPath, true)
      );
      assert.deepEqual(
        await readFile(join(fixture.rootDir, B7_FIXED_COMMIT_LOCK)),
        fixture.fixedBytes
      );
      assert.deepEqual(await readFile(fixture.pointerPath), fixture.stalePointerBytes);
    });
  }
});

test("B7 C fix1 exact same-actor successor winner cannot become active authority", async (t) => {
  const deadOwnerPid = 932010;
  const tipOwnerPid = 932011;
  const fixture = await makeB7CStaleFixture(
    t,
    "b7-c-fix1-successor-winner",
    deadOwnerPid
  );
  const chain = await materializeB7CTwoLeaseChain(
    fixture,
    932012,
    tipOwnerPid
  );
  const successorPath =
    `${chain.targetDir}/lease-after-${chain.tipLease.sha256}.json`;
  const observed = await runB7CStaleRecoveryChild(
    fixture.rootDir,
    deadOwnerPid,
    { [tipOwnerPid]: "ESRCH" },
    { inject_destination_before_link: successorPath }
  );

  assert.equal(observed.destination_winner_injected, true);
  assert.deepEqual(
    observed.result,
    b5ExpectedFailure("CLEANING_RECOVERY_LOCKED", successorPath, true)
  );
  assert.deepEqual(
    await readFile(join(fixture.rootDir, B7_FIXED_COMMIT_LOCK)),
    fixture.fixedBytes
  );
  assert.deepEqual(await readFile(fixture.pointerPath), fixture.stalePointerBytes);
});

test("B7 C fix1 successor loser adopts only a precise live competing winner", async (t) => {
  const deadOwnerPid = 932015;
  const tipOwnerPid = 932016;
  const winnerOwnerPid = 932017;
  const fixture = await makeB7CStaleFixture(
    t,
    "b7-c-fix1-successor-live-winner",
    deadOwnerPid
  );
  const chain = await materializeB7CTwoLeaseChain(
    fixture,
    932018,
    tipOwnerPid
  );
  const successorPath =
    `${chain.targetDir}/lease-after-${chain.tipLease.sha256}.json`;
  const observed = await runB7CStaleRecoveryChild(
    fixture.rootDir,
    deadOwnerPid,
    {
      [tipOwnerPid]: "ESRCH",
      [winnerOwnerPid]: "success"
    },
    {
      inject_destination_winner: {
        path: successorPath,
        owner_pid: winnerOwnerPid,
        owner_nonce: "7".repeat(32)
      }
    }
  );
  const candidatePath =
    `${chain.targetDir}/.lease-${chain.tipLease.sha256}.` +
    `${observed.child_pid}.${"a".repeat(32)}.tmp`;

  assert.equal(observed.destination_winner_injected, true);
  assert.deepEqual(
    observed.result,
    b5ExpectedFailure("CLEANING_RECOVERY_LOCKED", successorPath, true)
  );
  await assert.rejects(
    () => lstat(join(fixture.rootDir, candidatePath)),
    { code: "ENOENT" }
  );
  assert.deepEqual(
    await readFile(join(fixture.rootDir, B7_FIXED_COMMIT_LOCK)),
    fixture.fixedBytes
  );
  assert.deepEqual(await readFile(fixture.pointerPath), fixture.stalePointerBytes);
});

test("B7 C fix1 fixed unlink final gate revalidates fixed and active authority last", async (t) => {
  for (const drift of ["fixed", "target", "tip", "successor"]) {
    await t.test(drift, async (t) => {
      const deadOwnerPid = 932020;
      const priorTipOwnerPid = 932021;
      const fixture = await makeB7CStaleFixture(
        t,
        `b7-c-fix1-final-authority-${drift}`,
        deadOwnerPid
      );
      const chain = await materializeB7CTwoLeaseChain(
        fixture,
        932022,
        priorTipOwnerPid
      );
      const activeTipPath =
        `${chain.targetDir}/lease-after-${chain.tipLease.sha256}.json`;
      const replacedPath = drift === "fixed"
        ? B7_FIXED_COMMIT_LOCK
        : drift === "target"
          ? `${chain.targetDir}/target.json`
          : activeTipPath;
      const observed = await runB7CStaleRecoveryChild(
        fixture.rootDir,
        deadOwnerPid,
        { [priorTipOwnerPid]: "ESRCH" },
        drift === "successor"
          ? { inject_successor_at_fixed_unlink_proof: true }
          : { replace_at_fixed_unlink_proof_path: replacedPath }
      );
      const expectedPath = drift === "successor"
        ? observed.active_successor_path
        : replacedPath;

      assert.equal(observed.fixed_unlink_proof_hook_triggered, true);
      assert.notEqual(expectedPath, null);
      assert.deepEqual(
        observed.result,
        b5ExpectedFailure("LOCAL_STATE_INVALID", expectedPath, true)
      );
      assert.deepEqual(
        await readFile(join(fixture.rootDir, B7_FIXED_COMMIT_LOCK)),
        fixture.fixedBytes
      );
      assert.deepEqual(await readFile(fixture.pointerPath), fixture.stalePointerBytes);
    });
  }
});

test("B7 C dead candidate final proof rejects same-byte node identity drift", async (t) => {
  const deadOwnerPid = 930100;
  const candidateOwnerPid = 930101;
  const fixture = await makeB7CStaleFixture(
    t,
    "b7-c-candidate-final-proof",
    deadOwnerPid
  );
  const target = await materializeB7RecoveryPrefix(
    fixture.rootDir,
    fixture.currentC,
    fixture.fixedBytes,
    "target-only"
  );
  const nodePath = `${target.targetDir}/target.json`;
  const candidatePath =
    `${target.targetDir}/.target.${candidateOwnerPid}.${"d".repeat(32)}.tmp`;
  await writeB7PrivatePath(
    fixture.rootDir,
    candidatePath,
    makeB7RecoveryTargetFixture(fixture.fixedBytes).bytes
  );

  const observed = await runB7CStaleRecoveryChild(
    fixture.rootDir,
    deadOwnerPid,
    { [candidateOwnerPid]: "ESRCH" },
    {
      replace_candidate_owner_pid: candidateOwnerPid,
      replace_candidate_node_path: nodePath
    }
  );

  assert.equal(observed.candidate_node_replaced, true);
  assert.deepEqual(
    observed.result,
    b5ExpectedFailure("LOCAL_STATE_INVALID", nodePath)
  );
  assert.deepEqual(
    await readFile(join(fixture.rootDir, candidatePath)),
    makeB7RecoveryTargetFixture(fixture.fixedBytes).bytes
  );
});

test("B7 C post-write I/O failures keep sticky writes and exact stale topology", async (t) => {
  for (const failure of [
    "terminal-link",
    "fixed-unlink",
    "post-unlink-state-fsync"
  ]) {
    await t.test(failure, async (t) => {
      const deadOwnerPid = 930110;
      const fixture = await makeB7CStaleFixture(
        t,
        `b7-c-sticky-${failure}`,
        deadOwnerPid
      );
      const pointerBefore = await lstat(fixture.pointerPath);
      const observed = await runB7CStaleRecoveryChild(
        fixture.rootDir,
        deadOwnerPid,
        {},
        { failure }
      );
      const targetDir = `${B7_RECOVERY_LEASES_ROOT}/${fixture.currentC}`;
      const targetPath = `${targetDir}/target.json`;
      const rootPath = `${targetDir}/lease-root.json`;
      const retirement = makeB7RetirementTerminalFixture(
        fixture.plan,
        fixture.currentC,
        sha256(fixture.stalePointerBytes)
      );
      const fixedExists = failure !== "post-unlink-state-fsync";
      const terminalExists = failure !== "terminal-link";
      const expected = failure === "terminal-link"
        ? b5IoFailure("link", retirement.path, true)
        : failure === "fixed-unlink"
          ? b5IoFailure("unlink", B7_FIXED_COMMIT_LOCK, true)
          : b5IoFailure("fsync", ".local/state", true);

      assert.deepEqual(observed.result, expected);
      assert.deepEqual(
        await readFile(join(fixture.rootDir, targetPath)),
        makeB7RecoveryTargetFixture(fixture.fixedBytes).bytes
      );
      assert.equal((await lstat(join(fixture.rootDir, rootPath))).isFile(), true);
      assert.equal(
        await readFile(join(fixture.rootDir, retirement.path))
          .then(() => true, () => false),
        terminalExists
      );
      assert.equal(
        await readFile(join(fixture.rootDir, B7_FIXED_COMMIT_LOCK))
          .then(() => true, () => false),
        fixedExists
      );
      const transitionNames = (await readdir(
        join(fixture.rootDir, B7_TRANSITIONS_DIRECTORY)
      )).sort();
      const tempName = `.${retirement.path.slice(
        retirement.path.lastIndexOf("/") + 1
      )}.${observed.child_pid}.${"a".repeat(32)}.tmp`;
      assert.equal(transitionNames.includes(tempName), failure === "terminal-link");
      assert.deepEqual(await readFile(fixture.pointerPath), fixture.stalePointerBytes);
      const pointerAfter = await lstat(fixture.pointerPath);
      assert.deepEqual(
        [pointerAfter.dev, pointerAfter.ino],
        [pointerBefore.dev, pointerBefore.ino]
      );
    });
  }
});

test("B7 C fix1 root prelink repeats the original-owner gate after every proof", async (t) => {
  for (const finalMode of ["success", "EPERM"]) {
    await t.test(finalMode, async (t) => {
      const deadOwnerPid = 931001;
      const fixture = await makeB7CStaleFixture(
        t,
        `b7-c-fix1-root-owner-${finalMode}`,
        deadOwnerPid
      );
      const observed = await runB7CStaleRecoveryChild(
        fixture.rootDir,
        deadOwnerPid,
        {},
        {
          liveness_sequence: {
            [deadOwnerPid]: ["ESRCH", "ESRCH", finalMode]
          }
        }
      );
      const targetDir = `${B7_RECOVERY_LEASES_ROOT}/${fixture.currentC}`;
      const rootPath = `${targetDir}/lease-root.json`;

      assert.deepEqual(
        observed.result,
        b5ExpectedFailure(
          "RECOVERY_OWNER_ALIVE",
          B7_FIXED_COMMIT_LOCK,
          true
        )
      );
      assert.equal(
        observed.canonical_link_destinations.some((path) =>
          path.endsWith("/lease-root.json")),
        false
      );
      await assert.rejects(
        () => lstat(join(fixture.rootDir, rootPath)),
        { code: "ENOENT" }
      );
      assert.deepEqual(await readFile(fixture.pointerPath), fixture.stalePointerBytes);
      assert.deepEqual(
        await readFile(join(fixture.rootDir, B7_FIXED_COMMIT_LOCK)),
        fixture.fixedBytes
      );
    });
  }
});

test("B7 C fix1 candidate final proof re-probes every owner before unlink", async (t) => {
  for (const finalMode of ["success", "EPERM"]) {
    await t.test(finalMode, async (t) => {
      const deadOwnerPid = 931010;
      const candidateOwnerPid = 931011;
      const fixture = await makeB7CStaleFixture(
        t,
        `b7-c-fix1-candidate-owner-${finalMode}`,
        deadOwnerPid
      );
      const target = await materializeB7RecoveryPrefix(
        fixture.rootDir,
        fixture.currentC,
        fixture.fixedBytes,
        "empty"
      );
      const candidatePath =
        `${target.targetDir}/.target.${candidateOwnerPid}.${"e".repeat(32)}.tmp`;
      const candidateBytes = makeB7RecoveryTargetFixture(fixture.fixedBytes).bytes;
      await writeB7PrivatePath(fixture.rootDir, candidatePath, candidateBytes);

      const observed = await runB7CStaleRecoveryChild(
        fixture.rootDir,
        deadOwnerPid,
        {},
        {
          liveness_sequence: {
            [candidateOwnerPid]: ["ESRCH", finalMode]
          }
        }
      );

      assert.deepEqual(
        observed.result,
        b5ExpectedFailure("CLEANING_RECOVERY_LOCKED", candidatePath)
      );
      assert.deepEqual(
        await readFile(join(fixture.rootDir, candidatePath)),
        candidateBytes
      );
      assert.deepEqual(await readFile(fixture.pointerPath), fixture.stalePointerBytes);
      assert.deepEqual(
        await readFile(join(fixture.rootDir, B7_FIXED_COMMIT_LOCK)),
        fixture.fixedBytes
      );
    });
  }
});

test("B7 C fix1 lease prelink classifies every newly visible other candidate", async (t) => {
  for (const mode of ["success", "EPERM", "ESRCH"]) {
    await t.test(mode, async (t) => {
      const deadOwnerPid = 931015;
      const otherOwnerPid = 931016;
      const otherNonce = "f".repeat(32);
      const fixture = await makeB7CStaleFixture(
        t,
        `b7-c-fix1-other-candidate-${mode}`,
        deadOwnerPid
      );
      const targetDir = `${B7_RECOVERY_LEASES_ROOT}/${fixture.currentC}`;
      const otherPath =
        `${targetDir}/.lease-root.${otherOwnerPid}.${otherNonce}.tmp`;
      const observed = await runB7CStaleRecoveryChild(
        fixture.rootDir,
        deadOwnerPid,
        { [otherOwnerPid]: mode },
        {
          inject_other_lease_candidate: {
            path: otherPath,
            owner_pid: otherOwnerPid,
            owner_nonce: otherNonce
          }
        }
      );

      assert.equal(observed.other_lease_candidate_injected, true);
      assert.deepEqual(
        observed.result,
        b5ExpectedFailure(
          mode === "ESRCH"
            ? "LOCAL_STATE_INVALID"
            : "CLEANING_RECOVERY_LOCKED",
          otherPath,
          true
        )
      );
      await assert.rejects(
        () => lstat(join(fixture.rootDir, `${targetDir}/lease-root.json`)),
        { code: "ENOENT" }
      );
      assert.equal((await lstat(join(fixture.rootDir, otherPath))).isFile(), true);
      assert.deepEqual(await readFile(fixture.pointerPath), fixture.stalePointerBytes);
    });
  }
});

test("B7 C fix1 successor candidate matrix preserves node topology across liveness", async (t) => {
  const cases = [
    ["success", "absent"],
    ["EPERM", "absent"],
    ["ESRCH", "absent"],
    ["ESRCH", "same-inode"],
    ["ESRCH", "different-inode"]
  ];
  for (const [mode, nodeState] of cases) {
    await t.test(`${mode} ${nodeState}`, async (t) => {
      const deadOwnerPid = 931030;
      const tipOwnerPid = 931031;
      const candidateOwnerPid = 931032;
      const fixture = await makeB7CStaleFixture(
        t,
        `b7-c-fix1-successor-candidate-${mode}-${nodeState}`,
        deadOwnerPid
      );
      const chain = await materializeB7CTwoLeaseChain(
        fixture,
        931033,
        tipOwnerPid
      );
      const candidateNonce = "1".repeat(32);
      const nodePath =
        `${chain.targetDir}/lease-after-${chain.tipLease.sha256}.json`;
      const candidatePath =
        `${chain.targetDir}/.lease-${chain.tipLease.sha256}.` +
        `${candidateOwnerPid}.${candidateNonce}.tmp`;
      const candidate = makeB7RecoveryLeaseFixture({
        targetCommitLockSha256: fixture.currentC,
        previousLeaseSha256: chain.tipLease.sha256,
        generation: 2,
        ownerPid: candidateOwnerPid,
        ownerNonce: candidateNonce
      });
      if (nodeState === "same-inode") {
        await writeB7PrivatePath(fixture.rootDir, nodePath, candidate.bytes);
        await link(
          join(fixture.rootDir, nodePath),
          join(fixture.rootDir, candidatePath)
        );
      } else {
        if (nodeState === "different-inode") {
          await writeB7PrivatePath(fixture.rootDir, nodePath, candidate.bytes);
        }
        await writeB7PrivatePath(
          fixture.rootDir,
          candidatePath,
          candidate.bytes
        );
      }

      const observed = await runB7CStaleRecoveryChild(
        fixture.rootDir,
        deadOwnerPid,
        {
          [tipOwnerPid]: "ESRCH",
          [candidateOwnerPid]: mode
        }
      );

      if (mode === "success" || mode === "EPERM") {
        assert.deepEqual(
          observed.result,
          b5ExpectedFailure("CLEANING_RECOVERY_LOCKED", candidatePath)
        );
        assert.deepEqual(
          await readFile(join(fixture.rootDir, candidatePath)),
          candidate.bytes
        );
      } else {
        assert.equal(observed.result.ok, true);
        await assert.rejects(
          () => lstat(join(fixture.rootDir, candidatePath)),
          { code: "ENOENT" }
        );
        const retained = await readFile(join(fixture.rootDir, nodePath));
        assert.equal(
          nodeState === "absent"
            ? retained.equals(makeB7RecoveryLeaseFixture({
              targetCommitLockSha256: fixture.currentC,
              previousLeaseSha256: chain.tipLease.sha256,
              generation: 2,
              ownerPid: observed.child_pid,
              ownerNonce: "a".repeat(32)
            }).bytes)
            : retained.equals(candidate.bytes),
          true
        );
      }
      assert.deepEqual(await readFile(fixture.pointerPath), fixture.stalePointerBytes);
    });
  }
});

test("B7 C fix1 mkdir winner is validated before parent fsync and child reproof", async (t) => {
  for (const boundary of ["root", "target"]) {
    await t.test(boundary, async (t) => {
      const deadOwnerPid = 931020;
      const fixture = await makeB7CStaleFixture(
        t,
        `b7-c-fix1-mkdir-order-${boundary}`,
        deadOwnerPid
      );
      const rootSuffix = `/${B7_RECOVERY_LEASES_ROOT}`;
      const targetSuffix = `${rootSuffix}/${fixture.currentC}`;
      const observed = await runB7CStaleRecoveryChild(
        fixture.rootDir,
        deadOwnerPid,
        {},
        {
          inject_mkdir_eexist_suffix:
            boundary === "root" ? rootSuffix : targetSuffix
        }
      );
      assert.equal(observed.result.ok, true);
      const eventIndex = observed.io_events.findIndex(([operation, path]) =>
        operation === "mkdir-eexist" &&
        path.endsWith(boundary === "root" ? rootSuffix : targetSuffix));
      assert.notEqual(eventIndex, -1);
      const expectedParentSuffix = boundary === "root"
        ? "/.local/state"
        : rootSuffix;
      assert.deepEqual(
        observed.io_events[eventIndex + 1],
        [
          "fsync",
          observed.io_events[eventIndex][1]
            .slice(0, -(
              boundary === "root" ? rootSuffix.length : targetSuffix.length
            )) + expectedParentSuffix
        ]
      );
    });
  }
});

test("B7 C fix1 recovery directory parent fsync is durable for EEXIST and created paths", async (t) => {
  await t.test("EEXIST parent fsync failure", async (t) => {
    const deadOwnerPid = 931025;
    const fixture = await makeB7CStaleFixture(
      t,
      "b7-c-fix1-eexist-fsync",
      deadOwnerPid
    );
    const rootSuffix = `/${B7_RECOVERY_LEASES_ROOT}`;
    const observed = await runB7CStaleRecoveryChild(
      fixture.rootDir,
      deadOwnerPid,
      {},
      {
        inject_mkdir_eexist_suffix: rootSuffix,
        failure: "recovery-eexist-parent-fsync"
      }
    );
    assert.deepEqual(
      observed.result,
      b5IoFailure("fsync", ".local/state", false)
    );
    assert.deepEqual(
      await readFile(join(fixture.rootDir, B7_FIXED_COMMIT_LOCK)),
      fixture.fixedBytes
    );
  });

  await t.test("created child replacement during parent fsync", async (t) => {
    const deadOwnerPid = 931026;
    const fixture = await makeB7CStaleFixture(
      t,
      "b7-c-fix1-created-replacement",
      deadOwnerPid
    );
    const externalRoot = await makeB5Root(
      t,
      "b7-c-fix1-created-replacement-external"
    );
    const movedPath = join(externalRoot, "moved-recovery-root");
    const rootSuffix = `/${B7_RECOVERY_LEASES_ROOT}`;
    const observed = await runB7CStaleRecoveryChild(
      fixture.rootDir,
      deadOwnerPid,
      {},
      {
        track_created_directory_suffix: rootSuffix,
        replace_created_directory_on_parent_fsync: {
          parent_suffix: "/.local/state",
          moved_path: movedPath
        }
      }
    );
    assert.equal(observed.created_directory_replaced, true);
    assert.deepEqual(
      observed.io_events.filter(([operation]) => operation === "hook-error"),
      []
    );
    assert.deepEqual(
      observed.result,
      b5ExpectedFailure(
        "LOCAL_STATE_INVALID",
        B7_RECOVERY_LEASES_ROOT,
        true
      )
    );
    assert.equal((await lstat(movedPath)).isDirectory(), true);
    assert.deepEqual(await readFile(fixture.pointerPath), fixture.stalePointerBytes);
  });
});

test("B7 C fix1 recovery mkdir topology errors map to the exact recovery path", async (t) => {
  for (const code of ["ENOENT", "ENOTDIR", "ELOOP"]) {
    await t.test(code, async (t) => {
      const deadOwnerPid = 931027;
      const fixture = await makeB7CStaleFixture(
        t,
        `b7-c-fix1-mkdir-${code.toLowerCase()}`,
        deadOwnerPid
      );
      const observed = await runB7CStaleRecoveryChild(
        fixture.rootDir,
        deadOwnerPid,
        {},
        { recovery_mkdir_error_code: code }
      );

      assert.deepEqual(
        observed.result,
        b5ExpectedFailure("LOCAL_STATE_INVALID", B7_RECOVERY_LEASES_ROOT)
      );
      assert.deepEqual(
        await readFile(join(fixture.rootDir, B7_FIXED_COMMIT_LOCK)),
        fixture.fixedBytes
      );
      assert.deepEqual(await readFile(fixture.pointerPath), fixture.stalePointerBytes);
    });
  }
});

test("B7 C fix1 recovery lease publication uses exact flags and durable mutation order", async (t) => {
  const deadOwnerPid = 931040;
  const fixture = await makeB7CStaleFixture(
    t,
    "b7-c-fix1-lease-order",
    deadOwnerPid
  );
  const target = await materializeB7RecoveryPrefix(
    fixture.rootDir,
    fixture.currentC,
    fixture.fixedBytes,
    "target-only"
  );
  const observed = await runB7CStaleRecoveryChild(
    fixture.rootDir,
    deadOwnerPid
  );
  const candidatePath =
    `${target.targetDir}/.lease-root.${observed.child_pid}.${"a".repeat(32)}.tmp`;
  const rootPath = `${target.targetDir}/lease-root.json`;
  const relevant = observed.io_events.filter((event) =>
    event.some((value) => typeof value === "string" &&
      (value.endsWith("/" + candidatePath) ||
        value.endsWith("/" + rootPath))) ||
    (event[0] === "fsync" &&
      event[1].endsWith("/" + target.targetDir)));

  assert.equal(observed.result.ok, true);
  assert.deepEqual(
    relevant.map(([operation]) => operation),
    ["open", "write", "fsync", "link", "fsync", "unlink", "fsync"]
  );
  assert.equal(
    relevant[0][2],
    fsConstants.O_WRONLY | fsConstants.O_CREAT |
      fsConstants.O_EXCL | fsConstants.O_NOFOLLOW
  );
  assert.equal(relevant[0][3], 0o600);
  assert.equal(
    (await lstat(join(fixture.rootDir, target.targetDir))).mode & 0o7777,
    0o700
  );
  assert.equal(
    (await lstat(join(fixture.rootDir, rootPath))).mode & 0o7777,
    0o600
  );
});

test("B7 C fix1 representative recovery I/O failures preserve sticky exact topology", async (t) => {
  for (const failure of [
    "recovery-mkdir",
    "lease-candidate-fsync",
    "lease-link",
    "lease-candidate-unlink",
    "terminal-directory-fsync"
  ]) {
    await t.test(failure, async (t) => {
      const deadOwnerPid = 931050;
      const fixture = await makeB7CStaleFixture(
        t,
        `b7-c-fix1-io-${failure}`,
        deadOwnerPid
      );
      const observed = await runB7CStaleRecoveryChild(
        fixture.rootDir,
        deadOwnerPid,
        {},
        { failure }
      );
      const targetDir = `${B7_RECOVERY_LEASES_ROOT}/${fixture.currentC}`;
      const candidatePath =
        `${targetDir}/.lease-root.${observed.child_pid}.${"a".repeat(32)}.tmp`;
      const rootPath = `${targetDir}/lease-root.json`;
      const retirement = makeB7RetirementTerminalFixture(
        fixture.plan,
        fixture.currentC,
        sha256(fixture.stalePointerBytes)
      );
      const expected = failure === "recovery-mkdir"
        ? b5IoFailure("mkdir", B7_RECOVERY_LEASES_ROOT, false)
        : failure === "lease-candidate-fsync"
          ? b5IoFailure("fsync", candidatePath, true)
          : failure === "lease-link"
            ? b5IoFailure("link", rootPath, true)
            : failure === "lease-candidate-unlink"
              ? b5IoFailure("unlink", candidatePath, true)
              : b5IoFailure("fsync", B7_TRANSITIONS_DIRECTORY, true);
      assert.deepEqual(observed.result, expected);
      assert.deepEqual(await readFile(fixture.pointerPath), fixture.stalePointerBytes);
      assert.deepEqual(
        await readFile(join(fixture.rootDir, B7_FIXED_COMMIT_LOCK)),
        fixture.fixedBytes
      );
      if (failure === "lease-candidate-unlink") {
        assert.equal((await lstat(join(fixture.rootDir, rootPath))).isFile(), true);
        assert.equal((await lstat(join(fixture.rootDir, candidatePath))).isFile(), true);
      }
      if (failure === "terminal-directory-fsync") {
        assert.deepEqual(
          await readFile(join(fixture.rootDir, retirement.path)),
          retirement.bytes
        );
      }
    });
  }
});

test("B7 C fix1 ASCII-earlier unresolved or malformed C1 outranks dead fixed C2 with zero writes", async (t) => {
  for (const state of ["unresolved", "malformed"]) {
    await t.test(state, async (t) => {
      const deadOwnerPid = 931060;
      const fixture = await makeB7CStaleFixture(
        t,
        `b7-c-fix1-earlier-${state}`,
        deadOwnerPid
      );
      const historical = makeB7HistoricalLockBefore(
        fixture.plan,
        fixture.currentC
      );
      const target = await materializeB7RecoveryPrefix(
        fixture.rootDir,
        historical.commitLockSha256,
        historical.lockBytes,
        state === "unresolved" ? "target-only" : "empty"
      );
      const targetPath = `${target.targetDir}/target.json`;
      if (state === "malformed") {
        await writeB7PrivatePath(
          fixture.rootDir,
          targetPath,
          Buffer.from("{}\n")
        );
      }
      const before = await snapshotB5Tree(fixture.rootDir);
      const observed = await runB7CStaleRecoveryChild(
        fixture.rootDir,
        deadOwnerPid
      );

      assert.deepEqual(
        observed.result,
        b5ExpectedFailure(
          state === "unresolved"
            ? "RECOVERY_UNRESOLVED_TARGET"
            : "LOCAL_STATE_INVALID",
          state === "unresolved" ? target.targetDir : targetPath
        )
      );
      assert.deepEqual(await snapshotB5Tree(fixture.rootDir), before);
    });
  }
});

test("B7 C fix1 exact desired and expected-prior pointers stop at D E boundaries", async (t) => {
  await t.test("exact desired", async (t) => {
    const deadOwnerPid = 931070;
    const fixture = await makeB7CStaleFixture(
      t,
      "b7-c-fix1-exact-desired",
      deadOwnerPid
    );
    const desiredBytes = canonicalJsonDocumentBytes(
      fixture.plan.manifest.desired_pointer
    );
    await writeFile(fixture.pointerPath, desiredBytes);
    await chmod(fixture.pointerPath, 0o600);
    const pointerBefore = await lstat(fixture.pointerPath);
    const completion = makeB7CompletionTerminalFixture(
      fixture.plan,
      fixture.currentC
    );
    const observed = await runB7CStaleRecoveryChild(
      fixture.rootDir,
      deadOwnerPid
    );
    assert.deepEqual(observed.result, {
      ok: true,
      value: {
        kind: "recovered",
        selected_target_commit_lock_sha256: fixture.currentC,
        current_fixed_commit_lock_sha256: fixture.currentC,
        active_lease_path: `${B7_RECOVERY_LEASES_ROOT}/${fixture.currentC}/lease-root.json`,
        final_pointer: fixture.plan.manifest.desired_pointer,
        transition_record_path: completion.path,
        commit_lock_cleanup: "unlinked_and_fsynced",
        persistent_writes_occurred: true
      }
    });
    assert.deepEqual(await readFile(fixture.pointerPath), desiredBytes);
    const pointerAfter = await lstat(fixture.pointerPath);
    assert.deepEqual(
      [pointerAfter.dev, pointerAfter.ino],
      [pointerBefore.dev, pointerBefore.ino]
    );
    assert.deepEqual(
      await readFile(join(fixture.rootDir, completion.path)),
      completion.bytes
    );
    await assert.rejects(
      () => lstat(join(fixture.rootDir, B7_FIXED_COMMIT_LOCK)),
      { code: "ENOENT" }
    );
  });

  await t.test("exact expected prior", async (t) => {
    const stageCleaningRun = await loadStageCleaningRun();
    const publishCleaningRun = await loadPublishCleaningRun();
    const rootDir = await makeB5Root(t, "b7-c-fix1-exact-prior");
    const initialPlan = makeB5GoldenPlan();
    const initialStaged = await stageCleaningRun(
      b5Options(rootDir, initialPlan)
    );
    assert.equal(initialStaged.ok, true);
    assert.equal((await publishCleaningRun(
      b6Options(rootDir, initialStaged.value.staged_run)
    )).ok, true);
    const plan = makeB6IncrementalPlan(initialPlan);
    const staged = await stageCleaningRun(b5Options(rootDir, plan));
    assert.equal(staged.ok, true);
    const deadOwnerPid = 931071;
    const fixedBytes = await writeB7FixedLock(
      rootDir,
      makeB6CommitLockIntent(plan, deadOwnerPid, "7".repeat(32))
    );
    const fixedCommitLockSha256 = sha256(fixedBytes);
    const pointerPath = join(rootDir, B6_CURRENT_POINTER);
    const pointerBefore = await lstat(pointerPath);
    const completion = makeB7CompletionTerminalFixture(plan, fixedCommitLockSha256);
    const observed = await runB7CStaleRecoveryChild(
      rootDir,
      deadOwnerPid
    );
    assert.deepEqual(observed.result, {
      ok: true,
      value: {
        kind: "recovered",
        selected_target_commit_lock_sha256: fixedCommitLockSha256,
        current_fixed_commit_lock_sha256: fixedCommitLockSha256,
        active_lease_path:
          `${B7_RECOVERY_LEASES_ROOT}/${fixedCommitLockSha256}/lease-root.json`,
        final_pointer: plan.manifest.desired_pointer,
        transition_record_path: completion.path,
        commit_lock_cleanup: "unlinked_and_fsynced",
        persistent_writes_occurred: true
      }
    });
    const pointerAfter = await lstat(pointerPath);
    assert.notDeepEqual(
      [pointerAfter.dev, pointerAfter.ino],
      [pointerBefore.dev, pointerBefore.ino]
    );
    assert.deepEqual(
      await readFile(join(rootDir, completion.path)),
      completion.bytes
    );
    assert.deepEqual(await readFile(pointerPath), canonicalJsonDocumentBytes(plan.manifest.desired_pointer));
    await assert.rejects(
      () => lstat(join(rootDir, B7_FIXED_COMMIT_LOCK)),
      { code: "ENOENT" }
    );
  });
});
