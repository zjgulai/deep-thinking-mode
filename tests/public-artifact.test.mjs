import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const CHECKER = fileURLToPath(new URL("../tools/check-public-artifact.mjs", import.meta.url));
const TRUSTED_SOURCE_URLS = {
  "site/assets/site.js": new URL("../tools/site-assets/site.js", import.meta.url),
  "site/assets/router-controller.mjs": new URL("../tools/site-assets/router-controller.mjs", import.meta.url),
  "site/assets/router-engine.mjs": new URL("../tools/site-assets/router-engine.mjs", import.meta.url),
};
const META_CSP = "default-src 'self'; base-uri 'none'; object-src 'none'; form-action 'self'; img-src 'self' data:; style-src 'self'; script-src 'self'; connect-src 'none'; font-src 'self'";

function page({ head = "", body = "", csp = META_CSP } = {}) {
  const cspMeta = csp === null ? "" : `<meta http-equiv="Content-Security-Policy" content="${csp}">`;
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8">${cspMeta}${head}</head><body>${body}</body></html>`;
}

async function trustedScripts() {
  return Object.fromEntries(await Promise.all(
    Object.entries(TRUSTED_SOURCE_URLS).map(async ([target, source]) => [target, await readFile(source)]),
  ));
}

async function writeFiles(rootDir, files) {
  for (const [relativePath, content] of Object.entries(files)) {
    const absolutePath = path.join(rootDir, relativePath);
    await mkdir(path.dirname(absolutePath), { recursive: true });
    await writeFile(absolutePath, content);
  }
}

