import assert from "node:assert/strict";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";

import { canonicalJsonBytes, canonicalJsonDocumentBytes } from "../tools/lib/json.mjs";
import { sha256 } from "../tools/lib/hash.mjs";
import { readJsonl } from "../tools/lib/jsonl.mjs";
import { buildCurationSourceMap } from "../tools/build-curation-source-map.mjs";
import { createCleaningStateFixture } from "./helpers/cleaning-state-fixture.mjs";

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

function makeImageDominantAudit(imageUrl) {
  const metadataKeys = [
    "title",
    "author",
    "original_status",
    "published_at",
    "location",
    "source_url"
  ];
  const sourceByteLength = 256;
  const outputByteLength = 256;
  const imageSpanStart = 6;
  const imageSpanEnd = 8;
  const metadataSpans = Object.fromEntries(metadataKeys.map((key, index) => {
    const span = { start: index, end: index + 1 };
    const hash = sha256(Buffer.from(`meta-${key}`));
    return [key, {
      source_span: span,
      output_span: span,
      before_sha256: hash,
      after_sha256: hash,
      preserved: true
    }];
  }));
  const audit = {
    source_byte_length: sourceByteLength,
    output_byte_length: outputByteLength,
    retained_spans: [
      {
        source_line: 1,
        source_span: { start: 0, end: outputByteLength },
        output_span: { start: 0, end: outputByteLength },
        before_sha256: sha256(Buffer.from("retained-before")),
        after_sha256: sha256(Buffer.from("retained-after"))
      }
    ],
    metadata_spans: metadataSpans,
    image_spans: [
      {
        ordinal: 1,
        source_token_span: { start: 10, end: 11 },
        output_token_span: { start: imageSpanStart, end: imageSpanEnd },
        source_sha256: sha256(Buffer.from("source")),
        output_sha256: sha256(Buffer.from("output")),
        alt_sha256: sha256(Buffer.from("alt")),
        url_sha256: sha256(Buffer.from(imageUrl))
      }
    ],
    hard_breaks: [],
    body_output_span: { start: 6, end: 8 },
    ordered_body_images_preserved: true,
    body_non_whitespace_code_points: 0
  };

  return {
    audit,
    auditSha256: sha256(canonicalJsonBytes(audit))
  };
}

async function rebuildState(state, mutateSource) {
  const sources = state.report.run_preimage.sources.map((source, index) => {
    const next = structuredClone(source);
    return mutateSource(next, index);
  });
  const runPreimage = {
    ...state.report.run_preimage,
    sources
  };
  const runSha256 = sha256(canonicalJsonBytes(runPreimage));
  const runPath = `.local/cleaned/runs/${runSha256}`;
  const catalogEntries = sources.map((source) => projectCatalogEntry(source, runSha256));
  const catalogBytes = Buffer.concat(catalogEntries.map(canonicalJsonDocumentBytes));
  const report = {
    schema_version: "1.0.0",
    run_sha256: runSha256,
    run_preimage: runPreimage
  };
  const reportBytes = canonicalJsonDocumentBytes(report);

  const pointer = {
    ...state.pointer,
    run_sha256: runSha256,
    run_path: runPath,
    catalog_path: `${runPath}/catalog/sources.jsonl`,
    catalog_sha256: sha256(catalogBytes),
    report_path: `${runPath}/cleaning-report.json`,
    report_sha256: sha256(reportBytes)
  };
  const pointerBytes = canonicalJsonDocumentBytes(pointer);

  await mkdir(join(state.rootDir, runPath, "catalog"), { recursive: true });
  await writeFile(join(state.rootDir, pointer.catalog_path), catalogBytes);
  await writeFile(join(state.rootDir, pointer.report_path), reportBytes);
  await writeFile(state.pointerPath, pointerBytes);

  state.pointer = pointer;
  state.report = report;
  state.catalogEntries = catalogEntries;
  state.catalogPath = join(state.rootDir, pointer.catalog_path);
  state.pointerPath = join(state.rootDir, ".local/state/current-cleaning.json");
  return catalogEntries;
}

function catalogIndexById(catalogEntries) {
  return new Map(catalogEntries.map((entry) => [entry.source_id, entry]));
}

