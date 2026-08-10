import { createHash } from "node:crypto";
import { lstatSync, readFileSync, realpathSync } from "node:fs";
import { posix, resolve, sep } from "node:path";

export const CHAPTER_PRESENTATION_SCHEMA_VERSION = "1.0.0";
export const CHAPTER_STYLE_SYSTEM = "oriental-paper-monument-v1";
export const CHAPTER_IDS = Object.freeze(
  Array.from({ length: 13 }, (_, index) => String(index).padStart(2, "0")),
);
export const PORTRAIT_NOTICE = "AI 艺术化演绎，非真实肖像";

const ROOT_MENTOR_KEYS = new Set(["schema_version", "mentors"]);
const MENTOR_KEYS = new Set([
  "chapter_id",
  "mentor_id",
  "name",
  "dynasty",
  "role",
  "teaching_persona",
  "curatorial_intro",
  "selection_rationale",
  "historical_boundary",
  "portrait_notice",
]);
const ROOT_THEME_KEYS = new Set(["schema_version", "style_system", "themes"]);
const THEME_KEYS = new Set([
  "chapter_id",
  "theme_key",
  "motif_key",
  "mece",
  "palette",
  "layout",
  "portrait",
]);
const MECE_KEYS = new Set(["space", "object", "pattern", "divider"]);
const PALETTE_KEYS = new Set(["light", "dark"]);
const COLOR_KEYS = new Set(["accent", "accent_deep", "wash", "line"]);
const LAYOUT_KEYS = new Set(["hero_side", "watermark_anchor", "density"]);
const PORTRAIT_KEYS = new Set([
  "asset_version",
  "provenance_id",
  "source_sha256",
  "card",
  "hero",
  "focus_x",
  "focus_y",
  "alt",
]);
const PORTRAIT_VARIANT_KEYS = new Set([
  "avif_path",
  "webp_path",
  "avif_sha256",
  "webp_sha256",
  "width",
  "height",
]);
const PORTRAIT_VARIANTS = Object.freeze({
  card: Object.freeze({ width: 480, height: 600 }),
  hero: Object.freeze({ width: 960, height: 1200 }),
});

const HERO_SIDES = new Set(["left", "right"]);
const WATERMARK_ANCHORS = new Set([
  "top-left",
  "top-right",
  "bottom-left",
  "bottom-right",
]);
const DENSITIES = new Set(["quiet", "balanced"]);
const SAFE_KEY_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const SAFE_ASSET_PATH_RE = /^[a-z0-9][a-z0-9./-]*$/;
const HEX_COLOR_RE = /^#[0-9A-F]{6}$/;
const SHA256_RE = /^[0-9a-f]{64}$/;
const UNSAFE_TEXT_RE = /[<>]|\b(?:https?:|data:|javascript:|vbscript:|file:)|\/\/|url\s*\(|(?:style|class|on[a-z]+)\s*=/iu;
const VALID_PRESENTATIONS = new WeakSet();

function contractError(path, message) {
  return new Error(`CHAPTER_PRESENTATION_INVALID ${path}: ${message}`);
}

function isPlainObject(value) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function assertPlainObject(value, path) {
  if (!isPlainObject(value)) throw contractError(path, "expected plain object");
}

function assertExactKeys(value, allowed, path) {
  assertPlainObject(value, path);
  const actual = Object.keys(value).sort();
  const expected = [...allowed].sort();
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) {
    throw contractError(path, `expected exact keys ${expected.join(",")}`);
  }
}

function assertSafeText(value, path, { minLength = 1 } = {}) {
  if (typeof value !== "string" || value.trim() !== value || value.length < minLength) {
    throw contractError(path, "expected non-empty trimmed string");
  }
  if (/\p{Cc}/u.test(value)) throw contractError(path, "control characters are forbidden");
  if (UNSAFE_TEXT_RE.test(value)) throw contractError(path, "external URL or HTML/CSS syntax is forbidden");
}

function assertSafeKey(value, path) {
  if (typeof value !== "string" || !SAFE_KEY_RE.test(value)) {
    throw contractError(path, "expected lowercase kebab-case key");
  }
}

