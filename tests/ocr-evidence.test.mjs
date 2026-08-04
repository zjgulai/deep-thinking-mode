import assert from "node:assert/strict";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { mkdtempSync } from "node:fs";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

import { canonicalJsonBytes, canonicalJsonDocumentBytes } from "../tools/lib/json.mjs";
import { readJsonl, writeJsonl, writeJsonlBytes } from "../tools/lib/jsonl.mjs";
import { sha256 } from "../tools/lib/hash.mjs";
import { buildCurationSourceMap } from "../tools/build-curation-source-map.mjs";
import { registerOcrAssets } from "../tools/register-ocr-assets.mjs";
import { fetchBodyImages } from "../tools/fetch-body-images.mjs";
import { createCleaningStateFixture } from "./helpers/cleaning-state-fixture.mjs";

function makeSourceId(index) {
  return `src_${index.toString(16).padStart(32, "0")}`;
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

async function rebuildStateCatalog(state, mutateSource) {
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
  await mkdir(join(state.rootDir, runPath, "sources"), { recursive: true });
  await writeFile(join(state.rootDir, pointer.catalog_path), catalogBytes);
  await writeFile(join(state.rootDir, pointer.report_path), reportBytes);
  await writeFile(state.pointerPath, pointerBytes);

  state.pointer = pointer;
  state.report = report;
  return catalogEntries;
}

function mimeExtensionFromType(type) {
  if (type === "image/jpeg") return "jpg";
  if (type === "image/svg+xml") return "svg";
  return type.replace("image/", "");
}

function localAssetPath(bytes, mimeType) {
  const digest = sha256(bytes);
  return `.local/ocr/downloads/${digest.slice(0, 2)}/${digest}.${mimeExtensionFromType(mimeType)}`;
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
    body_output_span: { start: imageSpanStart, end: imageSpanEnd },
    ordered_body_images_preserved: true,
    body_non_whitespace_code_points: 0
  };

  return {
    audit,
    auditSha256: sha256(canonicalJsonBytes(audit))
  };
}

function createTempRoot() {
  const rootDir = mkdtempSync(join(tmpdir(), "ocr-evidence-test-"));
  mkdirSync(join(rootDir, ".local/ocr"), { recursive: true });
  const cleanup = () => rm(rootDir, { recursive: true, force: true });
  return { rootDir, cleanup };
}

