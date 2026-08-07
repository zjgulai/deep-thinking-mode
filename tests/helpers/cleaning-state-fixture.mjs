import { mkdir, mkdtemp, rm, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { sha256 } from "../../tools/lib/hash.mjs";
import {
  canonicalJsonBytes,
  canonicalJsonDocumentBytes
} from "../../tools/lib/json.mjs";

const CLEANER_VERSION = "1.0.0";
const POINTER_RELATIVE_PATH = ".local/state/current-cleaning.json";

function sourceId(index) {
  return `src_${index.toString(16).padStart(32, "0")}`;
}

function makeNeedsReviewSource(id, bytes) {
  const outputSha256 = sha256(bytes);
  return {
    source_id: id,
    source_kind: "markdown",
    locator_sha256: sha256(Buffer.from(`synthetic-locator:${id}`)),
    original_path: `.local/original/synthetic/${id}.md`,
    raw_sha256: outputSha256,
    cleaned_relative_path: `sources/${id}.md`,
    cleaned_sha256: outputSha256,
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
    review_state_bound_raw_sha256: outputSha256,
    review_state_bound_cleaned_sha256: outputSha256,
    review_state_bound_audit_sha256: null,
    review_state_bound_cleaner_version: CLEANER_VERSION,
    audit: null,
    audit_sha256: null,
    changes: [],
    warnings: ["SYNTHETIC_REVIEW"]
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

export async function createCleaningStateFixture({ sourceCount, outputs } = {}) {
  if (outputs !== undefined && sourceCount !== undefined) {
    throw new TypeError("provide sourceCount or outputs, not both");
  }
  const outputBytes = outputs === undefined
    ? Array.from({ length: sourceCount ?? 1 }, (_, index) =>
      Buffer.from(`synthetic output ${index + 1}\n`))
    : outputs.map((output) => Buffer.from(output));
  const ids = outputBytes.map((_, index) => sourceId(index + 1));
  const sources = ids.map((id, index) => makeNeedsReviewSource(id, outputBytes[index]));
  const runPreimage = {
    schema_version: "1.0.0",
    cleaner_version: CLEANER_VERSION,
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
    schema_version: "1.0.0",
    run_sha256: runSha256,
    run_path: runPath,
    catalog_path: `${runPath}/catalog/sources.jsonl`,
    catalog_sha256: sha256(catalogBytes),
    report_path: `${runPath}/cleaning-report.json`,
    report_sha256: sha256(reportBytes)
  };
  const pointerBytes = canonicalJsonDocumentBytes(pointer);
  const rootDir = await mkdtemp(join(tmpdir(), "brain-model-cleaning-state-"));
  const pointerPath = join(rootDir, POINTER_RELATIVE_PATH);
  const outputPaths = new Map(ids.map((id) => [id, join(rootDir, runPath, "sources", `${id}.md`)]));

  await mkdir(join(rootDir, runPath, "catalog"), { recursive: true });
  await mkdir(join(rootDir, runPath, "sources"), { recursive: true });
  await mkdir(dirname(pointerPath), { recursive: true });
  await Promise.all(ids.map((id, index) => writeFile(outputPaths.get(id), outputBytes[index])));
  await writeFile(join(rootDir, pointer.catalog_path), catalogBytes);
  await writeFile(join(rootDir, pointer.report_path), reportBytes);
  await writeFile(pointerPath, pointerBytes);

  return {
    rootDir,
    currentPointer: POINTER_RELATIVE_PATH,
    pointerPath,
    catalogPath: join(rootDir, pointer.catalog_path),
    reportPath: join(rootDir, pointer.report_path),
    outputPaths,
    ids,
    pointer,
    pointerBytes,
    catalogEntries,
    catalogBytes,
    report,
    reportBytes,
    deletePointer: () => unlink(pointerPath),
    deleteCatalog: () => unlink(join(rootDir, pointer.catalog_path)),
    deleteReport: () => unlink(join(rootDir, pointer.report_path)),
    deleteOutput: (id) => unlink(outputPaths.get(id)),
    replacePointer: (bytes) => writeFile(pointerPath, bytes),
    replaceCatalog: (bytes) => writeFile(join(rootDir, pointer.catalog_path), bytes),
    replaceReport: (bytes) => writeFile(join(rootDir, pointer.report_path), bytes),
    replaceOutput: (id, bytes) => writeFile(outputPaths.get(id), bytes),
    cleanup: () => rm(rootDir, { recursive: true, force: true })
  };
}
