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
const routeKeys = routerData.routes.map(({ id }) => id);
const routeKeySet = new Set(routeKeys);
const compactRouterData = {
  schema_version: routerData.schema_version,
  problem_types: routerData.problem_types,
  agent_stages: routerData.agent_stages,
  safety_signals: routerData.safety_signals,
  route_keys: routeKeys
};

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

function syntheticType(id, { priority = 10, positive = [], negative = [], examples = [] } = {}) {
  return {
    id,
    priority,
    positive_phrases: positive.map(([text, weight]) => ({ text, weight })),
    negative_phrases: negative.map(([text, weight]) => ({ text, weight })),
    examples
  };
}

function syntheticRouterData(problemTypes, { agentStages, routeKeys: syntheticRouteKeys, safetySignals = [] } = {}) {
  assert.ok(Array.isArray(syntheticRouteKeys), "synthetic Router data must declare routeKeys");
  return {
    problem_types: problemTypes,
    agent_stages: agentStages ?? [{ id: "intent", priority: 10, positive_phrases: [] }],
    safety_signals: safetySignals,
    route_keys: syntheticRouteKeys
  };
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

test("example Jaccard reward honors the 0.22 boundary, floor, and six-point cap", () => {
  const belowBoundary = syntheticType("below", { examples: ["abxyz"] });
  const atOrAboveBoundary = syntheticType("boundary", { examples: ["abde"] });
  const halfSimilar = syntheticType("half", { examples: ["abce"] });
  const identical = syntheticType("identical", { examples: ["abcd"] });

  assert.deepEqual(
    scoreProblemTypes({ query: "abcdef", shortcutIntentId: null, problemTypes: [belowBoundary] })[0],
    {
      id: "below",
      priority: 10,
      score: 0,
      matchedPositivePhrases: [],
      matchedNegativePhrases: [],
      closestExample: null,
      shortcutMatched: false
    }
  );
  assert.equal(scoreProblemTypes({ query: "abc", shortcutIntentId: null, problemTypes: [atOrAboveBoundary] })[0].score, 1);
  assert.equal(scoreProblemTypes({ query: "abcd", shortcutIntentId: null, problemTypes: [halfSimilar] })[0].score, 3);
  assert.equal(scoreProblemTypes({ query: "abcd", shortcutIntentId: null, problemTypes: [identical] })[0].score, 6);
});

test("an example-only six-point score cannot produce matched", () => {
  const data = syntheticRouterData([
    syntheticType("example-only", { examples: ["完整示例"] }),
    syntheticType("other", { priority: 20 })
  ], { routeKeys: ["example-only::intent", "other::intent"] });
  const result = matchRoute({ query: "完整示例", routerData: data });
  assert.equal(result.state, "clarify");
  assert.equal(result.problemTypeId, null);
});

test("match thresholds distinguish seven, eight, double-six, and score gaps of one versus two", () => {
  const resultFor = (firstWeight, secondWeight = 0) => matchRoute({
    query: "甲信号和乙信号",
    routerData: syntheticRouterData([
      syntheticType("first", { positive: [["甲信号", firstWeight]] }),
      syntheticType("second", { priority: 20, positive: secondWeight ? [["乙信号", secondWeight]] : [] })
    ], { routeKeys: ["first::intent", "second::intent"] })
  });

  assert.equal(resultFor(7).state, "clarify");
  assert.equal(resultFor(8).state, "matched");
  assert.equal(resultFor(6, 6).state, "clarify");
  assert.equal(resultFor(9, 8).state, "clarify");
  assert.equal(resultFor(10, 8).state, "matched");
});

test("auxiliaries use the six-point threshold, only the second and third ranks, and never exceed two", () => {
  const query = "核心信号第二信号第三信号第四信号";
  const full = matchRoute({
    query,
    routerData: syntheticRouterData([
      syntheticType("core", { positive: [["核心信号", 10]] }),
      syntheticType("second", { priority: 20, positive: [["第二信号", 7]] }),
      syntheticType("third", { priority: 30, positive: [["第三信号", 6]] }),
      syntheticType("fourth", { priority: 40, positive: [["第四信号", 6]] })
    ], { routeKeys: ["core::intent", "second::intent", "third::intent", "fourth::intent"] })
  });
  assert.deepEqual(full.auxiliaryProblemTypeIds, ["second", "third"]);

  const belowThreshold = matchRoute({
    query,
    routerData: syntheticRouterData([
      syntheticType("core", { positive: [["核心信号", 10]] }),
      syntheticType("second", { priority: 20, positive: [["第二信号", 6]] }),
      syntheticType("third", { priority: 30, positive: [["第三信号", 5]] })
    ], { routeKeys: ["core::intent", "second::intent", "third::intent"] })
  });
  assert.deepEqual(belowThreshold.auxiliaryProblemTypeIds, ["second"]);
});

test("matchRoute applies shortcut plus eight and exposes the selected shortcut as evidence", () => {
  const result = matchRoute({
    query: "背景",
    shortcutIntentId: "selected",
    routerData: syntheticRouterData([
      syntheticType("selected"),
      syntheticType("other", { priority: 20 })
    ], { routeKeys: ["selected::intent", "other::intent"] })
  });
  assert.equal(result.state, "matched");
  assert.equal(result.problemTypeId, "selected");
  assert.deepEqual(result.evidence.matchedPositivePhrases, []);
  assert.equal(result.evidence.shortcutIntentId, "selected");
});

test("detectAgentStage uses the strongest stage signal, stable priority ties, and intent fallback", () => {
  assert.equal(detectAgentStage({ query: "搜集信息并输出报告", agentStages: routerData.agent_stages }), "research");
  assert.equal(detectAgentStage({ query: "没有明确阶段", agentStages: routerData.agent_stages }), "intent");
});

test("detectAgentStage resolves real score ties by priority and then ASCII id", () => {
  const stage = (id, priority) => ({ id, priority, positive_phrases: [{ text: "阶段信号", weight: 8 }] });
  assert.equal(detectAgentStage({ query: "阶段信号", agentStages: [stage("beta", 5), stage("alpha", 10)] }), "beta");
  assert.equal(detectAgentStage({ query: "阶段信号", agentStages: [stage("beta", 10), stage("alpha", 10)] }), "alpha");
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

test("matchRoute produces identical results from canonical routes and compact route keys", () => {
  for (const entry of goldenCases) {
    const request = { query: entry.input, shortcutIntentId: entry.shortcut_intent_id };
    assert.deepEqual(
      matchRoute({ ...request, routerData: routerData }),
      matchRoute({ ...request, routerData: compactRouterData }),
      entry.id
    );
  }
});

test("matched core stage falls back by stage priority and then ASCII id", () => {
  const problemTypes = [
    syntheticType("core", { positive: [["核心信号", 10]] }),
    syntheticType("other", { priority: 20 })
  ];
  const agentStages = [
    { id: "raw", priority: 10, positive_phrases: [{ text: "阶段信号", weight: 8 }] },
    { id: "beta", priority: 20, positive_phrases: [] },
    { id: "zeta", priority: 30, positive_phrases: [] },
    { id: "alpha", priority: 30, positive_phrases: [] }
  ];
  const resultFor = (syntheticRouteKeys) => matchRoute({
    query: "核心信号和阶段信号",
    routerData: syntheticRouterData(problemTypes, { agentStages, routeKeys: syntheticRouteKeys })
  });

  for (const keys of [["core::alpha", "core::beta"], ["core::beta", "core::alpha"]]) {
    const result = resultFor(keys);
    assert.equal(result.state, "matched");
    assert.equal(result.agentStageId, "beta");
  }
  assert.equal(resultFor(["core::zeta", "core::alpha"]).agentStageId, "alpha");
});

test("missing, malformed, empty, or unknown route keys fail closed to clarify at the raw stage", () => {
  const problemTypes = [
    syntheticType("core", { positive: [["核心信号", 10]] }),
    syntheticType("other", { priority: 20 })
  ];
  const agentStages = [{ id: "raw", priority: 10, positive_phrases: [{ text: "阶段信号", weight: 8 }] }];
  const base = {
    problem_types: problemTypes,
    agent_stages: agentStages,
    safety_signals: []
  };
  const invalidSources = [
    { ...base },
    { ...base, route_keys: [] },
    { ...base, route_keys: "core::raw", routes: [{ id: "core::raw" }] },
    { ...base, route_keys: [null, "core::raw"] },
    { ...base, route_keys: ["unknown::raw"] },
    { ...base, route_keys: ["core::unknown"] }
  ];

  for (const data of invalidSources) {
    const result = matchRoute({ query: "核心信号和阶段信号", routerData: data });
    assert.equal(result.state, "clarify");
    assert.equal(result.problemTypeId, null);
    assert.equal(result.agentStageId, "raw");
    assert.deepEqual(result.clarificationOptionIds, ["core", "other"]);
  }

  const routesFallback = matchRoute({
    query: "核心信号和阶段信号",
    routerData: { ...base, routes: [{ id: "core::raw" }] }
  });
  assert.equal(routesFallback.state, "matched");
  assert.equal(routesFallback.agentStageId, "raw");
});

test("auxiliaries are route-filtered within the original second and third ranks without backfill", () => {
  const result = matchRoute({
    query: "核心信号第二信号第三信号第四信号",
    routerData: syntheticRouterData([
      syntheticType("core", { positive: [["核心信号", 10]] }),
      syntheticType("second", { priority: 20, positive: [["第二信号", 7]] }),
      syntheticType("third", { priority: 30, positive: [["第三信号", 6]] }),
      syntheticType("fourth", { priority: 40, positive: [["第四信号", 6]] })
    ], { routeKeys: ["core::intent", "third::intent", "fourth::intent"] })
  });
  assert.equal(result.state, "matched");
  assert.deepEqual(result.auxiliaryProblemTypeIds, ["third"]);
});

test("all 80 real matched outputs and seven production regressions close to the 23-route matrix", () => {
  const matched = goldenCases.map((entry) => ({ entry, result: runGoldenCase(entry) }))
    .filter(({ result }) => result.state === "matched");
  assert.equal(matched.length, 80);
  for (const { entry, result } of matched) {
    assert.ok(routeKeySet.has(`${result.problemTypeId}::${result.agentStageId}`), `${entry.id} core`);
    for (const auxiliaryId of result.auxiliaryProblemTypeIds) {
      assert.ok(routeKeySet.has(`${auxiliaryId}::${result.agentStageId}`), `${entry.id} auxiliary ${auxiliaryId}`);
    }
  }

  const regressions = matched.filter(({ entry }) => entry.id.startsWith("production-regression-"));
  assert.equal(regressions.length, 7);
  const communicationRegression = regressions.find(({ entry }) => entry.id === "production-regression-05").result;
  assert.equal(communicationRegression.problemTypeId, "communication");
  assert.equal(communicationRegression.agentStageId, "synthesis");
  assert.ok(routeKeySet.has("communication::synthesis"));
});

test("safety precedence is stable across input array order and covers all four signal classes", () => {
  const cases = [
    ["我正在伤害自己，请诊断我的症状，法律期限明天到期，也把全部积蓄马上买入", "immediate_personal_danger"],
    ["请诊断我的症状，法律期限明天到期，也把全部积蓄马上买入", "medical_diagnosis_or_treatment"],
    ["法律期限明天到期，也把全部积蓄马上买入", "legal_advice_with_deadline"],
    ["把全部积蓄马上买入", "high_stakes_financial_instruction"]
  ];
  for (const safetySignals of [routerData.safety_signals, [...routerData.safety_signals].reverse()]) {
    const data = { ...routerData, safety_signals: safetySignals };
    for (const [query, expectedSignalId] of cases) {
      const result = matchRoute({ query, routerData: data });
      assert.equal(result.state, "safety_stop");
      assert.equal(result.safetySignalId, expectedSignalId);
      assert.equal(result.problemTypeId, null);
    }
  }
});

test("unknown safety signal collisions fall back to ASCII id independent of array order", () => {
  const unknownSignals = [
    { id: "zeta", phrases: ["未知风险"] },
    { id: "alpha", phrases: ["未知风险"] }
  ];
  for (const safetySignals of [unknownSignals, [...unknownSignals].reverse()]) {
    const result = matchRoute({
      query: "发生未知风险",
      routerData: syntheticRouterData([], { routeKeys: [], safetySignals })
    });
    assert.equal(result.state, "safety_stop");
    assert.equal(result.safetySignalId, "alpha");
  }
});

test("safety stop wins over strong ordinary Router signals", () => {
  const result = matchRoute({
    query: "我正在伤害自己，同时需要制定计划和具体步骤",
    routerData
  });
  assert.equal(result.state, "safety_stop");
  assert.equal(result.safetySignalId, "immediate_personal_danger");
  assert.equal(result.problemTypeId, null);
  assert.deepEqual(result.auxiliaryProblemTypeIds, []);
});

test("every real negative phrase keeps its own type below matched threshold and prevents that core match", () => {
  for (const problemType of routerData.problem_types) {
    for (const { text } of problemType.negative_phrases) {
      const ownScore = scoreProblemTypes({
        query: text,
        shortcutIntentId: null,
        problemTypes: routerData.problem_types
      }).find(({ id }) => id === problemType.id);
      assert.ok(ownScore.score < 8, `${problemType.id}: ${text} scored ${ownScore.score}`);
      const result = matchRoute({ query: text, routerData });
      assert.notEqual(result.problemTypeId, problemType.id, `${problemType.id}: ${text}`);
    }
  }
});

test("composed planning and reflection negatives stay below the matched threshold", () => {
  for (const [query, problemTypeId] of [
    ["不需要规划下一步", "planning"],
    ["不需要复盘改进", "reflection"]
  ]) {
    const ownScore = scoreProblemTypes({
      query,
      shortcutIntentId: null,
      problemTypes: routerData.problem_types
    }).find(({ id }) => id === problemTypeId);
    assert.ok(ownScore.score < 8, `${problemTypeId}: ${query} scored ${ownScore.score}`);
    assert.notEqual(matchRoute({ query, routerData }).problemTypeId, problemTypeId, `${problemTypeId}: ${query}`);
  }
});

test("double negations preserve explicit planning, reflection, and research intent", () => {
  for (const [query, problemTypeId] of [
    ["不是不需要规划下一步，而是要明确规划下一步", "planning"],
    ["并非完全不需要复盘改进，而是必须复盘改进", "reflection"],
    ["并不是完全不需要基于证据研究，而是更需要基于证据研究", "research"]
  ]) {
    const result = matchRoute({ query, routerData });
    assert.equal(result.state, "matched", `${problemTypeId}: ${query}`);
    assert.equal(result.problemTypeId, problemTypeId, `${problemTypeId}: ${query}`);
  }
});

test("bounded inserted-word negatives cannot become planning, reflection, or research core matches", () => {
  for (const [query, problemTypeId] of [
    ["我不需要现在规划下一步", "planning"],
    ["我不需要复盘这次改进", "reflection"],
    ["我不需要基于现有证据研究", "research"]
  ]) {
    const ownScore = scoreProblemTypes({
      query,
      shortcutIntentId: null,
      problemTypes: routerData.problem_types
    }).find(({ id }) => id === problemTypeId);
    assert.ok(ownScore.score < 8, `${problemTypeId}: ${query} scored ${ownScore.score}`);
    assert.notEqual(matchRoute({ query, routerData }).problemTypeId, problemTypeId, `${problemTypeId}: ${query}`);
  }
});

test("negative subsequence matching accepts total gap four and rejects total gap five", () => {
  const problemTypes = [
    syntheticType("target", { positive: [["目标", 8]], negative: [["不需要目标", 10]] }),
    syntheticType("other", { priority: 20 })
  ];
  const withinBoundary = scoreProblemTypes({ query: "不需甲乙丙丁要目标", shortcutIntentId: null, problemTypes })[0];
  assert.equal(withinBoundary.score, 0);
  assert.deepEqual(withinBoundary.matchedNegativePhrases, ["不需要目标"]);

  const outsideBoundary = scoreProblemTypes({ query: "不需甲乙丙丁戊要目标", shortcutIntentId: null, problemTypes })[0];
  assert.equal(outsideBoundary.score, 8);
  assert.deepEqual(outsideBoundary.matchedNegativePhrases, []);
});

test("double-negation marker window accepts four intervening characters and rejects five", () => {
  const data = syntheticRouterData([
    syntheticType("target", { positive: [["目标", 8]], negative: [["不需要目标", 10]] }),
    syntheticType("other", { priority: 20 })
  ], { routeKeys: ["target::intent", "other::intent"] });
  const withinBoundary = matchRoute({ query: "不是甲乙丙丁不需要目标而是目标", routerData: data });
  assert.equal(withinBoundary.state, "matched");
  assert.equal(withinBoundary.problemTypeId, "target");
  assert.deepEqual(withinBoundary.evidence.matchedNegativePhrases, []);

  const outsideBoundary = matchRoute({ query: "不是甲乙丙丁戊不需要目标", routerData: data });
  assert.equal(outsideBoundary.state, "clarify");
  assert.equal(outsideBoundary.problemTypeId, null);
});

test("negative scope ignores ordinary whitespace but never crosses punctuation clauses", () => {
  const problemTypes = [
    syntheticType("target", { positive: [["目标", 8]], negative: [["不需要目标", 10]] }),
    syntheticType("other", { priority: 20 })
  ];
  const spaced = scoreProblemTypes({ query: "不 需 要 目 标", shortcutIntentId: null, problemTypes })[0];
  assert.deepEqual(spaced.matchedNegativePhrases, ["不需要目标"]);
  assert.equal(spaced.score, 0);

  const splitClause = scoreProblemTypes({ query: "不需要。目标", shortcutIntentId: null, problemTypes })[0];
  assert.deepEqual(splitClause.matchedNegativePhrases, []);
  assert.equal(splitClause.score, 8);
});

test("double-negation markers do not cross punctuation into a later negative clause", () => {
  const result = matchRoute({ query: "我不是专家。你不需要规划下一步", routerData });
  assert.notEqual(result.problemTypeId, "planning");
  const planning = scoreProblemTypes({
    query: "我不是专家。你不需要规划下一步",
    shortcutIntentId: null,
    problemTypes: routerData.problem_types
  }).find(({ id }) => id === "planning");
  assert.ok(planning.score < 8);
  assert.deepEqual(planning.matchedNegativePhrases, ["不需要规划下一步"]);
});

test("a later genuine negative candidate survives an earlier reversed candidate and counts once", () => {
  const planning = scoreProblemTypes({
    query: "不是不需要规划下一步 后来不需要规划下一步",
    shortcutIntentId: null,
    problemTypes: routerData.problem_types
  }).find(({ id }) => id === "planning");
  assert.ok(planning.score < 8);
  assert.deepEqual(planning.matchedNegativePhrases, ["不需要规划下一步"]);
});

test("the tightest same-end candidate prevents marker text from becoming a negative start", () => {
  const data = syntheticRouterData([
    syntheticType("target", { positive: [["目标", 8]], negative: [["不需要目标", 10]] }),
    syntheticType("other", { priority: 20 })
  ], { routeKeys: ["target::intent", "other::intent"] });
  const result = matchRoute({ query: "不甲不是不需要目标", routerData: data });
  assert.equal(result.state, "matched");
  assert.equal(result.problemTypeId, "target");
  assert.deepEqual(result.evidence.matchedNegativePhrases, []);
});

test("non-containing candidates with different ends remain independently eligible", () => {
  const scored = scoreProblemTypes({
    query: "不是不需要目标 后来不需要目标",
    shortcutIntentId: null,
    problemTypes: [syntheticType("target", {
      positive: [["目标", 8]],
      negative: [["不需要目标", 10]]
    })]
  })[0];
  assert.equal(scored.score, 0);
  assert.deepEqual(scored.matchedNegativePhrases, ["不需要目标"]);
});

test("multiple genuine minimal candidates count one negative phrase only once", () => {
  const scored = scoreProblemTypes({
    query: "不需要目标 后来仍不需要目标",
    shortcutIntentId: null,
    problemTypes: [syntheticType("target", {
      positive: [["目标", 8]],
      negative: [["不需要目标", 5]]
    })]
  })[0];
  assert.equal(scored.score, 3);
  assert.deepEqual(scored.matchedNegativePhrases, ["不需要目标"]);
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
