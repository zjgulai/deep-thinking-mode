#!/usr/bin/env node
import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  findPublicModelResidue,
  sanitizeV2Model,
  sanitizeV3Model,
} from "./lib/public-model-sanitizer.mjs";

const root = fileURLToPath(new URL("..", import.meta.url));
const write = process.argv.includes("--write");

function loadDirectory(relative) {
  const directory = join(root, relative);
  return readdirSync(directory).filter((file) => file.endsWith(".json")).sort().map((file) => {
    const path = join(directory, file);
    return { file, path, document: JSON.parse(readFileSync(path, "utf8")) };
  });
}

const v3 = loadDirectory(join("knowledge", "models-v3"));
const v3ById = new Map(v3.map((entry) => [entry.document.id, entry.document]));
const v2 = loadDirectory(join("knowledge", "models-v2"));
let changed = 0;

for (const entry of v3) {
  const before = JSON.stringify(entry.document);
  sanitizeV3Model(entry.document);
  if (JSON.stringify(entry.document) !== before) {
    changed += 1;
    if (write) writeFileSync(entry.path, `${JSON.stringify(entry.document, null, 2)}\n`);
  }
}
for (const entry of v2) {
  const before = JSON.stringify(entry.document);
  sanitizeV2Model(entry.document, v3ById.get(entry.document.id));
  if (JSON.stringify(entry.document) !== before) {
    changed += 1;
    if (write) writeFileSync(entry.path, `${JSON.stringify(entry.document, null, 2)}\n`);
  }
}

const findings = [];
for (const entry of [...v2, ...v3]) {
  for (const path of findPublicModelResidue(entry.document)) findings.push(`${entry.file}:${path}`);
}

if (!write && changed > 0) {
  process.stderr.write(`公开模型仍有 ${changed} 个文件需要清理；运行 npm run sanitize:models 后复核。\n`);
  process.exitCode = 1;
} else if (findings.length > 0) {
  process.stderr.write(`公开模型仍有 ${findings.length} 个摄取残留：\n${findings.slice(0, 20).join("\n")}\n`);
  process.exitCode = 1;
} else {
  process.stdout.write(`✓ 公开模型摄取残留为 0${write ? `；更新 ${changed} 个文件` : ""}\n`);
}
