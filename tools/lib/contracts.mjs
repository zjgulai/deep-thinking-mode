const CONTRACT_SCHEMA_VERSION = "1.0.0";
const ERROR_CODE = "CONTRACT_SCHEMA_INVALID";

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
