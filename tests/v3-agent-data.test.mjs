import assert from "node:assert/strict";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import {
  PUBLIC_V3_AGENT_PATHS,
  V3_AGENT_DATA_ERROR,
  loadV3AgentData,
  validateV3AgentData
} from "../tools/lib/v3-agent-data.mjs";
import { assertFrozenCounts } from "../tools/validate-v3-agent-data.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

function phrase(text, weight = 8) {
  return { text, weight };
}

function modelFixture(id = "model", roles = ["intent_clarifier"], category = "04") {
  return {
    schema_version: "3.0.0",
    id,
    meta: { name: "Model", category, tags: ["test"], skill_name: id, agent_roles: roles },
    core_definition: "A useful definition",
    when_to_use: { triggers: ["when needed"], anti_triggers: [] },
    before_after: { without_model: "before", with_model: "after" },
    reasoning_steps: [{ step: 1, action: "analyze", checkpoint: "check evidence" }],
    scenarios: { analysis: { situation: "a problem", application: "apply the model" } },
    codex_integration: { activation: "use model", system_prompt: "analyze carefully", skill_hint: "convert to skill" },
    pitfalls: [],
    quality: { definition_clarity: 5, trigger_precision: 5, step_completeness: 5, scenario_coverage: 5, prompt_effectiveness: 5, overall: 5 }
  };
}

function phaseFixture(overrides = {}) {
  return {
    id: "frame",
    order: 1,
    name: "Frame the task",
    agent_role: "intent_clarifier",
    model_ids: ["model"],
    input: "request",
    output: "framed request",
    checkpoint: "scope is clear",
    stop_condition: "scope is complete",
    loop_back_to: null,
    ...overrides
  };
}

function chainFixture(overrides = {}) {
  return {
    schema_version: "2.0-agent-chain",
    id: "example-chain",
    meta: { title: "Example chain" },
    phases: [phaseFixture()],
    ...overrides
  };
}

function routerFixtures() {
  return {
    routerIndex: {
      schema_version: "2.0-router",
      problem_types: [{
        id: "diagnosis",
        label: "诊断根因",
        priority: 10,
        positive_phrases: [phrase("哪里出了问题")],
        negative_phrases: [phrase("不需要找原因", 10)],
        examples: ["产品数据突然变差，我想知道发生了什么"],
        clarify_label: "我想找出原因"
      }],
      agent_stages: [{ id: "intent", label: "意图澄清", priority: 10, positive_phrases: [phrase("先弄清楚问题")] }],
      safety_signals: [
        ["high_stakes_financial_instruction", "高风险金融指令", "把全部积蓄马上买入"],
        ["immediate_personal_danger", "紧急人身危险", "正在伤害自己"],
        ["legal_advice_with_deadline", "有期限的法律建议", "法律期限明天到期"],
        ["medical_diagnosis_or_treatment", "医疗诊断或治疗", "请诊断我的症状"]
      ].map(([id, label, phraseText]) => ({
        id,
        label,
        phrases: [phraseText],
        message: "请优先联系当地紧急服务、可信赖的人或合格专业人士。"
      })),
      routes: [{
        id: "diagnosis::intent",
        problem_type_id: "diagnosis",
        agent_stage_id: "intent",
        recommended_role_ids: ["intent_clarifier"],
        model_ids: ["model"],
        chain_id: "example-chain"
      }]
    },
    routerPrompt: {
      schema_version: "2.0-router-prompt",
      references: {
        router_schema: "2.0-router",
        problem_type_ids: ["diagnosis"],
        agent_stage_ids: ["intent"],
        role_ids: ["intent_clarifier"],
        model_ids: ["model"],
        chain_ids: ["example-chain"]
      }
    }
  };
}

function validData(models = [modelFixture()]) {
  return {
    models,
    taxonomy: { chapters: [{ id: "04" }] },
    chains: [{ fileName: "example-chain.json", chain: chainFixture() }],
    curatedCollections: {
      example: { title: "Example", desc: "Test collection", tags: ["test"], keywords: ["example"], models: [{ model_id: "model" }], count: 1 }
    },
    ...routerFixtures()
  };
}

function clone(value) {
  return structuredClone(value);
}

function expectInvalid(mutator, message) {
  const data = validData();
  mutator(data);
  assert.throws(
    () => validateV3AgentData(data),
    (cause) => cause.code === V3_AGENT_DATA_ERROR && cause.message.includes(message)
  );
}

