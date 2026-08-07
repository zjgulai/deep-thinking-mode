import assert from "node:assert/strict";
import { mkdtemp, writeFile, unlink } from "node:fs/promises";
import { readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import { validateContract } from "../tools/lib/contracts.mjs";
import { readJsonl, writeJsonlBytes } from "../tools/lib/jsonl.mjs";

const FIXTURE_ROOT = join(dirname(fileURLToPath(import.meta.url)), "fixtures", "curation");

function readFixture(name) {
  return readFile(join(FIXTURE_ROOT, name), "utf8").then((contents) => JSON.parse(contents));
}

function assertContractError(promise, code) {
  return assert.rejects(promise, (cause) => cause.code === code);
}

const TAXONOMY_VALID = {
  schema_version: "1.0.0",
  content_types: ["canonical", "card", "case", "comparison", "series", "related"],
  risk_flags: ["needs_ocr", "needs_medical_review", "needs_logic_review", "evidence_limited"],
  chapters: [
    ...Array.from({ length: 13 }, (_, index) => ({
      id: String(index).padStart(2, "0"),
      order: index,
      slug: `chapter-${index}`,
      title: `Chapter ${index}`,
      description: `desc-${index}`,
      baseline_source_count: 0,
      subchapters: [],
      allowed_tags: []
    }))
  ]
};

test("contract: accepts valid source summary fixture", async () => {
  const summary = await readFixture("source-summary-valid.json");
  assert.equal(validateContract("source-summary", summary), undefined);
});

test("contract: accepts valid problem route fixture", async () => {
  const routes = await readFixture("problem-routes-valid.json");
  assert.equal(validateContract("problem-routes", routes), undefined);
});

test("contract: rejects unknown root fields", async () => {
  const summary = await readFixture("source-summary-valid.json");
  await assertContractError(
    Promise.resolve().then(() => validateContract("source-summary", { ...summary, extra_field: true })),
    "CONTRACT_SCHEMA_INVALID"
  );
});

test("contract: rejects invalid schema version", async () => {
  const summary = await readFixture("source-summary-valid.json");
  const modified = structuredClone(summary);
  modified.schema_version = "0.9.0";
  await assertContractError(Promise.resolve().then(() => validateContract("source-summary", modified)), "CONTRACT_SCHEMA_INVALID");
});

test("contract: rejects duplicate route ids and preserves fail-fast", async () => {
  const invalidRoutes = await readFixture("problem-routes-invalid.json");
  await assertContractError(Promise.resolve().then(() => validateContract("problem-routes", invalidRoutes)), "CONTRACT_SCHEMA_INVALID");
});

test("contract: rejects taxonomy chapter unsorted and duplicate id", () => {
  const unsorted = structuredClone(TAXONOMY_VALID);
  unsorted.chapters = [
    unsorted.chapters[1],
    unsorted.chapters[0],
    ...unsorted.chapters.slice(2)
  ];
  unsorted.chapters[0].id = "01";
  unsorted.chapters[1].id = "01";

  assert.throws(() => validateContract("taxonomy", unsorted), (cause) => cause.code === "CONTRACT_SCHEMA_INVALID");
});

test("contract: validates jsonl newline requirement", async () => {
  const tempDir = await mkdtemp(join(tmpdir(), "bm-contract-jsonl-"));
  const path = join(tempDir, "items.jsonl");
  const records = [{ source_id: "src_00000000000000000000000000000000" }, { source_id: "src_11111111111111111111111111111111" }];
  await writeFile(path, JSON.stringify(records[0]) + "\n" + JSON.stringify(records[1]));  // missing final newline
  await assertContractError(readJsonl(path), "JSONL_MISSING_EOF_NEWLINE");
  await writeFile(path, writeJsonlBytes(records));
  const parsed = await readJsonl(path);
  assert.deepEqual(parsed, records);
  await unlink(path);
});
