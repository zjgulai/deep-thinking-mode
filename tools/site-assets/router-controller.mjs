import { matchRoute, normalizeRouterText } from "./router-engine.mjs";

const PROBLEM_TYPE_IDS = Object.freeze([
  "diagnosis",
  "planning",
  "decision",
  "creative",
  "research",
  "reflection",
  "communication",
  "clarification"
]);

const AGENT_STAGE_IDS = Object.freeze([
  "intent",
  "cot_step",
  "planning",
  "execution",
  "reflect",
  "tot_branch",
  "research",
  "synthesis"
]);

const SAFETY_SIGNAL_IDS = Object.freeze([
  "high_stakes_financial_instruction",
  "immediate_personal_danger",
  "legal_advice_with_deadline",
  "medical_diagnosis_or_treatment"
]);

const ROUTE_KEYS = Object.freeze([
  "diagnosis::intent",
  "diagnosis::cot_step",
  "diagnosis::reflect",
  "diagnosis::tot_branch",
  "planning::intent",
  "planning::planning",
  "planning::execution",
  "planning::reflect",
  "decision::intent",
  "decision::cot_step",
  "decision::reflect",
  "decision::tot_branch",
  "creative::intent",
  "creative::cot_step",
  "creative::tot_branch",
  "creative::synthesis",
  "research::intent",
  "research::research",
  "research::synthesis",
  "reflection::reflect",
  "reflection::synthesis",
  "communication::synthesis",
  "clarification::intent"
]);

const PROBLEM_TYPE_ID_SET = new Set(PROBLEM_TYPE_IDS);
const AGENT_STAGE_ID_SET = new Set(AGENT_STAGE_IDS);
const SAFETY_SIGNAL_ID_SET = new Set(SAFETY_SIGNAL_IDS);
const ROUTE_KEY_SET = new Set(ROUTE_KEYS);
const CONTROLLERS = new WeakMap();
const CONTROLLER_SNAPSHOTS = new WeakMap();

const TOP_KEYS = new Set(["schema_version", "problem_types", "agent_stages", "safety_signals", "route_keys"]);
const PROBLEM_TYPE_KEYS = new Set(["id", "label", "priority", "positive_phrases", "negative_phrases", "examples", "clarify_label"]);
const AGENT_STAGE_KEYS = new Set(["id", "label", "priority", "positive_phrases"]);
const SAFETY_SIGNAL_KEYS = new Set(["id", "label", "message", "phrases"]);
const WEIGHTED_PHRASE_KEYS = new Set(["text", "weight"]);
const RESULT_KEYS = new Set([
  "state",
  "problemTypeId",
  "auxiliaryProblemTypeIds",
  "agentStageId",
  "evidence",
  "clarificationOptionIds",
  "safetySignalId"
]);
const EVIDENCE_KEYS = new Set([
  "matchedPositivePhrases",
  "matchedNegativePhrases",
  "closestExample",
  "shortcutIntentId"
]);

const SELECTORS = Object.freeze({
  clarify: "[data-router-clarify]",
  clarifyOption: "[data-clarify-option]",
  clarifyQuestion: "[data-router-clarify-question]",
  copy: "[data-router-copy]",
  copyStatus: "[data-router-copy-status]",
  copyText: "[data-router-copy-text]",
  examples: "[data-router-examples]",
  form: "[data-router-form]",
  hint: "[data-router-hint]",
  input: "[data-router-input]",
  live: "[data-router-live]",
  payload: "[data-router-payload]",
  results: "[data-router-results]",
  route: "[data-route-key]",
  safety: "[data-router-safety]",
  safetyFacts: "[data-safety-facts]",
  safetySignal: "[data-safety-signal]",
  shortcut: "[data-shortcut-intent]",
  shortcuts: "[data-router-shortcuts]",
  title: "[data-router-result-title]",
  unavailable: "[data-router-unavailable]"
});

function isRecord(value) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function hasExactKeys(value, expectedKeys) {
  if (!isRecord(value)) return false;
  const keys = Object.keys(value);
  return keys.length === expectedKeys.size && keys.every((key) => expectedKeys.has(key));
}

function isNonEmptyString(value) {
  return typeof value === "string" && value.trim().length > 0;
}

function isUniqueStringArray(value, { allowEmpty = false } = {}) {
  return Array.isArray(value)
    && (allowEmpty || value.length > 0)
    && value.every(isNonEmptyString)
    && new Set(value).size === value.length;
}

