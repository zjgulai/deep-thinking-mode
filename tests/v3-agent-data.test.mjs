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
        ["immediate_personal_danger", "紧急人身危险", "正在伤害自己"],
        ["medical_diagnosis_or_treatment", "医疗诊断或治疗", "请诊断我的症状"],
        ["legal_advice_with_deadline", "有期限的法律建议", "法律期限明天到期"],
        ["high_stakes_financial_instruction", "高风险金融指令", "把全部积蓄马上买入"]
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
