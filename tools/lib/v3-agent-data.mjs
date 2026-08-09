import { lstat, readdir, readFile } from "node:fs/promises";
import { basename, join } from "node:path";

export const V3_SCHEMA_VERSION = "3.0.0";
export const V3_AGENT_DATA_ERROR = "V3_AGENT_DATA_INVALID";
export const PUBLIC_V3_AGENT_PATHS = Object.freeze({
  models: join("knowledge", "models-v3"),
  taxonomy: join("knowledge", "taxonomy.json"),
  routerIndex: join("chain-protocols", "agent-router-index.json"),
  routerPrompt: join("chain-protocols", "agent-router-prompt.json")
});

const MODEL_ROOT_KEYS = new Set([
  "schema_version", "id", "meta", "core_definition", "when_to_use",
  "before_after", "reasoning_steps", "scenarios", "codex_integration",
  "pitfalls", "quality"
]);
const MODEL_META_REQUIRED_KEYS = new Set(["name", "category", "tags", "skill_name"]);
const MODEL_META_KEYS = new Set([
  ...MODEL_META_REQUIRED_KEYS, "source", "sourceType", "sourceTitle", "agent_roles"
]);
const QUALITY_KEYS = new Set([
  "definition_clarity", "trigger_precision", "step_completeness",
  "scenario_coverage", "prompt_effectiveness", "overall"
]);
const ROUTER_INDEX_KEYS = new Set([
  "schema_version", "description", "problem_type_signals",
  "agent_stage_signals", "routing_table"
]);
const ROUTER_PROMPT_KEYS = new Set([
  "schema_version", "name", "description", "router_system_prompt", "usage",
  "example_input", "example_output", "embedded_models", "routing_index"
]);

function dataError(message, path) {
  const error = new TypeError(`${message} at ${path}`);
  error.code = V3_AGENT_DATA_ERROR;
  error.path = path;
  return error;
}

function isPlainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value) &&
    Object.getPrototypeOf(value) === Object.prototype;
}

function assertPlainObject(value, path) {
  if (!isPlainObject(value)) throw dataError("expected object", path);
}

function assertExactKeys(value, keys, path) {
  assertPlainObject(value, path);
  const actual = Object.keys(value);
  if (actual.length !== keys.size || actual.some((key) => !keys.has(key))) {
    throw dataError("unknown or missing fields", path);
  }
}

function assertAllowedKeys(value, allowed, required, path) {
  assertPlainObject(value, path);
  const actual = Object.keys(value);
  if (actual.some((key) => !allowed.has(key)) || [...required].some((key) => !(key in value))) {
    throw dataError("unknown or missing fields", path);
  }
}