test("register-ocr-assets maps baseline IDs and updates source status", async (t) => {
  const state = await createCleaningStateFixture({ sourceCount: 25 });
  t.after(state.cleanup);

  const sourceCount = 25;
  const catalogEntries = await rebuildStateCatalog(state, (entry, index) => {
    entry.publication_policy = index === 0 ? "local_only" : "public_metadata";
    entry.review_state_owner = "reviewer";
    entry.review_state_version = 1;
    entry.cleaning_status = "cleaned";
    entry.processing_status = "needs_ocr";
    entry.content_mode = "image_dominant";
    const imageUrl = `https://images.example.test/${entry.source_id}-${index + 1}.png`;
    const { audit, auditSha256 } = makeImageDominantAudit(imageUrl);
    entry.body_image_urls = [imageUrl];
    entry.audit = audit;
    entry.audit_sha256 = auditSha256;
    entry.review_state_bound_audit_sha256 = auditSha256;
    entry.source_url = `https://example.com/source-${index + 1}.example`;
    return entry;
  });
  assert.equal(catalogEntries.length, sourceCount);

  await buildCurationSourceMap({ rootDir: state.rootDir });
  const sourceMap = await readJsonl(join(state.rootDir, ".local/state/curation-source-ids.jsonl"));

  const statuses = [
    "approved",
    "needs_visual_review",
    "rejected",
    "fetch_failed"
  ];
  const sourceIdByStatus = new Map();
  const baseline = [];
  for (let index = 0; index < sourceMap.length; index += 1) {
    const record = sourceMap[index];
    const status = statuses[index % statuses.length];
    const bySourceId = index % 2 === 0 ? record.catalog_source_id : record.source_id;
    baseline.push({
      source_id: bySourceId,
      status
    });
    sourceIdByStatus.set(record.source_id, status);
  }

  await writeFile(
    join(state.rootDir, ".local/reviews/image-dominant-baseline.json"),
    `${JSON.stringify(baseline)}\n`
  );

  const output = await registerOcrAssets({
    rootDir: state.rootDir,
    currentPointer: ".local/state/current-cleaning.json",
    sourceMapPath: ".local/state/curation-source-ids.jsonl",
    imageDominantBaselinePath: ".local/reviews/image-dominant-baseline.json",
    sourceSummaryPath: ".local/analysis/source-summaries.jsonl",
    knowledgeSourcesPath: "knowledge/sources.json",
    assetsPath: ".local/ocr/assets.jsonl",
    resultsPath: ".local/ocr/results.jsonl"
  });

  assert.equal(output.assets, 25);
  const assets = await readJsonl(join(state.rootDir, ".local/ocr/assets.jsonl"));
  assert.equal(assets.length, 25);
  for (const asset of assets) {
    assert.equal(asset.fetch_status, "queued");
    assert.equal(asset.local_path, null);
    assert.equal(asset.sha256, null);
    assert.equal(asset.mime_type, null);
    assert.equal(asset.width, null);
    assert.equal(asset.height, null);
  }

  const summaries = await readJsonl(join(state.rootDir, ".local/analysis/source-summaries.jsonl"));
  const knowledge = JSON.parse(await readFile(join(state.rootDir, "knowledge/sources.json"), "utf8"));

  const summaryBySource = new Map(summaries.map((entry) => [entry.source_id, entry]));
  const knowledgeBySource = new Map(knowledge.sources.map((entry) => [entry.source_id, entry]));

  for (const [sourceId, status] of sourceIdByStatus.entries()) {
    const sourceMapRecord = sourceMap.find(
      (entry) => entry.source_id === sourceId || entry.catalog_source_id === sourceId
    );
    const mappedSourceId = sourceMapRecord?.source_id;
    const catalogSourceId = sourceMapRecord?.catalog_source_id;
    const sourceIdLabel = mappedSourceId ?? sourceId;

    const summary = summaryBySource.get(sourceIdLabel);
    assert.equal(typeof summary, "object");

    const isLocalOnly = sourceMapRecord !== undefined &&
      catalogEntries.find((entry) => entry.source_id === catalogSourceId)?.publication_policy === "local_only";

    if (isLocalOnly) {
      assert.equal(summary.summary_status, status === "approved" ? "new" : "blocked_ocr");
      assert.equal(knowledgeBySource.has(sourceId), false);
      continue;
    }

    const knowledgeSource = knowledgeBySource.get(sourceIdLabel);
    assert.equal(typeof knowledgeSource, "object");

    if (status === "approved") {
      assert.equal(summary.summary_status, "new");
      assert.equal(knowledgeSource.ocr_status, "approved");
    } else {
      assert.equal(summary.summary_status, "blocked_ocr");
      assert.equal(summary.evidence_mode, "none");
      assert.equal(summary.core_question, null);
      assert.equal(summary.core_conclusion, null);
      assert.deepEqual(summary.key_concepts, []);
      assert.deepEqual(summary.mechanisms, []);
      assert.deepEqual(summary.methods, []);
      assert.deepEqual(summary.use_cases, []);
      assert.deepEqual(summary.limitations, []);
      assert.deepEqual(summary.unique_contributions, []);
      assert.deepEqual(summary.candidate_model_ids, []);

      assert.equal(knowledgeSource.processing_status, "needs_ocr");
      assert.equal(knowledgeSource.ocr_status, status);
    }

    assert.ok([
      "needs_ocr",
      "approved",
      "not_required",
      "needs_visual_review",
      "rejected",
      "fetch_failed"
    ].includes(knowledgeSource.ocr_status));
  }

  const results = await readFile(join(state.rootDir, ".local/ocr/results.jsonl"), "utf8");
  assert.equal(results, "\n");
});

