import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import {
  createBigrams,
  detectAgentStage,
  matchRoute,
  normalizeRouterText,
  scoreProblemTypes
} from "../tools/site-assets/router-engine.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const goldenCases = JSON.parse(await readFile(join(ROOT, "tests/fixtures/router/router-golden-cases.json"), "utf8"));
const routerData = JSON.parse(await readFile(join(ROOT, "chain-protocols/agent-router-index.json"), "utf8"));

const CASE_FIELDS = [
  "id",
  "group",
  "input",
  "shortcut_intent_id",
  "expected_state",
  "expected_problem_type_id",
  "allowed_auxiliary_type_ids",
  "expected_agent_stage_id",
  "allowed_chain_ids",
  "forbidden_problem_type_ids"
];

const PRODUCTION_REGRESSIONS = {
  "production-regression-01": "项目连续延期，我想判断根因并制定下一步计划",
  "production-regression-02": "迷茫，不知道下一步怎么办",
  "production-regression-03": "比较利弊",
  "production-regression-04": "哪里出了问题",
  "production-regression-05": "讲不清重点",
  "production-regression-06": "有没有别的思路可以突破现在的方案",
  "production-regression-07": "资料太多，不知道怎么整理出结论"
};

function runGoldenCase(entry) {
  return matchRoute({
    query: entry.input,
    shortcutIntentId: entry.shortcut_intent_id,
    routerData
  });
}

test("router golden corpus has the frozen 96-case composition and literal regression inputs", () => {
  assert.equal(goldenCases.length, 96);
  assert.equal(new Set(goldenCases.map(({ id }) => id)).size, 96);
  for (const entry of goldenCases) assert.deepEqual(Object.keys(entry), CASE_FIELDS, entry.id);

  const singleIntent = goldenCases.filter(({ group }) => group === "single_intent");
  const multiIntent = goldenCases.filter(({ group }) => group === "multi_intent");
  const uncertainOrSafety = goldenCases.filter(({ group }) => group === "uncertain_or_safety");
  assert.equal(singleIntent.length, 64);
  assert.equal(multiIntent.length, 16);
  assert.equal(uncertainOrSafety.length, 16);
  assert.deepEqual(
    Object.fromEntries(routerData.problem_types.map(({ id }) => [id, singleIntent.filter((entry) => entry.expected_problem_type_id === id).length])),
    {
      diagnosis: 8,
      planning: 8,
      decision: 8,
      creative: 8,
      research: 8,
      reflection: 8,
      communication: 8,
      clarification: 8
    }
  );
  assert.deepEqual(
    Object.fromEntries(goldenCases.filter(({ id }) => id.startsWith("production-regression-")).map(({ id, input }) => [id, input])),
    PRODUCTION_REGRESSIONS
  );
});

test("normalizeRouterText applies NFKC, Unicode lowercase, punctuation folding, and compact text", () => {
  assert.deepEqual(normalizeRouterText("  ＡＰＩ，　测试！Foo_Bar  "), {
    normalizedText: "api 测试 foo bar",
    compactText: "api测试foobar"
  });
  assert.deepEqual(normalizeRouterText("Foo+Bar"), {
    normalizedText: "foobar",
    compactText: "foobar"
  });
  assert.deepEqual(normalizeRouterText(null), { normalizedText: "", compactText: "" });
});

test("createBigrams returns deterministic unique adjacent character pairs", () => {
  assert.deepEqual([...createBigrams("思维abc")], ["思维", "维a", "ab", "bc"]);
  assert.deepEqual([...createBigrams("")], []);
});

test("scoreProblemTypes counts a positive phrase once, applies negatives, and rewards only the matching shortcut", () => {
  const problemTypes = [
    {
      id: "alpha",
      priority: 20,
      positive_phrases: [{ text: "原因", weight: 8 }],
      negative_phrases: [{ text: "不需要原因", weight: 10 }],
      examples: ["完全无关"]
    },
    {
      id: "beta",
      priority: 10,
      positive_phrases: [{ text: "计划", weight: 8 }],
      negative_phrases: [],
      examples: ["另一件事"]
    }
  ];

  const repeated = scoreProblemTypes({ query: "原因原因原因", shortcutIntentId: null, problemTypes });
  assert.equal(repeated[0].id, "alpha");
  assert.equal(repeated[0].score, 8);
  assert.deepEqual(repeated[0].matchedPositivePhrases, ["原因"]);

  const negated = scoreProblemTypes({ query: "不需要原因", shortcutIntentId: null, problemTypes });
  assert.equal(negated.find(({ id }) => id === "alpha").score, 0);
  assert.deepEqual(negated.find(({ id }) => id === "alpha").matchedNegativePhrases, ["不需要原因"]);

  const shortcut = scoreProblemTypes({ query: "无关背景", shortcutIntentId: "beta", problemTypes });
  assert.equal(shortcut[0].id, "beta");
  assert.equal(shortcut[0].score, 8);
  assert.equal(shortcut[0].shortcutMatched, true);
  assert.equal(shortcut.find(({ id }) => id === "alpha").shortcutMatched, false);
});

