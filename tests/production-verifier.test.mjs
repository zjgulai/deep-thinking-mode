/**
 * tests/production-verifier.test.mjs
 *
 * Tests for tools/verify-production.mjs behavior using local HTTP fixtures.
 * Tests the byte comparison logic directly without importing the CLI entry point.
 */

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { verifyProductionSite } from "../tools/verify-production.mjs";
import { META_CONTENT_SECURITY_POLICY } from "../tools/lib/site-security.mjs";

const VERIFIER = fileURLToPath(
  new URL("../tools/verify-production.mjs", import.meta.url),
);

function sha256(buf) {
  return createHash("sha256").update(buf).digest("hex");
}

// ─── local HTTP server helper ─────────────────────────────────────────────────
function startServer(handler) {
  return new Promise((resolve) => {
    const server = createServer(handler);
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      resolve({ server, port, url: `http://127.0.0.1:${port}/` });
    });
  });
}

function stopServer(server) {
  return new Promise((resolve) => server.close(resolve));
}

function runVerifier(cwd, url) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [VERIFIER, "--url", url], {
      cwd,
      env: { ...process.env, NO_COLOR: "1" },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.once("error", reject);
    child.once("close", (code, signal) => {
      resolve({ code, signal, stdout, stderr });
    });
  });
}

// ─── inline fetch helper (mirrors verify-production.mjs logic) ──────────────
function fetchUrl(url, maxRedirects = 5) {
  return new Promise((resolve, reject) => {
    const { get } = require("http");
    const req = get(url, { timeout: 5000 }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        if (maxRedirects <= 0) { reject(new Error("Too many redirects")); return; }
        resolve(fetchUrl(new URL(res.headers.location, url).href, maxRedirects - 1));
        res.resume();
        return;
      }
      const chunks = [];
      res.on("data", (c) => chunks.push(c));
      res.on("end", () => resolve({
        body: Buffer.concat(chunks),
        finalUrl: url,
        status: res.statusCode,
        contentType: res.headers["content-type"] || "",
      }));
      res.on("error", reject);
    });
    req.on("error", reject);
    req.on("timeout", () => { req.destroy(); reject(new Error("timeout")); });
  });
}

// Use import for http to stay ESM-compatible
import { get as httpGet } from "node:http";
function fetchUrlEsm(url, maxRedirects = 5) {
  return new Promise((resolve, reject) => {
    const req = httpGet(url, { timeout: 5000 }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        if (maxRedirects <= 0) { reject(new Error("Too many redirects")); return; }
        const next = new URL(res.headers.location, url).href;
        resolve(fetchUrlEsm(next, maxRedirects - 1));
        res.resume();
        return;
      }
      const chunks = [];
      res.on("data", (c) => chunks.push(c));
      res.on("end", () => resolve({
        body: Buffer.concat(chunks),
        finalUrl: url,
        status: res.statusCode,
        contentType: res.headers["content-type"] || "",
      }));
      res.on("error", reject);
    });
    req.on("error", reject);
    req.on("timeout", () => { req.destroy(); reject(new Error("timeout")); });
  });
}

// ─── tests ────────────────────────────────────────────────────────────────────
const LOCAL_HTML = Buffer.from("<!DOCTYPE html><html><body>hello</body></html>", "utf8");
const LOCAL_DIGEST = sha256(LOCAL_HTML);

const RELEASE_FIXTURE = {
  "index.html": Buffer.from(
    `<!doctype html><html><head><meta http-equiv="Content-Security-Policy" content="${META_CONTENT_SECURITY_POLICY}"></head><body><a href="combinations/">combinations</a></body></html>`,
  ),
  "combinations/index.html": Buffer.from(
    `<!doctype html><html><head><meta http-equiv="Content-Security-Policy" content="${META_CONTENT_SECURITY_POLICY}"></head><body><a href="cot-critic-chain.html#phases">detail</a></body></html>`,
  ),
  "combinations/cot-critic-chain.html": Buffer.from(
    `<!doctype html><html><head><meta http-equiv="Content-Security-Policy" content="${META_CONTENT_SECURITY_POLICY}"><script type="module" src="../assets/router-controller.mjs"></script></head><body><main id="phases">phases</main></body></html>`,
  ),
  "assets/router-engine.mjs": await readFile(
    new URL("../tools/site-assets/router-engine.mjs", import.meta.url),
  ),
  "assets/router-controller.mjs": await readFile(
    new URL("../tools/site-assets/router-controller.mjs", import.meta.url),
  ),
};

