import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const CHECKER = fileURLToPath(
  new URL("../tools/check-public-artifact.mjs", import.meta.url),
);

const META_CSP = "default-src 'self'; base-uri 'none'; object-src 'none'; form-action 'self'; img-src 'self' data:; style-src 'self'; script-src 'self'; connect-src 'none'; font-src 'self'";

function page({ head = "", body = "", csp = META_CSP } = {}) {
  const cspMeta = csp === null
    ? ""
    : `<meta http-equiv="Content-Security-Policy" content="${csp}">`;
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8">${cspMeta}${head}</head><body>${body}</body></html>`;
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
          '<a href="combinations/">组合工坊</a>',
          '<a href="https://github.com/example/project">源代码</a>',
        ].join(""),
      }),
      "site/assets/site.css": "body { color: #111; }",
      "site/assets/router-engine.mjs":
        'export function matchRoute() { return { state: "matched" }; }\n',
      "site/assets/router-controller.mjs": [
        'import { matchRoute } from "./router-engine.mjs";',
        "export function bootRouter() { return matchRoute(); }",
        "",
      ].join("\n"),
      "site/assets/logo.svg":
        '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1 1"><path d="M0 0h1v1H0z"/></svg>',
      "site/chapters/one.html": page({
        body: '<main id="detail"><img src="../assets/logo.svg" alt=""></main>',
      }),
      "site/combinations/index.html": page({
        body: '<a href="cot-critic-chain.html#phases">查看组合详情</a>',
      }),
      "site/combinations/cot-critic-chain.html": page({
        head: '<script type="module" src="../assets/router-controller.mjs"></script>',
        body: '<main id="phases">组合协议</main>',
      }),
    },
    ({ code, stdout, stderr }) => {
      assert.equal(code, 0, `${stdout}\n${stderr}`);
    },
  );
});

test("rejects an HTML page without the required CSP meta policy", async () => {
  await withArtifact(
    {
      "site/index.html": page({ csp: null }),
    },
    ({ code, stdout, stderr }) => {
      assert.notEqual(code, 0, `${stdout}\n${stderr}`);
      assert.match(stderr, /CSP_META_MISSING/, `${stdout}\n${stderr}`);
    },
  );
});

