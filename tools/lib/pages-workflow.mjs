#!/usr/bin/env node
/**
 * tools/lib/pages-workflow.mjs
 *
 * Deterministically render the complete .github/workflows/pages.yml bytes
 * from the checked-in pin configuration.
 */

import { readFile } from "node:fs/promises";
import { join } from "node:path";

const PINS_PATH = "tools/config/github-actions-pins.json";
const NODE_VERSION = "24.18.0";

export async function loadPins(rootDir = ".") {
  const raw = await readFile(join(rootDir, PINS_PATH), "utf8");
  return JSON.parse(raw);
}

export function validatePins(pins) {
  const REQUIRED = [
    "actions/checkout",
    "actions/setup-node",
    "actions/configure-pages",
    "actions/upload-pages-artifact",
    "actions/deploy-pages",
  ];
  const FULL_SHA = /^[0-9a-f]{40}$/;

  for (const action of REQUIRED) {
    if (!Object.prototype.hasOwnProperty.call(pins, action)) {
      throw new Error(`Missing pin for ${action}`);
    }
    const { sha } = pins[action];
    if (typeof sha !== "string" || !FULL_SHA.test(sha)) {
      throw new Error(`Invalid SHA for ${action}: ${sha}`);
    }
  }

  const extra = Object.keys(pins).filter((k) => !REQUIRED.includes(k));
  if (extra.length > 0) {
    throw new Error(`Unexpected actions in pins: ${extra.join(", ")}`);
  }

  // No duplicates
  const shas = Object.values(pins).map((p) => p.sha);
  const uniqueShas = new Set(shas);
  if (uniqueShas.size !== shas.length) {
    throw new Error("Duplicate SHAs in pin configuration");
  }
}

/**
 * Render the complete canonical workflow YAML as a UTF-8 string.
 * This is deterministic — same pins always produce the same output.
 */
export function renderPagesWorkflow(pins) {
  validatePins(pins);

  const co  = pins["actions/checkout"].sha;
  const sn  = pins["actions/setup-node"].sha;
  const cp  = pins["actions/configure-pages"].sha;
  const upa = pins["actions/upload-pages-artifact"].sha;
  const dp  = pins["actions/deploy-pages"].sha;

  return `name: Deploy to GitHub Pages

on:
  push:
    branches: [main]
  workflow_dispatch:

permissions:
  contents: read

concurrency:
  group: pages
  cancel-in-progress: false

jobs:
  build:
    runs-on: ubuntu-latest
    steps:
      - name: Checkout
        uses: actions/checkout@${co}  # ${pins["actions/checkout"].tag}
        with:
          fetch-depth: 1
          persist-credentials: false

      - name: Setup Node
        uses: actions/setup-node@${sn}  # ${pins["actions/setup-node"].tag}
        with:
          node-version: ${NODE_VERSION}
          cache: npm

      - name: Install dependencies
        run: npm ci

      - name: Run tests
        run: npm test

      - name: Run checks
        run: npm run check

      - name: Build site
        run: npm run build

      - name: Verify no site drift
        run: git diff --exit-code -- site docs

      - name: Check public artifact
        run: npm run check:public

      - name: Check public manifest drift
        run: npm run manifest:check

      - name: Check public tree
        run: node tools/check-public-tree.mjs --git-ref HEAD --manifest tools/config/public-paths.json

      - name: Setup Pages
        uses: actions/configure-pages@${cp}  # ${pins["actions/configure-pages"].tag}

      - name: Upload artifact
        uses: actions/upload-pages-artifact@${upa}  # ${pins["actions/upload-pages-artifact"].tag}
        with:
          path: ./site

  deploy:
    needs: build
    if: github.ref == 'refs/heads/main'
    environment:
      name: github-pages
      url: \${{ steps.deployment.outputs.page_url }}
    runs-on: ubuntu-latest
    permissions:
      pages: write
      id-token: write
    steps:
      - name: Deploy to GitHub Pages
        id: deployment
        uses: actions/deploy-pages@${dp}  # ${pins["actions/deploy-pages"].tag}
`;
}

/**
 * Return the canonical workflow bytes for the current pin configuration.
 */
export async function getCanonicalWorkflowBytes(rootDir = ".") {
  const pins = await loadPins(rootDir);
  return Buffer.from(renderPagesWorkflow(pins), "utf8");
}