function assertInteger(value, path, minimum, maximum) {
  if (!Number.isInteger(value) || value < minimum || value > maximum) {
    throw contractError(path, `expected integer in [${minimum}, ${maximum}]`);
  }
}

function assertSchemaVersion(value, path) {
  if (value !== CHAPTER_PRESENTATION_SCHEMA_VERSION) {
    throw contractError(path, `expected ${CHAPTER_PRESENTATION_SCHEMA_VERSION}`);
  }
}

function assertUnique(values, path) {
  const seen = new Set();
  for (const value of values) {
    if (seen.has(value)) throw contractError(path, `duplicate value ${value}`);
    seen.add(value);
  }
}

function assertTaxonomy(taxonomy) {
  assertPlainObject(taxonomy, "taxonomy");
  if (!Array.isArray(taxonomy.chapters) || taxonomy.chapters.length !== CHAPTER_IDS.length) {
    throw contractError("taxonomy.chapters", "expected exactly 13 chapters");
  }
  for (const [index, expectedId] of CHAPTER_IDS.entries()) {
    const chapter = taxonomy.chapters[index];
    assertPlainObject(chapter, `taxonomy.chapters[${index}]`);
    if (chapter.id !== expectedId) {
      throw contractError(`taxonomy.chapters[${index}].id`, `expected ${expectedId}`);
    }
    if (chapter.order !== index) {
      throw contractError(`taxonomy.chapters[${index}].order`, `expected ${index}`);
    }
    assertSafeKey(chapter.slug, `taxonomy.chapters[${index}].slug`);
    assertSafeText(chapter.title, `taxonomy.chapters[${index}].title`);
  }
}

function assertChapterOrder(records, taxonomy, path) {
  if (!Array.isArray(records) || records.length !== CHAPTER_IDS.length) {
    throw contractError(path, "expected exactly 13 records");
  }
  for (const [index, chapter] of taxonomy.chapters.entries()) {
    assertPlainObject(records[index], `${path}[${index}]`);
    if (records[index].chapter_id !== chapter.id) {
      throw contractError(`${path}[${index}].chapter_id`, `expected ${chapter.id}`);
    }
  }
}

function validateMentors(taxonomy, document) {
  assertExactKeys(document, ROOT_MENTOR_KEYS, "mentors");
  assertSchemaVersion(document.schema_version, "mentors.schema_version");
  assertChapterOrder(document.mentors, taxonomy, "mentors.mentors");

  for (const [index, mentor] of document.mentors.entries()) {
    const path = `mentors.mentors[${index}]`;
    assertExactKeys(mentor, MENTOR_KEYS, path);
    assertSafeKey(mentor.mentor_id, `${path}.mentor_id`);
    for (const key of [
      "name",
      "dynasty",
      "role",
      "teaching_persona",
      "curatorial_intro",
      "selection_rationale",
      "historical_boundary",
      "portrait_notice",
    ]) {
      assertSafeText(mentor[key], `${path}.${key}`);
    }
    if (mentor.portrait_notice !== PORTRAIT_NOTICE) {
      throw contractError(`${path}.portrait_notice`, `expected ${PORTRAIT_NOTICE}`);
    }
  }

  assertUnique(document.mentors.map((mentor) => mentor.mentor_id), "mentors.mentor_id");
  assertUnique(document.mentors.map((mentor) => mentor.name), "mentors.name");
}

function assertColorSet(value, path) {
  assertExactKeys(value, COLOR_KEYS, path);
  for (const key of COLOR_KEYS) {
    if (typeof value[key] !== "string" || !HEX_COLOR_RE.test(value[key])) {
      throw contractError(`${path}.${key}`, "expected uppercase six-digit hex color");
    }
  }
}