test("v3 agent data: accepts only V2 Router, prompt, and Chain contracts", () => {
  const data = validData();
  const result = validateV3AgentData(data);
  assert.equal(result.stats.modelCount, 1);
  assert.equal(result.stats.routeCount, 1);
  assert.equal(result.stats.chainCount, 1);
  assert.equal(result.stats.chainReferenceCount, 1);
  assert.equal(result.stats.curatedModelReferenceCount, 1);
  assert.deepEqual([...result.routesByProblemAndStage.keys()], ["diagnosis::intent"]);
  assert.deepEqual([...result.chainsById.keys()], ["example-chain"]);
  for (const [target, path] of [
    [data.routerIndex, "routerIndex.schema_version"],
    [data.routerPrompt, "routerPrompt.schema_version"],
    [data.chains[0].chain, "chains[0].schema_version"]
  ]) {
    target.schema_version = "1.0-router";
    assert.throws(() => validateV3AgentData(data), (cause) => cause.code === V3_AGENT_DATA_ERROR && cause.path.endsWith(path));
    target.schema_version = path.includes("routerPrompt") ? "2.0-router-prompt" : path.includes("chains") ? "2.0-agent-chain" : "2.0-router";
  }
});

test("v3 agent data: rejects duplicate Router identity, unsafe phrase weights, and legacy associations", () => {
  expectInvalid((data) => data.routerIndex.problem_types.push(clone(data.routerIndex.problem_types[0])), "duplicate problem type id");
  expectInvalid((data) => data.routerIndex.agent_stages.push(clone(data.routerIndex.agent_stages[0])), "duplicate agent stage id");
  expectInvalid((data) => data.routerIndex.routes.push(clone(data.routerIndex.routes[0])), "duplicate route key");
  expectInvalid((data) => { data.routerIndex.problem_types[0].positive_phrases[0].weight = 11; }, "expected phrase weight from 1 to 10");
  expectInvalid((data) => { data.routerIndex.problem_types[0].negative_phrases[0].text = "哪里出了问题"; }, "appears in both positive and negative phrases");
  expectInvalid((data) => { data.routerIndex.routes[0].file = "model.json"; }, "unknown or missing fields");
  expectInvalid((data) => { data.routerIndex.routes[0].chain_suggestion = "example-chain"; }, "unknown or missing fields");
  expectInvalid((data) => { data.curatedCollections.example.models[0].name = "Model"; }, "unknown or missing fields");
});

test("v3 agent data: rejects routes and safety signals outside canonical order", () => {
  const safety = validData();
  safety.routerIndex.safety_signals.reverse();
  assert.throws(
    () => validateV3AgentData(safety),
    (cause) => cause.code === V3_AGENT_DATA_ERROR && cause.message.includes("expected id stable order")
  );
  const routes = validData();
  routes.routerIndex.agent_stages.unshift({ id: "analysis", label: "分析", priority: 10, positive_phrases: [phrase("分析问题")] });
  routes.routerIndex.routes.push({
    id: "diagnosis::analysis",
    problem_type_id: "diagnosis",
    agent_stage_id: "analysis",
    recommended_role_ids: ["intent_clarifier"],
    model_ids: ["model"],
    chain_id: null
  });
  assert.throws(
    () => validateV3AgentData(routes),
    (cause) => cause.code === V3_AGENT_DATA_ERROR && cause.message.includes("expected route stable order")
  );
});

test("v3 agent data: rejects unknown V2 cross-references and Chain identity mismatches", () => {
  expectInvalid((data) => { data.routerIndex.routes[0].recommended_role_ids = ["unknown_role"]; }, "unknown role");
  expectInvalid((data) => { data.routerIndex.routes[0].model_ids = ["missing"]; }, "unknown model id");
  expectInvalid((data) => { data.routerIndex.routes[0].chain_id = "missing-chain"; }, "unknown chain id");
  expectInvalid((data) => { data.chains[0].chain.id = "other-chain"; }, "file name does not match chain id");
  expectInvalid((data) => { data.curatedCollections.example.models[0].model_id = "missing"; }, "unknown curated model id");
  expectInvalid((data) => { data.routerPrompt.references.model_ids = ["missing"]; }, "unknown prompt model");
});

