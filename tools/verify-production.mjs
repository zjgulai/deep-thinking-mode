#!/usr/bin/env node
/**
 * tools/verify-production.mjs
 *
 * Resolve the successful deployment for the activated root and compare
 * the decoded response bytes with site/index.html.
 *
 * Usage:
 *   node tools/verify-production.mjs [--url <pages-url>]
 */

import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { get as httpsGet } from "node:https";
import { get as httpGet } from "node:http";

const PAGES_URL = process.env.PAGES_URL ||
  "https://zjgulai.github.io/deep-thinking-mode/";

function sha256(buf) {
  return createHash("sha256").update(buf).digest("hex");
}

/**
 * Fetch URL, follow redirects, return { body: Buffer, finalUrl, status, contentType }.
 */
async function fetchUrl(url, maxRedirects = 5) {
  return new Promise((resolve, reject) => {
    const isHttps = url.startsWith("https://");
    const get = isHttps ? httpsGet : httpGet;

    const req = get(url, { timeout: 15000 }, (res) => {
      const { statusCode, headers } = res;

      if (statusCode >= 300 && statusCode < 400 && headers.location) {
        if (maxRedirects <= 0) {
          reject(new Error("Too many redirects"));
          return;
        }
        const next = new URL(headers.location, url).href;
        resolve(fetchUrl(next, maxRedirects - 1));
        res.resume();
        return;
      }

      const chunks = [];
      res.on("data", (c) => chunks.push(c));
      res.on("end", () =>
        resolve({
          body: Buffer.concat(chunks),
          finalUrl: url,
          status: statusCode,
          contentType: headers["content-type"] || "",
        })
      );
      res.on("error", reject);
    });

    req.on("timeout", () => {
      req.destroy();
      reject(new Error(`Request timed out: ${url}`));
    });
    req.on("error", reject);
  });
}

async function main() {
  const args = process.argv.slice(2);
  let targetUrl = PAGES_URL;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--url" && args[i + 1]) targetUrl = args[++i];
  }

  console.log(`Verifying production: ${targetUrl}`);

  let localHtml;
  try {
    localHtml = await readFile("site/index.html");
  } catch {
    console.error("✗ site/index.html not found. Run npm run build first.");
    process.exit(1);
  }

  const localDigest = sha256(localHtml);
  const localLen = localHtml.length;
  console.log(`  local  SHA-256: ${localDigest}`);
  console.log(`  local  length:  ${localLen}`);

  let result;
  try {
    result = await fetchUrl(targetUrl);
  } catch (err) {
    console.error(`✗ Fetch failed: ${err.message}`);
    process.exit(1);
  }

  const { body, finalUrl, status, contentType } = result;

  console.log(`  remote finalUrl: ${finalUrl}`);
  console.log(`  remote status:   ${status}`);
  console.log(`  remote type:     ${contentType}`);

  if (status !== 200) {
    console.error(`✗ HTTP ${status} — expected 200`);
    process.exit(1);
  }

  if (!contentType.includes("text/html")) {
    console.error(`✗ Unexpected content type: ${contentType}`);
    process.exit(1);
  }

  const remoteDigest = sha256(body);
  const remoteLen = body.length;
  console.log(`  remote SHA-256: ${remoteDigest}`);
  console.log(`  remote length:  ${remoteLen}`);

  if (localDigest === remoteDigest) {
    console.log("✓ Production byte-for-byte match confirmed.");
    process.exit(0);
  }

  // Find first differing byte
  let firstDiff = -1;
  const minLen = Math.min(localLen, remoteLen);
  for (let i = 0; i < minLen; i++) {
    if (localHtml[i] !== body[i]) { firstDiff = i; break; }
  }
  if (firstDiff === -1 && localLen !== remoteLen) firstDiff = minLen;

  console.error("✗ Production mismatch:");
  console.error(`  local  SHA-256: ${localDigest}  (${localLen} bytes)`);
  console.error(`  remote SHA-256: ${remoteDigest}  (${remoteLen} bytes)`);
  if (firstDiff >= 0) {
    console.error(`  first differing byte offset: ${firstDiff}`);
  }
  process.exit(1);
}

main();