function assertAssetPath(value, path, chapter, extension) {
  if (
    typeof value !== "string" ||
    !SAFE_ASSET_PATH_RE.test(value) ||
    posix.isAbsolute(value) ||
    posix.normalize(value) !== value ||
    value.split("/").some((segment) => segment === "." || segment === "..")
  ) {
    throw contractError(path, "expected safe ASCII relative asset path");
  }
  const requiredPrefix = `chapters/ch${chapter.id}-${chapter.slug}/`;
  if (!value.startsWith(requiredPrefix)) {
    throw contractError(path, `expected path under ${requiredPrefix}`);
  }
  if (posix.extname(value) !== extension) {
    throw contractError(path, `expected ${extension} asset`);
  }
}

function assertOptionalHash(value, path) {
  if (value !== null && (typeof value !== "string" || !SHA256_RE.test(value))) {
    throw contractError(path, "expected null or lowercase SHA-256");
  }
}

function assertHash(value, path) {
  if (typeof value !== "string" || !SHA256_RE.test(value)) {
    throw contractError(path, "expected lowercase SHA-256");
  }
}

function validatePortraitVariant({ value, path, chapter, assetVersion, variant }) {
  assertExactKeys(value, PORTRAIT_VARIANT_KEYS, path);
  assertAssetPath(value.avif_path, `${path}.avif_path`, chapter, ".avif");
  assertAssetPath(value.webp_path, `${path}.webp_path`, chapter, ".webp");
  const requiredDirectory = `/${assetVersion}/`;
  if (!value.avif_path.includes(requiredDirectory) || !value.webp_path.includes(requiredDirectory)) {
    throw contractError(path, `expected versioned path containing ${requiredDirectory}`);
  }
  if (!value.avif_path.endsWith(`/portrait-${variant}.avif`)) {
    throw contractError(`${path}.avif_path`, `expected portrait-${variant}.avif`);
  }
  if (!value.webp_path.endsWith(`/portrait-${variant}.webp`)) {
    throw contractError(`${path}.webp_path`, `expected portrait-${variant}.webp`);
  }
  assertOptionalHash(value.avif_sha256, `${path}.avif_sha256`);
  assertOptionalHash(value.webp_sha256, `${path}.webp_sha256`);
  assertInteger(value.width, `${path}.width`, 1, 8192);
  assertInteger(value.height, `${path}.height`, 1, 8192);
  const expected = PORTRAIT_VARIANTS[variant];
  if (value.width !== expected.width || value.height !== expected.height) {
    throw contractError(path, `expected ${expected.width}x${expected.height} ${variant} asset`);
  }
  if (value.width * 5 !== value.height * 4) {
    throw contractError(path, "portrait asset must use a 4:5 aspect ratio");
  }
}

