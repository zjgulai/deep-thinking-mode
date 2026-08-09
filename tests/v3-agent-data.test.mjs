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

function routerFixtures() {
  return {
    routerIndex: {
      schema_version: "1.0-router",
      description: "test router",
      problem_type_signals: { diagnosis: ["why"] },
      agent_stage_signals: { intent: ["clarify"] },
      routing_table: {
        "diagnosis::intent": {
          problem_type: "diagnosis",
          agent_stage: "intent",
          recommended_roles: ["logical_analyzer"],
          stateful_models: [{ name: "Model", file: "model.json", activation: "use model" }],
          chain_suggestion: "next"
        }
      }
    },
    routerPrompt: {
      schema_version: "1.0-router-prompt",
      name: "router",
      description: "router prompt",
      router_system_prompt: "route the request",
      usage: { step1: "ask" },
      example_input: "why",
      example_output: "model",
      embedded_models: { logical_analyzer: { name: "Model", sp: "analyze carefully" } },
      routing_index: "chain-protocols/agent-router-index.json"
    }
  };
}

function modelFixture(id = "model") {
  return {
    schema_version: "3.0.0",
    id,
    meta: {
      name: "Model",
      category: "04",
      tags: ["test"],
      skill_name: "model",
      agent_roles: ["logical_analyzer"]
    },
    core_definition: "A useful definition",
    when_to_use: { triggers: ["when needed"], anti_triggers: [] },
    before_after: { without_model: "before", with_model: "after" },
    reasoning_steps: [{ step: 1, action: "analyze", checkpoint: "check evidence" }],
    scenarios: { analysis: { situation: "a problem", application: "apply the model" } },
    codex_integration: {
      activation: "use model",
      system_prompt: "analyze carefully",
      skill_hint: "convert to skill"
    },
    pitfalls: [],
    quality: {
      definition_clarity: 5,
      trigger_precision: 5,
      step_completeness: 5,
      scenario_coverage: 5,
      prompt_effectiveness: 5,
      overall: 5
    }
  };
}

function validData(models = [modelFixture()]) {
  return {
    models,
    taxonomy: { chapters: [{ id: "04" }] },
    ...routerFixtures()
  };
}

test("v3 agent data: validates canonical roles and exposes build-ready router data", () => {
  const result = validateV3AgentData(validData());
  assert.equal(result.stats.modelCount, 1);
  assert.equal(result.stats.uniqueIdCount, 1);
  assert.equal(result.stats.assignedRoleCount, 1);
  assert.equal(result.roleCounts.logical_analyzer, 1);
  assert.deepEqual(Object.keys(result.router), [
    "problemTypeSignals", "agentStageSignals", "routingTable", "systemPrompt", "embeddedModels", "referencedModels"
  ]);
  assert.deepEqual(result.router.referencedModels, { "model.json": ["logical_analyzer"] });
});

test("v3 agent data: rejects V2 shape instead of silently adapting it", () => {
  const legacy = modelFixture();
  legacy.schema_version = "2.0.0";
  legacy.engine = {};
  delete legacy.core_definition;
  assert.throws(
    () => validateV3AgentData(validData([legacy])),
    (cause) => cause.code === V3_AGENT_DATA_ERROR && cause.path === "models[0]"
  );
});

test("v3 agent data: rejects duplicate ids", () => {
  assert.throws(
    () => validateV3AgentData(validData([modelFixture("duplicate"), modelFixture("duplicate")])),
    (cause) => cause.code === V3_AGENT_DATA_ERROR && cause.message.includes("duplicate model id")
  );
});

test("v3 agent data: only accepts roles declared by the public router", () => {
  const model = modelFixture();
  model.meta.agent_roles = ["undeclared_role"];
  assert.throws(
    () => validateV3AgentData(validData([model])),
    (cause) => cause.code === V3_AGENT_DATA_ERROR && cause.path.endsWith("meta.agent_roles[0]")
  );
});

test("v3 agent data: rejects duplicate role authority outside meta.agent_roles", () => {
  const model = modelFixture();
  model.codex_integration.agent_role = "logical_analyzer";
  assert.throws(
    () => validateV3AgentData(validData([model])),
    (cause) => cause.code === V3_AGENT_DATA_ERROR && cause.path.endsWith("codex_integration")
  );
});

test("v3 agent data: rejects a router reference to a missing model file", () => {
  const data = validData();
  data.routerIndex.routing_table["diagnosis::intent"].stateful_models[0].file = "missing.json";
  assert.throws(
    () => validateV3AgentData(data),
    (cause) => cause.code === V3_AGENT_DATA_ERROR &&
      cause.message.includes("router references a missing V3 model file")
  );
});

test("v3 agent data: rejects a referenced model missing a route-recommended role", () => {
  const model = modelFixture();
  model.meta.agent_roles = [];
  assert.throws(
    () => validateV3AgentData(validData([model])),
    (cause) => cause.code === V3_AGENT_DATA_ERROR &&
      cause.message.includes("does not declare recommended role logical_analyzer")
  );
});

test("v3 agent data: loader paths are public-only and the repository corpus passes", async () => {
  assert.deepEqual(Object.values(PUBLIC_V3_AGENT_PATHS), [
    "knowledge/models-v3",
    "knowledge/taxonomy.json",
    "chain-protocols/agent-router-index.json",
    "chain-protocols/agent-router-prompt.json"
  ]);
  const result = await loadV3AgentData(ROOT);
  assert.equal(result.stats.modelCount, 2789);
  assert.equal(result.stats.uniqueIdCount, 2789);
  assert.ok(result.stats.assignedRoleCount > 19);
  assert.ok(result.roleCounts.logical_analyzer >= 19);
  const agentFlows = [
    ["intent_clarifier", "problem_framer"],
    ["first_principles", "causal_reasoner", "logical_analyzer"],
    ["multi_perspective", "hypothesis_tester"],
    ["decision_maker", "bias_detector"],
    ["planner", "decomposer", "prioritizer", "action_executor"],
    ["observer_reflector", "error_handler"],
    ["knowledge_synthesizer", "pattern_recognizer"],
    ["communicator", "simplifier"]
  ];
  for (const roles of agentFlows) {
    assert.ok(roles.some((role) => (result.roleCounts[role] ?? 0) > 0), `empty agent flow: ${roles.join(",")}`);
  }
});