async function runChecker(rootDir) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [CHECKER], {
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

async function withArtifact(files, assertion) {
  const rootDir = await mkdtemp(path.join(tmpdir(), "public-artifact-"));
  try {
    await writeFiles(rootDir, files);
    await assertion(await runChecker(rootDir));
  } finally {
    await rm(rootDir, { recursive: true, force: true });
  }
}

function assertRejected(pattern) {
  return ({ code, stdout, stderr }) => {
    assert.notEqual(code, 0, `${stdout}\n${stderr}`);
    assert.match(stderr, pattern, `${stdout}\n${stderr}`);
  };
}

test("accepts a self-contained site with all three trusted script bytes", async () => {
  await withArtifact({
    "site/index.html": page({
      head: '<link rel="stylesheet" href="assets/site.css"><script src="assets/site.js" defer></script>',
      body: '<a href="combinations/">组合工坊</a>',
    }),
    "site/assets/site.css": "body { color: #111; }",
    ...(await trustedScripts()),
    "site/combinations/index.html": page({
      body: '<script type="module" src="../assets/router-controller.mjs"></script><main id="phases">组合协议</main>',
    }),
  }, ({ code, stdout, stderr }) => assert.equal(code, 0, `${stdout}\n${stderr}`));
});

test("rejects missing or noncanonical CSP", async (t) => {
  await t.test("missing", () => withArtifact(
    { "site/index.html": page({ csp: null }) },
    assertRejected(/CSP_META_MISSING/),
  ));
  await t.test("frame-ancestors cannot be carried by meta", () => withArtifact(
    { "site/index.html": page({ csp: `${META_CSP}; frame-ancestors 'none'` }) },
    assertRejected(/CSP_META_MISMATCH/),
  ));
});

test("rejects missing targets, bad anchors, and path escape", async (t) => {
  const cases = [
    ["missing stylesheet", { "site/index.html": page({ head: '<link rel="stylesheet" href="assets/missing.css">' }) }, /MISSING_TARGET/],
    ["missing combination", { "site/index.html": page({ body: '<a href="combinations/missing.html">缺失</a>' }) }, /MISSING_TARGET/],
    ["path escape", { "secret.html": page(), "site/index.html": page({ body: '<a href="../secret.html">越界</a>' }) }, /PATH_TRAVERSAL/],
    ["encoded path escape", { "secret.html": page(), "site/index.html": page({ body: '<a href="%2e%2e/secret.html">越界</a>' }) }, /PATH_TRAVERSAL/],
    ["missing anchor", { "site/index.html": page({ body: '<a href="chapter.html#missing">坏锚点</a>' }), "site/chapter.html": page({ body: '<main id="present"></main>' }) }, /MISSING_FRAGMENT/],
  ];
  for (const [name, files, pattern] of cases) {
    await t.test(name, () => withArtifact(files, assertRejected(pattern)));
  }
});

test("rejects external subresources and allows external navigation metadata", async (t) => {
  await t.test("external script", () => withArtifact(
    { "site/index.html": page({ body: '<script src="https://cdn.example/app.js"></script>' }) },
    assertRejected(/EXTERNAL_RESOURCE/),
  ));
  await t.test("protocol-relative image", () => withArtifact(
    { "site/index.html": page({ body: '<img src="//cdn.example/a.png">' }) },
    assertRejected(/EXTERNAL_RESOURCE/),
  ));
  await t.test("canonical link", () => withArtifact(
    { "site/index.html": page({ head: '<link rel="canonical" href="https://example.test/">' }) },
    ({ code, stdout, stderr }) => assert.equal(code, 0, `${stdout}\n${stderr}`),
  ));
});

test("rejects a byte mismatch for every trusted script path", async (t) => {
  for (const target of Object.keys(TRUSTED_SOURCE_URLS)) {
    await t.test(target, async () => {
      const files = await trustedScripts();
      files[target] = Buffer.concat([files[target], Buffer.from("\n")]);
      await withArtifact({
        "site/index.html": page(),
        ...files,
      }, assertRejected(/SCRIPT_BYTES_MISMATCH/));
    });
  }
});

test("rejects an extra script file or an untrusted script src", async (t) => {
  await t.test("extra script", () => withArtifact({
    "site/index.html": page(),
    "site/assets/extra.mjs": "export {};\n",
  }, assertRejected(/UNTRUSTED_SCRIPT/)));
  await t.test("untrusted src", () => withArtifact({
    "site/index.html": page({ body: '<script src="assets/extra.js"></script>' }),
    "site/assets/extra.js": "void 0;\n",
  }, assertRejected(/UNTRUSTED_SCRIPT/)));
});

test("rejects inline executable scripts without attempting execution", async (t) => {
  for (const body of [
    "<script>void 0;</script>",
    '<script type="module">export {};</script>',
    '<script type="text/javascript">fetch("/x")</script>',
  ]) {
    await t.test(body, () => withArtifact(
      { "site/index.html": page({ body }) },
      assertRejected(/INLINE_EXECUTABLE_SCRIPT/),
    ));
  }
});

test("allows only strictly parsed, HTML-safe inert JSON scripts", async (t) => {
  await t.test("application/json", () => withArtifact(
    { "site/index.html": page({ body: '<script type="application/json">{"safe":true}</script>' }) },
    ({ code, stdout, stderr }) => assert.equal(code, 0, `${stdout}\n${stderr}`),
  ));
  await t.test("application/ld+json", () => withArtifact(
    { "site/index.html": page({ head: '<script type="application/ld+json">{"@context":"https://schema.org"}</script>' }) },
    ({ code, stdout, stderr }) => assert.equal(code, 0, `${stdout}\n${stderr}`),
  ));
  await t.test("invalid JSON", () => withArtifact(
    { "site/index.html": page({ body: '<script type="application/json">{broken}</script>' }) },
    assertRejected(/INVALID_DATA_SCRIPT/),
  ));
  await t.test("unsafe JSON serialization", () => withArtifact(
    { "site/index.html": page({ body: '<script type="application/json">{"markup":"&"}</script>' }) },
    assertRejected(/UNSAFE_DATA_SCRIPT/),
  ));
});

test("reports AST capability and syntax errors distinctly from byte mismatch", async (t) => {
  const cases = [
    ["storage", "localStorage.clear();\n", /SCRIPT_CAPABILITY_DENIED/],
    ["network", "fetch('/x');\n", /SCRIPT_CAPABILITY_DENIED/],
    ["cookie", "document.cookie;\n", /SCRIPT_CAPABILITY_DENIED/],
    ["dynamic", 'import("./router-engine.mjs", { with: { type: "javascript" } });\n', /DYNAMIC_IMPORT_DENIED/],
    ["source type", 'import "./router-engine.mjs";\n', /SCRIPT_SYNTAX_ERROR/],
  ];
  for (const [name, source, pattern] of cases) {
    await t.test(name, () => withArtifact({
      "site/index.html": page(),
      "site/assets/site.js": source,
    }, assertRejected(pattern)));
  }
});

test("validates the static module closure before trusting parity", async (t) => {
  const cases = [
    ["missing", 'import "./missing.mjs";\n', {}, /MISSING_TARGET/],
    ["escape", 'import "../../secret.mjs";\n', { "secret.mjs": "export {};\n" }, /PATH_TRAVERSAL/],
    ["external", 'import "https://cdn.example/engine.mjs";\n', {}, /EXTERNAL_SCRIPT_IMPORT/],
    ["bare", 'import "router-engine";\n', {}, /UNTRUSTED_SCRIPT_IMPORT/],
    ["wrong extension", 'import "./data.json";\n', { "site/assets/data.json": "{}\n" }, /INVALID_SCRIPT_IMPORT_TARGET/],
  ];
  for (const [name, source, extra, pattern] of cases) {
    await t.test(name, () => withArtifact({
      "site/index.html": page(),
      "site/assets/router-controller.mjs": source,
      ...extra,
    }, assertRejected(pattern)));
  }
});

test("rejects a symbolic link inside the public tree", async () => {
  const rootDir = await mkdtemp(path.join(tmpdir(), "public-artifact-symlink-"));
  try {
    await writeFiles(rootDir, { "site/index.html": page(), "outside.mjs": "export {};\n" });
    await symlink(path.join(rootDir, "outside.mjs"), path.join(rootDir, "site", "linked.mjs"));
    assertRejected(/UNSAFE_FILE_TYPE/)(await runChecker(rootDir));
  } finally {
    await rm(rootDir, { recursive: true, force: true });
  }
});

test("rejects external CSS resources and disallowed file types", async (t) => {
  await t.test("CSS", () => withArtifact({
    "site/index.html": page({ head: '<link rel="stylesheet" href="assets/site.css">' }),
    "site/assets/site.css": '@import url("https://cdn.example/theme.css");',
  }, assertRejected(/EXTERNAL_RESOURCE/)));
  await t.test("private key extension", () => withArtifact({
    "site/index.html": page(),
    "site/private.pem": "not a public asset",
  }, assertRejected(/DISALLOWED_FILE_TYPE/)));
});
