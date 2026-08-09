#!/usr/bin/env node
import { lstat, readFile, readdir, writeFile } from "node:fs/promises";
import { join, relative, resolve, sep } from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const MANIFEST_PATH = join(ROOT, "tools", "config", "public-paths.json");
const ROOT_FILES = new Set([
  ".gitignore",
  ".graphifyignore",
  ".npmrc",
  ".nvmrc",
  "README.md",
  "package-lock.json",
  "package.json",
]);
const ROOT_DIRS = new Set([
  ".github",
  "chain-protocols",
  "deploy",
  "docs",
  "knowledge",
  "manuals",
  "site",
  "specs",
  "tests",
  "tools",
]);

function toPosix(path) {
  return path.split(sep).join("/");
}

function isGeneratedDeploymentPath(path) {
  return (
    path === "deploy/tencent-cloud/xmind-site/.env" ||
    path.startsWith("deploy/tencent-cloud/xmind-site/audit/") ||
    path.startsWith("deploy/tencent-cloud/xmind-site/dist/") ||
    (path.startsWith("deploy/tencent-cloud/xmind-site/context/site/") &&
      path !== "deploy/tencent-cloud/xmind-site/context/site/.gitignore")
  );
}

async function walk(directory, paths) {
  const entries = await readdir(directory, { withFileTypes: true });
  entries.sort((left, right) => left.name.localeCompare(right.name, "en"));
  for (const entry of entries) {
    const absolute = join(directory, entry.name);
    const path = toPosix(relative(ROOT, absolute));
    if (isGeneratedDeploymentPath(path)) continue;
    const stat = await lstat(absolute);
    if (stat.isSymbolicLink()) throw new Error(`公开清单拒绝软链: ${path}`);
    if (stat.isDirectory()) await walk(absolute, paths);
    else if (stat.isFile()) paths.push(path);
    else throw new Error(`公开清单拒绝特殊文件: ${path}`);
  }
}

export async function collectPublicManifestPaths() {
  const paths = [];
  for (const name of [...ROOT_FILES].sort()) {
    const absolute = resolve(ROOT, name);
    const stat = await lstat(absolute);
    if (!stat.isFile()) throw new Error(`公开根文件缺失或类型错误: ${name}`);
    paths.push(name);
  }
  for (const name of [...ROOT_DIRS].sort()) await walk(resolve(ROOT, name), paths);
  return [...new Set(paths)].sort();
}

function serialize(paths) {
  return `${JSON.stringify({ version: 1, description: "公开发布文件清单", paths }, null, 2)}\n`;
}

const paths = await collectPublicManifestPaths();
const expected = serialize(paths);
if (process.argv.includes("--check")) {
  const actual = await readFile(MANIFEST_PATH, "utf8");
  if (actual !== expected) {
    console.error("✗ 公开路径清单与当前候选工作区不一致；运行 npm run manifest:update 后审查 diff");
    process.exitCode = 1;
  } else {
    console.log(`✓ public manifest matches candidate worktree: ${paths.length} paths`);
  }
} else {
  await writeFile(MANIFEST_PATH, expected, "utf8");
  console.log(`✓ public manifest updated: ${paths.length} paths`);
}
