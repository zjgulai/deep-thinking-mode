import { access, mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { dirname, relative, resolve } from "node:path";

import { canonicalJsonBytes } from "./json.mjs";
import { validateContract } from "./contracts.mjs";
import { sha256 } from "./hash.mjs";

const SCHEMA_VERSION = "1.0.0";

const KNOWN_PATHS = {
  TAXONOMY: "knowledge/taxonomy.json",
  SOURCES: "knowledge/sources.json",
  ROUTES: "knowledge/problem-routes.json",
  MANIFEST: "knowledge/manifest.json",
  CHAPTERS_DIR: "knowledge/chapters",
  MODELS_DIR: "knowledge/models"
};

const PROCESSING_VERSIONS = Object.freeze({
  cleaner: "1.0.0",
  summary_protocol: "1.0.0",
  curation_protocol: "1.0.0",
  model_contract: "1.0.0",
  route_contract: "1.0.0"
});

const MODEL_META_RE = /<!--\s*model-meta:\s*({[\s\S]*?})\s*-->/;
const CARD_META_RE = /<!--\s*card-meta:\s*({[\s\S]*?})\s*-->/;

function fail(message, path) {
  const error = new Error(message);
  error.code = "KNOWLEDGE_MANIFEST_BUILD_ERROR";
  if (path) error.path = path;
  throw error;
}

async function exists(path) {
  try {
    await access(path);
    return true;
  } catch (cause) {
    if (cause?.code === "ENOENT") return false;
    throw cause;
  }
}

async function readJsonFile(path) {
  const raw = await readFile(path, "utf8");
  try {
    return JSON.parse(raw);
  } catch {
    const error = new Error(`invalid json file: ${path}`);
    error.code = "KNOWLEDGE_MANIFEST_BUILD_ERROR";
    error.path = path;
    throw error;
  }
}

async function readJsonFileOptional(path) {
  if (!(await exists(path))) return null;
  return readJsonFile(path);
}

async function listDirectoryFiles(path) {
  if (!(await exists(path))) return [];
  const files = await readdir(path, { withFileTypes: true });
  return files
    .filter((entry) => entry.isFile())
    .map((entry) => `${path}/${entry.name}`);
}

async function fileSha256(absolutePath) {
  return sha256(await readFile(absolutePath));
}

function countBy(values, getValue) {
  const counts = Object.create(null);
  for (const value of values) {
    const key = getValue(value);
    if (key === null || key === undefined) continue;
    counts[key] = (counts[key] ?? 0) + 1;
  }
  return counts;
}

function parseJsonComment(text, pattern) {
  const match = pattern.exec(text);
  if (match === null) return null;
  try {
    const parsed = JSON.parse(match[1]);
    return typeof parsed === "object" && parsed !== null ? parsed : null;
  } catch {
    return null;
  }
}

async function loadTaxonomy(rootDir) {
  const path = resolve(rootDir, KNOWN_PATHS.TAXONOMY);
  const payload = await readJsonFile(path);
  validateContract("taxonomy", payload);
  return payload;
}

async function loadSources(rootDir) {
  const path = resolve(rootDir, KNOWN_PATHS.SOURCES);
  const payload = await readJsonFile(path);
  validateContract("knowledge-sources", payload);
  if (!Array.isArray(payload.sources)) fail(`knowledge-sources.sources must be array: ${path}`, path);
  return payload;
}

async function loadRoutes(rootDir) {
  const path = resolve(rootDir, KNOWN_PATHS.ROUTES);
  const payload = await readJsonFile(path);
  validateContract("problem-routes", payload);
  return payload;
}

async function collectChapterPaths(rootDir) {
  const absolute = resolve(rootDir, KNOWN_PATHS.CHAPTERS_DIR);
  const paths = await listDirectoryFiles(absolute);
  return paths
    .filter((entry) => entry.endsWith(".md"))
    .map((entry) => relative(rootDir, entry).replaceAll("\\", "/"))
    .sort();
}

async function collectModelPaths(rootDir) {
  const absolute = resolve(rootDir, KNOWN_PATHS.MODELS_DIR);
  const paths = await listDirectoryFiles(absolute);
  return paths
    .filter((entry) => entry.endsWith(".md"))
    .map((entry) => relative(rootDir, entry).replaceAll("\\", "/"))
    .sort();
}

function buildChapterCounts(sources) {
  const counts = Object.create(null);
  for (const source of sources) {
    if (!source || typeof source.primary_chapter_id !== "string") continue;
    counts[source.primary_chapter_id] = (counts[source.primary_chapter_id] ?? 0) + 1;
  }
  return counts;
}

function normalizeSourceForCorpus(source) {
  return {
    source_id: source.source_id,
    title: source.title ?? null,
    provenance_visibility: source.provenance_visibility,
    primary_chapter_id: source.primary_chapter_id,
    primary_content_type: source.primary_content_type ?? null,
    tags: source.tags ?? [],
    model_roles: source.model_roles ?? [],
    related_sources: source.related_sources ?? [],
    processing_status: source.processing_status,
    ocr_status: source.ocr_status,
    medical_review_status: source.medical_review_status,
    logic_review_status: source.logic_review_status,
    risk_flags: source.risk_flags ?? [],
    evidence_boundary: source.evidence_boundary ?? null
  };
}

function computeKnowledgeVersion(publicFiles) {
  const combined = [...publicFiles]
    .sort((left, right) => left.path.localeCompare(right.path))
    .map((entry) => `${entry.path}\n${entry.sha256}`)
    .join("\n");
  return sha256(canonicalJsonBytes(combined)).slice(0, 16);
}

async function collectPublicFiles(rootDir) {
  const paths = [KNOWN_PATHS.TAXONOMY, KNOWN_PATHS.SOURCES];
  if (await exists(resolve(rootDir, KNOWN_PATHS.ROUTES))) {
    paths.push(KNOWN_PATHS.ROUTES);
  }

  const chapterPaths = await collectChapterPaths(rootDir);
  const modelPaths = await collectModelPaths(rootDir);
  paths.push(...chapterPaths);
  paths.push(...modelPaths);

  const records = [];
  for (const path of paths) {
    const absolute = resolve(rootDir, path);
    records.push({
      path,
      sha256: await fileSha256(absolute)
    });
  }
  return records;
}

async function collectModelReviewMetadata(rootDir, modelPaths) {
  const records = [];
  for (const path of modelPaths) {
    const absolute = resolve(rootDir, path);
    const raw = await readFile(absolute, "utf8");
    const modelMeta = parseJsonComment(raw, MODEL_META_RE);
    const cardMeta = parseJsonComment(raw, CARD_META_RE);
    if (modelMeta === null || typeof modelMeta.model_id !== "string") continue;
    records.push({
      path,
      model_id: modelMeta.model_id,
      model_review_status: typeof modelMeta.review_status === "string" ? modelMeta.review_status : null,
      card_review_status: cardMeta && typeof cardMeta.review_status === "string" ? cardMeta.review_status : null
    });
  }
  return records;
}

export function getManifestSchemaVersion() {
  return SCHEMA_VERSION;
}

export function getProcessingVersions() {
  return PROCESSING_VERSIONS;
}

export async function buildKnowledgeManifest(rootDir = process.cwd()) {
  const absoluteRoot = resolve(rootDir);

  const taxonomy = await loadTaxonomy(absoluteRoot);
  const sourcesPayload = await loadSources(absoluteRoot);
  const sources = sourcesPayload.sources;

  const routePayload = await readJsonFileOptional(resolve(absoluteRoot, KNOWN_PATHS.ROUTES));
  let routeCount = 0;
  if (routePayload !== null) {
    validateContract("problem-routes", routePayload);
    if (Array.isArray(routePayload.routes)) {
      routeCount = routePayload.routes.length;
    }
  }

  const chapterPaths = await collectChapterPaths(absoluteRoot);
  const modelPaths = await collectModelPaths(absoluteRoot);
  const publicFiles = await collectPublicFiles(absoluteRoot);
  const modelMetas = await collectModelReviewMetadata(absoluteRoot, modelPaths);
  const currentChapterCounts = buildChapterCounts(sources);
  const currentSourceCount = sources.length;

  const baselineSourceCount = taxonomy.chapters.reduce((total, chapter) => {
    return total + Number(chapter.baseline_source_count || 0);
  }, 0);
  const baselineChapterCounts = Object.create(null);
  for (const chapter of taxonomy.chapters) {
    baselineChapterCounts[chapter.id] = Number(chapter.baseline_source_count || 0);
  }

  const counts = {
    chapters: taxonomy.chapters.length,
    models: modelMetas.length,
    codex_cards: modelMetas.filter((entry) => entry.card_review_status === "ready").length,
    routes: routeCount
  };

  const sourceCounts = {
    source_status_counts: countBy(sources, (source) => source.processing_status),
    ocr_status_counts: countBy(sources, (source) => source.ocr_status),
    medical_review_status_counts: countBy(sources, (source) => source.medical_review_status),
    logic_review_status_counts: countBy(sources, (source) => source.logic_review_status)
  };

  const sortedSources = [...sources].sort((left, right) => left.source_id.localeCompare(right.source_id));
  const corpusHashInput = canonicalJsonBytes(sortedSources.map(normalizeSourceForCorpus));
  const corpus_version = `corpus-${sha256(corpusHashInput).slice(0, 16)}`;

  return {
    schema_version: SCHEMA_VERSION,
    knowledge_version: computeKnowledgeVersion(publicFiles),
    corpus_version,
    baseline_source_count: baselineSourceCount,
    current_source_count: currentSourceCount,
    baseline_chapter_counts,
    current_chapter_counts: currentChapterCounts,
    processing_versions: { ...PROCESSING_VERSIONS },
    counts,
    ...sourceCounts,
    public_files: publicFiles
  };
}

export async function validateKnowledgeManifest(manifest) {
  if (!manifest || typeof manifest !== "object" || Array.isArray(manifest)) {
    throw new TypeError("manifest must be an object");
  }
  if (manifest.schema_version !== SCHEMA_VERSION) {
    throw new Error(`manifest schema_version must be ${SCHEMA_VERSION}`);
  }
  if (typeof manifest.current_source_count !== "number" || manifest.current_source_count < 0) {
    throw new Error("manifest current_source_count must be a non-negative number");
  }
  if (typeof manifest.knowledge_version !== "string" || !/^[0-9a-f]{16}$/.test(manifest.knowledge_version)) {
    throw new Error("manifest knowledge_version must be 16 hex chars");
  }
  if (typeof manifest.corpus_version !== "string" || !/^corpus-[0-9a-f]{16}$/.test(manifest.corpus_version)) {
    throw new Error("manifest corpus_version must be corpus-xxxxxxxxxxxxxxxx");
  }
  if (!Array.isArray(manifest.public_files)) {
    throw new Error("manifest public_files must be an array");
  }
}

export async function writeKnowledgeManifest(rootDir = process.cwd()) {
  const manifest = await buildKnowledgeManifest(rootDir);
  const absolutePath = resolve(rootDir, KNOWN_PATHS.MANIFEST);
  await mkdir(dirname(absolutePath), { recursive: true });
  await writeFile(absolutePath, Buffer.concat([canonicalJsonBytes(manifest), Buffer.from([0x0a])]));
  return manifest;
}

export async function readKnowledgeSources(rootDir = process.cwd()) {
  return readJsonFileOptional(resolve(rootDir, KNOWN_PATHS.SOURCES));
}

export async function readProblemRoutes(rootDir = process.cwd()) {
  return readJsonFileOptional(resolve(rootDir, KNOWN_PATHS.ROUTES));
}

export { KNOWN_PATHS, countBy, collectModelReviewMetadata };