function fixtureContentType(relativePath) {
  return relativePath.endsWith(".html")
    ? "text/html; charset=utf-8"
    : "application/javascript; charset=utf-8";
}

async function withReleaseFixture(fault, assertion) {
  const rootDir = await mkdtemp(join(tmpdir(), "production-release-fixture-"));
  const siteDir = join(rootDir, "site");
  for (const [relativePath, body] of Object.entries(RELEASE_FIXTURE)) {
    const absolutePath = join(siteDir, relativePath);
    await mkdir(join(absolutePath, ".."), { recursive: true });
    await writeFile(absolutePath, body);
  }

  const { server, url } = await startServer((req, res) => {
    const requestedPath = decodeURIComponent(new URL(req.url, "http://fixture.test").pathname);
    const redirectedPrefix = "/redirected/";
    const isRedirectTarget = requestedPath.startsWith(redirectedPrefix);
    const relativePath = isRedirectTarget
      ? requestedPath.slice(redirectedPrefix.length)
      : requestedPath === "/"
        ? "index.html"
        : requestedPath.slice(1);
    const localBody = RELEASE_FIXTURE[relativePath];

    if (relativePath === fault.relativePath && !isRedirectTarget) {
      if (fault.kind === "404") {
        res.writeHead(404, { "content-type": "text/plain" });
        res.end("Not Found");
        return;
      }
      if (fault.kind === "redirect") {
        res.writeHead(302, { location: `${redirectedPrefix}${relativePath}` });
        res.end();
        return;
      }
    }

    if (!localBody) {
      res.writeHead(404, { "content-type": "text/plain" });
      res.end("Not Found");
      return;
    }

    const responseBody = relativePath === fault.relativePath && fault.kind === "bytes"
      ? Buffer.concat([localBody, Buffer.from("changed")])
      : localBody;
    const contentType = relativePath === fault.relativePath && fault.kind === "content-type"
      ? "text/plain"
      : relativePath === fault.relativePath && fault.kind === "octet-stream"
        ? "application/octet-stream"
        : fixtureContentType(relativePath);
    res.writeHead(200, { "content-type": contentType });
    res.end(responseBody);
  });

  try {
    await assertion(await runVerifier(rootDir, url));
  } finally {
    await stopServer(server);
    await rm(rootDir, { recursive: true, force: true });
  }
}

function verifierFailureTest(name, relativePath, kind, expectedPattern) {
  test(name, async () => {
    await withReleaseFixture(
      { relativePath, kind },
      ({ code, stdout, stderr }) => {
        assert.equal(code, 1, `${stdout}\n${stderr}`);
        assert.match(stderr, expectedPattern, `${stdout}\n${stderr}`);
      },
    );
  });
}

for (const [label, relativePath] of [
  ["combination detail", "combinations/cot-critic-chain.html"],
  ["local module", "assets/router-controller.mjs"],
]) {
  const escapedPath = relativePath.replaceAll(".", "\\.");
  verifierFailureTest(
    `production verifier — ${label} 404 exits 1`,
    relativePath,
    "404",
    new RegExp(`${escapedPath}: HTTP 404`),
  );
  verifierFailureTest(
    `production verifier — ${label} wrong Content-Type exits 1`,
    relativePath,
    "content-type",
    new RegExp(`${escapedPath}: unexpected content type text/plain`),
  );
  verifierFailureTest(
    `production verifier — ${label} redirect exits 1`,
    relativePath,
    "redirect",
    new RegExp(`${escapedPath}: unexpected redirect`),
  );
  verifierFailureTest(
    `production verifier — ${label} byte mismatch exits 1`,
    relativePath,
    "bytes",
    new RegExp(`${escapedPath}: byte mismatch at offset`),
  );
}

