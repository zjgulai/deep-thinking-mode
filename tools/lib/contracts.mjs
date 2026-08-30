import { canonicalJsonBytes } from "./json.mjs";
import { sha256 } from "./hash.mjs";

const CONTRACT_SCHEMA_VERSION = "1.0.0";
const ERROR_CODE = "CONTRACT_SCHEMA_INVALID";
const AGENT_KNOWLEDGE_ERROR_CODE = "AGENT_KNOWLEDGE_SCHEMA_INVALID";

const CONTRACT_KINDS = new Set([
  "curation-source-id",
  "knowledge-sources",
  "problem-routes",
  "source-summary",
  "taxonomy"
]);

const ISO_8601 = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/;
const SOURCE_ID_RE = /^src_[0-9a-f]{32}$/;
const MODEL_ID_RE = /^mdl-[0-9a-z-]+$/;
const ROUTE_ID_RE = /^r(?:[0-9]{2}|[0-9]+(?:[a-z])?)$/i;

const TAXONOMY_CHAPTER_IDS = [
  "00", "01", "02", "03", "04", "05", "06", "07", "08",
  "09", "10", "11", "12"
];

const TAXONOMY_TYPES = {
  content_types: new Set(["canonical", "card", "case", "comparison", "series", "related"]),
  risk_flags: new Set(["needs_ocr", "needs_medical_review", "needs_logic_review", "evidence_limited"]),
  evidence_modes: new Set(["none", "cleaned_text", "approved_ocr", "mixed", "independent_verification"]),
  source_statuses: new Set(["new", "draft", "needs_review", "blocked_ocr", "approved", "rejected"]),
  processing_status: new Set([
    "new", "cleaned", "ready", "needs_review", "needs_ocr", "needs_medical_review",
    "fetch_failed", "duplicate", "superseded"
  ]),
  ocr_statuses: new Set(["not_required", "queued", "needs_visual_review", "approved", "rejected", "fetch_failed"]),
  medical_review_status: new Set(["not_triaged", "not_applicable", "needs_expert", "approved", "rejected"]),
  logic_review_status: new Set(["not_triaged", "not_applicable", "needs_expert", "approved", "rejected"]),
  provenance_visibility: new Set(["public_metadata", "public_synthesis_redacted"]),
  content_role: new Set(["canonical", "card", "case", "comparison", "series", "related"]),
  relation_type: new Set([
    "duplicate_of", "short_version_of", "card_for", "case_for", "comparison_of",
    "series_part_of", "related_to"
  ]),
  review_status: new Set(["draft", "approved", "rejected"])
};

function contractError(message, path) {
  const error = new TypeError(message);
  error.code = ERROR_CODE;
  if (path) error.path = path;
  return error;
}

function agentKnowledgeError(message, path) {
  const error = new TypeError(message);
  error.code = AGENT_KNOWLEDGE_ERROR_CODE;
  error.path = path;
  return error;
}

function isPlainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value) &&
    Object.getPrototypeOf(value) === Object.prototype;
}

function assertString(value, path, options = {}) {
  const { minLength = 1 } = options;
  if (typeof value !== "string" || value.length < minLength) {
    throw contractError(`invalid string at ${path}`, path);
  }
}

function assertBoolean(value, path) {
  if (typeof value !== "boolean") throw contractError(`invalid boolean at ${path}`, path);
}

function assertNumber(value, path) {
  if (typeof value !== "number" || Number.isNaN(value)) {
    throw contractError(`invalid number at ${path}`, path);
  }
}

function assertInteger(value, path, min) {
  if (!Number.isInteger(value) || value < min) {
    throw contractError(`invalid integer at ${path}`, path);
  }
}

function assertArray(value, path, expectedLength = 0) {
  if (!Array.isArray(value) || value.length < expectedLength) {
    throw contractError(`invalid array at ${path}`, path);
  }
}

function assertValueIn(value, allowed, path) {
  const has = typeof allowed?.has === "function"
    ? allowed.has.bind(allowed)
    : (candidate) => allowed.includes(candidate);
  if (!has(value)) throw contractError(`invalid value at ${path}`, path);
}

function assertSchemaVersion(value, path) {
  if (value !== CONTRACT_SCHEMA_VERSION) throw contractError(`invalid schema_version at ${path}`, path);
}

function assertSha256(value, path) {
  if (typeof value !== "string" || !/^[0-9a-f]{64}$/.test(value)) {
    throw contractError(`invalid sha256 at ${path}`, path);
  }
}

function assertDateTime(value, path) {
  if (value === null) return;
  assertString(value, path);
  if (!ISO_8601.test(value)) throw contractError(`invalid RFC3339 datetime at ${path}`, path);
}

function assertSourceId(value, path) {
  if (!SOURCE_ID_RE.test(value)) throw contractError(`invalid source_id at ${path}`, path);
}

function assertNoUnknownKeys(value, allowed, path) {
  const keys = Object.keys(value).sort();
  const sortedAllowed = [...allowed].sort();
  if (keys.length !== sortedAllowed.length ||
      keys.some((key, index) => key !== sortedAllowed[index])) {
    throw contractError(`unknown or missing keys at ${path}`, path);
  }
}

function assertOrderedBy(values, keyGetter, path) {
  let previous = null;
  for (const entry of values) {
    const value = keyGetter(entry);
    if (previous !== null && value < previous) {
      throw contractError(`array not ordered at ${path}`, path);
    }
    previous = value;
  }
}

function assertUnique(values, keyGetter, path) {
  const seen = new Set();
  for (const value of values) {
    const key = keyGetter(value);
    if (seen.has(key)) throw contractError(`duplicate value at ${path}`, path);
    seen.add(key);
  }
}

function assertAgentObject(value, path, keys) {
  if (!isPlainObject(value)) throw agentKnowledgeError(`invalid object at ${path}`, path);
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) {
    throw agentKnowledgeError(`unknown or missing keys at ${path}`, path);
  }
}

function assertAgentString(value, path) {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw agentKnowledgeError(`invalid string at ${path}`, path);
  }
}

function assertAgentId(value, path, prefix) {
  assertAgentString(value, path);
  if (!new RegExp(`^${prefix}[a-z0-9]+(?:-[a-z0-9]+)*$`).test(value)) {
    throw agentKnowledgeError(`invalid id at ${path}`, path);
  }
}

function assertAgentStringArray(value, path, { min = 0, exact = null } = {}) {
  if (!Array.isArray(value) || value.length < min) {
    throw agentKnowledgeError(`invalid array at ${path}`, path);
  }
  const seen = new Set();
  for (const [index, item] of value.entries()) {
    assertAgentString(item, `${path}[${index}]`);
    if (seen.has(item)) throw agentKnowledgeError(`duplicate value at ${path}[${index}]`, `${path}[${index}]`);
    seen.add(item);
  }
  if (exact && (seen.size !== exact.size || [...exact].some((item) => !seen.has(item)))) {
    throw agentKnowledgeError(`unexpected values at ${path}`, path);
  }
}

function assertAgentEnum(value, allowed, path) {
  if (!allowed.has(value)) throw agentKnowledgeError(`invalid value at ${path}`, path);
}

function assertAgentScore(value, path) {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > 1) {
    throw agentKnowledgeError(`invalid score at ${path}`, path);
  }
  if (Math.abs(value * 10_000 - Math.round(value * 10_000)) > 1e-9) {
    throw agentKnowledgeError(`score exceeds four decimal places at ${path}`, path);
  }
}

function scoreBasisPoints(value) {
  return Math.round(value * 10_000);
}

function assertAgentDateTime(value, path, { nullable = false } = {}) {
  if (nullable && value === null) return;
  assertAgentString(value, path);
  if (!ISO_8601.test(value)) throw agentKnowledgeError(`invalid RFC3339 datetime at ${path}`, path);
}

function assertAgentReferenceArray(value, knownIds, path, { min = 0 } = {}) {
  assertAgentStringArray(value, path, { min });
  for (const [index, id] of value.entries()) {
    if (!knownIds.has(id)) throw agentKnowledgeError(`unknown reference at ${path}[${index}]`, `${path}[${index}]`);
  }
}

function assertNullableSha256(value, path) {
  if (value !== null && !/^[0-9a-f]{64}$/.test(value)) {
    throw agentKnowledgeError(`invalid sha256 at ${path}`, path);
  }
}

function assertSequentialSteps(value, path, keys) {
  if (!Array.isArray(value) || value.length === 0) throw agentKnowledgeError(`invalid steps at ${path}`, path);
  for (const [index, step] of value.entries()) {
    assertAgentObject(step, `${path}[${index}]`, keys);
    if (step.order !== index + 1) throw agentKnowledgeError(`invalid order at ${path}[${index}].order`, `${path}[${index}].order`);
  }
}

function assertNoPrivateText(value, path) {
  const forbiddenKeys = new Set([
    "reasoning", "encrypted_content", "agent_reasoning", "source_path", "session_id",
    "thread_id", "root_thread_id", "cwd", "username", "raw_message", "raw_output"
  ]);
  const privateTextPatterns = [
    /(?:\/Users\/|\/home\/|\/tmp\/|file:\/\/|[A-Za-z]:\\)/i,
    /(?:^|[^a-z0-9_.-])(?:coding_session|\.local)\//i,
    /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/i,
    /\b(?:sk|ghp|github_pat|xox[baprs])[-_][A-Za-z0-9_-]{12,}\b/,
    /\b(?:api[_-]?key|access[_-]?token|auth[_-]?token|password|secret)\s*[:=]\s*[^\s,;]+/i,
    /<\/?(?:analysis|reasoning)>/i,
    /\b(?:chain[- ]of[- ]thought|private reasoning)\b/i
  ];
  const visit = (entry, entryPath) => {
    if (typeof entry === "string") {
      if (privateTextPatterns.some((pattern) => pattern.test(entry))) {
        throw agentKnowledgeError(`private or sensitive text at ${entryPath}`, entryPath);
      }
      return;
    }
    if (Array.isArray(entry)) {
      entry.forEach((item, index) => visit(item, `${entryPath}[${index}]`));
      return;
    }
    if (!isPlainObject(entry)) return;
    for (const [key, child] of Object.entries(entry)) {
      if (forbiddenKeys.has(key)) throw agentKnowledgeError(`private field at ${entryPath}`, entryPath);
      visit(child, `${entryPath}.${key}`);
    }
  };
  visit(value, path);
}

function assertRfc3339Date(value, path) {
  assertString(value, path);
  if (!ISO_8601.test(value)) throw contractError(`invalid RFC3339 date at ${path}`, path);
}

function assertEvidenceContract(claim, path) {
  if (claim === null) return;
  if (!isPlainObject(claim)) throw contractError(`invalid evidence claim at ${path}`, path);
  const allowed = new Set(["claim_id", "text", "claim_status", "evidence_refs"]);
  if (Object.keys(claim).some((key) => !allowed.has(key))) {
    throw contractError(`unknown fields in evidence claim at ${path}`, path);
  }
  assertString(claim.claim_id, `${path}.claim_id`);
  if (!/^([a-z0-9_\\-]+)$/.test(claim.claim_id)) throw contractError(`invalid claim_id at ${path}.claim_id`, `${path}.claim_id`);
  assertString(claim.text, `${path}.text`, { minLength: 1 });
  assertValueIn(claim.claim_status, new Set([
    "source_claim", "cross_source_consensus", "independently_verified", "conflicted"
  ]), `${path}.claim_status`);
  if (!Array.isArray(claim.evidence_refs)) {
    throw contractError(`invalid evidence_refs at ${path}.evidence_refs`, `${path}.evidence_refs`);
  }
  for (const [index, evidence] of claim.evidence_refs.entries()) {
    if (!isPlainObject(evidence)) throw contractError(`invalid evidence ref at ${path}.evidence_refs[${index}]`, `${path}.evidence_refs[${index}]`);
    const allowedEvidence = new Set(["kind", "source_id", "artifact_sha256", "start_line", "end_line", "asset_id", "block_ids", "verification_id"]);
    if (Object.keys(evidence).some((key) => !allowedEvidence.has(key))) {
      throw contractError(`unknown evidence fields at ${path}.evidence_refs[${index}]`, `${path}.evidence_refs[${index}]`);
    }
    assertValueIn(evidence.kind, new Set(["cleaned_lines", "ocr_blocks", "verification_record"]), `${path}.evidence_refs[${index}].kind`);
    assertSourceId(evidence.source_id, `${path}.evidence_refs[${index}].source_id`);
    if (evidence.artifact_sha256 !== undefined) assertSha256(evidence.artifact_sha256, `${path}.evidence_refs[${index}].artifact_sha256`);
    if (evidence.start_line !== undefined && (typeof evidence.start_line !== "number" || evidence.start_line < 1)) {
      throw contractError(`invalid start_line at ${path}.evidence_refs[${index}].start_line`, `${path}.evidence_refs[${index}].start_line`);
    }
  }
}

