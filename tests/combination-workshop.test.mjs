import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  copyFileSync,
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  symlinkSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import * as siteBuilder from "../tools/build-site.mjs";
import { loadV3AgentData } from "../tools/lib/v3-agent-data.mjs";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const CHAIN_IDS = [
  "cot-critic-chain",
  "deep-research-chain",
  "plan-execute-reflect-chain",
  "react-agent-chain",
  "tot-tree-of-thought-chain",
];
const SECTION_ORDER = [
  "definition",
  "applicability",
  "limits",
  "input",
  "phases",
  "loops",
  "alternatives",
  "prompt",
  "evidence",
];

const buildView = await loadV3AgentData(ROOT);
const taxonomy = JSON.parse(readFileSync(join(ROOT, "knowledge", "taxonomy.json"), "utf8"));
const chapterById = new Map(taxonomy.chapters.map((chapter) => [chapter.id, chapter]));
const modelFile = new Map(
  [...buildView.modelsById.keys()].map((modelId, index) => [modelId, `verified-${String(index).padStart(4, "0")}.html`]),
);

function renderer(name) {
  assert.equal(typeof siteBuilder[name], "function", `${name} must be exported as a pure renderer`);
  return siteBuilder[name];
}

function matches(source, pattern) {
  return [...source.matchAll(pattern)];
}

function count(source, marker) {
  return source.split(marker).length - 1;
}

function decodeHtmlText(value) {
  return value
    .replace(/&lt;/gu, "<")
    .replace(/&gt;/gu, ">")
    .replace(/&quot;/gu, '"')
    .replace(/&#39;/gu, "'")
    .replace(/&amp;/gu, "&");
}

function extractCompositePrompt(html, chainId) {
  const prompts = matches(html, /<pre\b[^>]*id="combination-prompt-[^"]+"[^>]*><code>([\s\S]*?)<\/code><\/pre>/gu);
  assert.equal(prompts.length, 1, `${chainId}: unique composite prompt`);
  return decodeHtmlText(prompts[0][1]);
}

function read(root, relativePath) {
  return readFileSync(join(root, relativePath), "utf8");
}

function createIsolatedBuilder(t) {
  const fixtureRoot = realpathSync(mkdtempSync(join(tmpdir(), "combination-workshop-")));
  const toolsDir = join(fixtureRoot, "tools");
  mkdirSync(toolsDir, { recursive: true });
  copyFileSync(join(ROOT, "tools", "build-site.mjs"), join(toolsDir, "build-site.mjs"));
  symlinkSync(join(ROOT, "tools", "lib"), join(toolsDir, "lib"));
  symlinkSync(join(ROOT, "tools", "site-assets"), join(toolsDir, "site-assets"));
  cpSync(join(ROOT, "knowledge"), join(fixtureRoot, "knowledge"), { recursive: true });
  cpSync(join(ROOT, "chain-protocols"), join(fixtureRoot, "chain-protocols"), { recursive: true });
  t.after(() => rmSync(fixtureRoot, { recursive: true, force: true }));
  return { builder: join(toolsDir, "build-site.mjs"), fixtureRoot };
}

test("combination index renders exactly the five validated Chains in stable ID order", () => {
  const html = renderer("renderCombinationIndex")({ chainsById: buildView.chainsById });
  const cards = matches(html, /data-combination-card="([^"]+)"/gu).map((match) => match[1]);

  assert.deepEqual(cards, CHAIN_IDS);
  assert.match(html, /单体模型/u);
  assert.match(html, /主题精选/u);
  assert.match(html, /组合协议/u);
  assert.doesNotMatch(html, /成功率|完成时长|预计耗时/u);
  for (const chainId of CHAIN_IDS) {
    assert.match(html, new RegExp(`href="${chainId}\\.html"`, "u"));
  }
});