verifierFailureTest(
  "production verifier — executable module rejects application/octet-stream",
  "assets/router-controller.mjs",
  "octet-stream",
  /assets\/router-controller\.mjs: unexpected content type application\/octet-stream/,
);

await test("production verifier — exact match passes", async () => {
  const { server, url } = await startServer((req, res) => {
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    res.end(LOCAL_HTML);
  });
  try {
    const result = await fetchUrlEsm(url);
    assert.equal(result.status, 200);
    assert.ok(result.contentType.includes("text/html"));
    assert.equal(sha256(result.body), LOCAL_DIGEST, "Digests must match");
    assert.ok(result.body.equals(LOCAL_HTML), "Bytes must match exactly");
  } finally {
    await stopServer(server);
  }
});

await test("production verifier — HTML mismatch is detected", async () => {
  const different = Buffer.from("<!DOCTYPE html><html><body>different</body></html>", "utf8");
  const { server, url } = await startServer((req, res) => {
    res.writeHead(200, { "content-type": "text/html" });
    res.end(different);
  });
  try {
    const result = await fetchUrlEsm(url);
    assert.notEqual(sha256(result.body), LOCAL_DIGEST);
    assert.ok(!result.body.equals(LOCAL_HTML));
  } finally {
    await stopServer(server);
  }
});

await test("production verifier — 404 is detected", async () => {
  const { server, url } = await startServer((req, res) => {
    res.writeHead(404, { "content-type": "text/html" });
    res.end("Not Found");
  });
  try {
    const result = await fetchUrlEsm(url);
    assert.equal(result.status, 404);
    assert.notEqual(result.status, 200);
  } finally {
    await stopServer(server);
  }
});

await test("production verifier — redirect is followed", async () => {
  let redirectServer;
  let finalServer;

  finalServer = createServer((req, res) => {
    res.writeHead(200, { "content-type": "text/html" });
    res.end(LOCAL_HTML);
  });
  await new Promise((r) => finalServer.listen(0, "127.0.0.1", r));
  const finalPort = finalServer.address().port;

  redirectServer = createServer((req, res) => {
    res.writeHead(301, { location: `http://127.0.0.1:${finalPort}/` });
    res.end();
  });
  await new Promise((r) => redirectServer.listen(0, "127.0.0.1", r));
  const redirectPort = redirectServer.address().port;

  try {
    const result = await fetchUrlEsm(`http://127.0.0.1:${redirectPort}/`);
    assert.equal(result.status, 200);
    assert.equal(sha256(result.body), LOCAL_DIGEST);
  } finally {
    await stopServer(redirectServer);
    await stopServer(finalServer);
  }
});

await test("production verifier — unexpected content type is detected", async () => {
  const { server, url } = await startServer((req, res) => {
    res.writeHead(200, { "content-type": "application/json" });
    res.end("{}");
  });
  try {
    const result = await fetchUrlEsm(url);
    assert.equal(result.status, 200);
    assert.ok(!result.contentType.includes("text/html"), "Content type should not be HTML");
  } finally {
    await stopServer(server);
  }
});

await test("production verifier — same visible text but different bytes is a mismatch", async () => {
  // Same text, different encoding (UTF-8 BOM vs no BOM)
  const withBom = Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), LOCAL_HTML]);
  const { server, url } = await startServer((req, res) => {
    res.writeHead(200, { "content-type": "text/html" });
    res.end(withBom);
  });
  try {
    const result = await fetchUrlEsm(url);
    assert.notEqual(sha256(result.body), LOCAL_DIGEST, "BOM version should have different digest");
  } finally {
    await stopServer(server);
  }
});