function assertString(value, path, { allowEmpty = false } = {}) {
  if (typeof value !== "string" || (!allowEmpty && value.trim().length === 0)) {
    throw dataError("expected non-empty string", path);
  }
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

function assertSignalMap(value, path) {
  assertPlainObject(value, path);
  if (Object.keys(value).length === 0) throw dataError("expected non-empty signal map", path);
  for (const [key, signals] of Object.entries(value)) {
    assertString(key, `${path}.${key}`);
    assertStringArray(signals, `${path}.${key}`, { minLength: 1, unique: true });
  }
}

function validateRouter(routerIndex, routerPrompt) {
  assertExactKeys(routerIndex, ROUTER_INDEX_KEYS, "routerIndex");
  if (routerIndex.schema_version !== "1.0-router") {
    throw dataError("unsupported schema_version", "routerIndex.schema_version");
  }
  assertString(routerIndex.description, "routerIndex.description");
  assertSignalMap(routerIndex.problem_type_signals, "routerIndex.problem_type_signals");
  assertSignalMap(routerIndex.agent_stage_signals, "routerIndex.agent_stage_signals");
  assertPlainObject(routerIndex.routing_table, "routerIndex.routing_table");
  if (Object.keys(routerIndex.routing_table).length === 0) {
    throw dataError("expected non-empty routing table", "routerIndex.routing_table");
  }

  const roles = new Set();
  const referencedModels = new Map();
  for (const [routeKey, route] of Object.entries(routerIndex.routing_table)) {
    const path = `routerIndex.routing_table.${routeKey}`;
    assertExactKeys(route, new Set([
      "problem_type", "agent_stage", "recommended_roles", "stateful_models", "chain_suggestion"
    ]), path);
    if (routeKey !== `${route.problem_type}::${route.agent_stage}`) {
      throw dataError("route key does not match problem_type and agent_stage", path);
    }
    if (!(route.problem_type in routerIndex.problem_type_signals)) {
      throw dataError("unknown problem_type", `${path}.problem_type`);
    }
    if (!(route.agent_stage in routerIndex.agent_stage_signals)) {
      throw dataError("unknown agent_stage", `${path}.agent_stage`);
    }
    assertStringArray(route.recommended_roles, `${path}.recommended_roles`, { minLength: 1, unique: true });
    for (const role of route.recommended_roles) roles.add(role);
    if (!Array.isArray(route.stateful_models) || route.stateful_models.length === 0) {
      throw dataError("expected non-empty stateful_models", `${path}.stateful_models`);
    }
    for (const [index, model] of route.stateful_models.entries()) {
      const modelPath = `${path}.stateful_models[${index}]`;
      assertExactKeys(model, new Set(["name", "file", "activation"]), modelPath);
      assertString(model.name, `${modelPath}.name`);
      assertString(model.activation, `${modelPath}.activation`);
      assertString(model.file, `${modelPath}.file`, { allowEmpty: true });
      if (model.file && (basename(model.file) !== model.file || !model.file.endsWith(".json"))) {
        throw dataError("unsafe model file reference", `${modelPath}.file`);
      }
      if (model.file) {
        const reference = referencedModels.get(model.file) ?? { roles: new Set(), paths: [] };
        for (const role of route.recommended_roles) reference.roles.add(role);
        reference.paths.push(`${modelPath}.file`);
        referencedModels.set(model.file, reference);
      }
    }
    if (route.chain_suggestion !== null) {
      assertString(route.chain_suggestion, `${path}.chain_suggestion`);
    }
  }

  assertExactKeys(routerPrompt, ROUTER_PROMPT_KEYS, "routerPrompt");
  if (routerPrompt.schema_version !== "1.0-router-prompt") {
    throw dataError("unsupported schema_version", "routerPrompt.schema_version");
  }
  for (const key of ["name", "description", "router_system_prompt", "example_input", "example_output"]) {
    assertString(routerPrompt[key], `routerPrompt.${key}`);
  }
  assertPlainObject(routerPrompt.usage, "routerPrompt.usage");
  if (Object.keys(routerPrompt.usage).length === 0) throw dataError("expected usage steps", "routerPrompt.usage");
  for (const [key, value] of Object.entries(routerPrompt.usage)) assertString(value, `routerPrompt.usage.${key}`);
  assertPlainObject(routerPrompt.embedded_models, "routerPrompt.embedded_models");
  if (Object.keys(routerPrompt.embedded_models).length === 0) {
    throw dataError("expected embedded models", "routerPrompt.embedded_models");
  }
  for (const [role, model] of Object.entries(routerPrompt.embedded_models)) {
    assertString(role, `routerPrompt.embedded_models.${role}`);
    assertExactKeys(model, new Set(["name", "sp"]), `routerPrompt.embedded_models.${role}`);
    assertString(model.name, `routerPrompt.embedded_models.${role}.name`);
    assertString(model.sp, `routerPrompt.embedded_models.${role}.sp`);
    roles.add(role);
  }
  if (routerPrompt.routing_index !== PUBLIC_V3_AGENT_PATHS.routerIndex) {
    throw dataError("unexpected routing_index", "routerPrompt.routing_index");
  }

  return { roles, referencedModels };
}

function validateTaxonomy(taxonomy) {
  assertPlainObject(taxonomy, "taxonomy");
  if (!Array.isArray(taxonomy.chapters) || taxonomy.chapters.length === 0) {
    throw dataError("expected taxonomy chapters", "taxonomy.chapters");
  }
  const chapterIds = new Set();
  for (const [index, chapter] of taxonomy.chapters.entries()) {
    assertPlainObject(chapter, `taxonomy.chapters[${index}]`);
    assertString(chapter.id, `taxonomy.chapters[${index}].id`);
    if (chapterIds.has(chapter.id)) throw dataError("duplicate chapter id", `taxonomy.chapters[${index}].id`);
    chapterIds.add(chapter.id);
  }
  return chapterIds;
}

function validateV3Model(model, { path, chapterIds, routerRoles }) {
  assertExactKeys(model, MODEL_ROOT_KEYS, path);
  if (model.schema_version !== V3_SCHEMA_VERSION) {
    throw dataError("unsupported schema_version", `${path}.schema_version`);
  }
  assertString(model.id, `${path}.id`);
  if (basename(model.id) !== model.id || model.id.includes("/")) throw dataError("unsafe model id", `${path}.id`);

  assertAllowedKeys(model.meta, MODEL_META_KEYS, MODEL_META_REQUIRED_KEYS, `${path}.meta`);
  assertString(model.meta.name, `${path}.meta.name`);
  assertString(model.meta.category, `${path}.meta.category`);
  if (!chapterIds.has(model.meta.category)) throw dataError("unknown taxonomy category", `${path}.meta.category`);
  assertStringArray(model.meta.tags, `${path}.meta.tags`, { unique: true });
  assertString(model.meta.skill_name, `${path}.meta.skill_name`);
  for (const key of ["source", "sourceType", "sourceTitle"]) {
    if (key in model.meta) assertString(model.meta[key], `${path}.meta.${key}`);
  }
  const agentRoles = model.meta.agent_roles ?? [];
  assertStringArray(agentRoles, `${path}.meta.agent_roles`, { unique: true });
  for (const [index, role] of agentRoles.entries()) {
    if (!routerRoles.has(role)) throw dataError("role is not declared by router", `${path}.meta.agent_roles[${index}]`);
  }

  assertString(model.core_definition, `${path}.core_definition`);
  assertExactKeys(model.when_to_use, new Set(["triggers", "anti_triggers"]), `${path}.when_to_use`);
  assertStringArray(model.when_to_use.triggers, `${path}.when_to_use.triggers`, { minLength: 1 });
  assertStringArray(model.when_to_use.anti_triggers, `${path}.when_to_use.anti_triggers`);
  assertExactKeys(model.before_after, new Set(["without_model", "with_model"]), `${path}.before_after`);
  assertString(model.before_after.without_model, `${path}.before_after.without_model`);
  assertString(model.before_after.with_model, `${path}.before_after.with_model`);

  if (!Array.isArray(model.reasoning_steps) || model.reasoning_steps.length === 0) {
    throw dataError("expected reasoning steps", `${path}.reasoning_steps`);
  }
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
    const value = model.quality[key];
    if (!Number.isInteger(value) || value < 1 || value > 5) {
      throw dataError("expected quality score from 1 to 5", `${path}.quality.${key}`);
    }
  }
  return agentRoles;
}