function assertKnowledgeSource(value, path) {
  const required = new Set([
    "schema_version", "corpus_version", "sources"
  ]);
  assertNoUnknownKeys(value, required, path);
  assertSchemaVersion(value.schema_version, `${path}.schema_version`);
  assertString(value.corpus_version, `${path}.corpus_version`);
  assertArray(value.sources, `${path}.sources`, 0);
  const sourceIds = new Set();
  for (const [index, source] of value.sources.entries()) {
    if (!isPlainObject(source)) throw contractError(`invalid source at ${path}.sources[${index}]`, `${path}.sources[${index}]`);
    const allowedSourceFields = new Set([
      "source_id", "title", "author", "published_at", "date_precision",
      "source_url", "source_fingerprint", "provenance_visibility", "primary_chapter_id",
      "tags", "primary_content_type", "model_roles", "related_sources", "processing_status",
      "ocr_status", "medical_review_status", "logic_review_status", "risk_flags", "evidence_boundary"
    ]);
    if (Object.keys(source).some((key) => !allowedSourceFields.has(key))) {
      throw contractError(`unknown field in source[${index}]`, `${path}.sources[${index}]`);
    }
    assertSourceId(source.source_id, `${path}.sources[${index}].source_id`);
    if (sourceIds.has(source.source_id)) throw contractError(`duplicate source_id at ${path}.sources[${index}].source_id`, `${path}.sources[${index}].source_id`);
    sourceIds.add(source.source_id);
    assertString(source.title, `${path}.sources[${index}].title`);
    if (source.author !== null) assertString(source.author, `${path}.sources[${index}].author`);
    assertDateTime(source.published_at, `${path}.sources[${index}].published_at`);
  assertValueIn(source.date_precision, new Set(["datetime", "date", "month", "year", "unknown"]), `${path}.sources[${index}].date_precision`);
    if (source.source_url !== null) {
      assertString(source.source_url, `${path}.sources[${index}].source_url`);
      if (!/^https?:\/\//.test(source.source_url)) throw contractError(`invalid source_url at ${path}.sources[${index}].source_url`, `${path}.sources[${index}].source_url`);
    }
    if (source.source_fingerprint !== null) assertSha256(source.source_fingerprint, `${path}.sources[${index}].source_fingerprint`);
  assertValueIn(source.provenance_visibility, TAXONOMY_TYPES.provenance_visibility, `${path}.sources[${index}].provenance_visibility`);
    if (source.primary_chapter_id !== null) {
      assertString(source.primary_chapter_id, `${path}.sources[${index}].primary_chapter_id`);
  }
  assertArray(source.tags, `${path}.sources[${index}].tags`);
  for (const [tagIndex, tag] of source.tags.entries()) assertString(tag, `${path}.sources[${index}].tags[${tagIndex}]`);
    if (source.primary_content_type !== null) {
      assertValueIn(source.primary_content_type, TAXONOMY_TYPES.content_types, `${path}.sources[${index}].primary_content_type`);
    }
    assertArray(source.model_roles, `${path}.sources[${index}].model_roles`);
    for (const [modelRoleIndex, role] of source.model_roles.entries()) {
      if (!isPlainObject(role)) throw contractError(`invalid model_role at ${path}.sources[${index}].model_roles[${modelRoleIndex}]`, `${path}.sources[${index}].model_roles[${modelRoleIndex}]`);
      const allowedRole = new Set(["model_id", "content_role"]);
      if (Object.keys(role).some((key) => !allowedRole.has(key))) {
        throw contractError(`unknown model role field at ${path}.sources[${index}].model_roles[${modelRoleIndex}]`, `${path}.sources[${index}].model_roles[${modelRoleIndex}]`);
      }
      assertString(role.model_id, `${path}.sources[${index}].model_roles[${modelRoleIndex}].model_id`);
      assertValueIn(role.content_role, TAXONOMY_TYPES.content_role, `${path}.sources[${index}].model_roles[${modelRoleIndex}].content_role`);
    }
    assertArray(source.related_sources, `${path}.sources[${index}].related_sources`);
    for (const [relatedIndex, related] of source.related_sources.entries()) {
      if (!isPlainObject(related)) throw contractError(`invalid related source at ${path}.sources[${index}].related_sources[${relatedIndex}]`, `${path}.sources[${index}].related_sources[${relatedIndex}]`);
      const allowedRelated = new Set(["source_id", "relation"]);
      if (Object.keys(related).some((key) => !allowedRelated.has(key))) {
        throw contractError(`unknown related source field at ${path}.sources[${index}].related_sources[${relatedIndex}]`, `${path}.sources[${index}].related_sources[${relatedIndex}]`);
      }
      assertSourceId(related.source_id, `${path}.sources[${index}].related_sources[${relatedIndex}].source_id`);
      assertValueIn(related.relation, TAXONOMY_TYPES.relation_type, `${path}.sources[${index}].related_sources[${relatedIndex}].relation`);
    }
    assertValueIn(source.processing_status, TAXONOMY_TYPES.processing_status, `${path}.sources[${index}].processing_status`);
    assertValueIn(source.ocr_status, TAXONOMY_TYPES.ocr_statuses, `${path}.sources[${index}].ocr_status`);
    assertValueIn(source.medical_review_status, TAXONOMY_TYPES.medical_review_status, `${path}.sources[${index}].medical_review_status`);
    assertValueIn(source.logic_review_status, TAXONOMY_TYPES.logic_review_status, `${path}.sources[${index}].logic_review_status`);
    assertArray(source.risk_flags, `${path}.sources[${index}].risk_flags`);
  }
}

function assertSourceSummary(value, path) {
  const allowedSourceSummaryKeys = new Set([
    "schema_version", "source_id", "cleaned_sha256", "summary_status",
    "evidence_mode", "core_question", "core_conclusion", "key_concepts",
    "mechanisms", "methods", "use_cases", "limitations", "unique_contributions",
    "candidate_model_ids"
  ]);
  assertNoUnknownKeys(value, allowedSourceSummaryKeys, path);
  assertSchemaVersion(value.schema_version, `${path}.schema_version`);
  assertSourceId(value.source_id, `${path}.source_id`);
  assertSha256(value.cleaned_sha256, `${path}.cleaned_sha256`);
  assertValueIn(value.summary_status, TAXONOMY_TYPES.source_statuses, `${path}.summary_status`);
  assertValueIn(value.evidence_mode, TAXONOMY_TYPES.evidence_modes, `${path}.evidence_mode`);
  assertEvidenceContract(value.core_question, `${path}.core_question`);
  assertEvidenceContract(value.core_conclusion, `${path}.core_conclusion`);

  if (!Array.isArray(value.key_concepts)) throw contractError(`invalid key_concepts at ${path}.key_concepts`, `${path}.key_concepts`);
  for (const [index, concept] of value.key_concepts.entries()) {
    if (!isPlainObject(concept)) throw contractError(`invalid key_concept at ${path}.key_concepts[${index}]`, `${path}.key_concepts[${index}]`);
    const allowedConcept = new Set(["term", "definition"]);
    if (Object.keys(concept).some((key) => !allowedConcept.has(key))) {
      throw contractError(`unknown key_concept fields at ${path}.key_concepts[${index}]`, `${path}.key_concepts[${index}]`);
    }
    assertString(concept.term, `${path}.key_concepts[${index}].term`);
    assertEvidenceContract(concept.definition, `${path}.key_concepts[${index}].definition`);
  }

  for (const listName of ["mechanisms", "use_cases", "limitations", "unique_contributions"]) {
    if (!Array.isArray(value[listName])) throw contractError(`invalid ${listName} at ${path}.${listName}`, `${path}.${listName}`);
    for (const [index, claim] of value[listName].entries()) {
      assertEvidenceContract(claim, `${path}.${listName}[${index}]`);
    }
  }
  if (!Array.isArray(value.methods)) throw contractError(`invalid methods at ${path}.methods`, `${path}.methods`);
  for (const [methodIndex, method] of value.methods.entries()) {
    if (!isPlainObject(method)) throw contractError(`invalid methods[${methodIndex}]`, `${path}.methods[${methodIndex}]`);
    const allowedMethod = new Set(["name", "steps", "use_cases", "stop_conditions"]);
    if (Object.keys(method).some((key) => !allowedMethod.has(key))) {
      throw contractError(`unknown method fields at ${path}.methods[${methodIndex}]`, `${path}.methods[${methodIndex}]`);
    }
    assertEvidenceContract(method.name, `${path}.methods[${methodIndex}].name`);
    assertArray(method.steps, `${path}.methods[${methodIndex}].steps`);
    for (const [stepIndex, step] of method.steps.entries()) {
      if (!isPlainObject(step)) throw contractError(`invalid method step at ${path}.methods[${methodIndex}].steps[${stepIndex}]`, `${path}.methods[${methodIndex}].steps[${stepIndex}]`);
      if (Object.keys(step).some((key) => key !== "order" && key !== "claim")) {
        throw contractError(`unknown step fields at ${path}.methods[${methodIndex}].steps[${stepIndex}]`, `${path}.methods[${methodIndex}].steps[${stepIndex}]`);
      }
      assertInteger(step.order, `${path}.methods[${methodIndex}].steps[${stepIndex}].order`, 1);
      assertEvidenceContract(step.claim, `${path}.methods[${methodIndex}].steps[${stepIndex}].claim`);
    }
  }
  assertArray(value.candidate_model_ids, `${path}.candidate_model_ids`);
  const modelIds = new Set();
  for (const [index, modelId] of value.candidate_model_ids.entries()) {
    assertString(modelId, `${path}.candidate_model_ids[${index}]`);
    if (!MODEL_ID_RE.test(modelId)) throw contractError(`invalid model_id at ${path}.candidate_model_ids[${index}]`, `${path}.candidate_model_ids[${index}]`);
    if (modelIds.has(modelId)) throw contractError(`duplicate model_id at ${path}.candidate_model_ids[${index}]`, `${path}.candidate_model_ids[${index}]`);
    modelIds.add(modelId);
  }
}

function assertProblemRoutes(value, path) {
  const allowed = new Set([
    "schema_version", "matching_disclaimer", "max_auxiliary_models", "safety_rules",
    "model_tombstones", "model_relations", "routes"
  ]);
  assertNoUnknownKeys(value, allowed, path);
  assertSchemaVersion(value.schema_version, `${path}.schema_version`);
  assertString(value.matching_disclaimer, `${path}.matching_disclaimer`);
  assertInteger(value.max_auxiliary_models, `${path}.max_auxiliary_models`, 0);
  assertArray(value.safety_rules, `${path}.safety_rules`, 0);
  assertArray(value.model_tombstones, `${path}.model_tombstones`, 0);
  assertArray(value.model_relations, `${path}.model_relations`, 0);
  assertArray(value.routes, `${path}.routes`, 1);

  const safetyRuleIds = new Set();
  const routesIds = new Set();
  const modelIds = new Set();

  for (const [index, rule] of value.safety_rules.entries()) {
    if (!isPlainObject(rule)) throw contractError(`invalid safety_rule at ${path}.safety_rules[${index}]`, `${path}.safety_rules[${index}]`);
    const allowedRule = new Set([
      "safety_rule_id", "priority", "trigger_terms", "risk_type", "user_message",
      "prohibited_outputs", "test_cases"
    ]);
    if (Object.keys(rule).some((key) => !allowedRule.has(key))) {
      throw contractError(`unknown safety_rule fields at ${path}.safety_rules[${index}]`, `${path}.safety_rules[${index}]`);
    }
    if (typeof rule.safety_rule_id !== "string") throw contractError(`invalid safety_rule_id at ${path}.safety_rules[${index}].safety_rule_id`, `${path}.safety_rules[${index}].safety_rule_id`);
    if (safetyRuleIds.has(rule.safety_rule_id)) throw contractError(`duplicate safety_rule_id at ${path}.safety_rules[${index}].safety_rule_id`, `${path}.safety_rules[${index}].safety_rule_id`);
    safetyRuleIds.add(rule.safety_rule_id);
    assertInteger(rule.priority, `${path}.safety_rules[${index}].priority`, 0);
    assertArray(rule.trigger_terms, `${path}.safety_rules[${index}].trigger_terms`, 1);
    for (const [triggerIndex, term] of rule.trigger_terms.entries()) {
      assertString(term, `${path}.safety_rules[${index}].trigger_terms[${triggerIndex}]`);
    }
    assertValueIn(rule.risk_type, new Set(["medical", "mental_health", "legal", "financial", "personal_safety"]), `${path}.safety_rules[${index}].risk_type`);
    assertString(rule.user_message, `${path}.safety_rules[${index}].user_message`);
    assertArray(rule.prohibited_outputs, `${path}.safety_rules[${index}].prohibited_outputs`);
    for (const [outputIndex, prohibited] of rule.prohibited_outputs.entries()) {
      assertString(prohibited, `${path}.safety_rules[${index}].prohibited_outputs[${outputIndex}]`);
    }
    assertArray(rule.test_cases, `${path}.safety_rules[${index}].test_cases`);
  }

  const routePrioritySorted = value.routes.map((route) => route.priority);
  for (const [index, route] of value.routes.entries()) {
    if (!isPlainObject(route)) throw contractError(`invalid route at ${path}.routes[${index}]`, `${path}.routes[${index}]`);
    const allowedRoute = new Set([
      "route_id", "priority", "title", "trigger_terms", "exclude_terms",
      "minimum_score", "required_context_fields", "primary_model_id",
      "auxiliary_model_ids", "clarifying_questions", "stop_conditions", "safety_gate",
      "output_sections", "test_cases"
    ]);
    if (Object.keys(route).some((key) => !allowedRoute.has(key))) {
      throw contractError(`unknown route fields at ${path}.routes[${index}]`, `${path}.routes[${index}]`);
    }
    if (!ROUTE_ID_RE.test(route.route_id)) throw contractError(`invalid route_id at ${path}.routes[${index}].route_id`, `${path}.routes[${index}].route_id`);
    if (routesIds.has(route.route_id)) throw contractError(`duplicate route_id at ${path}.routes[${index}].route_id`, `${path}.routes[${index}].route_id`);
    routesIds.add(route.route_id);
    assertInteger(route.priority, `${path}.routes[${index}].priority`, 0);
    assertString(route.title, `${path}.routes[${index}].title`);
    assertArray(route.trigger_terms, `${path}.routes[${index}].trigger_terms`, 1);
    for (const [termIndex, term] of route.trigger_terms.entries()) {
      const termObject = isPlainObject(term) ? term : null;
      if (!isPlainObject(termObject)) throw contractError(`invalid trigger term at ${path}.routes[${index}].trigger_terms[${termIndex}]`, `${path}.routes[${index}].trigger_terms[${termIndex}]`);
      const allowedTerm = new Set(["term", "weight"]);
      if (Object.keys(termObject).some((key) => !allowedTerm.has(key))) {
        throw contractError(`unknown trigger term fields at ${path}.routes[${index}].trigger_terms[${termIndex}]`, `${path}.routes[${index}].trigger_terms[${termIndex}]`);
      }
      assertString(termObject.term, `${path}.routes[${index}].trigger_terms[${termIndex}].term`);
      assertNumber(termObject.weight, `${path}.routes[${index}].trigger_terms[${termIndex}].weight`);
    }
    assertArray(route.exclude_terms, `${path}.routes[${index}].exclude_terms`);
    assertNumber(route.minimum_score, `${path}.routes[${index}].minimum_score`);
    assertArray(route.required_context_fields, `${path}.routes[${index}].required_context_fields`, 1);
    for (const [fieldIndex, field] of route.required_context_fields.entries()) {
      assertValueIn(field, new Set([
        "situation", "goal", "facts", "assumptions", "constraints", "attempted", "desired_output"
      ]), `${path}.routes[${index}].required_context_fields[${fieldIndex}]`);
    }
    assertString(route.primary_model_id, `${path}.routes[${index}].primary_model_id`);
    assertArray(route.auxiliary_model_ids, `${path}.routes[${index}].auxiliary_model_ids`);
    for (const [modelIndex, modelId] of route.auxiliary_model_ids.entries()) {
      assertString(modelId, `${path}.routes[${index}].auxiliary_model_ids[${modelIndex}]`);
      if (!MODEL_ID_RE.test(modelId)) throw contractError(`invalid auxiliary model id at ${path}.routes[${index}].auxiliary_model_ids[${modelIndex}]`, `${path}.routes[${index}].auxiliary_model_ids[${modelIndex}]`);
      if (modelIds.has(modelId)) continue;
      modelIds.add(modelId);
    }
    assertArray(route.clarifying_questions, `${path}.routes[${index}].clarifying_questions`);
    for (const [questionIndex, question] of route.clarifying_questions.entries()) {
      assertString(question, `${path}.routes[${index}].clarifying_questions[${questionIndex}]`);
    }
    assertArray(route.stop_conditions, `${path}.routes[${index}].stop_conditions`);
    assertValueIn(route.safety_gate, new Set(["general", "medical", "mental_health", "legal", "financial"]), `${path}.routes[${index}].safety_gate`);
    assertArray(route.output_sections, `${path}.routes[${index}].output_sections`, 1);
    for (const [outputIndex, section] of route.output_sections.entries()) {
      assertString(section, `${path}.routes[${index}].output_sections[${outputIndex}]`);
    }
    if (route.test_cases.length === 0) continue;
    if (!Array.isArray(route.test_cases)) throw contractError(`invalid route test cases at ${path}.routes[${index}].test_cases`, `${path}.routes[${index}].test_cases`);
  }

  assertOrderedBy(value.routes, (route) => route.priority, `${path}.routes`);
  assertUnique(Array.from(safetyRuleIds), (id) => id, `${path}.safety_rules`);

  for (const [index, tombstone] of value.model_tombstones.entries()) {
    if (!isPlainObject(tombstone)) {
      throw contractError(`invalid model_tombstone at ${path}.model_tombstones[${index}]`, `${path}.model_tombstones[${index}]`);
    }
    const allowedTombstone = new Set(["retired_model_id", "successor_model_id", "reason"]);
    if (Object.keys(tombstone).some((key) => !allowedTombstone.has(key))) {
      throw contractError(`unknown tombstone fields at ${path}.model_tombstones[${index}]`, `${path}.model_tombstones[${index}]`);
    }
    assertString(tombstone.retired_model_id, `${path}.model_tombstones[${index}].retired_model_id`);
    if (!MODEL_ID_RE.test(tombstone.retired_model_id)) {
      throw contractError(`invalid retired_model_id at ${path}.model_tombstones[${index}].retired_model_id`, `${path}.model_tombstones[${index}].retired_model_id`);
    }
    if (tombstone.successor_model_id !== null) {
      assertString(tombstone.successor_model_id, `${path}.model_tombstones[${index}].successor_model_id`);
      if (!MODEL_ID_RE.test(tombstone.successor_model_id)) {
        throw contractError(`invalid successor_model_id at ${path}.model_tombstones[${index}].successor_model_id`, `${path}.model_tombstones[${index}].successor_model_id`);
      }
    }
    assertString(tombstone.reason, `${path}.model_tombstones[${index}].reason`);
  }

  for (const [index, relation] of value.model_relations.entries()) {
    if (!isPlainObject(relation)) throw contractError(`invalid model_relation at ${path}.model_relations[${index}]`, `${path}.model_relations[${index}]`);
    const allowedRelation = new Set(["from_model_id", "to_model_id", "type", "reason"]);
    if (Object.keys(relation).some((key) => !allowedRelation.has(key))) {
      throw contractError(`unknown model_relation fields at ${path}.model_relations[${index}]`, `${path}.model_relations[${index}]`);
    }
    assertString(relation.from_model_id, `${path}.model_relations[${index}].from_model_id`);
    assertString(relation.to_model_id, `${path}.model_relations[${index}].to_model_id`);
    if (!MODEL_ID_RE.test(relation.from_model_id)) throw contractError(`invalid from_model_id at ${path}.model_relations[${index}].from_model_id`, `${path}.model_relations[${index}].from_model_id`);
    if (!MODEL_ID_RE.test(relation.to_model_id)) throw contractError(`invalid to_model_id at ${path}.model_relations[${index}].to_model_id`, `${path}.model_relations[${index}].to_model_id`);
    assertValueIn(new Set([
      "prerequisite", "complements", "alternative", "confused_with",
      "applied_before", "stop_and_escalate"
    ]), relation.type, `${path}.model_relations[${index}].type`);
    assertString(relation.reason, `${path}.model_relations[${index}].reason`);
  }
}

function assertTaxonomy(value, path) {
  const allowed = new Set([
    "schema_version", "chapters", "content_types", "risk_flags"
  ]);
  assertNoUnknownKeys(value, allowed, path);
  assertSchemaVersion(value.schema_version, `${path}.schema_version`);
  assertArray(value.chapters, `${path}.chapters`, 13);
  if (value.chapters.length !== TAXONOMY_CHAPTER_IDS.length) {
    throw contractError(`invalid chapter count at ${path}.chapters`, `${path}.chapters`);
  }
  assertArray(value.content_types, `${path}.content_types`, 1);
  assertArray(value.risk_flags, `${path}.risk_flags`, 1);

  assertUnique(TAXONOMY_CHAPTER_IDS, (entry) => entry, `${path}.chapters`);
  assertUnique(value.chapters.map((chapter) => chapter.id), (value) => value, `${path}.chapters`);

  for (const [index, chapter] of value.chapters.entries()) {
    if (!isPlainObject(chapter)) throw contractError(`invalid chapter at ${path}.chapters[${index}]`, `${path}.chapters[${index}]`);
    const allowedChapterKeys = new Set([
      "id", "order", "slug", "title", "description", "baseline_source_count", "subchapters", "allowed_tags"
    ]);
    if (Object.keys(chapter).some((key) => !allowedChapterKeys.has(key))) {
      throw contractError(`unknown chapter fields at ${path}.chapters[${index}]`, `${path}.chapters[${index}]`);
    }
    assertString(chapter.id, `${path}.chapters[${index}].id`, { minLength: 2 });
    if (!TAXONOMY_CHAPTER_IDS.includes(chapter.id)) {
      throw contractError(`invalid chapter id at ${path}.chapters[${index}].id`, `${path}.chapters[${index}].id`);
    }
    assertInteger(chapter.order, `${path}.chapters[${index}].order`, 0);
    assertString(chapter.slug, `${path}.chapters[${index}].slug`);
    assertString(chapter.title, `${path}.chapters[${index}].title`);
    assertString(chapter.description, `${path}.chapters[${index}].description`);
    assertInteger(chapter.baseline_source_count, `${path}.chapters[${index}].baseline_source_count`, 0);
    if (!Array.isArray(chapter.subchapters)) throw contractError(`invalid subchapters at ${path}.chapters[${index}].subchapters`, `${path}.chapters[${index}].subchapters`);
    for (const [subIndex, subchapter] of chapter.subchapters.entries()) {
      if (!isPlainObject(subchapter)) throw contractError(`invalid subchapter at ${path}.chapters[${index}].subchapters[${subIndex}]`, `${path}.chapters[${index}].subchapters[${subIndex}]`);
      const allowedSubchapterKeys = new Set(["id", "order", "slug", "title"]);
      if (Object.keys(subchapter).some((key) => !allowedSubchapterKeys.has(key))) {
        throw contractError(`unknown subchapter fields at ${path}.chapters[${index}].subchapters[${subIndex}]`, `${path}.chapters[${index}].subchapters[${subIndex}]`);
      }
      assertString(subchapter.id, `${path}.chapters[${index}].subchapters[${subIndex}].id`);
      assertInteger(subchapter.order, `${path}.chapters[${index}].subchapters[${subIndex}].order`, 0);
      assertString(subchapter.slug, `${path}.chapters[${index}].subchapters[${subIndex}].slug`);
      assertString(subchapter.title, `${path}.chapters[${index}].subchapters[${subIndex}].title`);
    }
    assertUnique(chapter.subchapters, (entry) => entry.id, `${path}.chapters[${index}].subchapters`);
    assertArray(chapter.allowed_tags, `${path}.chapters[${index}].allowed_tags`);
    for (const [tagIndex, tag] of chapter.allowed_tags.entries()) {
      assertString(tag, `${path}.chapters[${index}].allowed_tags[${tagIndex}]`);
    }
  }

  assertOrderedBy(value.chapters, (chapter) => chapter.order, `${path}.chapters`);
  assertUnique(value.chapters.map((chapter) => chapter.order), (entry) => entry, `${path}.chapters.order`);
  assertUnique(value.chapters.map((chapter) => chapter.slug), (entry) => entry, `${path}.chapters.slug`);

  for (const contentType of value.content_types) {
    assertValueIn(contentType, TAXONOMY_TYPES.content_types, `${path}.content_types`);
  }
  for (const flag of value.risk_flags) {
    assertValueIn(flag, TAXONOMY_TYPES.risk_flags, `${path}.risk_flags`);
  }
  assertUnique(value.content_types, (value_) => value_, `${path}.content_types`);
  assertOrderedBy(value.content_types.slice().sort(), (value_) => value_, `${path}.content_types`);
}

function assertCurationSourceIdRecord(value, path) {
  const allowed = new Set([
    "schema_version", "catalog_source_id", "source_id", "created_by", "created_at"
  ]);
  assertNoUnknownKeys(value, allowed, path);
  assertSchemaVersion(value.schema_version, `${path}.schema_version`);
  assertString(value.catalog_source_id, `${path}.catalog_source_id`, { minLength: 1 });
  assertSourceId(value.source_id, `${path}.source_id`);
  assertString(value.created_by, `${path}.created_by`);
  assertRfc3339Date(value.created_at, `${path}.created_at`);
}

const MODEL_CASE_KEYS = new Set([
  "id", "title", "primary_model_id", "related_model_ids", "problem_type_ids",
  "agent_stage_ids", "mapping", "case_kind", "lifecycle_status", "summary",
  "detail", "evidence", "privacy", "tags", "observed_at", "verified_at", "origin_kind"
]);
const CASE_MAPPING_KEYS = new Set([
  "candidate_model_id", "relation_type", "fit_score", "runner_up_model_id", "runner_up_score",
  "counterevidence", "status"
]);
const CASE_SUMMARY_KEYS = new Set(["situation", "goal", "key_actions", "outcome", "lesson"]);
const CASE_DETAIL_KEYS = new Set([
  "constraints", "observable_steps", "decisions", "corrections", "verification",
  "limitations", "failure_conditions"
]);
const CASE_EVIDENCE_KEYS = new Set(["status", "plan_only", "claims"]);
const CASE_PRIVACY_KEYS = new Set([
  "deidentified", "dlp_status", "publication_status", "dlp_receipt_sha256", "redaction_summary"
]);

function validateModelCaseCatalogInternal(value, {
  modelIds = new Set(),
  problemTypeIds = new Set(),
  agentStageIds = new Set()
} = {}) {
  const path = "model-cases";
  assertNoPrivateText(value, path);
  assertAgentObject(value, path, new Set(["schema_version", "cases"]));
  if (value.schema_version !== "1.0.0") throw agentKnowledgeError(`invalid schema_version at ${path}.schema_version`, `${path}.schema_version`);
  if (!Array.isArray(value.cases)) throw agentKnowledgeError(`invalid cases at ${path}.cases`, `${path}.cases`);

  const caseIds = new Set();
  for (const [index, item] of value.cases.entries()) {
    const itemPath = `${path}.cases[${index}]`;
    assertAgentObject(item, itemPath, MODEL_CASE_KEYS);
    assertAgentId(item.id, `${itemPath}.id`, "case-");
    if (caseIds.has(item.id)) throw agentKnowledgeError(`duplicate case id at ${itemPath}.id`, `${itemPath}.id`);
    caseIds.add(item.id);
    assertAgentString(item.title, `${itemPath}.title`);
    if (item.primary_model_id !== null && !modelIds.has(item.primary_model_id)) {
      throw agentKnowledgeError(`unknown primary model at ${itemPath}.primary_model_id`, `${itemPath}.primary_model_id`);
    }
    assertAgentReferenceArray(item.related_model_ids, modelIds, `${itemPath}.related_model_ids`);
    if (item.related_model_ids.length > 3) throw agentKnowledgeError(`too many related models at ${itemPath}.related_model_ids`, `${itemPath}.related_model_ids`);
    assertAgentReferenceArray(item.problem_type_ids, problemTypeIds, `${itemPath}.problem_type_ids`, { min: 1 });
    assertAgentReferenceArray(item.agent_stage_ids, agentStageIds, `${itemPath}.agent_stage_ids`, { min: 1 });

    assertAgentObject(item.mapping, `${itemPath}.mapping`, CASE_MAPPING_KEYS);
    if (item.mapping.candidate_model_id !== null && !modelIds.has(item.mapping.candidate_model_id)) {
      throw agentKnowledgeError(`unknown candidate model at ${itemPath}.mapping.candidate_model_id`, `${itemPath}.mapping.candidate_model_id`);
    }
    if (item.mapping.relation_type !== null) {
      assertAgentEnum(item.mapping.relation_type, new Set(["explicit", "behavioral", "posthoc"]), `${itemPath}.mapping.relation_type`);
    }
    assertAgentScore(item.mapping.fit_score, `${itemPath}.mapping.fit_score`);
    if (item.mapping.runner_up_model_id !== null && !modelIds.has(item.mapping.runner_up_model_id)) {
      throw agentKnowledgeError(`unknown runner up model at ${itemPath}.mapping.runner_up_model_id`, `${itemPath}.mapping.runner_up_model_id`);
    }
    assertAgentScore(item.mapping.runner_up_score, `${itemPath}.mapping.runner_up_score`);
    assertAgentStringArray(item.mapping.counterevidence, `${itemPath}.mapping.counterevidence`);
    assertAgentEnum(item.mapping.status, new Set(["mapped", "awaiting_mapping"]), `${itemPath}.mapping.status`);
    if ((item.mapping.candidate_model_id === null) !== (item.mapping.relation_type === null)) {
      throw agentKnowledgeError(`candidate and relation mismatch at ${itemPath}.mapping`, `${itemPath}.mapping`);
    }
    if ((item.mapping.runner_up_model_id === null) !== (item.mapping.runner_up_score === 0)) {
      throw agentKnowledgeError(`runner up and score mismatch at ${itemPath}.mapping`, `${itemPath}.mapping`);
    }
    if (item.mapping.candidate_model_id !== null && item.mapping.candidate_model_id === item.mapping.runner_up_model_id) {
      throw agentKnowledgeError(`candidate duplicated as runner up at ${itemPath}.mapping.runner_up_model_id`, `${itemPath}.mapping.runner_up_model_id`);
    }
    if (item.mapping.fit_score < item.mapping.runner_up_score) {
      throw agentKnowledgeError(`runner up exceeds candidate at ${itemPath}.mapping.runner_up_score`, `${itemPath}.mapping.runner_up_score`);
    }
    if (item.mapping.candidate_model_id === null && item.mapping.fit_score !== 0) {
      throw agentKnowledgeError(`missing candidate has nonzero score at ${itemPath}.mapping.fit_score`, `${itemPath}.mapping.fit_score`);
    }
    const reliableMapping = item.mapping.candidate_model_id !== null &&
      scoreBasisPoints(item.mapping.fit_score) >= 7_500 &&
      scoreBasisPoints(item.mapping.fit_score) - scoreBasisPoints(item.mapping.runner_up_score) >= 1_000;
    if ((item.mapping.status === "mapped") !== reliableMapping) {
      throw agentKnowledgeError(`mapping status contradicts scores at ${itemPath}.mapping.status`, `${itemPath}.mapping.status`);
    }
    if (item.mapping.status === "mapped" && item.primary_model_id !== item.mapping.candidate_model_id) {
      throw agentKnowledgeError(`primary model does not match accepted candidate at ${itemPath}.primary_model_id`, `${itemPath}.primary_model_id`);
    }
    if (item.mapping.status === "awaiting_mapping" && item.primary_model_id !== null) {
      throw agentKnowledgeError(`awaiting case must not assign a primary model at ${itemPath}.primary_model_id`, `${itemPath}.primary_model_id`);
    }
    if (item.mapping.status === "awaiting_mapping" && item.related_model_ids.length !== 0) {
      throw agentKnowledgeError(`awaiting case must not assign related models at ${itemPath}.related_model_ids`, `${itemPath}.related_model_ids`);
    }
    if (item.related_model_ids.includes(item.mapping.candidate_model_id)) {
      throw agentKnowledgeError(`candidate model duplicated at ${itemPath}.related_model_ids`, `${itemPath}.related_model_ids`);
    }

    assertAgentEnum(item.case_kind, new Set(["plan", "execution"]), `${itemPath}.case_kind`);
    assertAgentEnum(item.lifecycle_status, new Set(["candidate", "formal", "awaiting_mapping", "quarantined"]), `${itemPath}.lifecycle_status`);
    if (item.lifecycle_status !== "quarantined" &&
        (item.lifecycle_status === "awaiting_mapping") !== (item.mapping.status === "awaiting_mapping")) {
      throw agentKnowledgeError(`case lifecycle contradicts mapping at ${itemPath}.lifecycle_status`, `${itemPath}.lifecycle_status`);
    }
    assertAgentObject(item.summary, `${itemPath}.summary`, CASE_SUMMARY_KEYS);
    for (const key of ["situation", "goal", "outcome", "lesson"]) assertAgentString(item.summary[key], `${itemPath}.summary.${key}`);
    assertAgentStringArray(item.summary.key_actions, `${itemPath}.summary.key_actions`, { min: 1 });

    assertAgentObject(item.detail, `${itemPath}.detail`, CASE_DETAIL_KEYS);
    assertAgentStringArray(item.detail.constraints, `${itemPath}.detail.constraints`);
    assertSequentialSteps(item.detail.observable_steps, `${itemPath}.detail.observable_steps`, new Set(["order", "action", "checkpoint"]));
    for (const [stepIndex, step] of item.detail.observable_steps.entries()) {
      assertAgentString(step.action, `${itemPath}.detail.observable_steps[${stepIndex}].action`);
      assertAgentString(step.checkpoint, `${itemPath}.detail.observable_steps[${stepIndex}].checkpoint`);
    }
    if (!Array.isArray(item.detail.decisions)) throw agentKnowledgeError(`invalid decisions at ${itemPath}.detail.decisions`, `${itemPath}.detail.decisions`);
    item.detail.decisions.forEach((decision, decisionIndex) => {
      const decisionPath = `${itemPath}.detail.decisions[${decisionIndex}]`;
      assertAgentObject(decision, decisionPath, new Set(["decision", "rationale_summary"]));
      assertAgentString(decision.decision, `${decisionPath}.decision`);
      assertAgentString(decision.rationale_summary, `${decisionPath}.rationale_summary`);
    });
    if (!Array.isArray(item.detail.corrections)) throw agentKnowledgeError(`invalid corrections at ${itemPath}.detail.corrections`, `${itemPath}.detail.corrections`);
    item.detail.corrections.forEach((correction, correctionIndex) => {
      const correctionPath = `${itemPath}.detail.corrections[${correctionIndex}]`;
      assertAgentObject(correction, correctionPath, new Set(["failure", "correction", "result"]));
      for (const key of ["failure", "correction", "result"]) assertAgentString(correction[key], `${correctionPath}.${key}`);
    });
    for (const key of ["verification", "limitations", "failure_conditions"]) assertAgentStringArray(item.detail[key], `${itemPath}.detail.${key}`);

    assertAgentObject(item.evidence, `${itemPath}.evidence`, CASE_EVIDENCE_KEYS);
    assertAgentEnum(item.evidence.status, new Set(["verified_outcome", "partially_verified", "reported_outcome", "plan_only", "failed_with_verified_correction"]), `${itemPath}.evidence.status`);
    if (typeof item.evidence.plan_only !== "boolean") throw agentKnowledgeError(`invalid boolean at ${itemPath}.evidence.plan_only`, `${itemPath}.evidence.plan_only`);
    if (item.evidence.plan_only !== (item.case_kind === "plan") || item.evidence.plan_only !== (item.evidence.status === "plan_only")) {
      throw agentKnowledgeError(`plan evidence mismatch at ${itemPath}.evidence`, `${itemPath}.evidence`);
    }
    if (!Array.isArray(item.evidence.claims) || item.evidence.claims.length === 0) throw agentKnowledgeError(`invalid claims at ${itemPath}.evidence.claims`, `${itemPath}.evidence.claims`);
    item.evidence.claims.forEach((claim, claimIndex) => {
      const claimPath = `${itemPath}.evidence.claims[${claimIndex}]`;
      assertAgentObject(claim, claimPath, new Set(["claim", "claim_type", "evidence_grade", "receipt_ids", "freshness", "invalidation_condition"]));
      assertAgentString(claim.claim, `${claimPath}.claim`);
      assertAgentEnum(claim.claim_type, new Set(["fact", "inference", "unknown"]), `${claimPath}.claim_type`);
      assertAgentEnum(claim.evidence_grade, new Set(["tool_receipt", "test_receipt", "artifact_receipt", "independent_verification", "reported_only", "none"]), `${claimPath}.evidence_grade`);
      assertAgentStringArray(claim.receipt_ids, `${claimPath}.receipt_ids`);
      claim.receipt_ids.forEach((receiptId, receiptIndex) => assertAgentId(receiptId, `${claimPath}.receipt_ids[${receiptIndex}]`, "receipt-"));
      const receiptBacked = new Set(["tool_receipt", "test_receipt", "artifact_receipt", "independent_verification"]).has(claim.evidence_grade);
      if (receiptBacked !== (claim.receipt_ids.length > 0)) {
        throw agentKnowledgeError(`claim receipt mismatch at ${claimPath}.receipt_ids`, `${claimPath}.receipt_ids`);
      }
      if (claim.claim_type === "unknown" && claim.evidence_grade !== "none") {
        throw agentKnowledgeError(`unknown claim must remain unverified at ${claimPath}.evidence_grade`, `${claimPath}.evidence_grade`);
      }
      assertAgentString(claim.freshness, `${claimPath}.freshness`);
      assertAgentString(claim.invalidation_condition, `${claimPath}.invalidation_condition`);
    });
    const hasReceiptBackedClaim = item.evidence.claims.some((claim) => claim.receipt_ids.length > 0);
    const verifiedEvidence = new Set(["verified_outcome", "partially_verified", "failed_with_verified_correction"])
      .has(item.evidence.status);
    if (verifiedEvidence !== hasReceiptBackedClaim) {
      throw agentKnowledgeError(`evidence status lacks receipt-backed claim at ${itemPath}.evidence.status`, `${itemPath}.evidence.status`);
    }

    assertAgentObject(item.privacy, `${itemPath}.privacy`, CASE_PRIVACY_KEYS);
    if (item.privacy.deidentified !== true) throw agentKnowledgeError(`case must be deidentified at ${itemPath}.privacy.deidentified`, `${itemPath}.privacy.deidentified`);
    assertAgentEnum(item.privacy.dlp_status, new Set(["pending_scan", "passed", "failed", "uncertain"]), `${itemPath}.privacy.dlp_status`);
    assertAgentEnum(item.privacy.publication_status, new Set(["pending_scan", "pending_mapping", "ready_not_publishable", "auto_publishable", "quarantined"]), `${itemPath}.privacy.publication_status`);
    assertNullableSha256(item.privacy.dlp_receipt_sha256, `${itemPath}.privacy.dlp_receipt_sha256`);
    assertAgentString(item.privacy.redaction_summary, `${itemPath}.privacy.redaction_summary`);
    const dlpPending = item.privacy.dlp_status === "pending_scan";
    if (dlpPending !== (item.privacy.dlp_receipt_sha256 === null)) {
      throw agentKnowledgeError(`DLP status lacks bound receipt at ${itemPath}.privacy.dlp_receipt_sha256`, `${itemPath}.privacy.dlp_receipt_sha256`);
    }
    const expectedPublication = item.lifecycle_status === "quarantined" || new Set(["failed", "uncertain"]).has(item.privacy.dlp_status)
      ? "quarantined"
      : dlpPending ? "pending_scan"
        : item.mapping.status === "awaiting_mapping" ? "pending_mapping"
          : "ready_not_publishable";
    if (item.privacy.publication_status !== expectedPublication) {
      throw agentKnowledgeError(`publication status contradicts DLP at ${itemPath}.privacy.publication_status`, `${itemPath}.privacy.publication_status`);
    }
    if (item.privacy.publication_status === "auto_publishable") {
      throw agentKnowledgeError(`auto publication remains disabled until DLP receipt production is implemented at ${itemPath}.privacy.publication_status`, `${itemPath}.privacy.publication_status`);
    }
    assertAgentStringArray(item.tags, `${itemPath}.tags`);
    assertAgentDateTime(item.observed_at, `${itemPath}.observed_at`);
    assertAgentDateTime(item.verified_at, `${itemPath}.verified_at`, { nullable: true });
    if (new Set(["verified_outcome", "partially_verified", "failed_with_verified_correction"]).has(item.evidence.status) && item.verified_at === null) {
      throw agentKnowledgeError(`verified case lacks verified_at at ${itemPath}.verified_at`, `${itemPath}.verified_at`);
    }
    if (item.lifecycle_status === "formal") {
      const formalStatuses = new Set(["verified_outcome", "failed_with_verified_correction"]);
      const factClaims = item.evidence.claims.filter((claim) => claim.claim_type === "fact");
      const factGrades = new Set(["tool_receipt", "test_receipt", "artifact_receipt", "independent_verification"]);
      if (!formalStatuses.has(item.evidence.status) || factClaims.length === 0 || factClaims.some((claim) => !factGrades.has(claim.evidence_grade))) {
        throw agentKnowledgeError(`formal case lacks verified facts at ${itemPath}.lifecycle_status`, `${itemPath}.lifecycle_status`);
      }
    }
    assertAgentEnum(item.origin_kind, new Set(["session_derived", "cursor_plan_derived"]), `${itemPath}.origin_kind`);
  }
}

export function validateModelCaseCatalogShape(value, options = {}) {
  return validateModelCaseCatalogInternal(value, options);
}

const FRAMEWORK_KEYS = new Set([
  "id", "name", "lifecycle_status", "promotion_mode", "nearest_existing_asset_ids",
  "semantic_signature", "human_version", "ai_protocol", "promotion_evidence", "privacy"
]);
const SEMANTIC_SIGNATURE_KEYS = new Set([
  "problem_representation", "decomposition_operators", "control_policy", "structural_invariants",
  "leaf_task_contract", "replanning_policy", "termination_condition", "evaluation_contract"
]);

function validateProblemSolvingFrameworkCatalogInternal(value, {
  caseIds = new Set(),
  problemTypeIds = new Set(),
  knownAssetIds = new Set()
} = {}) {
  const path = "problem-solving-frameworks";
  assertNoPrivateText(value, path);
  assertAgentObject(value, path, new Set(["schema_version", "frameworks"]));
  if (value.schema_version !== "1.0.0") throw agentKnowledgeError(`invalid schema_version at ${path}.schema_version`, `${path}.schema_version`);
  if (!Array.isArray(value.frameworks)) throw agentKnowledgeError(`invalid frameworks at ${path}.frameworks`, `${path}.frameworks`);
  const ids = new Set();
  for (const [index, framework] of value.frameworks.entries()) {
    const frameworkPath = `${path}.frameworks[${index}]`;
    assertAgentObject(framework, frameworkPath, FRAMEWORK_KEYS);
    assertAgentId(framework.id, `${frameworkPath}.id`, "framework-");
    if (ids.has(framework.id)) throw agentKnowledgeError(`duplicate framework id at ${frameworkPath}.id`, `${frameworkPath}.id`);
    ids.add(framework.id);
    assertAgentString(framework.name, `${frameworkPath}.name`);
    assertAgentEnum(framework.lifecycle_status, new Set(["candidate", "automatically_promoted", "deprecated", "quarantined"]), `${frameworkPath}.lifecycle_status`);
    if (framework.promotion_mode !== "automatic") throw agentKnowledgeError(`invalid promotion mode at ${frameworkPath}.promotion_mode`, `${frameworkPath}.promotion_mode`);
    assertAgentReferenceArray(framework.nearest_existing_asset_ids, knownAssetIds, `${frameworkPath}.nearest_existing_asset_ids`, { min: 1 });

    assertAgentObject(framework.semantic_signature, `${frameworkPath}.semantic_signature`, SEMANTIC_SIGNATURE_KEYS);
    for (const key of ["problem_representation", "control_policy", "leaf_task_contract", "replanning_policy", "termination_condition", "evaluation_contract"]) {
      assertAgentString(framework.semantic_signature[key], `${frameworkPath}.semantic_signature.${key}`);
    }
    for (const key of ["decomposition_operators", "structural_invariants"]) {
      assertAgentStringArray(framework.semantic_signature[key], `${frameworkPath}.semantic_signature.${key}`, { min: 1 });
    }

    assertAgentObject(framework.human_version, `${frameworkPath}.human_version`, new Set(["definition", "triggers", "anti_triggers", "steps", "stop_conditions", "failure_modes"]));
    assertAgentString(framework.human_version.definition, `${frameworkPath}.human_version.definition`);
    for (const key of ["triggers", "anti_triggers", "stop_conditions", "failure_modes"]) {
      assertAgentStringArray(framework.human_version[key], `${frameworkPath}.human_version.${key}`, { min: 1 });
    }
    assertSequentialSteps(framework.human_version.steps, `${frameworkPath}.human_version.steps`, new Set(["order", "action", "checkpoint"]));
    framework.human_version.steps.forEach((step, stepIndex) => {
      assertAgentString(step.action, `${frameworkPath}.human_version.steps[${stepIndex}].action`);
      assertAgentString(step.checkpoint, `${frameworkPath}.human_version.steps[${stepIndex}].checkpoint`);
    });

    assertAgentObject(framework.ai_protocol, `${frameworkPath}.ai_protocol`, new Set(["inputs", "state", "steps", "tool_contracts", "stop_conditions", "rollback_conditions"]));
    for (const key of ["inputs", "state", "tool_contracts", "stop_conditions", "rollback_conditions"]) {
      assertAgentStringArray(framework.ai_protocol[key], `${frameworkPath}.ai_protocol.${key}`, { min: 1 });
    }
    assertSequentialSteps(framework.ai_protocol.steps, `${frameworkPath}.ai_protocol.steps`, new Set(["order", "action", "branch", "checkpoint"]));
    framework.ai_protocol.steps.forEach((step, stepIndex) => {
      for (const key of ["action", "branch", "checkpoint"]) assertAgentString(step[key], `${frameworkPath}.ai_protocol.steps[${stepIndex}].${key}`);
    });

    assertAgentObject(framework.promotion_evidence, `${frameworkPath}.promotion_evidence`, new Set([
      "independent_episode_count", "task_type_count", "failure_or_non_trigger_count",
      "case_ids", "task_type_ids", "failure_or_non_trigger_case_ids", "comparison_summary",
      "verification_status", "gate_receipt_sha256"
    ]));
    for (const key of ["independent_episode_count", "task_type_count", "failure_or_non_trigger_count"]) {
      if (!Number.isInteger(framework.promotion_evidence[key]) || framework.promotion_evidence[key] < 0) {
        throw agentKnowledgeError(`invalid count at ${frameworkPath}.promotion_evidence.${key}`, `${frameworkPath}.promotion_evidence.${key}`);
      }
    }
    assertAgentReferenceArray(framework.promotion_evidence.case_ids, caseIds, `${frameworkPath}.promotion_evidence.case_ids`, { min: 1 });
    assertAgentReferenceArray(framework.promotion_evidence.task_type_ids, problemTypeIds, `${frameworkPath}.promotion_evidence.task_type_ids`, { min: 1 });
    assertAgentReferenceArray(framework.promotion_evidence.failure_or_non_trigger_case_ids, caseIds, `${frameworkPath}.promotion_evidence.failure_or_non_trigger_case_ids`);
    const supportingCases = new Set(framework.promotion_evidence.case_ids);
    for (const [caseIndex, caseId] of framework.promotion_evidence.failure_or_non_trigger_case_ids.entries()) {
      if (!supportingCases.has(caseId)) {
        throw agentKnowledgeError(
          `failure or non-trigger case is not supporting evidence at ${frameworkPath}.promotion_evidence.failure_or_non_trigger_case_ids[${caseIndex}]`,
          `${frameworkPath}.promotion_evidence.failure_or_non_trigger_case_ids[${caseIndex}]`
        );
      }
    }
    if (framework.promotion_evidence.independent_episode_count < 1 ||
        framework.promotion_evidence.independent_episode_count > framework.promotion_evidence.case_ids.length) {
      throw agentKnowledgeError(`episode count lacks case evidence at ${frameworkPath}.promotion_evidence.independent_episode_count`, `${frameworkPath}.promotion_evidence.independent_episode_count`);
    }
    if (framework.promotion_evidence.task_type_count !== framework.promotion_evidence.task_type_ids.length) {
      throw agentKnowledgeError(`task type count mismatch at ${frameworkPath}.promotion_evidence.task_type_count`, `${frameworkPath}.promotion_evidence.task_type_count`);
    }
    if (framework.promotion_evidence.failure_or_non_trigger_count !== framework.promotion_evidence.failure_or_non_trigger_case_ids.length) {
      throw agentKnowledgeError(`failure evidence count mismatch at ${frameworkPath}.promotion_evidence.failure_or_non_trigger_count`, `${frameworkPath}.promotion_evidence.failure_or_non_trigger_count`);
    }
    assertAgentString(framework.promotion_evidence.comparison_summary, `${frameworkPath}.promotion_evidence.comparison_summary`);
    assertAgentEnum(framework.promotion_evidence.verification_status, new Set(["insufficient_for_promotion", "promotion_gate_passed"]), `${frameworkPath}.promotion_evidence.verification_status`);
    assertNullableSha256(framework.promotion_evidence.gate_receipt_sha256, `${frameworkPath}.promotion_evidence.gate_receipt_sha256`);
    const thresholdsMet = framework.promotion_evidence.independent_episode_count >= 3 &&
      framework.promotion_evidence.task_type_count >= 2 &&
      framework.promotion_evidence.failure_or_non_trigger_count >= 1;
    const gatePassed = thresholdsMet &&
      framework.promotion_evidence.verification_status === "promotion_gate_passed" &&
      framework.promotion_evidence.gate_receipt_sha256 !== null;
    if (framework.promotion_evidence.verification_status === "promotion_gate_passed" && !gatePassed) {
      throw agentKnowledgeError(`unbound promotion receipt at ${frameworkPath}.promotion_evidence.verification_status`, `${frameworkPath}.promotion_evidence.verification_status`);
    }
    if (framework.promotion_evidence.verification_status === "insufficient_for_promotion" && framework.promotion_evidence.gate_receipt_sha256 !== null) {
      throw agentKnowledgeError(`insufficient evidence has gate receipt at ${frameworkPath}.promotion_evidence.gate_receipt_sha256`, `${frameworkPath}.promotion_evidence.gate_receipt_sha256`);
    }
    if (framework.lifecycle_status === "automatically_promoted") {
      throw agentKnowledgeError(`automatic promotion requires private evidence derivation at ${frameworkPath}.lifecycle_status`, `${frameworkPath}.lifecycle_status`);
    }
    if (framework.lifecycle_status === "candidate" && gatePassed) {
      throw agentKnowledgeError(`promotion gate mismatch at ${frameworkPath}.lifecycle_status`, `${frameworkPath}.lifecycle_status`);
    }

    assertAgentObject(framework.privacy, `${frameworkPath}.privacy`, CASE_PRIVACY_KEYS);
    if (framework.privacy.deidentified !== true) throw agentKnowledgeError(`framework must be deidentified at ${frameworkPath}.privacy.deidentified`, `${frameworkPath}.privacy.deidentified`);
    assertAgentEnum(framework.privacy.dlp_status, new Set(["pending_scan", "passed", "failed", "uncertain"]), `${frameworkPath}.privacy.dlp_status`);
    assertAgentEnum(framework.privacy.publication_status, new Set(["pending_scan", "ready_not_publishable", "auto_publishable", "quarantined"]), `${frameworkPath}.privacy.publication_status`);
    assertNullableSha256(framework.privacy.dlp_receipt_sha256, `${frameworkPath}.privacy.dlp_receipt_sha256`);
    assertAgentString(framework.privacy.redaction_summary, `${frameworkPath}.privacy.redaction_summary`);
    const dlpPending = framework.privacy.dlp_status === "pending_scan";
    if (dlpPending !== (framework.privacy.dlp_receipt_sha256 === null)) {
      throw agentKnowledgeError(`DLP status lacks bound receipt at ${frameworkPath}.privacy.dlp_receipt_sha256`, `${frameworkPath}.privacy.dlp_receipt_sha256`);
    }
    const expectedPublication = framework.lifecycle_status === "quarantined" || new Set(["failed", "uncertain"]).has(framework.privacy.dlp_status)
      ? "quarantined"
      : dlpPending ? "pending_scan" : "ready_not_publishable";
    if (framework.privacy.publication_status !== expectedPublication) {
      throw agentKnowledgeError(`publication status contradicts DLP at ${frameworkPath}.privacy.publication_status`, `${frameworkPath}.privacy.publication_status`);
    }
    if (framework.privacy.publication_status === "auto_publishable") {
      throw agentKnowledgeError(`auto publication remains disabled until DLP receipt production is implemented at ${frameworkPath}.privacy.publication_status`, `${frameworkPath}.privacy.publication_status`);
    }
  }
}

export function validateProblemSolvingFrameworkCatalogShape(value, options = {}) {
  return validateProblemSolvingFrameworkCatalogInternal(value, options);
}

const REQUIRED_EXCLUDED_FIELDS = new Set(["reasoning", "encrypted_content", "agent_reasoning"]);

export function validateCaseProvenance(value, { caseIds = new Set() } = {}) {
  const path = "case-provenance";
  assertAgentObject(value, path, new Set(["schema_version", "records"]));
  if (value.schema_version !== "1.0.0") throw agentKnowledgeError(`invalid schema_version at ${path}.schema_version`, `${path}.schema_version`);
  if (!Array.isArray(value.records)) throw agentKnowledgeError(`invalid records at ${path}.records`, `${path}.records`);
  const seenCases = new Set();
  for (const [index, record] of value.records.entries()) {
    const recordPath = `${path}.records[${index}]`;
    assertAgentObject(record, recordPath, new Set([
      "case_id", "root_episode_id", "source_spans", "extractor_version", "redactions",
      "excluded_fields", "created_at", "binding"
    ]));
    if (!caseIds.has(record.case_id)) throw agentKnowledgeError(`unknown case at ${recordPath}.case_id`, `${recordPath}.case_id`);
    if (seenCases.has(record.case_id)) throw agentKnowledgeError(`duplicate case provenance at ${recordPath}.case_id`, `${recordPath}.case_id`);
    seenCases.add(record.case_id);
    assertAgentString(record.root_episode_id, `${recordPath}.root_episode_id`);
    if (!Array.isArray(record.source_spans) || record.source_spans.length === 0) throw agentKnowledgeError(`invalid source spans at ${recordPath}.source_spans`, `${recordPath}.source_spans`);
    let previousPath = "";
    let previousEnd = 0;
    record.source_spans.forEach((span, spanIndex) => {
      const spanPath = `${recordPath}.source_spans[${spanIndex}]`;
      assertAgentObject(span, spanPath, new Set(["source_kind", "relative_path", "artifact_sha256", "start_line", "end_line", "event_ids"]));
      assertAgentEnum(span.source_kind, new Set(["session", "cursor_plan"]), `${spanPath}.source_kind`);
      assertAgentString(span.relative_path, `${spanPath}.relative_path`);
      if (span.relative_path.includes("\\") || span.relative_path.includes("\0") || span.relative_path.startsWith("/") || span.relative_path.split("/").includes("..")) {
        throw agentKnowledgeError(`unsafe source path at ${spanPath}.relative_path`, `${spanPath}.relative_path`);
      }
      const expectedPrefix = span.source_kind === "session" ? "coding_session/sessions/" : "coding_session/cursor_plan/";
      if (!span.relative_path.startsWith(expectedPrefix)) throw agentKnowledgeError(`source path outside allowed root at ${spanPath}.relative_path`, `${spanPath}.relative_path`);
      if (!/^[0-9a-f]{64}$/.test(span.artifact_sha256)) throw agentKnowledgeError(`invalid sha256 at ${spanPath}.artifact_sha256`, `${spanPath}.artifact_sha256`);
      if (!Number.isInteger(span.start_line) || span.start_line < 1 || !Number.isInteger(span.end_line) || span.end_line < span.start_line) {
        throw agentKnowledgeError(`invalid line span at ${spanPath}`, spanPath);
      }
      if (span.relative_path < previousPath || (span.relative_path === previousPath && span.start_line <= previousEnd)) {
        throw agentKnowledgeError(`unordered or overlapping span at ${spanPath}`, spanPath);
      }
      previousPath = span.relative_path;
      previousEnd = span.end_line;
      assertAgentStringArray(span.event_ids, `${spanPath}.event_ids`);
    });
    assertAgentString(record.extractor_version, `${recordPath}.extractor_version`);
    if (!Array.isArray(record.redactions)) throw agentKnowledgeError(`invalid redactions at ${recordPath}.redactions`, `${recordPath}.redactions`);
    record.redactions.forEach((redaction, redactionIndex) => {
      const redactionPath = `${recordPath}.redactions[${redactionIndex}]`;
      assertAgentObject(redaction, redactionPath, new Set(["kind", "count"]));
      assertAgentEnum(redaction.kind, new Set(["secret", "email", "local_path", "username", "repository", "production_identifier"]), `${redactionPath}.kind`);
      if (!Number.isInteger(redaction.count) || redaction.count < 1) throw agentKnowledgeError(`invalid count at ${redactionPath}.count`, `${redactionPath}.count`);
    });
    assertAgentStringArray(record.excluded_fields, `${recordPath}.excluded_fields`, { exact: REQUIRED_EXCLUDED_FIELDS });
    assertAgentDateTime(record.created_at, `${recordPath}.created_at`);
    assertAgentObject(record.binding, `${recordPath}.binding`, new Set(["status", "public_case_sha256", "bound_at"]));
    assertAgentEnum(record.binding.status, new Set(["captured", "bound"]), `${recordPath}.binding.status`);
    const isBound = record.binding.status === "bound";
    if (isBound) {
      if (!/^[0-9a-f]{64}$/.test(record.binding.public_case_sha256)) throw agentKnowledgeError(`invalid bound hash at ${recordPath}.binding.public_case_sha256`, `${recordPath}.binding.public_case_sha256`);
      assertAgentDateTime(record.binding.bound_at, `${recordPath}.binding.bound_at`);
    } else if (record.binding.public_case_sha256 !== null || record.binding.bound_at !== null) {
      throw agentKnowledgeError(`unbound provenance has binding values at ${recordPath}.binding`, `${recordPath}.binding`);
    }
  }
}

const CASE_PROVENANCE_V2_VERSION = "2.0.0";
const P2_SESSION_BINDING_KEYS = new Set([
  "kind", "root_episode_hmac", "store_digest", "lineage_status", "sources"
]);
const P2_CURSOR_PLAN_BINDING_KEYS = new Set(["kind", "plan_hmac", "lineage_status"]);
const P2_SOURCE_KEYS = new Set(["file_id_hmac", "projection_manifest_hmac", "records"]);
const P2_RECORD_KEYS = new Set(["record_no", "event_kind", "projection_hmac"]);
const P2_EVENT_KINDS = new Set([
  "agent_message", "context_compacted", "response_message", "session_meta",
  "task_complete", "task_started", "tool_end_status", "tool_output",
  "tool_request", "turn_aborted", "turn_context", "user_message"
]);
const V2_PROVENANCE_RECORD_KEYS = new Set([
  "case_id", "case_identity_sha256", "source_bindings", "source_binding_sha256",
  "extractor_version", "redactions", "excluded_fields", "created_at",
  "receipt_bindings", "binding"
]);
const V2_DLP_BINDING_KEYS = new Set([
  "receipt_id", "receipt_sha256", "subject_sha256", "policy_id", "policy_version",
  "policy_hash", "result", "status"
]);
const V2_CLAIM_BINDING_KEYS = new Set([
  "claim_index", "claim_sha256", "calibration", "expected_receipt", "receipts"
]);
const V2_CLAIM_CALIBRATION_KEYS = new Set([
  "claim_role", "calibration_status", "basis"
]);
const V2_EXPECTED_RECEIPT_KEYS = new Set([
  "subject_id", "subject_sha256", "evidence_grade", "policy_id", "policy_version",
  "policy_hash", "result", "status"
]);
const V2_RECEIPT_REFERENCE_KEYS = new Set(["receipt_id", "receipt_sha256"]);
const RECEIPT_ID_V2 = /^receipt-[0-9a-f]{64}$/;

function assertAgentSha256(value, path) {
  if (typeof value !== "string" || !/^[0-9a-f]{64}$/.test(value)) {
    throw agentKnowledgeError(`invalid sha256 at ${path}`, path);
  }
}

function assertReceiptIdV2(value, path) {
  if (typeof value !== "string" || !RECEIPT_ID_V2.test(value)) {
    throw agentKnowledgeError(`invalid receipt id at ${path}`, path);
  }
}

function compareAscii(left, right) {
  if (left === right) return 0;
  return left < right ? -1 : 1;
}

function sourceBindingSortKey(binding) {
  return binding.kind === "p2_session_projection_v1"
    ? `0:${binding.root_episode_hmac}:${binding.store_digest}`
    : `1:${binding.plan_hmac}`;
}

function validateSourceBindingsV2(value, path) {
  if (!Array.isArray(value) || value.length === 0) {
    throw agentKnowledgeError(`invalid source bindings at ${path}`, path);
  }
  let previousBindingKey = null;
  for (const [bindingIndex, sourceBinding] of value.entries()) {
    const bindingPath = `${path}[${bindingIndex}]`;
    if (!isPlainObject(sourceBinding)) {
      throw agentKnowledgeError(`invalid source binding at ${bindingPath}`, bindingPath);
    }
    if (sourceBinding.kind === "p2_session_projection_v1") {
      assertAgentObject(sourceBinding, bindingPath, P2_SESSION_BINDING_KEYS);
      assertAgentSha256(sourceBinding.root_episode_hmac, `${bindingPath}.root_episode_hmac`);
      assertAgentSha256(sourceBinding.store_digest, `${bindingPath}.store_digest`);
      if (sourceBinding.lineage_status !== "consistent") {
        throw agentKnowledgeError(`session lineage is not consistent at ${bindingPath}.lineage_status`, `${bindingPath}.lineage_status`);
      }
      if (!Array.isArray(sourceBinding.sources) || sourceBinding.sources.length === 0) {
        throw agentKnowledgeError(`invalid sources at ${bindingPath}.sources`, `${bindingPath}.sources`);
      }
      let previousFile = null;
      for (const [sourceIndex, source] of sourceBinding.sources.entries()) {
        const sourcePath = `${bindingPath}.sources[${sourceIndex}]`;
        assertAgentObject(source, sourcePath, P2_SOURCE_KEYS);
        assertAgentSha256(source.file_id_hmac, `${sourcePath}.file_id_hmac`);
        assertAgentSha256(source.projection_manifest_hmac, `${sourcePath}.projection_manifest_hmac`);
        if (previousFile !== null && compareAscii(previousFile, source.file_id_hmac) >= 0) {
          throw agentKnowledgeError(`unordered or duplicate source at ${sourcePath}.file_id_hmac`, `${sourcePath}.file_id_hmac`);
        }
        previousFile = source.file_id_hmac;
        if (!Array.isArray(source.records) || source.records.length === 0) {
          throw agentKnowledgeError(`invalid records at ${sourcePath}.records`, `${sourcePath}.records`);
        }
        let previousRecordNo = -1;
        for (const [recordIndex, record] of source.records.entries()) {
          const recordPath = `${sourcePath}.records[${recordIndex}]`;
          assertAgentObject(record, recordPath, P2_RECORD_KEYS);
          if (!Number.isSafeInteger(record.record_no) || record.record_no < 0 || record.record_no <= previousRecordNo) {
            throw agentKnowledgeError(`unordered or invalid record at ${recordPath}.record_no`, `${recordPath}.record_no`);
          }
          previousRecordNo = record.record_no;
          assertAgentEnum(record.event_kind, P2_EVENT_KINDS, `${recordPath}.event_kind`);
          assertAgentSha256(record.projection_hmac, `${recordPath}.projection_hmac`);
        }
      }
    } else if (sourceBinding.kind === "p2_cursor_plan_v1") {
      assertAgentObject(sourceBinding, bindingPath, P2_CURSOR_PLAN_BINDING_KEYS);
      assertAgentSha256(sourceBinding.plan_hmac, `${bindingPath}.plan_hmac`);
      if (sourceBinding.lineage_status !== "not_applicable") {
        throw agentKnowledgeError(`invalid Cursor Plan lineage status at ${bindingPath}.lineage_status`, `${bindingPath}.lineage_status`);
      }
    } else {
      throw agentKnowledgeError(`unknown source binding kind at ${bindingPath}.kind`, `${bindingPath}.kind`);
    }
    const bindingKey = sourceBindingSortKey(sourceBinding);
    if (previousBindingKey !== null && compareAscii(previousBindingKey, bindingKey) >= 0) {
      throw agentKnowledgeError(`unordered or duplicate source binding at ${bindingPath}`, bindingPath);
    }
    previousBindingKey = bindingKey;
  }
}

export function validateP2SourceBindingsV2Shape(value) {
  return validateSourceBindingsV2(value, "p2-source-bindings-v2");
}

function caseIdentityProjectionV2(caseRecord) {
  const { id: _id, ...withoutId } = caseRecord;
  return {
    ...withoutId,
    evidence: {
      ...withoutId.evidence,
      claims: withoutId.evidence.claims.map((claim) => ({ ...claim, receipt_ids: [] }))
    },
    privacy: {
      ...withoutId.privacy,
      dlp_status: "pending_scan",
      publication_status: "pending_scan",
      dlp_receipt_sha256: null
    }
  };
}

function dlpSubjectProjectionV2(caseRecord) {
  return {
    ...caseRecord,
    privacy: {
      ...caseRecord.privacy,
      dlp_status: "pending_scan",
      publication_status: "pending_scan",
      dlp_receipt_sha256: null
    }
  };
}

function normalizeDlpSubjectV2(value) {
  if (typeof value === "string") {
    return value.normalize("NFKC").replace(/\p{Default_Ignorable_Code_Point}/gu, "");
  }
  if (Array.isArray(value)) return value.map((entry) => normalizeDlpSubjectV2(entry));
  if (value !== null && typeof value === "object") {
    const result = {};
    for (const [key, child] of Object.entries(value)) {
      const normalizedKey = key.normalize("NFKC").replace(/\p{Default_Ignorable_Code_Point}/gu, "");
      result[normalizedKey] = normalizeDlpSubjectV2(child);
    }
    return result;
  }
  return value;
}

function claimProjectionV2(claim) {
  const { receipt_ids: _receiptIds, ...withoutReceipts } = claim;
  return withoutReceipts;
}

export function deriveSourceBindingSha256V2(sourceBindings) {
  return sha256(canonicalJsonBytes(sourceBindings));
}

export function deriveCaseIdentitySha256V2(caseRecord, sourceBindings) {
  return sha256(canonicalJsonBytes({
    case: caseIdentityProjectionV2(caseRecord),
    source_binding_sha256: deriveSourceBindingSha256V2(sourceBindings)
  }));
}

export function deriveClaimSha256V2(claim) {
  return sha256(canonicalJsonBytes(claimProjectionV2(claim)));
}

export function deriveDlpSubjectSha256V2(caseRecord) {
  return sha256(canonicalJsonBytes(normalizeDlpSubjectV2(dlpSubjectProjectionV2(caseRecord))));
}

export function validateCaseProvenanceV2Shape(value, { caseIds = new Set() } = {}) {
  const path = "case-provenance-v2";
  assertNoPrivateText(value, path);
  assertAgentObject(value, path, new Set(["schema_version", "records"]));
  if (value.schema_version !== CASE_PROVENANCE_V2_VERSION) {
    throw agentKnowledgeError(`invalid schema_version at ${path}.schema_version`, `${path}.schema_version`);
  }
  if (!Array.isArray(value.records)) {
    throw agentKnowledgeError(`invalid records at ${path}.records`, `${path}.records`);
  }
  let previousCaseId = null;
  const receiptOwners = new Map();
  function claimReceipt(receiptId, ownerPath) {
    const existingOwner = receiptOwners.get(receiptId);
    if (existingOwner !== undefined) {
      throw agentKnowledgeError(
        `receipt id is reused at ${ownerPath}.receipt_id`,
        `${ownerPath}.receipt_id`
      );
    }
    receiptOwners.set(receiptId, ownerPath);
  }
  for (const [index, record] of value.records.entries()) {
    const recordPath = `${path}.records[${index}]`;
    assertAgentObject(record, recordPath, V2_PROVENANCE_RECORD_KEYS);
    if (!caseIds.has(record.case_id)) {
      throw agentKnowledgeError(`unknown case at ${recordPath}.case_id`, `${recordPath}.case_id`);
    }
    if (previousCaseId !== null && compareAscii(previousCaseId, record.case_id) >= 0) {
      throw agentKnowledgeError(`unordered or duplicate case provenance at ${recordPath}.case_id`, `${recordPath}.case_id`);
    }
    previousCaseId = record.case_id;
    assertAgentSha256(record.case_identity_sha256, `${recordPath}.case_identity_sha256`);
    if (record.case_id !== `case-${record.case_identity_sha256}`) {
      throw agentKnowledgeError(`case id is not derived from its identity at ${recordPath}.case_id`, `${recordPath}.case_id`);
    }
    validateSourceBindingsV2(record.source_bindings, `${recordPath}.source_bindings`);
    assertAgentSha256(record.source_binding_sha256, `${recordPath}.source_binding_sha256`);
    if (record.source_binding_sha256 !== deriveSourceBindingSha256V2(record.source_bindings)) {
      throw agentKnowledgeError(`source binding digest mismatch at ${recordPath}.source_binding_sha256`, `${recordPath}.source_binding_sha256`);
    }
    assertAgentString(record.extractor_version, `${recordPath}.extractor_version`);
    if (!Array.isArray(record.redactions)) {
      throw agentKnowledgeError(`invalid redactions at ${recordPath}.redactions`, `${recordPath}.redactions`);
    }
    let previousRedaction = null;
    for (const [redactionIndex, redaction] of record.redactions.entries()) {
      const redactionPath = `${recordPath}.redactions[${redactionIndex}]`;
      assertAgentObject(redaction, redactionPath, new Set(["kind", "count"]));
      assertAgentEnum(redaction.kind, new Set([
        "secret", "email", "local_path", "username", "repository", "production_identifier"
      ]), `${redactionPath}.kind`);
      if (previousRedaction !== null && compareAscii(previousRedaction, redaction.kind) >= 0) {
        throw agentKnowledgeError(`unordered or duplicate redaction at ${redactionPath}.kind`, `${redactionPath}.kind`);
      }
      previousRedaction = redaction.kind;
      if (!Number.isSafeInteger(redaction.count) || redaction.count < 1) {
        throw agentKnowledgeError(`invalid redaction count at ${redactionPath}.count`, `${redactionPath}.count`);
      }
    }
    const exactExcluded = ["agent_reasoning", "encrypted_content", "reasoning"];
    if (!Array.isArray(record.excluded_fields) ||
        record.excluded_fields.length !== exactExcluded.length ||
        record.excluded_fields.some((field, fieldIndex) => field !== exactExcluded[fieldIndex])) {
      throw agentKnowledgeError(`invalid excluded fields at ${recordPath}.excluded_fields`, `${recordPath}.excluded_fields`);
    }
    assertAgentDateTime(record.created_at, `${recordPath}.created_at`);

    assertAgentObject(record.receipt_bindings, `${recordPath}.receipt_bindings`, new Set(["dlp", "claims"]));
    const dlpPath = `${recordPath}.receipt_bindings.dlp`;
    assertAgentObject(record.receipt_bindings.dlp, dlpPath, V2_DLP_BINDING_KEYS);
    assertReceiptIdV2(record.receipt_bindings.dlp.receipt_id, `${dlpPath}.receipt_id`);
    claimReceipt(record.receipt_bindings.dlp.receipt_id, dlpPath);
    for (const field of ["receipt_sha256", "subject_sha256", "policy_hash"]) {
      assertAgentSha256(record.receipt_bindings.dlp[field], `${dlpPath}.${field}`);
    }
    assertAgentString(record.receipt_bindings.dlp.policy_id, `${dlpPath}.policy_id`);
    assertAgentString(record.receipt_bindings.dlp.policy_version, `${dlpPath}.policy_version`);
    if (record.receipt_bindings.dlp.result !== "passed" || record.receipt_bindings.dlp.status !== "active") {
      throw agentKnowledgeError(`DLP receipt is not active and passed at ${dlpPath}`, dlpPath);
    }
    if (!Array.isArray(record.receipt_bindings.claims)) {
      throw agentKnowledgeError(`invalid claim bindings at ${recordPath}.receipt_bindings.claims`, `${recordPath}.receipt_bindings.claims`);
    }
    for (const [claimIndex, claimBinding] of record.receipt_bindings.claims.entries()) {
      const claimPath = `${recordPath}.receipt_bindings.claims[${claimIndex}]`;
      assertAgentObject(claimBinding, claimPath, V2_CLAIM_BINDING_KEYS);
      if (claimBinding.claim_index !== claimIndex) {
        throw agentKnowledgeError(`claim binding index mismatch at ${claimPath}.claim_index`, `${claimPath}.claim_index`);
      }
      assertAgentSha256(claimBinding.claim_sha256, `${claimPath}.claim_sha256`);
      const calibrationPath = `${claimPath}.calibration`;
      assertAgentObject(claimBinding.calibration, calibrationPath, V2_CLAIM_CALIBRATION_KEYS);
      assertAgentEnum(claimBinding.calibration.claim_role, new Set([
        "fact", "inference", "unknown"
      ]), `${calibrationPath}.claim_role`);
      assertAgentEnum(claimBinding.calibration.calibration_status, new Set([
        "receipt_verified", "reported", "unknown"
      ]), `${calibrationPath}.calibration_status`);
      assertAgentEnum(claimBinding.calibration.basis, new Set([
        "authenticated_receipt", "no_receipt"
      ]), `${calibrationPath}.basis`);
      if (claimBinding.expected_receipt !== null) {
        const expectedPath = `${claimPath}.expected_receipt`;
        assertAgentObject(claimBinding.expected_receipt, expectedPath, V2_EXPECTED_RECEIPT_KEYS);
        assertAgentString(claimBinding.expected_receipt.subject_id, `${expectedPath}.subject_id`);
        if (!/^case-[0-9a-f]{64}:claim:[0-9]+$/.test(claimBinding.expected_receipt.subject_id)) {
          throw agentKnowledgeError(`invalid claim subject at ${expectedPath}.subject_id`, `${expectedPath}.subject_id`);
        }
        assertAgentSha256(claimBinding.expected_receipt.subject_sha256, `${expectedPath}.subject_sha256`);
        assertAgentEnum(claimBinding.expected_receipt.evidence_grade, new Set([
          "tool_receipt", "test_receipt", "artifact_receipt", "independent_verification"
        ]), `${expectedPath}.evidence_grade`);
        assertAgentString(claimBinding.expected_receipt.policy_id, `${expectedPath}.policy_id`);
        assertAgentString(claimBinding.expected_receipt.policy_version, `${expectedPath}.policy_version`);
        assertAgentSha256(claimBinding.expected_receipt.policy_hash, `${expectedPath}.policy_hash`);
        if (claimBinding.expected_receipt.result !== "verified" || claimBinding.expected_receipt.status !== "active") {
          throw agentKnowledgeError(`claim receipt is not active and verified at ${expectedPath}`, expectedPath);
        }
        if (claimBinding.calibration.calibration_status !== "receipt_verified" ||
            claimBinding.calibration.basis !== "authenticated_receipt") {
          throw agentKnowledgeError(`claim calibration does not match its receipt at ${calibrationPath}`, calibrationPath);
        }
      } else if (claimBinding.calibration.basis !== "no_receipt" ||
                 claimBinding.calibration.calibration_status === "receipt_verified" ||
                 (claimBinding.calibration.claim_role === "unknown") !==
                   (claimBinding.calibration.calibration_status === "unknown")) {
        throw agentKnowledgeError(`claim calibration does not match an unverified claim at ${calibrationPath}`, calibrationPath);
      }
      if (!Array.isArray(claimBinding.receipts)) {
        throw agentKnowledgeError(`invalid receipt references at ${claimPath}.receipts`, `${claimPath}.receipts`);
      }
      let previousReceiptId = null;
      for (const [receiptIndex, receipt] of claimBinding.receipts.entries()) {
        const receiptPath = `${claimPath}.receipts[${receiptIndex}]`;
        assertAgentObject(receipt, receiptPath, V2_RECEIPT_REFERENCE_KEYS);
        assertReceiptIdV2(receipt.receipt_id, `${receiptPath}.receipt_id`);
        claimReceipt(receipt.receipt_id, receiptPath);
        assertAgentSha256(receipt.receipt_sha256, `${receiptPath}.receipt_sha256`);
        if (previousReceiptId !== null && compareAscii(previousReceiptId, receipt.receipt_id) >= 0) {
          throw agentKnowledgeError(`unordered or duplicate receipt id at ${receiptPath}.receipt_id`, `${receiptPath}.receipt_id`);
        }
        previousReceiptId = receipt.receipt_id;
      }
      if ((claimBinding.expected_receipt === null) !== (claimBinding.receipts.length === 0)) {
        throw agentKnowledgeError(`claim receipt expectation mismatch at ${claimPath}`, claimPath);
      }
    }

    assertAgentObject(record.binding, `${recordPath}.binding`, new Set(["status", "public_case_sha256", "bound_at"]));
    if (record.binding.status !== "bound") {
      throw agentKnowledgeError(`v2 provenance must be bound at ${recordPath}.binding.status`, `${recordPath}.binding.status`);
    }
    assertAgentSha256(record.binding.public_case_sha256, `${recordPath}.binding.public_case_sha256`);
    assertAgentDateTime(record.binding.bound_at, `${recordPath}.binding.bound_at`);
  }
}

function sameStringArray(left, right) {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

export function validateCaseClaimBundleV2Shape(value, {
  modelIds = new Set(),
  problemTypeIds = new Set(),
  agentStageIds = new Set(),
  dlpPolicy = null,
  evidencePolicies = new Map()
} = {}) {
  const path = "case-claim-bundle-v2";
  if (dlpPolicy !== null) {
    assertAgentObject(dlpPolicy, `${path}.options.dlpPolicy`, new Set([
      "policy_id", "policy_version", "policy_hash"
    ]));
    assertAgentString(dlpPolicy.policy_id, `${path}.options.dlpPolicy.policy_id`);
    assertAgentString(dlpPolicy.policy_version, `${path}.options.dlpPolicy.policy_version`);
    assertAgentSha256(dlpPolicy.policy_hash, `${path}.options.dlpPolicy.policy_hash`);
  }
  if (!(evidencePolicies instanceof Map)) {
    throw agentKnowledgeError(`invalid evidence policies at ${path}.options.evidencePolicies`, `${path}.options.evidencePolicies`);
  }
  assertAgentObject(value, path, new Set(["cases", "provenance", "publication_authority"]));
  if (value.publication_authority !== false) {
    throw agentKnowledgeError(`publication authority remains disabled at ${path}.publication_authority`, `${path}.publication_authority`);
  }
  validateModelCaseCatalogInternal(value.cases, { modelIds, problemTypeIds, agentStageIds });
  const caseIds = new Set(value.cases.cases.map((entry) => entry.id));
  validateCaseProvenanceV2Shape(value.provenance, { caseIds });
  const provenanceByCaseId = new Map(value.provenance.records.map((entry) => [entry.case_id, entry]));
  if (caseIds.size !== provenanceByCaseId.size || [...caseIds].some((caseId) => !provenanceByCaseId.has(caseId))) {
    throw agentKnowledgeError(`cases and provenance differ at ${path}.provenance`, `${path}.provenance`);
  }
  for (const caseRecord of value.cases.cases) {
    const provenance = provenanceByCaseId.get(caseRecord.id);
    const identitySha256 = deriveCaseIdentitySha256V2(caseRecord, provenance.source_bindings);
    if (provenance.case_identity_sha256 !== identitySha256 || caseRecord.id !== `case-${identitySha256}`) {
      throw agentKnowledgeError(`case identity mismatch at ${path}.provenance`, `${path}.provenance`);
    }
    if (provenance.binding.public_case_sha256 !== caseDigest(caseRecord)) {
      throw agentKnowledgeError(`public case digest mismatch at ${path}.provenance`, `${path}.provenance`);
    }
    const expectedOriginKind = caseRecord.origin_kind === "session_derived"
      ? "p2_session_projection_v1"
      : "p2_cursor_plan_v1";
    if (provenance.source_bindings.some((binding) => binding.kind !== expectedOriginKind)) {
      throw agentKnowledgeError(`case origin and source binding differ at ${path}.provenance`, `${path}.provenance`);
    }
    if (caseRecord.origin_kind === "cursor_plan_derived" && caseRecord.case_kind !== "plan") {
      throw agentKnowledgeError(
        `Cursor Plan provenance must remain plan-only at ${path}.cases.${caseRecord.id}.case_kind`,
        `${path}.cases.${caseRecord.id}.case_kind`
      );
    }
    if (caseRecord.privacy.dlp_status !== "passed" ||
        provenance.receipt_bindings.dlp.receipt_sha256 !== caseRecord.privacy.dlp_receipt_sha256 ||
        provenance.receipt_bindings.dlp.subject_sha256 !== deriveDlpSubjectSha256V2(caseRecord)) {
      throw agentKnowledgeError(`DLP binding mismatch at ${path}.provenance.${caseRecord.id}.receipt_bindings.dlp`, `${path}.provenance.${caseRecord.id}.receipt_bindings.dlp`);
    }
    if (dlpPolicy !== null && (
      provenance.receipt_bindings.dlp.policy_id !== dlpPolicy.policy_id ||
      provenance.receipt_bindings.dlp.policy_version !== dlpPolicy.policy_version ||
      provenance.receipt_bindings.dlp.policy_hash !== dlpPolicy.policy_hash
    )) {
      throw agentKnowledgeError(`DLP policy mismatch at ${path}.provenance.${caseRecord.id}.receipt_bindings.dlp`, `${path}.provenance.${caseRecord.id}.receipt_bindings.dlp`);
    }
    if (provenance.receipt_bindings.claims.length !== caseRecord.evidence.claims.length) {
      throw agentKnowledgeError(`claim binding count mismatch at ${path}.provenance.${caseRecord.id}.receipt_bindings.claims`, `${path}.provenance.${caseRecord.id}.receipt_bindings.claims`);
    }
    for (const [claimIndex, claim] of caseRecord.evidence.claims.entries()) {
      const claimBinding = provenance.receipt_bindings.claims[claimIndex];
      const expectedReceipt = claimBinding.expected_receipt;
      const expectedSubjectId = `${caseRecord.id}:claim:${claimIndex}`;
      const receiptIds = claimBinding.receipts.map((receipt) => receipt.receipt_id);
      const receiptBacked = new Set([
        "tool_receipt", "test_receipt", "artifact_receipt", "independent_verification"
      ]).has(claim.evidence_grade);
      const expectedCalibration = {
        claim_role: claim.claim_type,
        calibration_status: receiptBacked
          ? "receipt_verified"
          : claim.claim_type === "unknown" ? "unknown" : "reported",
        basis: receiptBacked ? "authenticated_receipt" : "no_receipt"
      };
      const evidencePolicy = expectedReceipt === null
        ? null
        : evidencePolicies.get(expectedReceipt.policy_id);
      if (claimBinding.claim_sha256 !== deriveClaimSha256V2(claim) ||
          !sameStringArray(receiptIds, claim.receipt_ids) ||
          receiptBacked !== (expectedReceipt !== null) ||
          claimBinding.calibration.claim_role !== expectedCalibration.claim_role ||
          claimBinding.calibration.calibration_status !== expectedCalibration.calibration_status ||
          claimBinding.calibration.basis !== expectedCalibration.basis ||
          (expectedReceipt !== null && (
            expectedReceipt.subject_id !== expectedSubjectId ||
            expectedReceipt.subject_sha256 !== provenance.case_identity_sha256 ||
            expectedReceipt.evidence_grade !== claim.evidence_grade ||
            evidencePolicy === undefined ||
            !isPlainObject(evidencePolicy) ||
            Object.keys(evidencePolicy).length !== 2 ||
            expectedReceipt.policy_version !== evidencePolicy.policy_version ||
            expectedReceipt.policy_hash !== evidencePolicy.policy_hash
          ))) {
        throw agentKnowledgeError(`claim receipt binding mismatch at ${path}.provenance.${caseRecord.id}.receipt_bindings.claims[${claimIndex}]`, `${path}.provenance.${caseRecord.id}.receipt_bindings.claims[${claimIndex}]`);
      }
    }
    const anyReceiptVerified = provenance.receipt_bindings.claims.some(
      (claimBinding) => claimBinding.calibration.calibration_status === "receipt_verified"
    );
    const factClaimIndexes = caseRecord.evidence.claims
      .map((claim, claimIndex) => ({ claim, claimIndex }))
      .filter(({ claim }) => claim.claim_type === "fact")
      .map(({ claimIndex }) => claimIndex);
    const expectedEvidenceStatus = caseRecord.case_kind === "plan"
      ? "plan_only"
      : !anyReceiptVerified
        ? "reported_outcome"
        : factClaimIndexes.length > 0 && factClaimIndexes.every(
          (claimIndex) => provenance.receipt_bindings.claims[claimIndex]
            .calibration.calibration_status === "receipt_verified"
        )
          ? "verified_outcome"
          : "partially_verified";
    if (caseRecord.evidence.status !== expectedEvidenceStatus) {
      throw agentKnowledgeError(
        `Case evidence status does not match its calibration ledger at ${path}.cases.${caseRecord.id}.evidence.status`,
        `${path}.cases.${caseRecord.id}.evidence.status`
      );
    }
    const requiresVerifiedAt = expectedEvidenceStatus === "verified_outcome" ||
      expectedEvidenceStatus === "partially_verified";
    if ((caseRecord.verified_at !== null) !== requiresVerifiedAt) {
      throw agentKnowledgeError(
        `Case verified time does not match its calibration ledger at ${path}.cases.${caseRecord.id}.verified_at`,
        `${path}.cases.${caseRecord.id}.verified_at`
      );
    }
  }
}

function caseDigest(caseRecord) {
  return sha256(canonicalJsonBytes(caseRecord));
}

function deriveFrameworkPromotionEvidence(framework, casesById, provenanceByCaseId) {
  const supportingCases = framework.promotion_evidence.case_ids.map((caseId) => casesById.get(caseId));
  const episodeIds = new Set(framework.promotion_evidence.case_ids.map((caseId) => provenanceByCaseId.get(caseId).root_episode_id));
  const taskTypes = new Set(supportingCases.flatMap((entry) => entry.problem_type_ids));
  const exceptionalCases = new Set(framework.promotion_evidence.failure_or_non_trigger_case_ids);
  return {
    independent_episode_count: episodeIds.size,
    task_type_ids: [...taskTypes].sort(),
    failure_or_non_trigger_count: exceptionalCases.size
  };
}

export function validateAgentKnowledgeBundle(value, {
  modelIds = new Set(),
  problemTypeIds = new Set(),
  agentStageIds = new Set(),
  knownAssetIds = new Set(),
  receiptIds = new Set(),
  dlpReceipts = new Map(),
  promotionReceipts = new Map()
} = {}) {
  const path = "agent-knowledge-bundle";
  assertAgentObject(value, path, new Set(["cases", "frameworks", "provenance"]));
  validateModelCaseCatalogInternal(value.cases, { modelIds, problemTypeIds, agentStageIds });
  const caseIds = new Set(value.cases.cases.map((entry) => entry.id));
  validateCaseProvenance(value.provenance, { caseIds });

  const casesById = new Map(value.cases.cases.map((entry) => [entry.id, entry]));
  const provenanceByCaseId = new Map(value.provenance.records.map((entry) => [entry.case_id, entry]));
  if (caseIds.size !== provenanceByCaseId.size || [...caseIds].some((caseId) => !provenanceByCaseId.has(caseId))) {
    throw agentKnowledgeError(`public cases and private provenance differ at ${path}.provenance`, `${path}.provenance`);
  }
  for (const caseRecord of value.cases.cases) {
    const provenance = provenanceByCaseId.get(caseRecord.id);
    if (provenance.binding.status !== "bound" || provenance.binding.public_case_sha256 !== caseDigest(caseRecord)) {
      throw agentKnowledgeError(`case provenance hash mismatch at ${path}.provenance`, `${path}.provenance`);
    }
    for (const [claimIndex, claim] of caseRecord.evidence.claims.entries()) {
      for (const [receiptIndex, receiptId] of claim.receipt_ids.entries()) {
        if (!receiptIds.has(receiptId)) {
          throw agentKnowledgeError(`unknown evidence receipt at ${path}.cases.${caseRecord.id}.evidence.claims[${claimIndex}].receipt_ids[${receiptIndex}]`, `${path}.cases.${caseRecord.id}.evidence.claims[${claimIndex}].receipt_ids[${receiptIndex}]`);
        }
      }
    }
    const dlpReceipt = dlpReceipts.get(caseRecord.id);
    if (caseRecord.privacy.dlp_status === "passed" && dlpReceipt !== caseRecord.privacy.dlp_receipt_sha256) {
      throw agentKnowledgeError(`case DLP receipt mismatch at ${path}.cases.${caseRecord.id}.privacy.dlp_receipt_sha256`, `${path}.cases.${caseRecord.id}.privacy.dlp_receipt_sha256`);
    }
  }

  validateProblemSolvingFrameworkCatalogInternal(value.frameworks, {
    caseIds,
    problemTypeIds,
    knownAssetIds
  });
  for (const framework of value.frameworks.frameworks) {
    const dlpReceipt = dlpReceipts.get(framework.id);
    if (framework.privacy.dlp_status === "passed" && dlpReceipt !== framework.privacy.dlp_receipt_sha256) {
      throw agentKnowledgeError(`framework DLP receipt mismatch at ${path}.frameworks.${framework.id}.privacy.dlp_receipt_sha256`, `${path}.frameworks.${framework.id}.privacy.dlp_receipt_sha256`);
    }
    const derived = deriveFrameworkPromotionEvidence(framework, casesById, provenanceByCaseId);
    const declared = framework.promotion_evidence;
    const taskTypeIdsMatch = declared.task_type_ids.length === derived.task_type_ids.length &&
      declared.task_type_ids.every((id, index) => id === derived.task_type_ids[index]);
    if (declared.independent_episode_count !== derived.independent_episode_count ||
        declared.task_type_count !== derived.task_type_ids.length || !taskTypeIdsMatch ||
        declared.failure_or_non_trigger_count !== derived.failure_or_non_trigger_count) {
      throw agentKnowledgeError(`framework promotion evidence is not derived at ${path}.frameworks.${framework.id}.promotion_evidence`, `${path}.frameworks.${framework.id}.promotion_evidence`);
    }
    if (declared.verification_status === "promotion_gate_passed" && promotionReceipts.get(framework.id) !== declared.gate_receipt_sha256) {
      throw agentKnowledgeError(`framework promotion receipt mismatch at ${path}.frameworks.${framework.id}.promotion_evidence.gate_receipt_sha256`, `${path}.frameworks.${framework.id}.promotion_evidence.gate_receipt_sha256`);
    }
  }
}

export function validateContract(kind, value) {
  if (!isPlainObject(value)) throw contractError("contract must be an object", "contract");
  if (!CONTRACT_KINDS.has(kind)) {
    throw contractError(`unknown contract kind: ${kind}`, "kind");
  }
  if (!/^[a-z][a-z-]*$/.test(kind)) throw contractError("invalid contract kind format", "kind");
  switch (kind) {
    case "taxonomy":
      return assertTaxonomy(value, "taxonomy");
    case "source-summary":
      return assertSourceSummary(value, "source-summary");
    case "problem-routes":
      return assertProblemRoutes(value, "problem-routes");
    case "knowledge-sources":
      return assertKnowledgeSource(value, "knowledge-sources");
    case "curation-source-id":
      return assertCurationSourceIdRecord(value, "curation-source-id");
    default:
      throw contractError(`unsupported contract kind: ${kind}`, "kind");
  }
}

export { CONTRACT_SCHEMA_VERSION as CONTRACT_VERSION };