test("v3 agent data: rejects invalid Chain ordering, loop boundaries, roles, and legacy model links", () => {
  expectInvalid((data) => { data.chains[0].chain.phases[0].order = 2; }, "expected phase order to increment from 1");
  expectInvalid((data) => { data.chains[0].chain.phases.push(phaseFixture({ id: "frame", order: 2 })); }, "duplicate phase id");
  expectInvalid((data) => { data.chains[0].chain.phases[0].loop_back_to = "frame"; }, "loop_back_to must target an earlier phase");
  expectInvalid((data) => { data.chains[0].chain.phases.push(phaseFixture({ id: "review", order: 2, loop_back_to: "review" })); }, "loop_back_to must target an earlier phase");
  const roleMismatch = validData([modelFixture(), modelFixture("other", ["problem_framer"])]);
  roleMismatch.chains[0].chain.phases[0].agent_role = "problem_framer";
  assert.throws(() => validateV3AgentData(roleMismatch), (cause) => cause.code === V3_AGENT_DATA_ERROR && cause.message.includes("does not declare agent role"));
  expectInvalid((data) => { data.chains[0].chain.phases[0].model = "Model"; }, "unknown or missing fields");
  expectInvalid((data) => { data.chains[0].chain.phases[0].file = "model.json"; }, "unknown or missing fields");
});

test("v3 agent data: returns independent, deeply frozen V2 build views", () => {
  const data = validData();
  const result = validateV3AgentData(data);
  data.models[0].meta.name = "changed source";
  data.routerIndex.routes[0].model_ids.push("other");
  data.chains[0].chain.phases[0].model_ids[0] = "other";
  data.curatedCollections.example.models[0].model_id = "other";
  assert.equal(result.modelsById.get("model").meta.name, "Model");
  assert.deepEqual(result.routesByProblemAndStage.get("diagnosis::intent").model_ids, ["model"]);
  assert.deepEqual(result.chainsById.get("example-chain").phases[0].model_ids, ["model"]);
  assert.deepEqual(result.curatedCollections.example.models, [{ model_id: "model" }]);
  assert.ok(Object.isFrozen(result));
  assert.ok(Object.isFrozen(result.problemTypes));
  assert.ok(Object.isFrozen(result.routesByProblemAndStage));
  assert.ok(Object.isFrozen(result.routesByProblemAndStage.get("diagnosis::intent").model_ids));
  assert.throws(() => result.routesByProblemAndStage.set("other", {}), TypeError);
  assert.throws(() => result.chainsById.get("example-chain").phases[0].model_ids.push("other"), TypeError);
  for (const map of [
    result.modelsById,
    result.routesByProblemAndStage,
    result.chainsById,
    result.compositionsByModelId,
    result.compositionsByChapterId
  ]) {
    assert.throws(() => Map.prototype.set.call(map, "other", {}), TypeError);
    assert.throws(() => Map.prototype.delete.call(map, "other"), TypeError);
    assert.throws(() => Map.prototype.clear.call(map), TypeError);
  }
});

test("v3 agent data: CLI rejects every frozen corpus count drift", () => {
  const valid = {
    modelCount: 2789,
    uniqueIdCount: 2789,
    problemTypeCount: 8,
    agentStageCount: 8,
    routeCount: 23,
    chainCount: 5,
    chainReferenceCount: 13,
    curatedModelReferenceCount: 48
  };
  assert.doesNotThrow(() => assertFrozenCounts(valid));
  for (const [field, expected] of Object.entries(valid)) {
    assert.throws(
      () => assertFrozenCounts({ ...valid, [field]: expected - 1 }),
      (cause) => cause.code === V3_AGENT_DATA_ERROR && cause.path === `stats.${field}`
    );
  }
});