function validWeightedPhrases(value) {
  if (!(Array.isArray(value)
    && value.length > 0
    && value.every((entry) => (
      hasExactKeys(entry, WEIGHTED_PHRASE_KEYS)
      && isNonEmptyString(entry.text)
      && Number.isInteger(entry.weight)
      && entry.weight >= 1
      && entry.weight <= 10
    )))) return false;
  const normalizedTexts = value.map(({ text }) => normalizeRouterText(text).compactText);
  return normalizedTexts.every((text) => text.length > 0)
    && new Set(normalizedTexts).size === normalizedTexts.length;
}

function arraysEqual(actual, expected) {
  return Array.isArray(actual)
    && actual.length === expected.length
    && actual.every((value, index) => value === expected[index]);
}

function validProblemType(value, index) {
  if (
    !hasExactKeys(value, PROBLEM_TYPE_KEYS)
    || value.id !== PROBLEM_TYPE_IDS[index]
    || !isNonEmptyString(value.label)
    || value.priority !== (index + 1) * 10
    || !validWeightedPhrases(value.positive_phrases)
    || !validWeightedPhrases(value.negative_phrases)
    || !isUniqueStringArray(value.examples)
    || !isNonEmptyString(value.clarify_label)
  ) return false;

  const positiveTexts = new Set(value.positive_phrases.map(({ text }) => normalizeRouterText(text).compactText));
  return value.negative_phrases.every(({ text }) => !positiveTexts.has(normalizeRouterText(text).compactText));
}

function validAgentStage(value, index) {
  return hasExactKeys(value, AGENT_STAGE_KEYS)
    && value.id === AGENT_STAGE_IDS[index]
    && isNonEmptyString(value.label)
    && value.priority === (index + 1) * 10
    && validWeightedPhrases(value.positive_phrases);
}

function validSafetySignal(value, index) {
  if (!(hasExactKeys(value, SAFETY_SIGNAL_KEYS)
    && value.id === SAFETY_SIGNAL_IDS[index]
    && isNonEmptyString(value.label)
    && isNonEmptyString(value.message)
    && isUniqueStringArray(value.phrases))) return false;
  const normalizedPhrases = value.phrases.map((phrase) => normalizeRouterText(phrase).compactText);
  return normalizedPhrases.every((phrase) => phrase.length > 0)
    && new Set(normalizedPhrases).size === normalizedPhrases.length;
}

export function parseRouterPayload(scriptNode) {
  if (!scriptNode || typeof scriptNode.textContent !== "string") return null;
  try {
    const payload = JSON.parse(scriptNode.textContent);
    if (
      !hasExactKeys(payload, TOP_KEYS)
      || payload.schema_version !== "2.0-router"
      || !Array.isArray(payload.problem_types)
      || payload.problem_types.length !== PROBLEM_TYPE_IDS.length
      || !payload.problem_types.every(validProblemType)
      || !Array.isArray(payload.agent_stages)
      || payload.agent_stages.length !== AGENT_STAGE_IDS.length
      || !payload.agent_stages.every(validAgentStage)
      || !Array.isArray(payload.safety_signals)
      || payload.safety_signals.length !== SAFETY_SIGNAL_IDS.length
      || !payload.safety_signals.every(validSafetySignal)
      || !arraysEqual(payload.route_keys, ROUTE_KEYS)
    ) return null;
    return payload;
  } catch {
    return null;
  }
}

function all(root, selector) {
  return [...root.querySelectorAll(selector)];
}

function collectSelectorNodes(root) {
  return Object.fromEntries(
    Object.entries(SELECTORS).map(([name, selector]) => [name, all(root, selector)])
  );
}

function createSelectorSnapshot(selectorNodes) {
  return Object.freeze(
    Object.keys(SELECTORS).map((name) => Object.freeze([...selectorNodes[name]]))
  );
}

function selectorSnapshotsEqual(actual, expected) {
  return Array.isArray(actual)
    && actual.length === expected.length
    && actual.every((nodes, index) => arraysEqual(nodes, expected[index]));
}

function exactNodeCollection(nodes, attribute, expectedIds) {
  return nodes.length === expectedIds.length
    && nodes.every((node, index) => node.getAttribute(attribute) === expectedIds[index]);
}

function isEmptyEvidence(evidence) {
  return evidence.matchedPositivePhrases.length === 0
    && evidence.matchedNegativePhrases.length === 0
    && evidence.closestExample === null
    && evidence.shortcutIntentId === null;
}