test("register-ocr-assets rejects baseline with wrong image-dominant count", async (t) => {
  const state = await createCleaningStateFixture({ sourceCount: 25 });
  t.after(state.cleanup);

  const catalogEntries = await rebuildStateCatalog(state, (entry, index) => {
    entry.publication_policy = "public_metadata";
    entry.review_state_owner = "reviewer";
    entry.review_state_version = 1;
    entry.cleaning_status = "cleaned";
    entry.processing_status = "needs_ocr";
    entry.content_mode = "image_dominant";
    const imageUrl = `https://images.example.test/${entry.source_id}-${index + 1}.png`;
    const { audit, auditSha256 } = makeImageDominantAudit(imageUrl);
    entry.body_image_urls = [imageUrl];
    entry.audit = audit;
    entry.audit_sha256 = auditSha256;
    entry.review_state_bound_audit_sha256 = auditSha256;
    entry.source_url = `https://example.com/source-${index + 1}.example`;
    return entry;
  });

  await buildCurationSourceMap({ rootDir: state.rootDir });
  const sourceMap = await readJsonl(join(state.rootDir, ".local/state/curation-source-ids.jsonl"));

  const baseline = sourceMap.slice(0, 24).map((record, index) => ({
    source_id: index % 2 === 0 ? record.catalog_source_id : record.source_id,
    status: "approved"
  }));
  await writeFile(
    join(state.rootDir, ".local/reviews/image-dominant-baseline.json"),
    `${JSON.stringify(baseline)}\n`
  );

  await assert.rejects(() => registerOcrAssets({
    rootDir: state.rootDir,
    currentPointer: ".local/state/current-cleaning.json",
    sourceMapPath: ".local/state/curation-source-ids.jsonl",
    imageDominantBaselinePath: ".local/reviews/image-dominant-baseline.json",
    sourceSummaryPath: ".local/analysis/source-summaries.jsonl",
    knowledgeSourcesPath: "knowledge/sources.json",
    assetsPath: ".local/ocr/assets.jsonl",
    resultsPath: ".local/ocr/results.jsonl"
  }), /baseline image-dominant set must have 25 items/);
});

test("fetch-body-images downloads queued images with safety checks", async (t) => {
  const { rootDir, cleanup } = createTempRoot();
  t.after(cleanup);

  const sourceId = makeSourceId(1);
  const imageBytes = Buffer.from("hello-image");
  const mimeType = "image/png";
  const assetPath = localAssetPath(imageBytes, mimeType);

  const originalFetch = global.fetch;
  t.after(() => {
    global.fetch = originalFetch;
  });
  let fetchCalls = 0;
  global.fetch = async (input) => {
    fetchCalls += 1;
    const url = typeof input === "string" ? input : input.href;
    if (url === "http://127.0.0.1:10001/photo.png") {
      return new Response(imageBytes, {
        status: 200,
        headers: {
          "content-type": mimeType,
          "content-length": `${imageBytes.length}`
        }
      });
    }
    throw new Error(`unexpected fetch url: ${url}`);
  };

  const assetsPath = ".local/ocr/assets.jsonl";
  const records = [
    {
      asset_id: "asset-success",
      source_id: sourceId,
      ordinal: 1,
      source_url: "http://127.0.0.1:10001/photo.png",
      local_path: null,
      sha256: null,
      fetch_status: "queued",
      mime_type: null,
      width: null,
      height: null
    }
  ];
  await writeFile(join(rootDir, assetsPath), writeJsonlBytes(records));

  const result = await fetchBodyImages({
    rootDir,
    assetsPath,
    timeoutMs: 2000,
    maxBytes: 1024,
    maxRedirects: 3
  });

  assert.equal(result.fetched, 1);
  assert.equal(result.failed, 0);
  assert.equal(result.processed, 1);
  assert.equal(fetchCalls, 1);

  const next = await readJsonl(join(rootDir, assetsPath));
  assert.equal(next.length, 1);
  const fetched = next[0];
  assert.equal(fetched.fetch_status, "fetched");
  assert.equal(fetched.local_path, assetPath);
  assert.equal(fetched.sha256, sha256(imageBytes));
  assert.equal(fetched.mime_type, "image/png");

  const saved = await readFile(join(rootDir, assetPath));
  assert.equal(saved.toString(), imageBytes.toString());
});