test("v3 agent data: repository corpus preserves every stable route, Chain, collection, and reverse index", async () => {
  const result = await loadV3AgentData(ROOT);
  assert.deepEqual(
    Object.fromEntries([...result.routesByProblemAndStage].filter(([, route]) => route.chain_id).map(([id, route]) => [id, route.chain_id])),
    {
      "diagnosis::cot_step": "cot-critic-chain",
      "diagnosis::reflect": "plan-execute-reflect-chain",
      "diagnosis::tot_branch": "tot-tree-of-thought-chain",
      "planning::planning": "plan-execute-reflect-chain",
      "planning::execution": "react-agent-chain",
      "planning::reflect": "plan-execute-reflect-chain",
      "decision::cot_step": "cot-critic-chain",
      "decision::reflect": "plan-execute-reflect-chain",
      "decision::tot_branch": "tot-tree-of-thought-chain",
      "creative::cot_step": "cot-critic-chain",
      "creative::tot_branch": "tot-tree-of-thought-chain",
      "research::research": "deep-research-chain",
      "reflection::reflect": "plan-execute-reflect-chain"
    }
  );
  assert.deepEqual(
    [...result.chainsById].map(([id, chain]) => [id, chain.phases.map((phase) => [phase.id, phase.model_ids])]),
    [
      ["cot-critic-chain", [["decompose", ["框架思维_核心功能解析与高效落地路径"]], ["reason", ["第一性原理_看透本质_高效破局的底层"]], ["critique", ["批判性思维工具包_3步拆解论点_5类"]], ["revise", ["第一性原理_看透本质_高效破局的底层"]], ["reflect", ["事后总结_并非终点_而是认知的_逆向"]]]],
      ["deep-research-chain", [["clarify", ["爱因斯坦式提问_5步重新定义问题_告"]], ["hypothesize", ["批判性思维工具包_3步拆解论点_5类"]], ["gather_evidence", ["批判性思维工具包_3步拆解论点_5类"]], ["verify", ["批判性思维工具包_3步拆解论点_5类"]], ["synthesize", ["金字塔原理_理清逻辑_高效表达的底层"]]]],
      ["plan-execute-reflect-chain", [["plan", ["框架思维_核心功能解析与高效落地路径"]], ["decompose", ["框架思维_核心功能解析与高效落地路径"]], ["execute", ["事后总结_并非终点_而是认知的_逆向"]], ["reflect", ["事后总结_并非终点_而是认知的_逆向"]]]],
      ["react-agent-chain", [["clarify", ["爱因斯坦式提问_5步重新定义问题_告"]], ["plan", ["第一性原理_看透本质_高效破局的底层"]], ["act", ["事后总结_并非终点_而是认知的_逆向"]], ["observe", ["事后总结_并非终点_而是认知的_逆向"]], ["communicate", ["金字塔原理_理清逻辑_高效表达的底层"]]]],
      ["tot-tree-of-thought-chain", [["frame", ["爱因斯坦式提问_5步重新定义问题_告"]], ["branch", ["10个时间黑洞_多巴胺陷阱_决策瘫痪"]], ["evaluate", ["第二层思维_超越共识_决胜决策的底层"]], ["simulate", ["第二层思维_超越共识_决胜决策的底层"]], ["decide", ["10个时间黑洞_多巴胺陷阱_决策瘫痪"]]]]
    ]
  );
  assert.deepEqual(Object.fromEntries(Object.entries(result.curatedCollections).map(([id, collection]) => [id, collection.models.map((model) => model.model_id)])), {
    ai_boost: ["socratic-midwifery", "苏格拉底6类追问组合拳-破题-澄清-挖根-破框-推演-一套完整的深度探究流程", "思维工具箱_三把剃刀_二八法则_系统", "苏格拉底6大提问框架-澄清-假设-证据-视角-结果-对问题的提问-一套完整的思维检验闭环", "苏格拉底6大提问框架-澄清-假设-证据-视角-结果-对问题的提问-一套完整的思维检验闭环", "苏格拉底6大提问框架_澄清_假设_证", "five-factors-tot", "ref-100-思维模型合集-模型思-第一性原理-找到第一性原理-回归到本源来"],
    decision_master: ["应对不确定性的4个层级-不同未知场景-用不同策略", "sunzi-five-factors", "应对不确定性的4个层级_不同未知场景", "思维工具箱_三把剃刀_二八法则_系统", "ref-100-思维模型合集-模型思-先动脑-再动手-凡事先思考一下-再开始行", "ooda循环不确定环境下的快速决策与行动法则", "ref-100-思维模型合集-模型思-不确定性", "为什么越想越错-决策心理学的4个陷阱及3个破解方法"],
    problem_solver: ["思维工具箱-三把剃刀-二八法则-系统思维-一套完整的认知避坑指南", "问题重构五步法_一套完整的根源解题系", "七种问题重构法-一套完整的认知破局系统", "思维工具箱_三把剃刀_二八法则_系统", "问题重构五步法-一套完整的根源解题系统", "ref-100-思维模型合集-模型思-第一性原理-找到第一性原理-回归到本源来", "七种问题重构法-一套完整的认知破局系统", "ref-100-思维模型合集-模型思-正确的信念-例如"],
    learning_accelerator: ["ref-100-思维模型合集-模型思-刻意练习", "ref-100-思维模型合集-模型思-元认知技能", "ref-100-思维模型合集-模型思-为什么卡壳了要返回去-", "ref-100-思维模型合集-模型思-学习技能", "ref-100-思维模型合集-模型思-第一步", "ref-100-思维模型合集-模型思-学习", "习惯管持续-刻意练习管增长-复利成长缺一不可", "经验学习四步法-从经历中提炼能力-附复盘问题清单-"],
    emotion_master: ["别等有动力再行动-颠覆常识-动力从来不是行动的前提", "别等有动力再行动_颠覆常识_动力从来", "**第一部分", "帕累托法则破局时间焦虑-20-低效习惯-藏着80-的时间内耗", "自控与冲动的核心关系", "批判性思维工具包-3步拆解论点-5类逻辑谬误-4项日常练习", "**第一部分", "思维工具箱_三把剃刀_二八法则_系统"],
    communication_power: ["金字塔原理_理清逻辑_高效表达的底层", "金字塔原理-理清逻辑-高效表达的底层思维框架", "马斯洛需求金字塔-一套自查工具-精准定位你当下的成长瓶颈", "马斯洛需求金字塔-一套自查工具-精准定位你当下的成长瓶颈", "苏格拉底6大提问框架_澄清_假设_证", "ref-100-思维模型合集-模型思-用权威说服大众-", "ref-100-思维模型合集-模型思-序言仅涉及读者不会对其真实性提出质疑的内", "ref-100-思维模型合集-模型思-一线经理转型的方法"]
  });
  assert.deepEqual(result.compositionsByModelId.get("第一性原理_看透本质_高效破局的底层"), [
    { chain_id: "cot-critic-chain", phase_id: "reason", phase_order: 2, model_id: "第一性原理_看透本质_高效破局的底层", agent_role: "logical_analyzer" },
    { chain_id: "cot-critic-chain", phase_id: "revise", phase_order: 4, model_id: "第一性原理_看透本质_高效破局的底层", agent_role: "first_principles" },
    { chain_id: "react-agent-chain", phase_id: "plan", phase_order: 2, model_id: "第一性原理_看透本质_高效破局的底层", agent_role: "first_principles" }
  ]);
  assert.deepEqual(result.compositionsByChapterId.get("04"), [
    { chain_id: "cot-critic-chain", phase_id: "decompose", phase_order: 1, model_id: "框架思维_核心功能解析与高效落地路径", agent_role: "decomposer" },
    { chain_id: "cot-critic-chain", phase_id: "reason", phase_order: 2, model_id: "第一性原理_看透本质_高效破局的底层", agent_role: "logical_analyzer" },
    { chain_id: "cot-critic-chain", phase_id: "revise", phase_order: 4, model_id: "第一性原理_看透本质_高效破局的底层", agent_role: "first_principles" },
    { chain_id: "plan-execute-reflect-chain", phase_id: "plan", phase_order: 1, model_id: "框架思维_核心功能解析与高效落地路径", agent_role: "planner" },
    { chain_id: "plan-execute-reflect-chain", phase_id: "decompose", phase_order: 2, model_id: "框架思维_核心功能解析与高效落地路径", agent_role: "decomposer" },
    { chain_id: "react-agent-chain", phase_id: "plan", phase_order: 2, model_id: "第一性原理_看透本质_高效破局的底层", agent_role: "first_principles" }
  ]);
});

test("v3 agent data: loader is public-only and resolves the V2 corpus", async () => {
  assert.deepEqual(Object.values(PUBLIC_V3_AGENT_PATHS), [
    "knowledge/models-v3",
    "knowledge/taxonomy.json",
    "chain-protocols/agent-router-index.json",
    "chain-protocols/agent-router-prompt.json",
    "chain-protocols",
    "knowledge/curated-collections.json"
  ]);
  const result = await loadV3AgentData(ROOT);
  assert.equal(result.stats.modelCount, 2789);
  assert.equal(result.stats.uniqueIdCount, 2789);
  assert.equal(result.stats.problemTypeCount, 8);
  assert.equal(result.stats.agentStageCount, 8);
  assert.equal(result.stats.routeCount, 23);
  assert.equal(result.stats.chainCount, 5);
  assert.equal(result.stats.chainReferenceCount, 13);
  assert.equal(result.stats.curatedModelReferenceCount, 48);
  assert.equal(result.safetySignals.length, 4);
});
