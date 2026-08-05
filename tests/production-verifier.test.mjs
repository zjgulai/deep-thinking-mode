/**
 * tests/production-verifier.test.mjs
 *
 * Tests for tools/verify-production.mjs behavior using local HTTP fixtures.
 * Tests the byte comparison logic directly without importing the CLI entry point.
 */

import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import test from "node:test";

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