test("all five detail renderers preserve real phase order, stable model links, and earlier loop anchors", () => {
  const renderDetail = renderer("renderCombinationDetail");
  const knownModelUrls = new Set([...modelFile.values()].map((file) => `../models/${file}`));

  for (const chainId of CHAIN_IDS) {
    const chain = buildView.chainsById.get(chainId);
    const html = renderDetail({ chain, modelsById: buildView.modelsById, chapterById, modelFile });
    const renderedSectionOrder = matches(html, /data-combination-section="([^"]+)"/gu).map((match) => match[1]);
    const phases = matches(html, /<li\b[^>]*data-phase-id="([^"]+)"[^>]*data-phase-order="(\d+)"/gu);
    const modelLinks = matches(html, /<a\b[^>]*data-chain-model-id="([^"]+)"[^>]*href="([^"]+)"/gu);

    assert.deepEqual(renderedSectionOrder, SECTION_ORDER, chainId);
    assert.equal(count(html, '<ol class="combination-phases"'), 1, chainId);
    assert.deepEqual(phases.map((match) => match[1]), chain.phases.map((phase) => phase.id), chainId);
    assert.deepEqual(phases.map((match) => Number(match[2])), chain.phases.map((phase) => phase.order), chainId);
    assert.equal(modelLinks.length, chain.phases.reduce((sum, phase) => sum + phase.model_ids.length, 0), chainId);
    for (const [, modelId, href] of modelLinks) {
      assert.ok(buildView.modelsById.has(modelId), `${chainId}: ${modelId}`);
      assert.equal(href, `../models/${modelFile.get(modelId)}`, `${chainId}: ${modelId}`);
      assert.ok(knownModelUrls.has(href), `${chainId}: ${href}`);
    }
    for (const phase of chain.phases) {
      assert.match(html, new RegExp(`data-phase-role="${phase.agent_role}"`, "u"), `${chainId}:${phase.id}:role`);
      assert.match(html, new RegExp(`data-phase-checkpoint="${phase.id}"`, "u"), `${chainId}:${phase.id}:checkpoint`);
      if (phase.loop_back_to === null) continue;
      const target = chain.phases.find((candidate) => candidate.id === phase.loop_back_to);
      assert.ok(target.order < phase.order, `${chainId}:${phase.id}:loop order`);
      assert.match(
        html,
        new RegExp(`data-loop-from="${phase.id}"[^>]*href="#phase-${phase.loop_back_to}"`, "u"),
        `${chainId}:${phase.id}:loop anchor`,
      );
    }
    assert.match(html, /使用前需要提供的输入/u, chainId);
    assert.match(html, /不适用与停止条件/u, chainId);
    assert.match(html, /复合 Prompt/u, chainId);
    assert.match(html, /由已验证阶段协议在构建时编排/u, chainId);
    assert.match(html, /事实、假设与专业升级/u, chainId);
    assert.equal(
      html,
      renderDetail({ chain, modelsById: buildView.modelsById, chapterById, modelFile }),
      `${chainId}: deterministic renderer`,
    );
    assert.doesNotMatch(html, /源数据自带|JSON 原生字段/u, chainId);
    assert.doesNotMatch(html, /\son[a-z]+\s*=/iu, chainId);
  }
});

test("each composite Prompt subtree contains the complete validated Chain meta and phase contract", () => {
  const renderDetail = renderer("renderCombinationDetail");

  for (const chainId of CHAIN_IDS) {
    const chain = buildView.chainsById.get(chainId);
    const html = renderDetail({ chain, modelsById: buildView.modelsById, chapterById, modelFile });
    const prompt = extractCompositePrompt(html, chainId);

    assert.match(prompt, /由已验证阶段协议在构建时编排/u, chainId);
    for (const value of [chain.meta.title, chain.meta.description, chain.meta.agent_flow, ...chain.meta.problem_types, ...chain.meta.trigger_signals]) {
      assert.ok(prompt.includes(value), `${chainId}: missing meta value ${value}`);
    }
    for (const phase of chain.phases) {
      for (const value of [phase.input, phase.output, phase.checkpoint, phase.stop_condition]) {
        assert.ok(prompt.includes(value), `${chainId}:${phase.id}: missing ${value}`);
      }
      const expectedLoop = phase.loop_back_to === null
        ? "回环：无"
        : `回环：未通过时回到 ${chain.phases.find((candidate) => candidate.id === phase.loop_back_to).name}`;
      assert.ok(prompt.includes(expectedLoop), `${chainId}:${phase.id}: missing ${expectedLoop}`);
    }
  }
});

test("detail model resolution cannot fall back from stable ID to a display name", () => {
  const renderDetail = renderer("renderCombinationDetail");
  const chain = buildView.chainsById.get(CHAIN_IDS[0]);
  const modelId = chain.phases[0].model_ids[0];
  const displayName = "NAME_FALLBACK_SENTINEL";
  const modelsById = new Map(buildView.modelsById);
  const originalModel = buildView.modelsById.get(modelId);
  modelsById.set(modelId, { ...originalModel, meta: { ...originalModel.meta, name: displayName } });
  const invalidFiles = new Map(modelFile);
  invalidFiles.delete(modelId);
  invalidFiles.set(displayName, "forbidden-name-fallback.html");

  assert.throws(
    () => renderDetail({ chain, modelsById, chapterById, modelFile: invalidFiles }),
    new RegExp(modelId.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&"), "u"),
  );
});

test("reverse-link renderer exposes one stable entry per validated composition", () => {
  const renderLinks = renderer("renderCompositionLinks");

  for (const [modelId, compositions] of buildView.compositionsByModelId) {
    const html = renderLinks(compositions);
    assert.equal(count(html, "data-composition-entry"), compositions.length, modelId);
    assert.deepEqual(
      matches(html, /href="\.\.\/combinations\/([^"]+)\.html"/gu).map((match) => match[1]),
      compositions.map((composition) => composition.chain_id),
      modelId,
    );
  }

  for (const [chapterId, compositions] of buildView.compositionsByChapterId) {
    const firstByChain = compositions.filter(
      (composition, index) => compositions.findIndex((candidate) => candidate.chain_id === composition.chain_id) === index,
    );
    const html = renderLinks(firstByChain);
    assert.equal(count(html, "data-composition-entry"), new Set(compositions.map(({ chain_id }) => chain_id)).size, chapterId);
  }
});