function validateEvidence(evidence) {
  return hasExactKeys(evidence, EVIDENCE_KEYS)
    && isUniqueStringArray(evidence.matchedPositivePhrases, { allowEmpty: true })
    && isUniqueStringArray(evidence.matchedNegativePhrases, { allowEmpty: true })
    && (evidence.closestExample === null || isNonEmptyString(evidence.closestExample))
    && (evidence.shortcutIntentId === null || PROBLEM_TYPE_ID_SET.has(evidence.shortcutIntentId));
}

function validateMatchResult(result) {
  if (
    !hasExactKeys(result, RESULT_KEYS)
    || !validateEvidence(result.evidence)
    || !Array.isArray(result.auxiliaryProblemTypeIds)
    || !Array.isArray(result.clarificationOptionIds)
  ) return false;

  const baseEmpty = result.problemTypeId === null
    && result.auxiliaryProblemTypeIds.length === 0
    && result.clarificationOptionIds.length === 0
    && result.safetySignalId === null
    && isEmptyEvidence(result.evidence);

  if (result.state === "idle" || result.state === "needs_input") {
    return baseEmpty && result.agentStageId === null;
  }

  if (result.state === "clarify") {
    return result.problemTypeId === null
      && result.auxiliaryProblemTypeIds.length === 0
      && AGENT_STAGE_ID_SET.has(result.agentStageId)
      && result.clarificationOptionIds.length >= 2
      && result.clarificationOptionIds.length <= 4
      && result.clarificationOptionIds.every((id) => PROBLEM_TYPE_ID_SET.has(id))
      && new Set(result.clarificationOptionIds).size === result.clarificationOptionIds.length
      && result.safetySignalId === null
      && isEmptyEvidence(result.evidence);
  }

  if (result.state === "safety_stop") {
    return result.problemTypeId === null
      && result.auxiliaryProblemTypeIds.length === 0
      && result.agentStageId === null
      && result.clarificationOptionIds.length === 0
      && SAFETY_SIGNAL_ID_SET.has(result.safetySignalId)
      && isEmptyEvidence(result.evidence);
  }

  if (result.state !== "matched") return false;
  if (
    !PROBLEM_TYPE_ID_SET.has(result.problemTypeId)
    || result.auxiliaryProblemTypeIds.length > 2
    || !result.auxiliaryProblemTypeIds.every((id) => PROBLEM_TYPE_ID_SET.has(id) && id !== result.problemTypeId)
    || new Set(result.auxiliaryProblemTypeIds).size !== result.auxiliaryProblemTypeIds.length
    || !AGENT_STAGE_ID_SET.has(result.agentStageId)
    || result.clarificationOptionIds.length !== 0
    || result.safetySignalId !== null
  ) return false;

  return true;
}

function matchResultsEqual(actual, expected) {
  return actual.state === expected.state
    && actual.problemTypeId === expected.problemTypeId
    && arraysEqual(actual.auxiliaryProblemTypeIds, expected.auxiliaryProblemTypeIds)
    && actual.agentStageId === expected.agentStageId
    && arraysEqual(actual.evidence.matchedPositivePhrases, expected.evidence.matchedPositivePhrases)
    && arraysEqual(actual.evidence.matchedNegativePhrases, expected.evidence.matchedNegativePhrases)
    && actual.evidence.closestExample === expected.evidence.closestExample
    && actual.evidence.shortcutIntentId === expected.evidence.shortcutIntentId
    && arraysEqual(actual.clarificationOptionIds, expected.clarificationOptionIds)
    && actual.safetySignalId === expected.safetySignalId;
}

