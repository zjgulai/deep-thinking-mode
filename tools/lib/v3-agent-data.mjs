import { lstat, readdir, readFile } from "node:fs/promises";
import { basename, join } from "node:path";

export const V3_SCHEMA_VERSION = "3.0.0";
export const V3_AGENT_DATA_ERROR = "V3_AGENT_DATA_INVALID";
export const PUBLIC_V3_AGENT_PATHS = Object.freeze({
  models: join("knowledge", "models-v3"),
  taxonomy: join("knowledge", "taxonomy.json"),
  routerIndex: join("chain-protocols", "agent-router-index.json"),
  routerPrompt: join("chain-protocols", "agent-router-prompt.json"),
  chainsDir: "chain-protocols",
  curatedCollections: join("knowledge", "curated-collections.json")
});

const CHAIN_FILE_NAMES = Object.freeze([
  "cot-critic-chain.json",
  "deep-research-chain.json",
  "plan-execute-reflect-chain.json",
  "react-agent-chain.json",
  "tot-tree-of-thought-chain.json"
]);
const SAFETY_SIGNAL_IDS = new Set([
  "immediate_personal_danger",
  "medical_diagnosis_or_treatment",
  "legal_advice_with_deadline",
  "high_stakes_financial_instruction"
]);
const MODEL_ROOT_KEYS = new Set([
  "schema_version", "id", "meta", "core_definition", "when_to_use", "before_after",
  "reasoning_steps", "scenarios", "codex_integration", "pitfalls", "quality"
]);
const MODEL_META_REQUIRED_KEYS = new Set(["name", "category", "tags", "skill_name"]);
const MODEL_META_KEYS = new Set([...MODEL_META_REQUIRED_KEYS, "source", "sourceType", "sourceTitle", "agent_roles"]);
const QUALITY_KEYS = new Set(["definition_clarity", "trigger_precision", "step_completeness", "scenario_coverage", "prompt_effectiveness", "overall"]);
const ROUTER_INDEX_KEYS = new Set(["schema_version", "problem_types", "agent_stages", "safety_signals", "routes"]);
const PROBLEM_TYPE_KEYS = new Set(["id", "label", "priority", "positive_phrases", "negative_phrases", "examples", "clarify_label"]);
const AGENT_STAGE_KEYS = new Set(["id", "label", "priority", "positive_phrases"]);
const SAFETY_SIGNAL_KEYS = new Set(["id", "label", "phrases", "message"]);
const ROUTE_KEYS = new Set(["id", "problem_type_id", "agent_stage_id", "recommended_role_ids", "model_ids", "chain_id"]);
const ROUTER_PROMPT_KEYS = new Set(["schema_version", "references"]);
const ROUTER_PROMPT_REFERENCE_KEYS = new Set(["router_schema", "problem_type_ids", "agent_stage_ids", "role_ids", "model_ids", "chain_ids"]);
const CHAIN_KEYS = new Set(["schema_version", "id", "meta", "phases"]);
const CHAIN_PHASE_KEYS = new Set(["id", "order", "name", "agent_role", "model_ids", "input", "output", "checkpoint", "stop_condition", "loop_back_to"]);
const COLLECTION_KEYS = new Set(["title", "desc", "tags", "keywords", "models", "count"]);
const COLLECTION_MODEL_KEYS = new Set(["model_id"]);

function dataError(message, path) {
  const error = new TypeError(`${message} at ${path}`);
  error.code = V3_AGENT_DATA_ERROR;
  error.path = path;
  return error;
}

function isPlainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype;
}

function assertPlainObject(value, path) {
  if (!isPlainObject(value)) throw dataError("expected object", path);
}

function assertExactKeys(value, keys, path) {
  assertPlainObject(value, path);
  const actual = Object.keys(value);
  if (actual.length !== keys.size || actual.some((key) => !keys.has(key))) throw dataError("unknown or missing fields", path);
}

function assertAllowedKeys(value, allowed, required, path) {
  assertPlainObject(value, path);
  const actual = Object.keys(value);
  if (actual.some((key) => !allowed.has(key)) || [...required].some((key) => !(key in value))) {
    throw dataError("unknown or missing fields", path);
  }
}

