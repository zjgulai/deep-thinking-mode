import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  auditPageFamilyMarkup,
  auditPageMarkup,
  auditNotFoundResponse,
  auditProductionPages,
  classifyPage,
} from "../tools/lib/production-page-audit.mjs";
import { collectSiteFiles } from "../tools/check-public-artifact.mjs";
import {
  META_CONTENT_SECURITY_POLICY,
  PRODUCTION_SECURITY_HEADERS,
} from "../tools/lib/site-security.mjs";

const BASE_URL = "https://xmind.lute-tlz-dddd.top/";

function securityRawHeaders(overrides = new Map()) {
  const headers = [];
  for (const [name, value] of PRODUCTION_SECURITY_HEADERS) {
    const nextValue = overrides.get(name);
    if (nextValue === null) continue;
    headers.push(name, nextValue ?? value);
  }
  headers.push("content-type", "text/html; charset=utf-8");
  return headers;
}

function page({
  relativePath = "index.html",
  title = "前车之鉴-思维制胜",
  body = "<h1>前车之鉴</h1>",
} = {}) {
  const canonicalPath = relativePath === "index.html"
    ? ""
    : relativePath.endsWith("/index.html")
      ? relativePath.slice(0, -"index.html".length)
      : relativePath;
  return `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta name="description" content="可验证的生产页面">
  <meta http-equiv="Content-Security-Policy" content="${META_CONTENT_SECURITY_POLICY}">
  <link rel="canonical" href="${BASE_URL}${canonicalPath}">
  <meta property="og:url" content="${BASE_URL}${canonicalPath}">
  <title>${title}</title>
</head>
<body>
  <a class="skip-link" href="#main-content">跳至正文</a>
  <header class="site-header"><nav class="primary-nav" aria-label="主导航"><a href="${relativePath === "index.html" ? "chapter.html" : "index.html"}">导航</a></nav></header>
  <main id="main-content">${body}</main>
  <footer class="site-footer">站点页脚</footer>
</body>
</html>`;
}

test("page audit accepts the complete production page contract", () => {
  assert.deepEqual(
    auditPageMarkup({
      html: page({
        body: '<h1>前车之鉴</h1><img src="portrait.webp" width="480" height="600" alt="章节导师">',
      }),
      relativePath: "index.html",
      targetUrl: BASE_URL,
    }),
    [],
  );
});

test("page audit rejects semantic, accessibility, and interaction weaknesses", async (t) => {
  const cases = [
    ["missing title", (html) => html.replace(/\s*<title>[\s\S]*?<\/title>/u, ""), "MISSING_TITLE"],
    ["duplicate main", (html) => html.replace("</main>", "</main><main></main>"), "MAIN_COUNT_MISMATCH"],
    ["duplicate h1", (html) => html.replace("</h1>", "</h1><h1>重复</h1>"), "H1_COUNT_MISMATCH"],
    ["missing skip link", (html) => html.replace(/\s*<a class="skip-link"[^>]*>[^<]*<\/a>/u, ""), "MISSING_SKIP_LINK"],
    ["missing image alt", (html) => html.replace(' alt="章节导师"', ""), "IMAGE_ALT_MISSING"],
    ["missing image dimensions", (html) => html.replace(' width="480" height="600"', ""), "IMAGE_DIMENSIONS_MISSING"],
    ["inline event handler", (html) => html.replace("<h1>", '<h1 onclick="alert(1)">'), "INLINE_EVENT_HANDLER"],
    ["unsafe embedded document", (html) => html.replace("</main>", '<iframe src="about:blank"></iframe></main>'), "UNSAFE_EMBEDDED_ELEMENT"],
    ["button without type", (html) => html.replace("</main>", "<button>提交</button></main>"), "BUTTON_TYPE_MISSING"],
    ["unlabelled control", (html) => html.replace("</main>", '<input id="query"></main>'), "CONTROL_NAME_MISSING"],
    ["unsafe blank target", (html) => html.replace("</main>", '<a href="https://example.test" target="_blank">外链</a></main>'), "BLANK_TARGET_REL_MISSING"],
    ["canonical drift", (html) => html.replace(`${BASE_URL}\"`, `${BASE_URL}wrong\"`), "CANONICAL_URL_MISMATCH"],
  ];

  for (const [name, mutate, code] of cases) {
    await t.test(name, () => {
      const errors = auditPageMarkup({
        html: mutate(page({
          body: '<h1>前车之鉴</h1><img src="portrait.webp" width="480" height="600" alt="章节导师">',
        })),
        relativePath: "index.html",
        targetUrl: BASE_URL,
      });
      assert.ok(errors.some((issue) => issue.startsWith(`${code}:`)), errors.join("\n"));
    });
  }
});