function validateThemes(taxonomy, mentorDocument, document) {
  assertExactKeys(document, ROOT_THEME_KEYS, "themes");
  assertSchemaVersion(document.schema_version, "themes.schema_version");
  if (document.style_system !== CHAPTER_STYLE_SYSTEM) {
    throw contractError("themes.style_system", `expected ${CHAPTER_STYLE_SYSTEM}`);
  }
  assertChapterOrder(document.themes, taxonomy, "themes.themes");

  for (const [index, theme] of document.themes.entries()) {
    const path = `themes.themes[${index}]`;
    const chapter = taxonomy.chapters[index];
    const mentor = mentorDocument.mentors[index];
    assertExactKeys(theme, THEME_KEYS, path);
    assertSafeKey(theme.theme_key, `${path}.theme_key`);
    assertSafeKey(theme.motif_key, `${path}.motif_key`);

    assertExactKeys(theme.mece, MECE_KEYS, `${path}.mece`);
    for (const key of MECE_KEYS) assertSafeText(theme.mece[key], `${path}.mece.${key}`);

    assertExactKeys(theme.palette, PALETTE_KEYS, `${path}.palette`);
    assertColorSet(theme.palette.light, `${path}.palette.light`);
    assertColorSet(theme.palette.dark, `${path}.palette.dark`);

    assertExactKeys(theme.layout, LAYOUT_KEYS, `${path}.layout`);
    if (!HERO_SIDES.has(theme.layout.hero_side)) {
      throw contractError(`${path}.layout.hero_side`, "unsupported hero side");
    }
    if (!WATERMARK_ANCHORS.has(theme.layout.watermark_anchor)) {
      throw contractError(`${path}.layout.watermark_anchor`, "unsupported watermark anchor");
    }
    if (!DENSITIES.has(theme.layout.density)) {
      throw contractError(`${path}.layout.density`, "unsupported ornament density");
    }

    assertExactKeys(theme.portrait, PORTRAIT_KEYS, `${path}.portrait`);
    assertSafeKey(theme.portrait.asset_version, `${path}.portrait.asset_version`);
    assertSafeKey(theme.portrait.provenance_id, `${path}.portrait.provenance_id`);
    assertHash(theme.portrait.source_sha256, `${path}.portrait.source_sha256`);
    for (const variant of Object.keys(PORTRAIT_VARIANTS)) {
      validatePortraitVariant({
        value: theme.portrait[variant],
        path: `${path}.portrait.${variant}`,
        chapter,
        assetVersion: theme.portrait.asset_version,
        variant,
      });
    }
    assertInteger(theme.portrait.focus_x, `${path}.portrait.focus_x`, 0, 100);
    assertInteger(theme.portrait.focus_y, `${path}.portrait.focus_y`, 0, 100);
    assertSafeText(theme.portrait.alt, `${path}.portrait.alt`);
    if (!theme.portrait.alt.includes(mentor.name)) {
      throw contractError(`${path}.portrait.alt`, `must identify mentor ${mentor.name}`);
    }
  }

  assertUnique(document.themes.map((theme) => theme.theme_key), "themes.theme_key");
  assertUnique(document.themes.map((theme) => theme.motif_key), "themes.motif_key");
  for (const key of MECE_KEYS) {
    assertUnique(document.themes.map((theme) => theme.mece[key]), `themes.mece.${key}`);
  }
  assertUnique(
    document.themes.flatMap((theme) => Object.keys(PORTRAIT_VARIANTS).flatMap((variant) => {
      return [theme.portrait[variant].avif_path, theme.portrait[variant].webp_path];
    })),
    "themes.portrait.paths",
  );
  assertUnique(document.themes.map((theme) => theme.portrait.provenance_id), "themes.portrait.provenance_id");
  assertUnique(document.themes.map((theme) => theme.portrait.source_sha256), "themes.portrait.source_sha256");
}

function deepFreeze(value) {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}

export function validateChapterPresentation({ taxonomy, mentors, themes }) {
  assertTaxonomy(taxonomy);
  validateMentors(taxonomy, mentors);
  validateThemes(taxonomy, mentors, themes);

  const presentation = deepFreeze({
    schema_version: CHAPTER_PRESENTATION_SCHEMA_VERSION,
    style_system: CHAPTER_STYLE_SYSTEM,
    chapters: taxonomy.chapters.map((chapter, index) => ({
      chapter: {
        id: chapter.id,
        order: chapter.order,
        slug: chapter.slug,
        title: chapter.title,
      },
      mentor: structuredClone(mentors.mentors[index]),
      theme: structuredClone(themes.themes[index]),
    })),
  });
  VALID_PRESENTATIONS.add(presentation);
  return presentation;
}

const ANCHOR_POSITIONS = Object.freeze({
  "top-left": ["0%", "0%"],
  "top-right": ["100%", "0%"],
  "bottom-left": ["0%", "100%"],
  "bottom-right": ["100%", "100%"],
});

const DENSITY_OPACITY = Object.freeze({ quiet: "0.10", balanced: "0.16" });

