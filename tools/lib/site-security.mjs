import { get as httpGet } from "node:http";
import { get as httpsGet } from "node:https";

export const META_CONTENT_SECURITY_POLICY = "default-src 'self'; base-uri 'none'; object-src 'none'; form-action 'self'; img-src 'self' data:; style-src 'self'; script-src 'self'; connect-src 'none'; font-src 'self'";
export const HEADER_CONTENT_SECURITY_POLICY = `${META_CONTENT_SECURITY_POLICY}; frame-ancestors 'none'`;

export const PRODUCTION_SECURITY_HEADERS = new Map([
  ["content-security-policy", HEADER_CONTENT_SECURITY_POLICY],
  ["strict-transport-security", "max-age=31536000"],
  ["x-content-type-options", "nosniff"],
  ["x-frame-options", "DENY"],
  ["referrer-policy", "strict-origin-when-cross-origin"],
  ["permissions-policy", "camera=(), microphone=(), geolocation=()"],
]);

export function auditSecurityHeaders(rawHeaders) {
  if (!Array.isArray(rawHeaders) || rawHeaders.length % 2 !== 0) {
    throw new TypeError("rawHeaders must contain alternating header names and values");
  }

  const actual = new Map();
  for (let index = 0; index < rawHeaders.length; index += 2) {
    const name = String(rawHeaders[index]).toLowerCase();
    const values = actual.get(name) ?? [];
    values.push(String(rawHeaders[index + 1]));
    actual.set(name, values);
  }

  const errors = [];
  for (const [name, expected] of PRODUCTION_SECURITY_HEADERS) {
    const values = actual.get(name) ?? [];
    if (values.length === 0) {
      errors.push(`MISSING_SECURITY_HEADER: ${name}`);
    } else if (values.length > 1) {
      errors.push(`DUPLICATE_SECURITY_HEADER: ${name} appears ${values.length} times`);
    } else if (values[0] !== expected) {
      errors.push(`SECURITY_HEADER_MISMATCH: ${name}`);
    }
  }
  return errors;
}

export function verifySecurityHeadersAtUrl(targetUrl, { timeoutMs = 15_000 } = {}) {
  const url = new URL(targetUrl);
  const request = url.protocol === "https:" ? httpsGet : url.protocol === "http:" ? httpGet : null;
  if (!request) {
    throw new TypeError(`unsupported protocol: ${url.protocol}`);
  }

  return new Promise((resolve, reject) => {
    const call = request(url, { headers: { "User-Agent": "xmind-release-verifier/1.0" } }, (response) => {
      response.resume();
      response.once("end", () => {
        const errors = auditSecurityHeaders(response.rawHeaders);
        if (response.statusCode !== 200) {
          errors.unshift(`HTTP_STATUS_MISMATCH: expected 200, got ${response.statusCode ?? "unknown"}`);
        }
        resolve({
          url: url.href,
          status: response.statusCode ?? null,
          rawHeaders: response.rawHeaders,
          errors,
        });
      });
    });
    call.setTimeout(timeoutMs, () => call.destroy(new Error(`request timed out after ${timeoutMs}ms`)));
    call.once("error", reject);
  });
}
