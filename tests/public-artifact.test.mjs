import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const CHECKER = fileURLToPath(
  new URL("../tools/check-public-artifact.mjs", import.meta.url),
);

function page({ head = "", body = "" } = {}) {
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8">${head}</head><body>${body}</body></html>`;
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

async function withArtifact(files, assertion) {
  const rootDir = await mkdtemp(path.join(tmpdir(), "public-artifact-"));
  try {
    await writeFiles(rootDir, files);
    await assertion(await runChecker(rootDir));
  } finally {
    await rm(rootDir, { recursive: true, force: true });
  }
}

test("accepts a self-contained multi-page site", async () => {
  await withArtifact(
    {
      "site/index.html": page({
        head: '<link rel="stylesheet" href="assets/site.css">',
        body: [
          '<a href="chapters/one.html#detail">章节</a>',
          '<a href="https://github.com/example/project">源代码</a>',
        ].join(""),
      }),
      "site/assets/site.css": "body { color: #111; }",
      "site/assets/logo.svg":
        '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1 1"><path d="M0 0h1v1H0z"/></svg>',
      "site/chapters/one.html": page({
        body: '<main id="detail"><img src="../assets/logo.svg" alt=""></main>',
      }),
    },
    ({ code, stdout, stderr }) => {
      assert.equal(code, 0, `${stdout}\n${stderr}`);
    },
  );
});

test("rejects an internal stylesheet that is missing", async () => {
  await withArtifact(
    {
      "site/index.html": page({
        head: '<link rel="stylesheet" href="assets/missing.css">',
      }),
    },
    ({ code, stdout, stderr }) => {
      assert.notEqual(code, 0, `${stdout}\n${stderr}`);
      assert.match(stderr, /MISSING_TARGET/, `${stdout}\n${stderr}`);
    },
  );
});

test("rejects a missing internal chapter", async () => {
  await withArtifact(
    {
      "site/index.html": page({
        body: '<a href="chapters/missing.html">缺失章节</a>',
      }),
    },
    ({ code, stdout, stderr }) => {
      assert.notEqual(code, 0, `${stdout}\n${stderr}`);
      assert.match(stderr, /MISSING_TARGET/, `${stdout}\n${stderr}`);
    },
  );
});

test("rejects path traversal even when the escaped file exists", async () => {
  await withArtifact(
    {
      "secret.html": page({ body: "secret" }),
      "site/index.html": page({
        body: '<a href="../secret.html">越界</a>',
      }),
    },
    ({ code, stdout, stderr }) => {
      assert.notEqual(code, 0, `${stdout}\n${stderr}`);
      assert.match(stderr, /PATH_TRAVERSAL/, `${stdout}\n${stderr}`);
    },
  );
});

test("rejects encoded path traversal", async () => {
  await withArtifact(
    {
      "secret.html": page({ body: "secret" }),
      "site/index.html": page({
        body: '<a href="%2e%2e/secret.html">编码越界</a>',
      }),
    },
    ({ code, stdout, stderr }) => {
      assert.notEqual(code, 0, `${stdout}\n${stderr}`);
      assert.match(stderr, /PATH_TRAVERSAL/, `${stdout}\n${stderr}`);
    },
  );
});

test("rejects a fragment that does not exist in the target page", async () => {
  await withArtifact(
    {
      "site/index.html": page({
        body: '<a href="chapters/one.html#missing">坏锚点</a>',
      }),
      "site/chapters/one.html": page({
        body: '<main id="present">内容</main>',
      }),
    },
    ({ code, stdout, stderr }) => {
      assert.notEqual(code, 0, `${stdout}\n${stderr}`);
      assert.match(stderr, /MISSING_FRAGMENT/, `${stdout}\n${stderr}`);
    },
  );
});

test("rejects protocol-relative external subresources", async () => {
  await withArtifact(
    {
      "site/index.html": page({
        body: '<script src="//cdn.example.com/app.js"></script>',
      }),
    },
    ({ code, stdout, stderr }) => {
      assert.notEqual(code, 0, `${stdout}\n${stderr}`);
      assert.match(stderr, /EXTERNAL_RESOURCE/, `${stdout}\n${stderr}`);
    },
  );
});

test("rejects a missing internal src target", async () => {
  await withArtifact(
    {
      "site/index.html": page({
        body: '<img src="assets/missing.png" alt="">',
      }),
    },
    ({ code, stdout, stderr }) => {
      assert.notEqual(code, 0, `${stdout}\n${stderr}`);
      assert.match(stderr, /MISSING_TARGET/, `${stdout}\n${stderr}`);
    },
  );
});

test("rejects external resources loaded from CSS", async () => {
  await withArtifact(
    {
      "site/index.html": page({
        head: '<link rel="stylesheet" href="assets/site.css">',
      }),
      "site/assets/site.css":
        '@import url("https://cdn.example.com/theme.css");',
    },
    ({ code, stdout, stderr }) => {
      assert.notEqual(code, 0, `${stdout}\n${stderr}`);
      assert.match(stderr, /EXTERNAL_RESOURCE/, `${stdout}\n${stderr}`);
    },
  );
});

test("rejects files outside the public artifact allowlist", async () => {
  await withArtifact(
    {
      "site/index.html": page(),
      "site/private.pem": "not a public asset",
    },
    ({ code, stdout, stderr }) => {
      assert.notEqual(code, 0, `${stdout}\n${stderr}`);
      assert.match(stderr, /DISALLOWED_FILE_TYPE/, `${stdout}\n${stderr}`);
    },
  );
});

test("allows JSON-LD identifiers without treating them as network code", async () => {
  await withArtifact(
    {
      "site/index.html": page({
        head: '<script type="application/ld+json">{"@context":"https://schema.org"}</script>',
      }),
    },
    ({ code, stdout, stderr }) => {
      assert.equal(code, 0, `${stdout}\n${stderr}`);
    },
  );
});

test("allows an HTTPS canonical link because it is metadata, not a subresource", async () => {
  await withArtifact(
    {
      "site/index.html": page({
        head: '<link rel="canonical" href="https://example.test/">',
      }),
    },
    ({ code, stdout, stderr }) => {
      assert.equal(code, 0, `${stdout}\n${stderr}`);
    },
  );
});