test("fetch-body-images preserves non-queued status and ignores fetch response", async (t) => {
  const { rootDir, cleanup } = createTempRoot();
  t.after(cleanup);

  const sourceId = makeSourceId(2);
  const assetsPath = ".local/ocr/assets.jsonl";
  const records = [
    {
      asset_id: "asset-skipped",
      source_id: sourceId,
      ordinal: 1,
      source_url: "http://127.0.0.1:10002/photo.png",
      local_path: "old/path.png",
      sha256: "a".repeat(64),
      fetch_status: "fetched",
      mime_type: "image/png",
      width: 0,
      height: 0
    }
  ];
  await writeFile(join(rootDir, assetsPath), writeJsonlBytes(records));

  const originalFetch = global.fetch;
  t.after(() => {
    global.fetch = originalFetch;
  });
  global.fetch = () => {
    throw new Error("should not be called");
  };

  const result = await fetchBodyImages({ rootDir, assetsPath, timeoutMs: 2000, maxBytes: 64, maxRedirects: 1 });
  assert.equal(result.fetched, 0);
  assert.equal(result.failed, 0);
  assert.equal(result.processed, 1);

  const next = await readJsonl(join(rootDir, assetsPath));
  assert.deepEqual(next[0], records[0]);
});

test("fetch-body-images marks mime mismatch and oversized downloads as failed", async (t) => {
  const { rootDir, cleanup } = createTempRoot();
  t.after(cleanup);

  const sourceId = makeSourceId(3);
  const assetsPath = ".local/ocr/assets.jsonl";
  const textBody = Buffer.from("not-an-image");

  const originalFetch = global.fetch;
  t.after(() => {
    global.fetch = originalFetch;
  });

  global.fetch = async (input) => {
    const url = typeof input === "string" ? input : input.href;
    if (url === "http://127.0.0.1:10003/photo.txt") {
      return new Response(textBody, {
        status: 200,
        headers: {
          "content-type": "text/plain",
          "content-length": `${textBody.length}`
        }
      });
    }
    if (url === "http://127.0.0.1:10004/photo.png") {
      const large = Buffer.from("x".repeat(11));
      return new Response(large, {
        status: 200,
        headers: {
          "content-type": "image/png",
          "content-length": "20"
        }
      });
    }
    throw new Error(`unexpected fetch url: ${url}`);
  };

  await writeFile(join(rootDir, assetsPath), writeJsonlBytes([
    {
      asset_id: "asset-text",
      source_id: sourceId,
      ordinal: 1,
      source_url: "http://127.0.0.1:10003/photo.txt",
      local_path: null,
      sha256: null,
      fetch_status: "queued",
      mime_type: null,
      width: null,
      height: null
    },
    {
      asset_id: "asset-large",
      source_id: sourceId,
      ordinal: 2,
      source_url: "http://127.0.0.1:10004/photo.png",
      local_path: null,
      sha256: null,
      fetch_status: "queued",
      mime_type: null,
      width: null,
      height: null
    }
  ]));

  const result = await fetchBodyImages({
    rootDir,
    assetsPath,
    maxBytes: 10,
    maxRedirects: 1,
    timeoutMs: 2000
  });
  assert.equal(result.fetched, 0);
  assert.equal(result.failed, 2);

  const next = await readJsonl(join(rootDir, assetsPath));
  assert.equal(next[0].fetch_status, "fetch_failed");
  assert.equal(next[1].fetch_status, "fetch_failed");
});