test("scoreProblemTypes resolves ties by priority and then ASCII id", () => {
  const problemTypes = ["beta", "alpha", "gamma"].map((id) => ({
    id,
    priority: id === "gamma" ? 5 : 10,
    positive_phrases: [{ text: "命中", weight: 8 }],
    negative_phrases: [],
    examples: []
  }));
  assert.deepEqual(
    scoreProblemTypes({ query: "命中", shortcutIntentId: null, problemTypes }).map(({ id }) => id),
    ["gamma", "alpha", "beta"]
  );
});

test("detectAgentStage uses the strongest stage signal, stable priority ties, and intent fallback", () => {
  assert.equal(detectAgentStage({ query: "搜集信息并输出报告", agentStages: routerData.agent_stages }), "research");
  assert.equal(detectAgentStage({ query: "没有明确阶段", agentStages: routerData.agent_stages }), "intent");
});

test("matchRoute exposes only the frozen local-rule result contract", () => {
  assert.equal(matchRoute({ query: null, routerData }).state, "idle");
  assert.equal(matchRoute({ query: "！", routerData }).state, "needs_input");
  const result = matchRoute({ query: "为什么失败了", routerData });
  assert.deepEqual(Object.keys(result), [
    "state",
    "problemTypeId",
    "auxiliaryProblemTypeIds",
    "agentStageId",
    "evidence",
    "clarificationOptionIds",
    "safetySignalId"
  ]);
  assert.deepEqual(Object.keys(result.evidence), [
    "matchedPositivePhrases",
    "matchedNegativePhrases",
    "closestExample",
    "shortcutIntentId"
  ]);
  assert.equal(result.state, "matched");
  assert.equal(result.problemTypeId, "diagnosis");
});

test("router matches every golden case with bounded auxiliaries and no forbidden type", async (t) => {
  for (const entry of goldenCases) {
    await t.test(entry.id, () => {
      const result = runGoldenCase(entry);
      assert.equal(result.state, entry.expected_state);
      assert.equal(result.problemTypeId, entry.expected_problem_type_id);
      assert.equal(result.agentStageId, entry.expected_agent_stage_id);
      assert.ok(result.auxiliaryProblemTypeIds.length <= 2);
      assert.ok(result.auxiliaryProblemTypeIds.every((id) => entry.allowed_auxiliary_type_ids.includes(id)));
      const returnedTypes = [result.problemTypeId, ...result.auxiliaryProblemTypeIds].filter(Boolean);
      assert.ok(entry.forbidden_problem_type_ids.every((id) => !returnedTypes.includes(id)));
      if (result.state === "clarify") {
        assert.ok(result.clarificationOptionIds.length >= 2);
        assert.ok(result.clarificationOptionIds.length <= 4);
      } else {
        assert.deepEqual(result.clarificationOptionIds, []);
      }
      if (result.state === "safety_stop") assert.ok(result.safetySignalId);
      else assert.equal(result.safetySignalId, null);
    });
  }
});

test("router clears all three frozen aggregate quality gates", () => {
  const singleIntent = goldenCases.filter(({ group }) => group === "single_intent");
  const multiIntent = goldenCases.filter(({ group }) => group === "multi_intent");
  const uncertainOrSafety = goldenCases.filter(({ group }) => group === "uncertain_or_safety");
  const singleCorrect = singleIntent.filter((entry) => runGoldenCase(entry).problemTypeId === entry.expected_problem_type_id).length;
  const multiCorrect = multiIntent.filter((entry) => runGoldenCase(entry).problemTypeId === entry.expected_problem_type_id).length;
  const uncertainSafe = uncertainOrSafety.filter((entry) => ["clarify", "safety_stop"].includes(runGoldenCase(entry).state)).length;

  assert.ok(singleCorrect / singleIntent.length >= 0.85, `single-intent Top-1 ${singleCorrect}/64`);
  assert.ok(multiCorrect / multiIntent.length >= 0.8, `multi-intent core ${multiCorrect}/16`);
  assert.equal(uncertainSafe, uncertainOrSafety.length);
});