function compileLightRule(entry) {
  const { chapter, theme } = entry;
  const [watermarkX, watermarkY] = ANCHOR_POSITIONS[theme.layout.watermark_anchor];
  const copyOrder = theme.layout.hero_side === "right" ? 1 : 2;
  const mediaOrder = theme.layout.hero_side === "right" ? 2 : 1;
  const copyColumn = theme.layout.hero_side === "right" ? 1 : 2;
  const mediaColumn = theme.layout.hero_side === "right" ? 2 : 1;
  return `:where([data-chapter="${chapter.id}"]) {\n` +
    `  --chapter-accent: ${theme.palette.light.accent};\n` +
    `  --chapter-accent-deep: ${theme.palette.light.accent_deep};\n` +
    `  --chapter-wash: ${theme.palette.light.wash};\n` +
    `  --chapter-line: ${theme.palette.light.line};\n` +
    `  --chapter-focus-x: ${theme.portrait.focus_x}%;\n` +
    `  --chapter-focus-y: ${theme.portrait.focus_y}%;\n` +
    `  --chapter-copy-order: ${copyOrder};\n` +
    `  --chapter-media-order: ${mediaOrder};\n` +
    `  --chapter-copy-column: ${copyColumn};\n` +
    `  --chapter-media-column: ${mediaColumn};\n` +
    `  --chapter-watermark-x: ${watermarkX};\n` +
    `  --chapter-watermark-y: ${watermarkY};\n` +
    `  --chapter-ornament-opacity: ${DENSITY_OPACITY[theme.layout.density]};\n` +
    `}`;
}

export function compileChapterThemesCss(input) {
  const presentation = VALID_PRESENTATIONS.has(input)
    ? input
    : validateChapterPresentation(input);
  const light = presentation.chapters.map(compileLightRule).join("\n\n");
  return `/* Generated from knowledge/chapter-themes.json. Do not edit by hand. */\n${light}\n`;
}

function readUint24LE(bytes, offset) {
  return bytes[offset] | (bytes[offset + 1] << 8) | (bytes[offset + 2] << 16);
}

function parseWebpDimensions(bytes, path) {
  if (
    bytes.length < 30 ||
    bytes.toString("ascii", 0, 4) !== "RIFF" ||
    bytes.toString("ascii", 8, 12) !== "WEBP"
  ) {
    throw contractError(path, "invalid WebP file magic");
  }
  const chunk = bytes.toString("ascii", 12, 16);
  if (chunk === "VP8X") {
    return {
      width: readUint24LE(bytes, 24) + 1,
      height: readUint24LE(bytes, 27) + 1,
    };
  }
  if (chunk === "VP8L" && bytes.length >= 25 && bytes[20] === 0x2f) {
    const b0 = bytes[21];
    const b1 = bytes[22];
    const b2 = bytes[23];
    const b3 = bytes[24];
    return {
      width: 1 + b0 + ((b1 & 0x3f) << 8),
      height: 1 + (b1 >> 6) + (b2 << 2) + ((b3 & 0x0f) << 10),
    };
  }
  if (
    chunk === "VP8 " &&
    bytes.length >= 30 &&
    bytes[23] === 0x9d &&
    bytes[24] === 0x01 &&
    bytes[25] === 0x2a
  ) {
    return {
      width: bytes.readUInt16LE(26) & 0x3fff,
      height: bytes.readUInt16LE(28) & 0x3fff,
    };
  }
  throw contractError(path, "unsupported or truncated WebP payload");
}

function parseAvifDimensions(bytes, path) {
  if (bytes.length < 32 || bytes.toString("ascii", 4, 8) !== "ftyp") {
    throw contractError(path, "invalid AVIF file magic");
  }
  const ftypSize = bytes.readUInt32BE(0);
  if (ftypSize < 16 || ftypSize > bytes.length) {
    throw contractError(path, "invalid AVIF ftyp box");
  }
  const brands = [];
  brands.push(bytes.toString("ascii", 8, 12));
  for (let offset = 16; offset + 4 <= ftypSize; offset += 4) {
    brands.push(bytes.toString("ascii", offset, offset + 4));
  }
  if (!brands.some((brand) => brand === "avif" || brand === "avis")) {
    throw contractError(path, "AVIF brand is missing");
  }
  const marker = Buffer.from("ispe", "ascii");
  const dimensions = [];
  let offset = ftypSize;
  while ((offset = bytes.indexOf(marker, offset)) !== -1) {
    if (offset >= 4 && offset + 16 <= bytes.length && bytes.readUInt32BE(offset - 4) >= 20) {
      const width = bytes.readUInt32BE(offset + 8);
      const height = bytes.readUInt32BE(offset + 12);
      if (width > 0 && height > 0) dimensions.push({ width, height });
    }
    offset += marker.length;
  }
  if (dimensions.length === 0) {
    throw contractError(path, "AVIF ispe dimensions are missing");
  }
  return dimensions.sort((a, b) => (b.width * b.height) - (a.width * a.height))[0];
}