test("fetch-body-images rejects redirects that change origin or exceed pin policy", async (t) => {
  const { rootDir, cleanup } = createTempRoot();
  t.after(cleanup);

  const sourceId = makeSourceId(4);
  const assetsPath = ".local/ocr/assets.jsonl";

  const originalFetch = global.fetch;
  t.after(() => {
    global.fetch = originalFetch;
  });
  global.fetch = async (input) => {
    const url = typeof input === "string" ? input : input.href;
    if (url === "http://127.0.0.1:10005/redirect") {
      return new Response(null, {
        status: 302,
        headers: { location: "http://127.0.0.2:10005/blocked" }
      });
    }
    if (url === "http://127.0.0.1:10006/loop") {
      return new Response(null, {
        status: 302,
        headers: { location: "/loop" }
      });
    }
    throw new Error(`unexpected fetch url: ${url}`);
  };

  await writeFile(join(rootDir, assetsPath), writeJsonlBytes([
    {
      asset_id: "asset-origin",
      source_id: sourceId,
      ordinal: 1,
      source_url: "http://127.0.0.1:10005/redirect",
      local_path: null,
      sha256: null,
      fetch_status: "queued",
      mime_type: null,
      width: null,
      height: null
    },
    {
      asset_id: "asset-loop",
      source_id: sourceId,
      ordinal: 2,
      source_url: "http://127.0.0.1:10006/loop",
      local_path: null,
      sha256: null,
      fetch_status: "queued",
      mime_type: null,
      width: null,
      height: null
    }
  ]));

  const result = await fetchBodyImages({
    rootDir,
    assetsPath,
    maxRedirects: 1,
    timeoutMs: 2000,
    maxBytes: 64
  });
  assert.equal(result.fetched, 0);
  assert.equal(result.failed, 2);
});

test("fetch-body-images fails when existing destination has different hash", async (t) => {
  const { rootDir, cleanup } = createTempRoot();
  t.after(cleanup);

  const sourceId = makeSourceId(5);
  const assetsPath = ".local/ocr/assets.jsonl";
  const bytes = Buffer.from("approved-image");
  const mimeType = "image/png";
  const expectedPath = localAssetPath(bytes, mimeType);
  const collision = Buffer.from("not-the-same");

  await mkdir(join(rootDir, ".local/ocr/downloads", sha256(bytes).slice(0, 2)), { recursive: true });
  await writeFile(join(rootDir, expectedPath), collision);

  const originalFetch = global.fetch;
  t.after(() => {
    global.fetch = originalFetch;
  });
  global.fetch = async (input) => {
    const url = typeof input === "string" ? input : input.href;
    if (url === "http://127.0.0.1:10007/photo.png") {
      return new Response(bytes, {
        status: 200,
        headers: {
          "content-type": "image/png",
          "content-length": `${bytes.length}`
        }
      });
    }
    throw new Error(`unexpected fetch url: ${url}`);
  };

  await writeFile(join(rootDir, assetsPath), writeJsonlBytes([
    {
      asset_id: "asset-conflict",
      source_id: sourceId,
      ordinal: 1,
      source_url: "http://127.0.0.1:10007/photo.png",
      local_path: null,
      sha256: null,
      fetch_status: "queued",
      mime_type: null,
      width: null,
      height: null
    }
  ]));

  const result = await fetchBodyImages({ rootDir, assetsPath, timeoutMs: 2000, maxBytes: 64, maxRedirects: 3 });
  assert.equal(result.fetched, 0);
  assert.equal(result.failed, 1);

  const next = await readJsonl(join(rootDir, assetsPath));
  assert.equal(next[0].fetch_status, "fetch_failed");
});