test("real build emits six discoverable pages and reverse entries matching the validated loader maps", (t) => {
  const { builder, fixtureRoot } = createIsolatedBuilder(t);
  execFileSync(process.execPath, [builder], { cwd: fixtureRoot, encoding: "utf8" });

  const siteRoot = join(fixtureRoot, "site");
  const docsRoot = join(fixtureRoot, "docs");
  const combinationPaths = ["combinations/index.html", ...CHAIN_IDS.map((id) => `combinations/${id}.html`)];
  for (const path of combinationPaths) {
    assert.equal(existsSync(join(siteRoot, path)), true, path);
    assert.equal(read(siteRoot, path), read(docsRoot, path), path);
  }

  const indexPage = read(siteRoot, "combinations/index.html");
  assert.match(indexPage, /<a href="\.\.\/combinations\/index\.html" aria-current="page">组合工坊<\/a>/u);
  assert.match(indexPage, /模型库[\s\S]*组合工坊[\s\S]*Agent 路由/u);
  const home = read(siteRoot, "index.html");
  assert.deepEqual(matches(home, /data-home-combination="([^"]+)"/gu).map((match) => match[1]), CHAIN_IDS);
  assert.ok(home.indexOf("主题精选不是组合协议") < home.indexOf('data-home-combination="'), "theme collections precede combinations");
  assert.doesNotMatch(home, /内容整理中/u);

  const sitemap = read(siteRoot, "sitemap.xml");
  for (const path of ["/combinations/", ...CHAIN_IDS.map((id) => `/combinations/${id}.html`)]) {
    assert.match(sitemap, new RegExp(`<loc>https://xmind\\.lute-tlz-dddd\\.top${path.replaceAll("/", "\\/")}</loc>`, "u"));
  }
  const notFound = read(siteRoot, "404.html");
  const recoverySection = notFound.match(/<section\b[^>]*class="not-found section-shell"[^>]*>([\s\S]*?)<\/section>/u);
  assert.ok(recoverySection, "404 recovery section");
  const recoveryLinks = new Map(
    matches(recoverySection[1], /<a\b[^>]*href="([^"]+)"[^>]*>([^<]+)<\/a>/gu).map((match) => [match[2], match[1]]),
  );
  const expectedRecoveryPaths = new Map([
    ["返回首页", "/"],
    ["浏览模型库", "/models/"],
    ["进入组合工坊", "/combinations/"],
    ["使用 Agent 路由", "/router.html"],
  ]);
  assert.deepEqual([...recoveryLinks.keys()], [...expectedRecoveryPaths.keys()]);
  for (const base of [
    "https://xmind.lute-tlz-dddd.top/models/missing.html",
    "https://xmind.lute-tlz-dddd.top/chapters/deep/missing.html",
    "https://xmind.lute-tlz-dddd.top/combinations/archive/deep/missing.html",
  ]) {
    for (const [label, pathname] of expectedRecoveryPaths) {
      assert.equal(new URL(recoveryLinks.get(label), base).pathname, pathname, `${base}: ${label}`);
    }
  }

  const modelFileById = new Map();
  for (const path of CHAIN_IDS.map((id) => `combinations/${id}.html`)) {
    const html = read(siteRoot, path);
    for (const [, modelId, filename] of matches(html, /data-chain-model-id="([^"]+)"[^>]*href="\.\.\/models\/([^"]+)"/gu)) {
      modelFileById.set(modelId, filename);
    }
  }
  assert.deepEqual(new Set(modelFileById.keys()), new Set(buildView.compositionsByModelId.keys()));
  for (const [modelId, compositions] of buildView.compositionsByModelId) {
    const html = read(siteRoot, `models/${modelFileById.get(modelId)}`);
    assert.equal(count(html, "data-composition-entry"), compositions.length, modelId);
  }
  const modelPagesWithReverseEntry = readdirSync(join(siteRoot, "models"))
    .filter((filename) => filename.endsWith(".html"))
    .filter((filename) => read(siteRoot, `models/${filename}`).includes("data-model-compositions"));
  assert.equal(modelPagesWithReverseEntry.length, buildView.compositionsByModelId.size);

  for (const chapter of taxonomy.chapters) {
    const html = read(siteRoot, `chapters/ch${chapter.id}-${chapter.slug}.html`);
    const compositions = buildView.compositionsByChapterId.get(chapter.id) ?? [];
    const expected = new Set(compositions.map(({ chain_id }) => chain_id)).size;
    assert.equal(count(html, "data-composition-entry"), expected, chapter.id);
    assert.equal(html.includes("data-chapter-compositions"), expected > 0, chapter.id);
  }
});