function assertString(value, path, { allowEmpty = false } = {}) {
  if (typeof value !== "string" || (!allowEmpty && value.trim().length === 0)) throw dataError("expected non-empty string", path);
}

function assertStringArray(value, path, { minLength = 0, unique = false } = {}) {
  if (!Array.isArray(value) || value.length < minLength) throw dataError("expected string array", path);
  const seen = new Set();
  for (const [index, item] of value.entries()) {
    assertString(item, `${path}[${index}]`);
    if (unique && seen.has(item)) throw dataError("duplicate string", `${path}[${index}]`);
    seen.add(item);
  }
}

function assertId(value, path) {
  assertString(value, path);
  if (basename(value) !== value || value.includes("/")) throw dataError("unsafe id", path);
}

function compareAscii(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

function assertPriorityOrder(entries, path) {
  for (let index = 1; index < entries.length; index += 1) {
    const previous = entries[index - 1];
    const current = entries[index];
    if (previous.priority > current.priority || (previous.priority === current.priority && compareAscii(previous.id, current.id) > 0)) {
      throw dataError("expected priority and id stable order", `${path}[${index}]`);
    }
  }
}

function assertIdOrder(entries, path) {
  for (let index = 1; index < entries.length; index += 1) {
    if (compareAscii(entries[index - 1].id, entries[index].id) > 0) {
      throw dataError("expected id stable order", `${path}[${index}]`);
    }
  }
}

function assertRouteOrder(routes, routerContract) {
  for (let index = 1; index < routes.length; index += 1) {
    const previous = routes[index - 1];
    const current = routes[index];
    const previousProblem = routerContract.problemTypes.get(previous.problem_type_id);
    const currentProblem = routerContract.problemTypes.get(current.problem_type_id);
    const previousStage = routerContract.agentStages.get(previous.agent_stage_id);
    const currentStage = routerContract.agentStages.get(current.agent_stage_id);
    const comparison = previousProblem.priority - currentProblem.priority ||
      previousStage.priority - currentStage.priority ||
      compareAscii(previous.id, current.id);
    if (comparison > 0) throw dataError("expected route stable order", `routerIndex.routes[${index}]`);
  }
}

function assertPhraseList(value, path, { allowEmpty = false } = {}) {
  if (!Array.isArray(value) || (!allowEmpty && value.length === 0)) throw dataError("expected phrase array", path);
  const texts = new Set();
  for (const [index, phrase] of value.entries()) {
    const phrasePath = `${path}[${index}]`;
    assertExactKeys(phrase, new Set(["text", "weight"]), phrasePath);
    assertString(phrase.text, `${phrasePath}.text`);
    if (!Number.isInteger(phrase.weight) || phrase.weight < 1 || phrase.weight > 10) {
      throw dataError("expected phrase weight from 1 to 10", `${phrasePath}.weight`);
    }
    if (texts.has(phrase.text)) throw dataError("duplicate phrase text", `${phrasePath}.text`);
    texts.add(phrase.text);
  }
  return texts;
}

function validateTaxonomy(taxonomy) {
  assertPlainObject(taxonomy, "taxonomy");
  if (!Array.isArray(taxonomy.chapters) || taxonomy.chapters.length === 0) throw dataError("expected taxonomy chapters", "taxonomy.chapters");
  const chapterIds = new Set();
  for (const [index, chapter] of taxonomy.chapters.entries()) {
    assertPlainObject(chapter, `taxonomy.chapters[${index}]`);
    assertString(chapter.id, `taxonomy.chapters[${index}].id`);
    if (chapterIds.has(chapter.id)) throw dataError("duplicate chapter id", `taxonomy.chapters[${index}].id`);
    chapterIds.add(chapter.id);
  }
  return chapterIds;
}

function validateV3Model(model, { path, chapterIds }) {
  assertExactKeys(model, MODEL_ROOT_KEYS, path);
  if (model.schema_version !== V3_SCHEMA_VERSION) throw dataError("unsupported schema_version", `${path}.schema_version`);
  assertId(model.id, `${path}.id`);
  assertAllowedKeys(model.meta, MODEL_META_KEYS, MODEL_META_REQUIRED_KEYS, `${path}.meta`);
  assertString(model.meta.name, `${path}.meta.name`);
  assertString(model.meta.category, `${path}.meta.category`);
  if (!chapterIds.has(model.meta.category)) throw dataError("unknown taxonomy category", `${path}.meta.category`);
  assertStringArray(model.meta.tags, `${path}.meta.tags`, { unique: true });
  assertString(model.meta.skill_name, `${path}.meta.skill_name`);
  for (const key of ["source", "sourceType", "sourceTitle"]) if (key in model.meta) assertString(model.meta[key], `${path}.meta.${key}`);
  const agentRoles = model.meta.agent_roles ?? [];
  assertStringArray(agentRoles, `${path}.meta.agent_roles`, { unique: true });
  assertString(model.core_definition, `${path}.core_definition`);
  assertExactKeys(model.when_to_use, new Set(["triggers", "anti_triggers"]), `${path}.when_to_use`);
  assertStringArray(model.when_to_use.triggers, `${path}.when_to_use.triggers`, { minLength: 1 });
  assertStringArray(model.when_to_use.anti_triggers, `${path}.when_to_use.anti_triggers`);
  assertExactKeys(model.before_after, new Set(["without_model", "with_model"]), `${path}.before_after`);
  assertString(model.before_after.without_model, `${path}.before_after.without_model`);
  assertString(model.before_after.with_model, `${path}.before_after.with_model`);
  if (!Array.isArray(model.reasoning_steps) || model.reasoning_steps.length === 0) throw dataError("expected reasoning steps", `${path}.reasoning_steps`);
  for (const [index, step] of model.reasoning_steps.entries()) {
    const stepPath = `${path}.reasoning_steps[${index}]`;
    assertExactKeys(step, new Set(["step", "action", "checkpoint"]), stepPath);
    if (!Number.isInteger(step.step) || step.step < 1) throw dataError("expected positive step number", `${stepPath}.step`);
    assertString(step.action, `${stepPath}.action`);
    assertString(step.checkpoint, `${stepPath}.checkpoint`);
  }
  assertPlainObject(model.scenarios, `${path}.scenarios`);
  if (Object.keys(model.scenarios).length === 0) throw dataError("expected scenarios", `${path}.scenarios`);
  for (const [name, scenario] of Object.entries(model.scenarios)) {
    const scenarioPath = `${path}.scenarios.${name}`;
    assertString(name, scenarioPath);
    assertExactKeys(scenario, new Set(["situation", "application"]), scenarioPath);
    assertString(scenario.situation, `${scenarioPath}.situation`);
    assertString(scenario.application, `${scenarioPath}.application`);
  }
  assertExactKeys(model.codex_integration, new Set(["activation", "system_prompt", "skill_hint"]), `${path}.codex_integration`);
  assertString(model.codex_integration.activation, `${path}.codex_integration.activation`);
  assertString(model.codex_integration.system_prompt, `${path}.codex_integration.system_prompt`);
  assertString(model.codex_integration.skill_hint, `${path}.codex_integration.skill_hint`);
  assertStringArray(model.pitfalls, `${path}.pitfalls`);
  assertExactKeys(model.quality, QUALITY_KEYS, `${path}.quality`);
  for (const key of QUALITY_KEYS) {
    if (!Number.isInteger(model.quality[key]) || model.quality[key] < 1 || model.quality[key] > 5) {
      throw dataError("expected quality score from 1 to 5", `${path}.quality.${key}`);
    }
  }
  return agentRoles;
}

function validateRouterIndex(routerIndex) {
  assertExactKeys(routerIndex, ROUTER_INDEX_KEYS, "routerIndex");
  if (routerIndex.schema_version !== "2.0-router") throw dataError("unsupported schema_version", "routerIndex.schema_version");
  const problemTypes = new Map();
  if (!Array.isArray(routerIndex.problem_types) || routerIndex.problem_types.length === 0) throw dataError("expected problem_types", "routerIndex.problem_types");
  for (const [index, problemType] of routerIndex.problem_types.entries()) {
    const path = `routerIndex.problem_types[${index}]`;
    assertExactKeys(problemType, PROBLEM_TYPE_KEYS, path);
    assertId(problemType.id, `${path}.id`);
    assertString(problemType.label, `${path}.label`);
    if (!Number.isInteger(problemType.priority) || problemType.priority < 1) throw dataError("expected positive priority", `${path}.priority`);
    const positive = assertPhraseList(problemType.positive_phrases, `${path}.positive_phrases`);
    const negative = assertPhraseList(problemType.negative_phrases, `${path}.negative_phrases`, { allowEmpty: true });
    for (const text of positive) if (negative.has(text)) throw dataError("phrase appears in both positive and negative phrases", `${path}.negative_phrases`);
    assertStringArray(problemType.examples, `${path}.examples`, { minLength: 1, unique: true });
    assertString(problemType.clarify_label, `${path}.clarify_label`);
    if (problemTypes.has(problemType.id)) throw dataError("duplicate problem type id", `${path}.id`);
    problemTypes.set(problemType.id, problemType);
  }
  assertPriorityOrder(routerIndex.problem_types, "routerIndex.problem_types");
  const agentStages = new Map();
  if (!Array.isArray(routerIndex.agent_stages) || routerIndex.agent_stages.length === 0) throw dataError("expected agent_stages", "routerIndex.agent_stages");
  for (const [index, agentStage] of routerIndex.agent_stages.entries()) {
    const path = `routerIndex.agent_stages[${index}]`;
    assertExactKeys(agentStage, AGENT_STAGE_KEYS, path);
    assertId(agentStage.id, `${path}.id`);
    assertString(agentStage.label, `${path}.label`);
    if (!Number.isInteger(agentStage.priority) || agentStage.priority < 1) throw dataError("expected positive priority", `${path}.priority`);
    assertPhraseList(agentStage.positive_phrases, `${path}.positive_phrases`);
    if (agentStages.has(agentStage.id)) throw dataError("duplicate agent stage id", `${path}.id`);
    agentStages.set(agentStage.id, agentStage);
  }
  assertPriorityOrder(routerIndex.agent_stages, "routerIndex.agent_stages");
  const safetySignals = new Map();
  if (!Array.isArray(routerIndex.safety_signals) || routerIndex.safety_signals.length !== SAFETY_SIGNAL_IDS.size) {
    throw dataError("expected four safety signals", "routerIndex.safety_signals");
  }
  for (const [index, signal] of routerIndex.safety_signals.entries()) {
    const path = `routerIndex.safety_signals[${index}]`;
    assertExactKeys(signal, SAFETY_SIGNAL_KEYS, path);
    assertId(signal.id, `${path}.id`);
    if (!SAFETY_SIGNAL_IDS.has(signal.id) || safetySignals.has(signal.id)) throw dataError("unknown or duplicate safety signal id", `${path}.id`);
    assertString(signal.label, `${path}.label`);
    assertStringArray(signal.phrases, `${path}.phrases`, { minLength: 1, unique: true });
    assertString(signal.message, `${path}.message`);
    safetySignals.set(signal.id, signal);
  }
  assertIdOrder(routerIndex.safety_signals, "routerIndex.safety_signals");
  return { problemTypes, agentStages, safetySignals };
}

function validateChains(chains, modelRecords, knownRoles) {
  if (!Array.isArray(chains) || chains.length === 0) throw dataError("expected chains", "chains");
  const chainsById = new Map();
  const compositionsByModelId = new Map();
  const compositionsByChapterId = new Map();
  for (const [index, entry] of chains.entries()) {
    const chain = entry?.chain ?? entry;
    const path = entry?.path ?? `chains[${index}]`;
    assertExactKeys(chain, CHAIN_KEYS, path);
    if (chain.schema_version !== "2.0-agent-chain") throw dataError("unsupported schema_version", `${path}.schema_version`);
    assertId(chain.id, `${path}.id`);
    const fileName = entry?.fileName ?? `${chain.id}.json`;
    if (fileName !== `${chain.id}.json`) throw dataError("file name does not match chain id", path);
    assertPlainObject(chain.meta, `${path}.meta`);
    if (!Array.isArray(chain.phases) || chain.phases.length === 0) throw dataError("expected chain phases", `${path}.phases`);
    const phaseIds = new Map();
    for (const [phaseIndex, phase] of chain.phases.entries()) {
      const phasePath = `${path}.phases[${phaseIndex}]`;
      assertExactKeys(phase, CHAIN_PHASE_KEYS, phasePath);
      assertId(phase.id, `${phasePath}.id`);
      if (phaseIds.has(phase.id)) throw dataError("duplicate phase id", `${phasePath}.id`);
      if (!Number.isInteger(phase.order) || phase.order !== phaseIndex + 1) throw dataError("expected phase order to increment from 1", `${phasePath}.order`);
      for (const key of ["name", "agent_role", "input", "output", "checkpoint", "stop_condition"]) assertString(phase[key], `${phasePath}.${key}`);
      if (!knownRoles.has(phase.agent_role)) throw dataError("unknown role", `${phasePath}.agent_role`);
      assertStringArray(phase.model_ids, `${phasePath}.model_ids`, { minLength: 1, unique: true });
      for (const [modelIndex, modelId] of phase.model_ids.entries()) {
        const model = modelRecords.get(modelId);
        if (!model) throw dataError("unknown model id", `${phasePath}.model_ids[${modelIndex}]`);
        if (!(model.model.meta.agent_roles ?? []).includes(phase.agent_role)) {
          throw dataError("chain model does not declare agent role", `${phasePath}.model_ids[${modelIndex}]`);
        }
        const composition = { chain_id: chain.id, phase_id: phase.id, phase_order: phase.order, model_id: modelId, agent_role: phase.agent_role };
        const byModel = compositionsByModelId.get(modelId) ?? [];
        byModel.push(composition);
        compositionsByModelId.set(modelId, byModel);
        const byChapter = compositionsByChapterId.get(model.model.meta.category) ?? [];
        byChapter.push(composition);
        compositionsByChapterId.set(model.model.meta.category, byChapter);
      }
      if (phase.loop_back_to !== null) {
        assertString(phase.loop_back_to, `${phasePath}.loop_back_to`);
        const targetOrder = phaseIds.get(phase.loop_back_to);
        if (targetOrder === undefined || targetOrder >= phase.order) throw dataError("loop_back_to must target an earlier phase", `${phasePath}.loop_back_to`);
      }
      phaseIds.set(phase.id, phase.order);
    }
    if (chainsById.has(chain.id)) throw dataError("duplicate chain id", `${path}.id`);
    chainsById.set(chain.id, chain);
  }
  for (const values of [...compositionsByModelId.values(), ...compositionsByChapterId.values()]) {
    values.sort((left, right) => compareAscii(left.chain_id, right.chain_id) || left.phase_order - right.phase_order || compareAscii(left.model_id, right.model_id));
  }
  return { chainsById, compositionsByModelId, compositionsByChapterId };
}

function validateRoutes(routerIndex, routerContract, modelRecords, knownRoles, chainsById) {
  if (!Array.isArray(routerIndex.routes) || routerIndex.routes.length === 0) throw dataError("expected routes", "routerIndex.routes");
  const routesByProblemAndStage = new Map();
  let chainReferenceCount = 0;
  for (const [index, route] of routerIndex.routes.entries()) {
    const path = `routerIndex.routes[${index}]`;
    assertExactKeys(route, ROUTE_KEYS, path);
    assertId(route.id, `${path}.id`);
    assertId(route.problem_type_id, `${path}.problem_type_id`);
    assertId(route.agent_stage_id, `${path}.agent_stage_id`);
    const routeKey = `${route.problem_type_id}::${route.agent_stage_id}`;
    if (route.id !== routeKey) throw dataError("route id does not match problem type and agent stage", `${path}.id`);
    if (!routerContract.problemTypes.has(route.problem_type_id)) throw dataError("unknown problem type", `${path}.problem_type_id`);
    if (!routerContract.agentStages.has(route.agent_stage_id)) throw dataError("unknown agent stage", `${path}.agent_stage_id`);
    if (routesByProblemAndStage.has(routeKey)) throw dataError("duplicate route key", `${path}.id`);
    assertStringArray(route.recommended_role_ids, `${path}.recommended_role_ids`, { minLength: 1, unique: true });
    for (const [roleIndex, role] of route.recommended_role_ids.entries()) {
      if (!knownRoles.has(role)) throw dataError("unknown role", `${path}.recommended_role_ids[${roleIndex}]`);
    }
    assertStringArray(route.model_ids, `${path}.model_ids`, { unique: true });
    for (const [modelIndex, modelId] of route.model_ids.entries()) {
      const model = modelRecords.get(modelId);
      if (!model) throw dataError("unknown model id", `${path}.model_ids[${modelIndex}]`);
      for (const role of route.recommended_role_ids) {
        if (!(model.model.meta.agent_roles ?? []).includes(role)) throw dataError("route model does not declare recommended role", `${path}.model_ids[${modelIndex}]`);
      }
    }
    if (route.chain_id !== null) {
      assertId(route.chain_id, `${path}.chain_id`);
      if (!chainsById.has(route.chain_id)) throw dataError("unknown chain id", `${path}.chain_id`);
      chainReferenceCount += 1;
    }
    routesByProblemAndStage.set(routeKey, route);
  }
  assertRouteOrder(routerIndex.routes, routerContract);
  return { routesByProblemAndStage, chainReferenceCount };
}

function validateRouterPrompt(routerPrompt, routerContract, modelRecords, knownRoles, chainsById) {
  assertExactKeys(routerPrompt, ROUTER_PROMPT_KEYS, "routerPrompt");
  if (routerPrompt.schema_version !== "2.0-router-prompt") throw dataError("unsupported schema_version", "routerPrompt.schema_version");
  assertExactKeys(routerPrompt.references, ROUTER_PROMPT_REFERENCE_KEYS, "routerPrompt.references");
  if (routerPrompt.references.router_schema !== "2.0-router") throw dataError("unexpected router_schema", "routerPrompt.references.router_schema");
  const references = [
    ["problem_type_ids", routerContract.problemTypes],
    ["agent_stage_ids", routerContract.agentStages],
    ["role_ids", knownRoles],
    ["model_ids", modelRecords],
    ["chain_ids", chainsById]
  ];
  for (const [key, known] of references) {
    assertStringArray(routerPrompt.references[key], `routerPrompt.references.${key}`, { unique: true });
    for (const [index, id] of routerPrompt.references[key].entries()) {
      if (!known.has(id)) throw dataError(`unknown prompt ${key.slice(0, -4)}`, `routerPrompt.references.${key}[${index}]`);
    }
  }
}

function validateCuratedCollections(curatedCollections, modelRecords) {
  assertPlainObject(curatedCollections, "curatedCollections");
  const collectionIds = Object.keys(curatedCollections);
  if (collectionIds.length === 0) throw dataError("expected curated collections", "curatedCollections");
  let curatedModelReferenceCount = 0;
  for (const collectionId of collectionIds) {
    const path = `curatedCollections.${collectionId}`;
    assertId(collectionId, path);
    const collection = curatedCollections[collectionId];
    assertExactKeys(collection, COLLECTION_KEYS, path);
    assertString(collection.title, `${path}.title`);
    assertString(collection.desc, `${path}.desc`);
    assertStringArray(collection.tags, `${path}.tags`, { minLength: 1, unique: true });
    assertStringArray(collection.keywords, `${path}.keywords`, { minLength: 1, unique: true });
    if (!Array.isArray(collection.models) || collection.models.length === 0) throw dataError("expected collection models", `${path}.models`);
    if (!Number.isInteger(collection.count) || collection.count !== collection.models.length) throw dataError("collection count does not match models", `${path}.count`);
    for (const [index, reference] of collection.models.entries()) {
      const referencePath = `${path}.models[${index}]`;
      assertExactKeys(reference, COLLECTION_MODEL_KEYS, referencePath);
      assertId(reference.model_id, `${referencePath}.model_id`);
      if (!modelRecords.has(reference.model_id)) throw dataError("unknown curated model id", `${referencePath}.model_id`);
      curatedModelReferenceCount += 1;
    }
  }
  return curatedModelReferenceCount;
}

function deepFreeze(value, seen = new WeakSet()) {
  if (value === null || typeof value !== "object" || seen.has(value)) return value;
  seen.add(value);
  for (const key of Reflect.ownKeys(value)) deepFreeze(value[key], seen);
  return Object.freeze(value);
}

function readonlyMap(entries) {
  const target = new Map(entries);
  let view;
  view = new Proxy(target, {
    get(map, property) {
      if (property === "size") return map.size;
      if (["set", "delete", "clear"].includes(property)) {
        return () => { throw new TypeError("read-only map"); };
      }
      if (property === "forEach") {
        return (callback, thisArg) => map.forEach((value, key) => callback.call(thisArg, value, key, view));
      }
      const value = Reflect.get(map, property, map);
      return typeof value === "function" ? value.bind(map) : value;
    }
  });
  return Object.freeze(view);
}

function frozenClone(value) {
  return deepFreeze(structuredClone(value));
}

export function validateV3AgentData({ models, taxonomy, routerIndex, routerPrompt, chains, curatedCollections }) {
  if (!Array.isArray(models) || models.length === 0) throw dataError("expected models", "models");
  const chapterIds = validateTaxonomy(taxonomy);
  const modelRecords = new Map();
  const knownRoles = new Set();
  const roleCounts = new Map();
  for (const [index, entry] of models.entries()) {
    const model = entry?.model ?? entry;
    const path = entry?.path ?? `models[${index}]`;
    const roles = validateV3Model(model, { path, chapterIds });
    if (modelRecords.has(model.id)) throw dataError("duplicate model id", `${path}.id`);
    if (entry?.fileName !== undefined && entry.fileName !== `${model.id}.json`) throw dataError("file name does not match model id", path);
    modelRecords.set(model.id, { model, path });
    for (const role of roles) {
      knownRoles.add(role);
      roleCounts.set(role, (roleCounts.get(role) ?? 0) + 1);
    }
  }
  if (knownRoles.size === 0) throw dataError("no models declare agent roles", "models.meta.agent_roles");
  const routerContract = validateRouterIndex(routerIndex);
  const chainContract = validateChains(chains, modelRecords, knownRoles);
  const routeContract = validateRoutes(routerIndex, routerContract, modelRecords, knownRoles, chainContract.chainsById);
  validateRouterPrompt(routerPrompt, routerContract, modelRecords, knownRoles, chainContract.chainsById);
  const curatedModelReferenceCount = validateCuratedCollections(curatedCollections, modelRecords);
  const modelsById = readonlyMap([...modelRecords.entries()].map(([id, record]) => [id, frozenClone(record.model)]));
  const routesByProblemAndStage = readonlyMap([...routeContract.routesByProblemAndStage.entries()].map(([id, route]) => [id, frozenClone(route)]));
  const chainsById = readonlyMap([...chainContract.chainsById.entries()].map(([id, chain]) => [id, frozenClone(chain)]));
  const compositionsByModelId = readonlyMap([...chainContract.compositionsByModelId.entries()].map(([id, values]) => [id, frozenClone(values)]));
  const compositionsByChapterId = readonlyMap([...chainContract.compositionsByChapterId.entries()].map(([id, values]) => [id, frozenClone(values)]));
  return deepFreeze({
    modelsById,
    problemTypes: frozenClone(routerIndex.problem_types),
    agentStages: frozenClone(routerIndex.agent_stages),
    routesByProblemAndStage,
    chainsById,
    curatedCollections: frozenClone(curatedCollections),
    compositionsByModelId,
    compositionsByChapterId,
    safetySignals: frozenClone(routerIndex.safety_signals),
    roleCounts: frozenClone(Object.fromEntries([...roleCounts.entries()].sort(([left], [right]) => compareAscii(left, right)))),
    stats: deepFreeze({
      modelCount: models.length,
      uniqueIdCount: modelRecords.size,
      problemTypeCount: routerIndex.problem_types.length,
      agentStageCount: routerIndex.agent_stages.length,
      routeCount: routerIndex.routes.length,
      chainCount: chainContract.chainsById.size,
      chainReferenceCount: routeContract.chainReferenceCount,
      curatedModelReferenceCount,
      assignedRoleCount: [...roleCounts.values()].reduce((sum, count) => sum + count, 0)
    })
  });
}

async function readJson(path, label) {
  let raw;
  try {
    raw = await readFile(path, "utf8");
  } catch (cause) {
    throw dataError(`unable to read public JSON: ${cause.code ?? cause.message}`, label);
  }
  try {
    return JSON.parse(raw);
  } catch (cause) {
    throw dataError(`invalid JSON: ${cause.message}`, label);
  }
}

async function resolvePublicPath(rootDir, relativePath, expectedKind) {
  let current = rootDir;
  const segments = relativePath.split(/[\\/]+/);
  for (const [index, segment] of ["", ...segments].entries()) {
    if (segment) current = join(current, segment);
    let stat;
    try {
      stat = await lstat(current);
    } catch (cause) {
      throw dataError(`unable to inspect public path: ${cause.code ?? cause.message}`, relativePath);
    }
    if (stat.isSymbolicLink()) throw dataError("symbolic links are not allowed in public data paths", relativePath);
    if (index === segments.length) {
      const kindMatches = expectedKind === "directory" ? stat.isDirectory() : stat.isFile();
      if (!kindMatches) throw dataError(`expected ${expectedKind}`, relativePath);
    } else if (!stat.isDirectory()) {
      throw dataError("public data ancestor is not a directory", relativePath);
    }
  }
  return current;
}

export async function loadV3AgentData(rootDir) {
  assertString(rootDir, "rootDir");
  const modelDir = await resolvePublicPath(rootDir, PUBLIC_V3_AGENT_PATHS.models, "directory");
  let entries;
  try {
    entries = await readdir(modelDir, { withFileTypes: true });
  } catch (cause) {
    throw dataError(`unable to list public model directory: ${cause.code ?? cause.message}`, PUBLIC_V3_AGENT_PATHS.models);
  }
  entries.sort((left, right) => compareAscii(left.name, right.name));
  const models = [];
  for (const entry of entries) {
    const label = join(PUBLIC_V3_AGENT_PATHS.models, entry.name);
    if (!entry.isFile() || !entry.name.endsWith(".json")) throw dataError("unexpected entry in public model directory", label);
    models.push({ fileName: entry.name, path: label, model: await readJson(join(modelDir, entry.name), label) });
  }
  const [taxonomyPath, routerIndexPath, routerPromptPath, chainsDir, curatedCollectionsPath] = await Promise.all([
    resolvePublicPath(rootDir, PUBLIC_V3_AGENT_PATHS.taxonomy, "file"),
    resolvePublicPath(rootDir, PUBLIC_V3_AGENT_PATHS.routerIndex, "file"),
    resolvePublicPath(rootDir, PUBLIC_V3_AGENT_PATHS.routerPrompt, "file"),
    resolvePublicPath(rootDir, PUBLIC_V3_AGENT_PATHS.chainsDir, "directory"),
    resolvePublicPath(rootDir, PUBLIC_V3_AGENT_PATHS.curatedCollections, "file")
  ]);
  const chainPaths = await Promise.all(CHAIN_FILE_NAMES.map(async (fileName) => ({
    fileName,
    path: join(PUBLIC_V3_AGENT_PATHS.chainsDir, fileName),
    absolutePath: await resolvePublicPath(rootDir, join(PUBLIC_V3_AGENT_PATHS.chainsDir, fileName), "file")
  })));
  const [taxonomy, routerIndex, routerPrompt, curatedCollections, ...chainValues] = await Promise.all([
    readJson(taxonomyPath, PUBLIC_V3_AGENT_PATHS.taxonomy),
    readJson(routerIndexPath, PUBLIC_V3_AGENT_PATHS.routerIndex),
    readJson(routerPromptPath, PUBLIC_V3_AGENT_PATHS.routerPrompt),
    readJson(curatedCollectionsPath, PUBLIC_V3_AGENT_PATHS.curatedCollections),
    ...chainPaths.map(({ absolutePath, path }) => readJson(absolutePath, path))
  ]);
  const chains = chainPaths.map(({ fileName, path }, index) => ({ fileName, path, chain: chainValues[index] }));
  void chainsDir;
  return validateV3AgentData({ models, taxonomy, routerIndex, routerPrompt, chains, curatedCollections });
}