test("build-curation-source-map reuses IDs and emits opaque source ids", async (t) => {
  const state = await createCleaningStateFixture({ sourceCount: 3 });
  t.after(state.cleanup);
  const catalogEntries = await rebuildState(state, (entry, index) => {
    entry.processing_status = "needs_review";
    entry.publication_policy = index === 2 ? "local_only" : "public_metadata";
    return entry;
  });

  const first = await buildCurationSourceMap({ rootDir: state.rootDir });
  const second = await buildCurationSourceMap({ rootDir: state.rootDir });
  assert.deepEqual(first.sourceMapRecords.length, 3);
  assert.deepEqual(second.sourceMapRecords.length, 3);

  const sourceMapRecords = await readJsonl(join(state.rootDir, ".local/state/curation-source-ids.jsonl"));
  assert.equal(sourceMapRecords.length, 3);
  const firstPass = first.sourceMapRecords.map((record) => record.source_id);
  const secondPass = second.sourceMapRecords.map((record) => record.source_id);
  assert.deepEqual(firstPass, secondPass);

  for (const record of sourceMapRecords) {
    assert.match(record.source_id, /^src_[0-9a-f]{32}$/);
  }

  const indexByCatalog = catalogIndexById(catalogEntries);
  for (const record of sourceMapRecords) {
    const catalogEntry = indexByCatalog.get(record.catalog_source_id);
    assert.ok(catalogEntry !== undefined);
    assert.ok(!record.source_id.includes(catalogEntry.source_id));
    assert.ok(!record.source_id.includes(catalogEntry.cleaned_sha256.slice(0, 16)));
    if (catalogEntry.source_url !== null) {
      assert.equal(typeof catalogEntry.source_url, "string");
      assert.ok(!record.source_id.includes(catalogEntry.source_url));
    }
  }

  const knowledgeSources = JSON.parse(
    await readFile(join(state.rootDir, "knowledge/sources.json"), "utf8")
  );
  const publicIds = new Set(knowledgeSources.sources.map((entry) => entry.source_id));
  for (const [catalogId, sourceId] of sourceMapRecords.map((record) => [record.catalog_source_id, record.source_id])) {
    const catalogEntry = indexByCatalog.get(catalogId);
    if (catalogEntry?.publication_policy === "local_only") {
      assert.equal(publicIds.has(sourceId), false);
    }
  }
  assert.equal(knowledgeSources.sources.length, 2);
  for (const source of knowledgeSources.sources) {
    assert.notEqual(source.processing_status, "ready");
  }
});

test("build-curation-source-map marks image-dominant sources as blocked_ocr", async (t) => {
  const state = await createCleaningStateFixture({ sourceCount: 1 });
  t.after(state.cleanup);
  await rebuildState(state, (entry) => {
    entry.publication_policy = "public_metadata";
    entry.review_state_owner = "reviewer";
    entry.review_state_version = 1;
    entry.cleaning_status = "cleaned";
    entry.processing_status = "needs_ocr";
    entry.content_mode = "image_dominant";
    const imageUrl = "https://example.com/image-a.png";
    const { audit, auditSha256 } = makeImageDominantAudit(imageUrl);
    entry.body_image_urls = [imageUrl];
    entry.audit = audit;
    entry.audit_sha256 = auditSha256;
    entry.review_state_bound_audit_sha256 = auditSha256;
    entry.source_url = "https://example.com/image-source";
    return entry;
  });

  await buildCurationSourceMap({ rootDir: state.rootDir });
  const summaries = await readJsonl(join(state.rootDir, ".local/analysis/source-summaries.jsonl"));
  assert.deepEqual(summaries.length, 1);
  const summary = summaries[0];
  assert.equal(summary.summary_status, "blocked_ocr");
  assert.equal(summary.evidence_mode, "none");
});

test("build-curation-source-map writes empty JSONL placeholders for private-only stores", async (t) => {
  const state = await createCleaningStateFixture({ sourceCount: 1 });
  t.after(state.cleanup);
  await rebuildState(state, (entry) => {
    entry.publication_policy = "local_only";
    entry.processing_status = "needs_review";
    return entry;
  });
  await buildCurationSourceMap({ rootDir: state.rootDir });

  for (const relativePath of [
    ".local/dedup/model-contributions.jsonl",
    ".local/verification/records.jsonl",
    ".local/reviews/queue.jsonl"
  ]) {
    const bytes = await readFile(join(state.rootDir, relativePath));
    assert.equal(bytes.length, 0);
  }
});