test("rejects header-only frame-ancestors inside the CSP meta policy", async () => {
  await withArtifact(
    {
      "site/index.html": page({
        csp: `${META_CSP}; frame-ancestors 'none'`,
      }),
    },
    ({ code, stdout, stderr }) => {
      assert.notEqual(code, 0, `${stdout}\n${stderr}`);
      assert.match(stderr, /CSP_META_MISMATCH/, `${stdout}\n${stderr}`);
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

test("rejects a missing combination detail target", async () => {
  await withArtifact(
    {
      "site/index.html": page({
        body: '<a href="combinations/missing.html">缺失组合</a>',
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

test("rejects a missing fragment in a combination detail page", async () => {
  await withArtifact(
    {
      "site/index.html": page({
        body: '<a href="combinations/one.html#missing">坏锚点</a>',
      }),
      "site/combinations/one.html": page({
        body: '<main id="present">组合详情</main>',
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

test("rejects an external module script", async () => {
  await withArtifact(
    {
      "site/index.html": page({
        body: '<script type="module" src="https://cdn.example.com/router.mjs"></script>',
      }),
    },
    ({ code, stdout, stderr }) => {
      assert.notEqual(code, 0, `${stdout}\n${stderr}`);
      assert.match(stderr, /EXTERNAL_RESOURCE/, `${stdout}\n${stderr}`);
    },
  );
});

test("rejects fetch in a local module", async () => {
  await withArtifact(
    {
      "site/index.html": page({
        body: '<script type="module" src="assets/router-controller.mjs"></script>',
      }),
      "site/assets/router-controller.mjs": 'fetch("/router-data.json");\n',
    },
    ({ code, stdout, stderr }) => {
      assert.notEqual(code, 0, `${stdout}\n${stderr}`);
      assert.match(stderr, /NETWORK_CAPABLE_SCRIPT/, `${stdout}\n${stderr}`);
    },
  );
});

test("rejects browser storage in a local module", async () => {
  await withArtifact(
    {
      "site/index.html": page({
        body: '<script type="module" src="assets/router-controller.mjs"></script>',
      }),
      "site/assets/router-controller.mjs":
        'localStorage.setItem("router-query", "private input");\n',
    },
    ({ code, stdout, stderr }) => {
      assert.notEqual(code, 0, `${stdout}\n${stderr}`);
      assert.match(stderr, /STORAGE_CAPABLE_SCRIPT/, `${stdout}\n${stderr}`);
    },
  );
});

test("rejects session storage in a local module", async () => {
  await withArtifact(
    {
      "site/index.html": page({
        body: '<script type="module" src="assets/router-controller.mjs"></script>',
      }),
      "site/assets/router-controller.mjs":
        'sessionStorage.getItem("router-query");\n',
    },
    ({ code, stdout, stderr }) => {
      assert.notEqual(code, 0, `${stdout}\n${stderr}`);
      assert.match(stderr, /STORAGE_CAPABLE_SCRIPT/, `${stdout}\n${stderr}`);
    },
  );
});

test("allows browser storage names in inert strings and comments", async () => {
  await withArtifact(
    {
      "site/index.html": page({
        body: '<script type="module" src="assets/router-controller.mjs"></script>',
      }),
      "site/assets/router-controller.mjs": [
        'const label = "localStorage.setItem";',
        "// sessionStorage.clear() is documentation, not executable code.",
        "/* indexedDB.open() is also inert here. */",
        "export { label };",
        "",
      ].join("\n"),
    },
    ({ code, stdout, stderr }) => {
      assert.equal(code, 0, `${stdout}\n${stderr}`);
    },
  );
});

test("rejects executable browser storage across JavaScript lexical forms", async (t) => {
  const moduleCases = [
    ["template expression", 'const value = `${localStorage.value}`;\n'],
    ["globalThis bracket access", 'globalThis["localStorage"].setItem("router-query", "private");\n'],
    ["globalThis optional bracket access", 'globalThis?.["localStorage"].clear();\n'],
    ["window bracket access", 'window["sessionStorage"].clear();\n'],
    ["optional chaining", 'localStorage?.setItem("router-query", "private");\n'],
    ["code after regex literal", '/localStorage\\.value/.test(name); localStorage.value;\n'],
    ["indexedDB identifier", 'indexedDB.open("router");\n'],
    ["escaped storage identifier", 'local\\u0053torage.setItem("router-query", "private");\n'],
  ];

  for (const [name, source] of moduleCases) {
    await t.test(name, async () => {
      await withArtifact(
        {
          "site/index.html": page({
            body: '<script type="module" src="assets/router-controller.mjs"></script>',
          }),
          "site/assets/router-controller.mjs": source,
        },
        ({ code, stdout, stderr }) => {
          assert.notEqual(code, 0, `${source}\n${stdout}\n${stderr}`);
          assert.match(stderr, /STORAGE_CAPABLE_SCRIPT/, `${source}\n${stdout}\n${stderr}`);
        },
      );
    });
  }

  await t.test("inline module template and bracket access", async () => {
    await withArtifact(
      {
        "site/index.html": page({
          body: '<script type="module">const value = `${self["localStorage"].value}`;</script>',
        }),
      },
      ({ code, stdout, stderr }) => {
        assert.notEqual(code, 0, `${stdout}\n${stderr}`);
        assert.match(stderr, /STORAGE_CAPABLE_SCRIPT/, `${stdout}\n${stderr}`);
      },
    );
  });
});

test("rejects literal storage keys used through simple aliases and destructuring", async (t) => {
  const moduleCases = [
    [
      "computed destructuring key",
      'const {["localStorage"]: storage} = globalThis; storage.setItem("query", "private");\n',
    ],
    [
      "aliased browser global",
      'const root = window; root["localStorage"].setItem("query", "private");\n',
    ],
    [
      "literal key variable",
      'const key = "localStorage"; globalThis[key].setItem("query", "private");\n',
    ],
  ];

  for (const [name, source] of moduleCases) {
    await t.test(name, async () => {
      await withArtifact(
        {
          "site/index.html": page({
            body: '<script type="module" src="assets/router-controller.mjs"></script>',
          }),
          "site/assets/router-controller.mjs": source,
        },
        ({ code, stdout, stderr }) => {
          assert.notEqual(code, 0, `${source}\n${stdout}\n${stderr}`);
          assert.match(stderr, /STORAGE_CAPABLE_SCRIPT/, `${source}\n${stdout}\n${stderr}`);
        },
      );
    });
  }
});

test("allows storage spellings in inert strings, comments, regexes, and template quasis", async () => {
  await withArtifact(
    {
      "site/index.html": page({
        body: '<script type="module" src="assets/router-controller.mjs"></script>',
      }),
      "site/assets/router-controller.mjs": [
        'const label = "localStorage.setItem";',
        "const pattern = /localStorage.value|window\\[\\\"sessionStorage\\\"\\]/;",
        'if (label) /localStorage/.test(label);',
        "const template = `indexedDB.open is documentation`;",
        "// globalThis['localStorage'].clear() is documentation.",
        "/* self[\"sessionStorage\"].clear() is documentation. */",
        "export { label, pattern, template };",
        "",
      ].join("\n"),
    },
    ({ code, stdout, stderr }) => {
      assert.equal(code, 0, `${stdout}\n${stderr}`);
    },
  );
});

test("allows inert storage regexes after completed blocks and function declarations", async () => {
  await withArtifact(
    {
      "site/index.html": page({
        body: '<script type="module" src="assets/router-controller.mjs"></script>',
      }),
      "site/assets/router-controller.mjs": [
        "const ok = true;",
        "const value = 'safe';",
        "if (ok) {} /localStorage/.test(value);",
        "function check() {} /sessionStorage/.test(value);",
        "const ratio = 12 / 3 / 2;",
        "export { ratio };",
        "",
      ].join("\n"),
    },
    ({ code, stdout, stderr }) => {
      assert.equal(code, 0, `${stdout}\n${stderr}`);
    },
  );
});

test("rejects incomplete, escaping, non-literal, bare, and non-script module dependencies", async (t) => {
  const cases = [
    {
      name: "missing static side-effect import",
      source: 'import "./missing.mjs";\n',
      error: /MISSING_TARGET/,
    },
    {
      name: "missing static import-from",
      source: 'import { boot } from "./missing.mjs";\n',
      error: /MISSING_TARGET/,
    },
    {
      name: "missing export-from",
      source: 'export { boot } from "./missing.mjs";\n',
      error: /MISSING_TARGET/,
    },
    {
      name: "escaping static import",
      source: 'import "../../secret.mjs";\n',
      outside: { "secret.mjs": "export {};\n" },
      error: /PATH_TRAVERSAL/,
    },
    {
      name: "missing literal dynamic import",
      source: 'import("./missing.mjs");\n',
      error: /MISSING_TARGET/,
    },
    {
      name: "non-literal dynamic import",
      source: 'const target = "./engine.mjs"; import(target);\n',
      error: /NON_LITERAL_DYNAMIC_IMPORT/,
    },
    {
      name: "bare static import",
      source: 'import "router-runtime";\n',
      error: /UNSAFE_MODULE_SPECIFIER/,
    },
    {
      name: "non-script import target",
      source: 'import "./data.json";\n',
      files: { "site/assets/data.json": "{}\n" },
      error: /INVALID_MODULE_TARGET/,
    },
  ];

  for (const fixture of cases) {
    await t.test(fixture.name, async () => {
      await withArtifact(
        {
          ...(fixture.outside ?? {}),
          "site/index.html": page({
            body: '<script type="module" src="assets/router-controller.mjs"></script>',
          }),
          "site/assets/router-controller.mjs": fixture.source,
          ...(fixture.files ?? {}),
        },
        ({ code, stdout, stderr }) => {
          assert.notEqual(code, 0, `${fixture.source}\n${stdout}\n${stderr}`);
          assert.match(stderr, fixture.error, `${fixture.source}\n${stdout}\n${stderr}`);
        },
      );
    });
  }
});

test("rejects a missing dependency imported by an inline module", async () => {
  await withArtifact(
    {
      "site/index.html": page({
        body: '<script type="module">import "./assets/missing.mjs";</script>',
      }),
    },
    ({ code, stdout, stderr }) => {
      assert.notEqual(code, 0, `${stdout}\n${stderr}`);
      assert.match(stderr, /MISSING_TARGET/, `${stdout}\n${stderr}`);
    },
  );
});

test("audits dynamic imports in classic inline scripts", async (t) => {
  await t.test("missing literal dependency", async () => {
    await withArtifact(
      {
        "site/index.html": page({
          body: '<script>import("./assets/missing.mjs");</script>',
        }),
      },
      ({ code, stdout, stderr }) => {
        assert.notEqual(code, 0, `${stdout}\n${stderr}`);
        assert.match(stderr, /MISSING_TARGET/, `${stdout}\n${stderr}`);
      },
    );
  });

  await t.test("non-literal dependency", async () => {
    await withArtifact(
      {
        "site/index.html": page({
          body: '<script>const target = "./assets/dep.mjs"; import(target);</script>',
        }),
        "site/assets/dep.mjs": "export {};\n",
      },
      ({ code, stdout, stderr }) => {
        assert.notEqual(code, 0, `${stdout}\n${stderr}`);
        assert.match(stderr, /NON_LITERAL_DYNAMIC_IMPORT/, `${stdout}\n${stderr}`);
      },
    );
  });

  await t.test("closed literal dependency", async () => {
    await withArtifact(
      {
        "site/index.html": page({
          body: '<script>import("./assets/dep.mjs");</script>',
        }),
        "site/assets/dep.mjs": "export {};\n",
      },
      ({ code, stdout, stderr }) => {
        assert.equal(code, 0, `${stdout}\n${stderr}`);
      },
    );
  });
});

test("accepts a literal dynamic import with a nested options argument", async () => {
  await withArtifact(
    {
      "site/index.html": page({
        body: '<script type="module">import("./assets/dep.mjs", { with: { type: "javascript" } });</script>',
      }),
      "site/assets/dep.mjs": "export {};\n",
    },
    ({ code, stdout, stderr }) => {
      assert.equal(code, 0, `${stdout}\n${stderr}`);
    },
  );
});

test("rejects a dynamic import with mismatched nested option delimiters", async () => {
  await withArtifact(
    {
      "site/index.html": page({
        body: '<script type="module">import("./assets/dep.mjs", { with: [} });</script>',
      }),
      "site/assets/dep.mjs": "export {};\n",
    },
    ({ code, stdout, stderr }) => {
      assert.notEqual(code, 0, `${stdout}\n${stderr}`);
      assert.match(stderr, /NON_LITERAL_DYNAMIC_IMPORT/, `${stdout}\n${stderr}`);
    },
  );
});

test("accepts a closed file and inline module dependency graph", async () => {
  await withArtifact(
    {
      "site/index.html": page({
        body: '<script type="module">import "./assets/router-controller.mjs";</script>',
      }),
      "site/assets/router-controller.mjs": [
        'import { matchRoute } from "./router-engine.mjs";',
        'export { matchRoute as route } from "./router-engine.mjs";',
        'export async function load() { return import("./router-engine.mjs"); }',
        "",
      ].join("\n"),
      "site/assets/router-engine.mjs":
        'export function matchRoute() { return { state: "matched" }; }\n',
    },
    ({ code, stdout, stderr }) => {
      assert.equal(code, 0, `${stdout}\n${stderr}`);
    },
  );
});

test("rejects a symbolic link inside the public tree", async () => {
  const rootDir = await mkdtemp(path.join(tmpdir(), "public-artifact-symlink-"));
  try {
    await writeFiles(rootDir, {
      "site/index.html": page(),
      "outside.mjs": "export {};\n",
    });
    await symlink(
      path.join(rootDir, "outside.mjs"),
      path.join(rootDir, "site", "linked.mjs"),
    );
    const { code, stdout, stderr } = await runChecker(rootDir);
    assert.notEqual(code, 0, `${stdout}\n${stderr}`);
    assert.match(stderr, /UNSAFE_FILE_TYPE/, `${stdout}\n${stderr}`);
  } finally {
    await rm(rootDir, { recursive: true, force: true });
  }
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
