import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const HASHER = fileURLToPath(new URL("../tools/hash-public-artifact.mjs", import.meta.url));
const TRUSTED_SITE_JS = new URL("../tools/site-assets/site.js", import.meta.url);
const META_CSP = "default-src 'self'; base-uri 'none'; object-src 'none'; form-action 'self'; img-src 'self' data:; style-src 'self'; script-src 'self'; connect-src 'none'; font-src 'self'";

function page(body = "") {
  return `<!doctype html><html><head><meta http-equiv="Content-Security-Policy" content="${META_CSP}"></head><body>${body}</body></html>`;
}

async function writeFiles(rootDir, files) {
  for (const [relativePath, content] of Object.entries(files)) {
    const absolutePath = path.join(rootDir, relativePath);
    await mkdir(path.dirname(absolutePath), { recursive: true });
    await writeFile(absolutePath, content);
  }
}

function runHasher(rootDir) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [HASHER, "site"], {
      cwd: rootDir,
      env: { ...process.env, NO_COLOR: "1" },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.once("error", reject);
    child.once("close", (code, signal) => resolve({ code, signal, stdout, stderr }));
  });
}

function digestFixture(files) {
  const hash = createHash("sha256");
  for (const relativePath of Object.keys(files).sort()) {
    hash.update(relativePath, "utf8");
    hash.update("\0");
    hash.update(files[relativePath]);
    hash.update("\0");
  }
  return hash.digest("hex");
}

async function withArtifact(files, assertion) {
  const rootDir = await mkdtemp(path.join(tmpdir(), "artifact-hash-"));
  try {
    await writeFiles(rootDir, Object.fromEntries(
      Object.entries(files).map(([relativePath, content]) => [`site/${relativePath}`, content]),
    ));
    await assertion(await runHasher(rootDir));
  } finally {
    await rm(rootDir, { recursive: true, force: true });
  }
}

test("hashes one validated byte snapshot with the established deterministic framing", async () => {
  const files = {
    "assets/site.js": await readFile(TRUSTED_SITE_JS),
    "index.html": page('<script src="assets/site.js" defer></script>'),
  };
  await withArtifact(files, ({ code, stdout, stderr }) => {
    assert.equal(code, 0, `${stdout}\n${stderr}`);
    assert.equal(stdout, `${digestFixture(files)}  site  2 files\n`);
  });
});

test("exports the hasher without running the CLI on import", async () => {
  const module = await import(`${new URL(HASHER, import.meta.url).href}?test=side-effect-free`);
  assert.equal(typeof module.hashPublicArtifact, "function");
});

test("refuses to issue an artifact digest for any public-contract violation", async (t) => {
  const trustedSiteJs = await readFile(TRUSTED_SITE_JS);
  const cases = [
    ["trusted byte mismatch", {
      "index.html": page('<script src="assets/site.js" defer></script>'),
      "assets/site.js": Buffer.concat([trustedSiteJs, Buffer.from("\n")]),
    }, /SCRIPT_BYTES_MISMATCH/],
    ["denied capability", {
      "index.html": page('<script src="assets/site.js" defer></script>'),
      "assets/site.js": "localStorage.clear();\n",
    }, /SCRIPT_CAPABILITY_DENIED/],
    ["extra script", {
      "index.html": page(),
      "assets/extra.js": "void 0;\n",
    }, /UNTRUSTED_SCRIPT/],
    ["inline executable", {
      "index.html": page("<script>void 0;</script>"),
    }, /INLINE_EXECUTABLE_SCRIPT/],
  ];

  for (const [name, files, pattern] of cases) {
    await t.test(name, () => withArtifact(files, ({ code, stdout, stderr }) => {
      assert.notEqual(code, 0, `${stdout}\n${stderr}`);
      assert.equal(stdout, "", `invalid artifact leaked a success digest: ${stdout}`);
      assert.match(stderr, pattern, stderr);
      assert.doesNotMatch(stderr, /^[0-9a-f]{64}\s{2}/m);
    }));
  }
});
