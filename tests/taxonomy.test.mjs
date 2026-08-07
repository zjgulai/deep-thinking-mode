import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import { validateContract } from "../tools/lib/contracts.mjs";

const FIXTURE = join(dirname(fileURLToPath(import.meta.url)), "..", "knowledge", "taxonomy.json");

function baselineCountSum(chapters) {
  return chapters.reduce((total, chapter) => total + chapter.baseline_source_count, 0);
}

test("taxonomy: validates contract and 13-章约束", async () => {
  const raw = await readFile(FIXTURE, "utf8");
  const taxonomy = JSON.parse(raw);
  validateContract("taxonomy", taxonomy);

  assert.equal(taxonomy.chapters.length, 13, "taxonomy chapters must be 13");
  assert.equal(baselineCountSum(taxonomy.chapters), 418, "baseline count must equal 418");
  assert.equal(taxonomy.content_types.length, 6);
  assert.equal(taxonomy.risk_flags.length, 4);
});

test("taxonomy: chapter ids and orders are deterministic", async () => {
  const taxonomy = JSON.parse(await readFile(FIXTURE, "utf8"));
  const ids = taxonomy.chapters.map((chapter) => chapter.id);
  const orders = taxonomy.chapters.map((chapter) => chapter.order);
  assert.deepEqual(ids, Array.from({ length: 13 }, (_, index) => String(index).padStart(2, "0")));
  assert.deepEqual(orders, Array.from({ length: 13 }, (_, index) => index));
});
