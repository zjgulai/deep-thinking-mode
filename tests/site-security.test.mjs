import assert from "node:assert/strict";
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import test from "node:test";

const HEADER_CSP = "default-src 'self'; base-uri 'none'; object-src 'none'; form-action 'self'; img-src 'self' data:; style-src 'self'; script-src 'self'; connect-src 'none'; font-src 'self'; frame-ancestors 'none'";

const CANONICAL_HEADERS = [
  "Content-Security-Policy", HEADER_CSP,
  "Strict-Transport-Security", "max-age=31536000",
  "X-Content-Type-Options", "nosniff",
  "X-Frame-Options", "DENY",
  "Referrer-Policy", "strict-origin-when-cross-origin",
  "Permissions-Policy", "camera=(), microphone=(), geolocation=()",
];

async function securityModule() {
  return import("../tools/lib/site-security.mjs");
}

test("production security headers accept one canonical value per policy", async () => {
  const { auditSecurityHeaders } = await securityModule();
  assert.equal(typeof auditSecurityHeaders, "function");
  assert.deepEqual(auditSecurityHeaders(CANONICAL_HEADERS), []);
});

test("production security headers reject a duplicated policy", async () => {
  const { auditSecurityHeaders } = await securityModule();
  assert.equal(typeof auditSecurityHeaders, "function");
  const errors = auditSecurityHeaders([
    ...CANONICAL_HEADERS,
    "X-Content-Type-Options",
    "nosniff",
  ]);

  assert.deepEqual(errors, [
    "DUPLICATE_SECURITY_HEADER: x-content-type-options appears 2 times",
  ]);
});

test("production security headers reject a missing CSP policy", async () => {
  const { auditSecurityHeaders } = await securityModule();
  assert.equal(typeof auditSecurityHeaders, "function");
  const withoutCsp = CANONICAL_HEADERS.slice(2);

  assert.deepEqual(auditSecurityHeaders(withoutCsp), [
    "MISSING_SECURITY_HEADER: content-security-policy",
  ]);
});

test("security header verifier checks a real HTTP response", async (context) => {
  const { verifySecurityHeadersAtUrl } = await securityModule();
  assert.equal(typeof verifySecurityHeadersAtUrl, "function");
  const server = createServer((_request, response) => {
    for (let index = 0; index < CANONICAL_HEADERS.length; index += 2) {
      response.setHeader(CANONICAL_HEADERS[index], CANONICAL_HEADERS[index + 1]);
    }
    response.end("ok");
  });
  context.after(() => new Promise((resolve) => server.close(resolve)));
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();

  const result = await verifySecurityHeadersAtUrl(
    `http://127.0.0.1:${address.port}/`,
  );

  assert.equal(result.status, 200);
  assert.deepEqual(result.errors, []);
});

test("origin nginx maps .mjs modules to a JavaScript MIME type", async () => {
  const nginxConfig = await readFile(
    new URL("../deploy/tencent-cloud/xmind-site/nginx/nginx.conf", import.meta.url),
    "utf8",
  );

  assert.match(nginxConfig, /application\/javascript\s+mjs;/);
});