function readSafeAsset(assetsRoot, relativePath) {
  const canonicalRoot = realpathSync(assetsRoot);
  const segments = relativePath.split("/");
  let current = canonicalRoot;
  for (const [index, segment] of segments.entries()) {
    current = resolve(current, segment);
    const stat = lstatSync(current);
    if (stat.isSymbolicLink()) throw contractError(relativePath, "symbolic links are forbidden");
    if (index < segments.length - 1 && !stat.isDirectory()) {
      throw contractError(relativePath, "asset ancestor must be a directory");
    }
    if (index === segments.length - 1 && !stat.isFile()) {
      throw contractError(relativePath, "asset must be a regular file");
    }
  }
  const canonicalFile = realpathSync(current);
  if (canonicalFile !== canonicalRoot && !canonicalFile.startsWith(`${canonicalRoot}${sep}`)) {
    throw contractError(relativePath, "asset escapes assets root");
  }
  return readFileSync(canonicalFile);
}

function verifyOneAsset({ assetsRoot, relativePath, expectedHash, expectedWidth, expectedHeight, type, requirePinnedHashes }) {
  if (requirePinnedHashes && expectedHash === null) {
    throw contractError(relativePath, "asset SHA-256 is not pinned");
  }
  const bytes = readSafeAsset(assetsRoot, relativePath);
  const actualHash = createHash("sha256").update(bytes).digest("hex");
  if (expectedHash !== null && actualHash !== expectedHash) {
    throw contractError(relativePath, "asset SHA-256 mismatch");
  }
  const dimensions = type === "avif"
    ? parseAvifDimensions(bytes, relativePath)
    : parseWebpDimensions(bytes, relativePath);
  if (dimensions.width !== expectedWidth || dimensions.height !== expectedHeight) {
    throw contractError(
      relativePath,
      `expected ${expectedWidth}x${expectedHeight}, got ${dimensions.width}x${dimensions.height}`,
    );
  }
  return { path: relativePath, sha256: actualHash, bytes: bytes.length, ...dimensions };
}

export function verifyChapterPortraitAssets({
  assetsRoot,
  presentation,
  requirePinnedHashes = true,
  chapterIds = null,
}) {
  if (typeof assetsRoot !== "string" || !assetsRoot) {
    throw new TypeError("assetsRoot must be a non-empty string");
  }
  if (!VALID_PRESENTATIONS.has(presentation)) {
    throw new TypeError("presentation must come from validateChapterPresentation()");
  }
  let selected = presentation.chapters;
  if (chapterIds !== null) {
    if (!Array.isArray(chapterIds) || chapterIds.length === 0) {
      throw new TypeError("chapterIds must be null or a non-empty array");
    }
    assertUnique(chapterIds, "chapterIds");
    const requested = new Set(chapterIds);
    if (chapterIds.some((id) => !CHAPTER_IDS.includes(id))) {
      throw contractError("chapterIds", "unknown chapter id");
    }
    selected = presentation.chapters.filter((entry) => requested.has(entry.chapter.id));
  }
  const results = [];
  for (const entry of selected) {
    const portrait = entry.theme.portrait;
    const verified = { chapter_id: entry.chapter.id };
    for (const variant of Object.keys(PORTRAIT_VARIANTS)) {
      const asset = portrait[variant];
      verified[variant] = {
        avif: verifyOneAsset({
          assetsRoot,
          relativePath: asset.avif_path,
          expectedHash: asset.avif_sha256,
          expectedWidth: asset.width,
          expectedHeight: asset.height,
          type: "avif",
          requirePinnedHashes,
        }),
        webp: verifyOneAsset({
          assetsRoot,
          relativePath: asset.webp_path,
          expectedHash: asset.webp_sha256,
          expectedWidth: asset.width,
          expectedHeight: asset.height,
          type: "webp",
          requirePinnedHashes,
        }),
      };
    }
    results.push(verified);
  }
  return deepFreeze(results);
}
