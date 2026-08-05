#!/usr/bin/env node
/**
 * tools/check-public-artifact.mjs
 *
 * Orchestrates the site HTML checker and artifact-scope verifier.
 * Called as `npm run check:public` in CI and locally.
 *
 * Checks:
 *   1. site/ contains only index.html
 *   2. site/index.html is well-formed HTML (basic checks)
 *   3. No external resource references (no CDN, remote fonts, remote images)
 *   4. No inline scripts that fetch remote data
 */

import { readFile, readdir } from "node:fs/promises";

const SITE_DIR = "site";

async function checkSite() {
  const errors = [];

  // 1. site/ must contain only index.html
  let files;
  try {
    files = await readdir(SITE_DIR);
  } catch {
    errors.push("SITE_DIR_MISSING: site/ directory not found — run npm run build first");
    return errors;
  }

  const unexpected = files.filter((f) => f !== "index.html");
  if (unexpected.length > 0) {
    errors.push(`EXTRA_FILES: site/ contains unexpected files: ${unexpected.join(", ")}`);
  }

  if (!files.includes("index.html")) {
    errors.push("MISSING_INDEX: site/index.html not found");
    return errors;
  }

  const html = await readFile(`${SITE_DIR}/index.html`, "utf8");

  // 2. Basic HTML well-formedness
  if (!html.includes("<!DOCTYPE html>") && !html.includes("<!doctype html>")) {
    errors.push("NO_DOCTYPE: site/index.html missing DOCTYPE");
  }
  if (!html.includes("<html")) errors.push("NO_HTML_TAG: missing <html>");
  if (!html.includes("</html>")) errors.push("NO_CLOSE_HTML: missing </html>");

  // 3. No external resources
  const externalPatterns = [
    { re: /src=["']https?:\/\//gi,  label: "external src=" },
    { re: /href=["']https?:\/\/(?!github\.com)/gi, label: "external href= (non-GitHub)" },
    { re: /@import\s+url\(["']?https?:\/\//gi, label: "CSS @import external" },
    { re: /fonts\.googleapis\.com/gi, label: "Google Fonts" },
    { re: /cdn\.[a-z]/gi, label: "CDN reference" },
    { re: /unpkg\.com/gi, label: "unpkg CDN" },
    { re: /jsdelivr\.net/gi, label: "jsDelivr CDN" },
  ];

  for (const { re, label } of externalPatterns) {
    const matches = html.match(re);
    if (matches) {
      errors.push(`EXTERNAL_RESOURCE: ${label} found (${matches.length} occurrence${matches.length > 1 ? "s" : ""})`);
    }
  }

  // 4. No fetch/XHR in inline scripts
  const scriptBlocks = html.match(/<script[^>]*>([\s\S]*?)<\/script>/gi) || [];
  for (const block of scriptBlocks) {
    if (/\bfetch\s*\(/.test(block))   errors.push("INLINE_FETCH: fetch() in inline script");
    if (/\bnew\s+XMLHttpRequest/.test(block)) errors.push("INLINE_XHR: XMLHttpRequest in inline script");
    if (/\bWebSocket\b/.test(block))  errors.push("INLINE_WEBSOCKET: WebSocket in inline script");
  }

  return errors;
}

export { checkSite };

// CLI entry point
async function main() {
  const errors = await checkSite();
  if (errors.length === 0) {
    console.log("✓ public-artifact check passed");
    process.exit(0);
  } else {
    console.error(`✗ public-artifact check failed (${errors.length} error${errors.length > 1 ? "s" : ""}):`);
    for (const e of errors) console.error(`  ${e}`);
    process.exit(1);
  }
}

main();