export function createRouterController({ root, matcher = matchRoute }) {
  const selectorNodes = collectSelectorNodes(root);
  const selectorSnapshot = createSelectorSnapshot(selectorNodes);
  const existing = CONTROLLERS.get(root);
  if (existing && selectorSnapshotsEqual(CONTROLLER_SNAPSHOTS.get(root), selectorSnapshot)) return existing;
  if (existing) existing.destroy();

  const payloadNodes = selectorNodes.payload;
  const forms = selectorNodes.form;
  const inputs = selectorNodes.input;
  const liveNodes = selectorNodes.live;
  const hintNodes = selectorNodes.hint;
  const titleNodes = selectorNodes.title;
  const exampleNodes = selectorNodes.examples;
  const shortcutContainers = selectorNodes.shortcuts;
  const resultContainers = selectorNodes.results;
  const clarifyContainers = selectorNodes.clarify;
  const clarifyQuestionNodes = selectorNodes.clarifyQuestion;
  const safetyContainers = selectorNodes.safety;
  const safetyFactNodes = selectorNodes.safetyFacts;
  const unavailableNodes = selectorNodes.unavailable;
  const copyButtons = selectorNodes.copy;
  const copyStatusNodes = selectorNodes.copyStatus;
  const copyTextNodes = selectorNodes.copyText;
  const singletonCollections = [
    payloadNodes,
    forms,
    inputs,
    liveNodes,
    hintNodes,
    titleNodes,
    exampleNodes,
    shortcutContainers,
    resultContainers,
    clarifyContainers,
    clarifyQuestionNodes,
    safetyContainers,
    safetyFactNodes,
    unavailableNodes,
    copyButtons,
    copyStatusNodes,
    copyTextNodes
  ];
  const requiredNodes = singletonCollections.map(([node]) => node ?? null);
  const [
    payloadNode,
    form,
    input,
    live,
    hint,
    title,
    examples,
    shortcuts,
    results,
    clarify,
    clarifyQuestion,
    safety,
    safetyFacts,
    unavailable,
    copyButton,
    copyStatus,
    copyText
  ] = requiredNodes;
  const payload = parseRouterPayload(payloadNode);
  const routeCards = selectorNodes.route;
  const shortcutButtons = selectorNodes.shortcut;
  const clarifyButtons = selectorNodes.clarifyOption;
  const safetyPanels = selectorNodes.safetySignal;
  const view = root.defaultView;
  const copyButtonLabel = copyButton?.textContent ?? "";
  const contractNodes = [
    ...requiredNodes,
    ...shortcutButtons,
    ...clarifyButtons,
    ...safetyPanels,
    ...routeCards
  ];

  const domReady = singletonCollections.every((nodes) => nodes.length === 1)
    && new Set(contractNodes).size === contractNodes.length
    && exactNodeCollection(shortcutButtons, "data-shortcut-intent", PROBLEM_TYPE_IDS)
    && exactNodeCollection(clarifyButtons, "data-clarify-option", PROBLEM_TYPE_IDS)
    && exactNodeCollection(safetyPanels, "data-safety-signal", SAFETY_SIGNAL_IDS)
    && exactNodeCollection(routeCards, "data-route-key", ROUTE_KEYS)
    && typeof view?.addEventListener === "function"
    && typeof view?.removeEventListener === "function";

  const routeCardByKey = new Map(routeCards.map((card) => [card.getAttribute("data-route-key"), card]));
  const safetyPanelById = new Map(safetyPanels.map((panel) => [panel.getAttribute("data-safety-signal"), panel]));
  let selectedShortcutIntentId = null;
  let clarificationCount = 0;
  let active = domReady;
  let destroyed = false;
  let generation = 0;

  function announce(message) {
    if (live) live.textContent = message;
  }

  function clearTransientMessages() {
    if (hint) hint.textContent = "";
    generation += 1;
    if (copyStatus) copyStatus.textContent = "";
    if (copyButton) copyButton.textContent = copyButtonLabel;
  }

  function hideRoutes() {
    for (const card of routeCards) {
      card.hidden = true;
      card.setAttribute("data-route-kind", "");
    }
  }

  function hideClarification() {
    if (clarify) clarify.hidden = true;
    for (const button of clarifyButtons) button.hidden = true;
  }

  function hideSafety() {
    if (safety) safety.hidden = true;
    if (safetyFacts) safetyFacts.hidden = true;
    for (const panel of safetyPanels) panel.hidden = true;
  }

  function hideUnavailable() {
    if (unavailable) unavailable.hidden = true;
  }

  function setShortcutSelection(intentId) {
    selectedShortcutIntentId = intentId;
    for (const button of shortcutButtons) {
      button.setAttribute("aria-pressed", String(button.getAttribute("data-shortcut-intent") === intentId));
    }
  }

  function showIdle({ clearInput = false } = {}) {
    clarificationCount = 0;
    if (clearInput && input) input.value = "";
    if (examples) examples.hidden = false;
    if (shortcuts) shortcuts.hidden = false;
    if (results) results.hidden = true;
    if (title) title.hidden = true;
    hideUnavailable();
    hideRoutes();
    hideClarification();
    hideSafety();
    clearTransientMessages();
    announce("");
  }

  function showUnavailable() {
    clarificationCount = 0;
    if (examples) examples.hidden = true;
    if (shortcuts) shortcuts.hidden = true;
    if (results) results.hidden = true;
    if (title) title.hidden = true;
    hideRoutes();
    hideClarification();
    hideSafety();
    clearTransientMessages();
    if (unavailable) {
      unavailable.hidden = false;
      unavailable.textContent = "路由数据不可用";
    }
    announce("路由数据不可用");
  }

  function showNeedsInput() {
    clarificationCount = 0;
    if (examples) examples.hidden = false;
    if (shortcuts) shortcuts.hidden = false;
    if (results) results.hidden = true;
    if (title) title.hidden = true;
    hideUnavailable();
    hideRoutes();
    hideClarification();
    hideSafety();
    announce("需要补充");
    input.focus();
  }

  function showMatched(match) {
    clarificationCount = 0;
    if (examples) examples.hidden = true;
    if (shortcuts) shortcuts.hidden = true;
    if (results) results.hidden = false;
    if (title) title.hidden = false;
    hideUnavailable();
    hideClarification();
    hideSafety();
    hideRoutes();

    const routeIds = [match.problemTypeId, ...match.auxiliaryProblemTypeIds];
    for (const [index, problemTypeId] of routeIds.entries()) {
      const card = routeCardByKey.get(`${problemTypeId}::${match.agentStageId}`);
      card.hidden = false;
      card.setAttribute("data-route-kind", index === 0 ? "core" : "auxiliary");
    }
    announce(`已匹配 ${routeIds.length} 条路径`);
    title.focus();
    const reducedMotion = view.matchMedia?.("(prefers-reduced-motion: reduce)").matches === true;
    title.scrollIntoView({ behavior: reducedMotion ? "auto" : "smooth", block: "start" });
  }

  function showClarify(match) {
    if (examples) examples.hidden = true;
    if (results) results.hidden = true;
    if (title) title.hidden = true;
    hideUnavailable();
    hideRoutes();
    hideSafety();
    announce("需要澄清");

    if (clarificationCount >= 2) {
      hideClarification();
      shortcuts.hidden = false;
      return;
    }

    clarificationCount = 1;
    shortcuts.hidden = true;
    clarify.hidden = false;
    clarifyQuestion.textContent = "你现在最需要的是找出原因、做出选择，还是制定下一步行动？";
    for (const button of clarifyButtons) {
      button.hidden = !match.clarificationOptionIds.includes(button.getAttribute("data-clarify-option"));
    }
  }

  function showSafetyStop(match) {
    clarificationCount = 0;
    if (examples) examples.hidden = true;
    if (shortcuts) shortcuts.hidden = true;
    if (results) results.hidden = true;
    if (title) title.hidden = true;
    hideUnavailable();
    hideRoutes();
    hideClarification();
    hideSafety();
    safety.hidden = false;
    safetyFacts.hidden = false;
    safetyPanelById.get(match.safetySignalId).hidden = false;
    announce(match.safetySignalId === "immediate_personal_danger"
      ? "已停止自助路由，请优先寻求当地紧急服务或可信赖的人"
      : "已停止自助路由，请寻求相应的专业支持");
  }

  function render(match) {
    if (match.state === "idle") showIdle();
    else if (match.state === "needs_input") showNeedsInput();
    else if (match.state === "matched") showMatched(match);
    else if (match.state === "clarify") showClarify(match);
    else showSafetyStop(match);
  }

  function hasRequiredResultTargets(match) {
    if (match.state === "matched") {
      return [match.problemTypeId, ...match.auxiliaryProblemTypeIds]
        .every((problemTypeId) => ROUTE_KEY_SET.has(`${problemTypeId}::${match.agentStageId}`)
          && routeCardByKey.has(`${problemTypeId}::${match.agentStageId}`));
    }
    return match.state !== "safety_stop" || safetyPanelById.has(match.safetySignalId);
  }

  function runMatch() {
    if (!active || destroyed) return;
    if (!payload) {
      showUnavailable();
      return;
    }
    if (clarificationCount === 1) clarificationCount = 2;
    clearTransientMessages();
    let match;
    try {
      const request = {
        query: input.value,
        shortcutIntentId: selectedShortcutIntentId,
        routerData: payload
      };
      const reference = matchRoute(request);
      match = matcher === matchRoute ? reference : matcher(request);
      if (
        !validateMatchResult(reference)
        || !validateMatchResult(match)
        || !matchResultsEqual(match, reference)
        || !hasRequiredResultTargets(match)
      ) {
        showUnavailable();
        return;
      }
    } catch {
      showUnavailable();
      return;
    }
    render(match);
  }

  function resetState() {
    selectedShortcutIntentId = null;
    clarificationCount = 0;
    if (input) input.value = "";
    setShortcutSelection(null);
    if (payload && domReady) showIdle();
    else showUnavailable();
  }

  function handleSubmit(event) {
    event.preventDefault();
    if (!active || destroyed) return;
    runMatch();
  }

  function handleReset() {
    if (!active || destroyed) return;
    generation += 1;
    resetState();
  }

  const shortcutHandlers = shortcutButtons.map((button) => function handleShortcut() {
    if (!active || destroyed || !payload) return;
    const intentId = button.getAttribute("data-shortcut-intent");
    if (!PROBLEM_TYPE_ID_SET.has(intentId)) return;
    if (selectedShortcutIntentId === intentId) {
      runMatch();
      return;
    }
    clearTransientMessages();
    setShortcutSelection(intentId);
    const problemType = payload.problem_types.find(({ id }) => id === intentId);
    hint.textContent = `已选择“${problemType.clarify_label}”，可继续补充后提交`;
  });

  const clarifyHandlers = clarifyButtons.map((button) => function handleClarify() {
    if (!active || destroyed || clarificationCount !== 1 || button.hidden) return;
    const intentId = button.getAttribute("data-clarify-option");
    if (!PROBLEM_TYPE_ID_SET.has(intentId)) return;
    setShortcutSelection(intentId);
    runMatch();
  });

  async function handleCopy() {
    if (!active || destroyed) return;
    generation += 1;
    copyStatus.textContent = "";
    copyButton.textContent = copyButtonLabel;
    const requestGeneration = generation;
    const text = copyText.value ?? copyText.textContent ?? "";
    try {
      const writeText = view.navigator?.clipboard?.writeText;
      if (typeof writeText !== "function") throw new Error("clipboard unavailable");
      await writeText.call(view.navigator.clipboard, text);
      if (!active || destroyed || generation !== requestGeneration) return;
      copyButton.textContent = "已复制";
      copyStatus.textContent = "已复制";
    } catch {
      if (!active || destroyed || generation !== requestGeneration) return;
      copyText.focus();
      copyText.selectionStart = 0;
      copyText.selectionEnd = text.length;
      copyStatus.textContent = "复制失败，请手动复制已选文本";
    }
  }

  function handlePageHide() {
    if (destroyed) return;
    active = false;
    generation += 1;
    resetState();
  }

  function handlePageShow() {
    if (destroyed || !domReady) return;
    active = true;
    generation += 1;
    resetState();
  }

  function reset() {
    handleReset();
  }

  function destroy() {
    if (destroyed) return;
    destroyed = true;
    active = false;
    generation += 1;
    resetState();
    for (const candidate of new Set(forms)) candidate.removeEventListener("submit", handleSubmit);
    if (domReady) {
      form.removeEventListener("reset", handleReset);
      shortcutButtons.forEach((button, index) => button.removeEventListener("click", shortcutHandlers[index]));
      clarifyButtons.forEach((button, index) => button.removeEventListener("click", clarifyHandlers[index]));
      copyButton.removeEventListener("click", handleCopy);
      view.removeEventListener("pagehide", handlePageHide);
      view.removeEventListener("pageshow", handlePageShow);
    }
    if (CONTROLLERS.get(root) === controller) {
      CONTROLLERS.delete(root);
      CONTROLLER_SNAPSHOTS.delete(root);
    }
  }

  const controller = Object.freeze({ reset, destroy });

  for (const candidate of new Set(forms)) candidate.addEventListener("submit", handleSubmit);
  if (domReady) {
    form.addEventListener("reset", handleReset);
    shortcutButtons.forEach((button, index) => button.addEventListener("click", shortcutHandlers[index]));
    clarifyButtons.forEach((button, index) => button.addEventListener("click", clarifyHandlers[index]));
    copyButton.addEventListener("click", handleCopy);
    view.addEventListener("pagehide", handlePageHide);
    view.addEventListener("pageshow", handlePageShow);
  }

  if (payload && domReady) showIdle();
  else showUnavailable();

  CONTROLLERS.set(root, controller);
  CONTROLLER_SNAPSHOTS.set(root, selectorSnapshot);
  return controller;
}

export function bootRouter(root = document) {
  return createRouterController({ root });
}
