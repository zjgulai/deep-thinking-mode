#!/usr/bin/env node
import { createHash } from "node:crypto";
import { resolve } from "node:path";
import process from "node:process";

import { inspectSiteArtifact } from "./check-public-artifact.mjs";

export async function hashPublicArtifact(siteDir = "site") {
  const root = resolve(siteDir);
  const snapshot = await inspectSiteArtifact({ siteDir: root });
  if (snapshot.errors.length > 0) {
    throw new Error(`PUBLIC_ARTIFACT_INVALID:\n${snapshot.errors.join("\n")}`);
  }
  const files = snapshot.files.sort((left, right) =>
    left.relativePath.localeCompare(right.relativePath, "en"));
  const hash = createHash("sha256");
  for (const { relativePath, bytes } of files) {
    hash.update(relativePath, "utf8");
    hash.update("\0");
    hash.update(bytes);
    hash.update("\0");
  }
  return { digest: hash.digest("hex"), fileCount: files.length };
}

async function main() {
  const siteDir = process.argv[2] ?? "site";
  const result = await hashPublicArtifact(siteDir);
  console.log(`${result.digest}  ${siteDir}  ${result.fileCount} files`);
}

if (import.meta.main) {
  main().catch((mainError) => {
    console.error(mainError.message);
    process.exitCode = 1;
  });
}