test("production audit checks every HTML page and every page response header", async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "production-page-audit-"));
  const siteDir = path.join(root, "site");
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(siteDir, { recursive: true });

  const pages = new Map([
    ["index.html", page()],
    ["chapter.html", page({ relativePath: "chapter.html", title: "章节", body: "<h1>章节</h1>" })],
  ]);
  for (const [relativePath, html] of pages) {
    await writeFile(path.join(siteDir, relativePath), html);
  }

  const fetched = [];
  const fetcher = async (url) => {
    const pathname = new URL(url).pathname;
    const relativePath = pathname === "/" ? "index.html" : pathname.slice(1);
    fetched.push(relativePath);
    const html = pages.get(relativePath);
    return {
      body: Buffer.from(html, "utf8"),
      contentType: "text/html; charset=utf-8",
      finalUrl: url,
      rawHeaders: relativePath === "chapter.html"
        ? securityRawHeaders(new Map([["x-frame-options", null]]))
        : securityRawHeaders(),
      redirects: [],
      status: 200,
    };
  };

  const result = await auditProductionPages({
    targetUrl: BASE_URL,
    siteDir,
    fetcher,
    concurrency: 2,
    probeNotFound: false,
  });

  assert.deepEqual(fetched.sort(), ["chapter.html", "index.html"]);
  assert.equal(result.checkedFiles, 2);
  assert.equal(result.checkedPages, 2);
  assert.deepEqual(result.pageTypes, { root: 1, unknown: 1 });
  assert.ok(
    result.errors.some((issue) => issue === "chapter.html: MISSING_SECURITY_HEADER: x-frame-options"),
    result.errors.join("\n"),
  );
});

test("production audit applies the canonical production URL when the library caller omits it", async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "production-page-default-url-"));
  const siteDir = path.join(root, "site");
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(siteDir, { recursive: true });
  const html = page({
    body: `<h1>前车之鉴</h1>${'<article class="chapter-card"></article>'.repeat(13)}${'<article data-home-combination></article>'.repeat(5)}`,
  })
    .replace("<body>", '<body class="home-page">')
    .replace('href="chapter.html"', 'href="/"');
  await writeFile(path.join(siteDir, "index.html"), html);

  const result = await auditProductionPages({
    siteDir,
    probeNotFound: false,
    fetcher: async (url) => ({
      body: Buffer.from(html, "utf8"),
      contentType: "text/html; charset=utf-8",
      finalUrl: url,
      rawHeaders: securityRawHeaders(),
      redirects: [],
      status: 200,
    }),
  });

  assert.deepEqual(result.errors, []);
  assert.equal(result.checkedPages, 1);
  assert.deepEqual(result.pageTypes, { root: 1 });
});

test("404 probe rejects soft-404, redirects, body drift, and missing headers", () => {
  const expectedBody = Buffer.from(page({ relativePath: "404.html" }), "utf8");
  const expectedUrl = `${BASE_URL}__production-audit-not-found__.html`;
  const response = {
    body: Buffer.from("soft 404", "utf8"),
    contentType: "text/plain",
    finalUrl: `${BASE_URL}404.html`,
    rawHeaders: [],
    status: 200,
  };
  const errors = auditNotFoundResponse({ expectedBody, expectedUrl, response });
  for (const code of [
    "NOT_FOUND_STATUS_MISMATCH",
    "NOT_FOUND_REDIRECT",
    "NOT_FOUND_CONTENT_TYPE_MISMATCH",
    "NOT_FOUND_BODY_MISMATCH",
    "MISSING_SECURITY_HEADER",
  ]) {
    assert.ok(errors.some((error) => error.startsWith(`${code}:`)), errors.join("\n"));
  }
});

test("page-family audit rejects unknown routes and a Router without its module", async () => {
  assert.equal(classifyPage("unexpected.html"), "unknown");
  assert.deepEqual(
    auditPageFamilyMarkup({ html: page(), relativePath: "unexpected.html" }),
    ["UNKNOWN_PAGE_FAMILY: unexpected.html"],
  );

  const router = await readFile(new URL("../site/router.html", import.meta.url), "utf8");
  const withoutController = router.replace(
    /\s*<script type="module" src="assets\/router-controller\.mjs"><\/script>/u,
    "",
  );
  const errors = auditPageFamilyMarkup({
    html: withoutController,
    relativePath: "router.html",
  });
  assert.ok(errors.includes("ROUTER_MODULE_MISSING: router.html"), errors.join("\n"));
});

test("the complete local public tree satisfies every page and family contract", async () => {
  const siteUrl = new URL("../site/", import.meta.url);
  const siteDir = fileURLToPath(siteUrl);
  const htmlFiles = (await collectSiteFiles(siteDir)).filter((file) => file.endsWith(".html"));
  const pageTypes = {};
  const errors = [];
  for (const relativePath of htmlFiles) {
    const html = await readFile(new URL(relativePath, siteUrl), "utf8");
    const type = classifyPage(relativePath);
    pageTypes[type] = (pageTypes[type] ?? 0) + 1;
    for (const pageError of auditPageMarkup({ html, relativePath, targetUrl: BASE_URL })) {
      errors.push(`${relativePath}: ${pageError}`);
    }
    for (const familyError of auditPageFamilyMarkup({ html, relativePath })) {
      errors.push(`${relativePath}: ${familyError}`);
    }
  }

  assert.equal(htmlFiles.length, 2812);
  assert.deepEqual(pageTypes, {
    error: 1,
    chapters: 13,
    "combinations-detail": 5,
    "combinations-index": 1,
    "models-detail": 2789,
    "models-index": 1,
    root: 1,
    router: 1,
  });
  assert.deepEqual(errors, []);
});