export function validateV3AgentData({ models, taxonomy, routerIndex, routerPrompt }) {
  if (!Array.isArray(models) || models.length === 0) throw dataError("expected models", "models");
  const chapterIds = validateTaxonomy(taxonomy);
  const routerContract = validateRouter(routerIndex, routerPrompt);
  const routerRoles = routerContract.roles;
  const modelIds = new Set();
  const modelsByFile = new Map();
  const roleCounts = Object.fromEntries([...routerRoles].sort().map((role) => [role, 0]));

  for (const [index, entry] of models.entries()) {
    const model = entry?.model ?? entry;
    const path = entry?.path ?? `models[${index}]`;
    const roles = validateV3Model(model, { path, chapterIds, routerRoles });
    if (modelIds.has(model.id)) throw dataError("duplicate model id", `${path}.id`);
    modelIds.add(model.id);
    if (entry?.fileName !== undefined && entry.fileName !== `${model.id}.json`) {
      throw dataError("file name does not match model id", path);
    }
    const fileName = entry?.fileName ?? `${model.id}.json`;
    modelsByFile.set(fileName, { model, path });
    for (const role of roles) roleCounts[role] += 1;
  }

  for (const [fileName, reference] of routerContract.referencedModels) {
    const referencedModel = modelsByFile.get(fileName);
    if (!referencedModel) {
      throw dataError("router references a missing V3 model file", reference.paths[0]);
    }
    const declaredRoles = new Set(referencedModel.model.meta.agent_roles ?? []);
    for (const role of reference.roles) {
      if (!declaredRoles.has(role)) {
        throw dataError(
          `router-referenced model does not declare recommended role ${role}`,
          `${referencedModel.path}.meta.agent_roles`
        );
      }
    }
  }

  const assignedRoleCount = Object.values(roleCounts).reduce((sum, count) => sum + count, 0);
  if (assignedRoleCount === 0) throw dataError("no models declare agent roles", "models.meta.agent_roles");

  return {
    models: models.map((entry) => entry?.model ?? entry),
    router: {
      problemTypeSignals: routerIndex.problem_type_signals,
      agentStageSignals: routerIndex.agent_stage_signals,
      routingTable: routerIndex.routing_table,
      systemPrompt: routerPrompt.router_system_prompt,
      embeddedModels: routerPrompt.embedded_models,
      referencedModels: Object.fromEntries(
        [...routerContract.referencedModels].map(([fileName, reference]) => [fileName, [...reference.roles].sort()])
      )
    },
    agentRoles: [...routerRoles].sort(),
    roleCounts,
    stats: {
      modelCount: models.length,
      uniqueIdCount: modelIds.size,
      assignedRoleCount
    }
  };
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
  entries.sort((left, right) => left.name.localeCompare(right.name, "zh-CN"));
  const models = [];
  for (const entry of entries) {
    const label = join(PUBLIC_V3_AGENT_PATHS.models, entry.name);
    if (!entry.isFile() || !entry.name.endsWith(".json")) {
      throw dataError("unexpected entry in public model directory", label);
    }
    models.push({
      fileName: entry.name,
      path: label,
      model: await readJson(join(modelDir, entry.name), label)
    });
  }

  const [taxonomyPath, routerIndexPath, routerPromptPath] = await Promise.all([
    resolvePublicPath(rootDir, PUBLIC_V3_AGENT_PATHS.taxonomy, "file"),
    resolvePublicPath(rootDir, PUBLIC_V3_AGENT_PATHS.routerIndex, "file"),
    resolvePublicPath(rootDir, PUBLIC_V3_AGENT_PATHS.routerPrompt, "file")
  ]);
  const [taxonomy, routerIndex, routerPrompt] = await Promise.all([
    readJson(taxonomyPath, PUBLIC_V3_AGENT_PATHS.taxonomy),
    readJson(routerIndexPath, PUBLIC_V3_AGENT_PATHS.routerIndex),
    readJson(routerPromptPath, PUBLIC_V3_AGENT_PATHS.routerPrompt)
  ]);
  return validateV3AgentData({ models, taxonomy, routerIndex, routerPrompt });
}