await test("production verifier — truncated response is a mismatch", async () => {
  // Send fewer bytes than LOCAL_HTML but declare correct content-length
  // so the connection completes (no hang)
  const truncated = LOCAL_HTML.slice(0, LOCAL_HTML.length - 5);
  const { server, url } = await startServer((req, res) => {
    res.writeHead(200, {
      "content-type": "text/html",
      "content-length": String(truncated.length), // honest truncated length
    });
    res.end(truncated);
  });
  try {
    const result = await fetchUrlEsm(url);
    assert.notEqual(result.body.length, LOCAL_HTML.length, "Truncated body should have different length");
    assert.notEqual(sha256(result.body), LOCAL_DIGEST, "Truncated body should have different digest");
  } finally {
    await stopServer(server);
  }
});

await test("production verifier — sha256 function produces consistent output", () => {
  const buf = Buffer.from("test");
  const d1 = sha256(buf);
  const d2 = sha256(buf);
  assert.equal(d1, d2);
  assert.match(d1, /^[0-9a-f]{64}$/);
});

await test("production verifier — reports first differing byte offset correctly", () => {
  const local = Buffer.from("abcdefgh");
  const remote = Buffer.from("abcXefgh");
  let firstDiff = -1;
  const minLen = Math.min(local.length, remote.length);
  for (let i = 0; i < minLen; i++) {
    if (local[i] !== remote[i]) { firstDiff = i; break; }
  }
  assert.equal(firstDiff, 3, "First differing byte should be at offset 3");
});

await test("production verifier — verifies nested assets, not only index.html", async () => {
  const rootDir = await mkdtemp(join(tmpdir(), "production-verifier-"));
  const localIndex = Buffer.from(
    `<!doctype html><html><head><meta http-equiv="Content-Security-Policy" content="${META_CONTENT_SECURITY_POLICY}"><link rel="stylesheet" href="assets/site.css"></head><body></body></html>`,
  );
  const { server, url } = await startServer((req, res) => {
    if (req.url === "/") {
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      res.end(localIndex);
      return;
    }
    res.writeHead(404, { "content-type": "text/plain" });
    res.end("Not Found");
  });

  try {
    await mkdir(join(rootDir, "site", "assets"), { recursive: true });
    await writeFile(join(rootDir, "site", "index.html"), localIndex);
    await writeFile(join(rootDir, "site", "assets", "site.css"), "body{}\n");

    const result = await runVerifier(rootDir, url);
    assert.notEqual(result.code, 0, `${result.stdout}\n${result.stderr}`);
    assert.match(
      result.stderr,
      /assets\/site\.css[\s\S]*HTTP 404/,
      `${result.stdout}\n${result.stderr}`,
    );
  } finally {
    await stopServer(server);
    await rm(rootDir, { recursive: true, force: true });
  }
});

await test("production verifier — maps every local file under a deployment subpath", async () => {
  const rootDir = await mkdtemp(join(tmpdir(), "production-verifier-subpath-"));
  const siteDir = join(rootDir, "site");
  const localIndex = Buffer.from(
    `<!doctype html><html><head><meta http-equiv="Content-Security-Policy" content="${META_CONTENT_SECURITY_POLICY}"><link rel="stylesheet" href="assets/site.css"></head><body></body></html>`,
  );
  const localCss = Buffer.from("body{}\n");
  const requested = [];

  try {
    await mkdir(join(siteDir, "assets"), { recursive: true });
    await writeFile(join(siteDir, "index.html"), localIndex);
    await writeFile(join(siteDir, "assets", "site.css"), localCss);

    const verification = await verifyProductionSite({
      targetUrl: "https://example.test/product",
      siteDir,
      fetcher: async (url) => {
        requested.push(url);
        const isCss = url.endsWith("/assets/site.css");
        return {
          body: isCss ? localCss : localIndex,
          finalUrl: url,
          status: 200,
          contentType: isCss ? "text/css" : "text/html; charset=utf-8",
          redirects: [],
        };
      },
    });

    assert.deepEqual(verification.errors, []);
    assert.equal(verification.checkedFiles, 2);
    assert.deepEqual(requested.sort(), [
      "https://example.test/product/",
      "https://example.test/product/assets/site.css",
    ]);
  } finally {
    await rm(rootDir, { recursive: true, force: true });
  }
});
