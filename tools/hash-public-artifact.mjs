#!/usr/bin/env node
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import process from "node:process";

import { collectSiteFiles } from "./check-public-artifact.mjs";

export async function hashPublicArtifact(siteDir = "site") {
  const root = resolve(siteDir);
  const files = (await collectSiteFiles(root)).sort();
  const hash = createHash("sha256");
  for (const relativePath of files) {
    hash.update(relativePath, "utf8");
    hash.update("\0");
    hash.update(await readFile(resolve(root, relativePath)));
    hash.update("\0");
  }
  return { digest: hash.digest("hex"), fileCount: files.length };
}

const siteDir = process.argv[2] ?? "site";
const result = await hashPublicArtifact(siteDir);
console.log(`${result.digest}  ${siteDir}  ${result.fileCount} files`);
