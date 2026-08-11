import { matchRoute } from "./router-engine.mjs";

const SAFETY_SIGNAL_IDS = new Set([
  "high_stakes_financial_instruction",
  "immediate_personal_danger",
  "legal_advice_with_deadline",
  "medical_diagnosis_or_treatment"
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
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isNonEmptyString(value) {
  return typeof value === "string" && value.trim().length > 0;
}

function validWeightedPhrases(value, { allowEmpty = false } = {}) {
  return Array.isArray(value) && value.every((entry) => (
    isRecord(entry)
    && isNonEmptyString(entry.text)
    && Number.isInteger(entry.weight)
    && entry.weight >= 1
    && entry.weight <= 10
  )) && (allowEmpty || value.length > 0);
}

function validProblemType(value) {
  return isRecord(value)
    && isNonEmptyString(value.id)
    && isNonEmptyString(value.label)
    && Number.isInteger(value.priority)
    && value.priority > 0
    && validWeightedPhrases(value.positive_phrases)
    && validWeightedPhrases(value.negative_phrases, { allowEmpty: true })
    && Array.isArray(value.examples)
    && value.examples.length > 0
    && value.examples.every(isNonEmptyString)
    && isNonEmptyString(value.clarify_label);
}

function validAgentStage(value) {
  return isRecord(value)
    && isNonEmptyString(value.id)
    && isNonEmptyString(value.label)
    && Number.isInteger(value.priority)
    && value.priority > 0
    && validWeightedPhrases(value.positive_phrases);
}

function validSafetySignal(value) {
  return isRecord(value)
    && isNonEmptyString(value.id)
    && isNonEmptyString(value.label)
    && isNonEmptyString(value.message)
    && Array.isArray(value.phrases)
    && value.phrases.length > 0
    && value.phrases.every(isNonEmptyString);
}

function hasUniqueIds(values) {
  return new Set(values.map(({ id }) => id)).size === values.length;
}

export function parseRouterPayload(scriptNode) {
  if (!scriptNode || typeof scriptNode.textContent !== "string") return null;
  try {
    const payload = JSON.parse(scriptNode.textContent);
    if (
      !isRecord(payload)
      || payload.schema_version !== "2.0-router"
      || !Array.isArray(payload.problem_types)
      || payload.problem_types.length < 2
      || !payload.problem_types.every(validProblemType)
      || !hasUniqueIds(payload.problem_types)
      || !Array.isArray(payload.agent_stages)
      || payload.agent_stages.length === 0
      || !payload.agent_stages.every(validAgentStage)
      || !hasUniqueIds(payload.agent_stages)
      || !Array.isArray(payload.safety_signals)
      || payload.safety_signals.length !== 4
      || !payload.safety_signals.every(validSafetySignal)
      || !hasUniqueIds(payload.safety_signals)
      || !payload.safety_signals.every(({ id }) => SAFETY_SIGNAL_IDS.has(id))
    ) return null;
    return payload;
  } catch {
    return null;
  }
}

function all(root, selector) {
  return [...root.querySelectorAll(selector)];
}

export function createRouterController({ root, matcher = matchRoute }) {
  const payload = parseRouterPayload(root.querySelector(SELECTORS.payload));
  const form = root.querySelector(SELECTORS.form);
  const input = root.querySelector(SELECTORS.input);
  const live = root.querySelector(SELECTORS.live);
  const hint = root.querySelector(SELECTORS.hint);
  const title = root.querySelector(SELECTORS.title);
  const examples = root.querySelector(SELECTORS.examples);
  const shortcuts = root.querySelector(SELECTORS.shortcuts);
  const results = root.querySelector(SELECTORS.results);
  const clarify = root.querySelector(SELECTORS.clarify);
  const clarifyQuestion = root.querySelector(SELECTORS.clarifyQuestion);
  const safety = root.querySelector(SELECTORS.safety);
  const safetyFacts = root.querySelector(SELECTORS.safetyFacts);
  const unavailable = root.querySelector(SELECTORS.unavailable);
  const copyButton = root.querySelector(SELECTORS.copy);
  const copyStatus = root.querySelector(SELECTORS.copyStatus);
  const copyText = root.querySelector(SELECTORS.copyText);
  const routeCards = all(root, SELECTORS.route);
  const shortcutButtons = all(root, SELECTORS.shortcut);
  const clarifyButtons = all(root, SELECTORS.clarifyOption);
  const safetyPanels = all(root, SELECTORS.safetySignal);
  const view = root.defaultView;
  const copyButtonLabel = copyButton?.textContent ?? "";

  let selectedShortcutIntentId = null;
  let clarificationCount = 0;

  function announce(message) {
    if (live) live.textContent = message;
  }

  function clearTransientMessages() {
    if (hint) hint.textContent = "";
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

  function setShortcutSelection(intentId) {
    selectedShortcutIntentId = intentId;
    for (const button of shortcutButtons) {
      button.setAttribute("aria-pressed", String(button.getAttribute("data-shortcut-intent") === intentId));
    }
  }

  function showIdle({ clearInput = false } = {}) {
    if (clearInput && input) input.value = "";
    if (examples) examples.hidden = false;
    if (shortcuts) shortcuts.hidden = false;
    if (results) results.hidden = true;
    if (title) title.hidden = true;
    if (unavailable) unavailable.hidden = true;
    hideRoutes();
    hideClarification();
    hideSafety();
    clearTransientMessages();
    announce("");
  }

  function showUnavailable() {
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
    if (examples) examples.hidden = false;
    if (shortcuts) shortcuts.hidden = false;
    if (results) results.hidden = true;
    if (title) title.hidden = true;
    hideRoutes();
    hideClarification();
    hideSafety();
    announce("需要补充");
    if (input) input.focus();
  }

  function showMatched(match) {
    if (examples) examples.hidden = true;
    if (shortcuts) shortcuts.hidden = true;
    if (results) results.hidden = false;
    if (title) title.hidden = false;
    hideClarification();
    hideSafety();
    hideRoutes();

    const routeIds = [
      match.problemTypeId,
      ...match.auxiliaryProblemTypeIds.filter((id) => id !== match.problemTypeId).slice(0, 2)
    ];
    let visibleCount = 0;
    for (const [index, problemTypeId] of routeIds.entries()) {
      const exactKey = `${problemTypeId}::${match.agentStageId}`;
      const card = routeCards.find((candidate) => candidate.getAttribute("data-route-key") === exactKey);
      if (!card) continue;
      card.hidden = false;
      card.setAttribute("data-route-kind", index === 0 ? "core" : "auxiliary");
      visibleCount += 1;
    }
    announce(`已匹配 ${visibleCount} 条路径`);
    if (title) {
      title.focus();
      const reducedMotion = view?.matchMedia?.("(prefers-reduced-motion: reduce)").matches === true;
      title.scrollIntoView({ behavior: reducedMotion ? "auto" : "smooth", block: "start" });
    }
  }

  function showClarify(match) {
    if (examples) examples.hidden = true;
    if (results) results.hidden = true;
    if (title) title.hidden = true;
    hideRoutes();
    hideSafety();
    announce("需要澄清");

    if (clarificationCount >= 1) {
      hideClarification();
      if (shortcuts) shortcuts.hidden = false;
      return;
    }

    if (shortcuts) shortcuts.hidden = true;
    if (clarify) clarify.hidden = false;
    if (clarifyQuestion) clarifyQuestion.textContent = "你现在最需要的是找出原因、做出选择，还是制定下一步行动？";
    const optionIds = [...new Set(match.clarificationOptionIds)].slice(0, 4);
    for (const button of clarifyButtons) {
      button.hidden = !optionIds.includes(button.getAttribute("data-clarify-option"));
    }
  }

  function showSafetyStop(match) {
    if (examples) examples.hidden = true;
    if (shortcuts) shortcuts.hidden = true;
    if (results) results.hidden = true;
    if (title) title.hidden = true;
    hideRoutes();
    hideClarification();
    hideSafety();
    if (safety) safety.hidden = false;
    if (safetyFacts) safetyFacts.hidden = false;
    const panel = safetyPanels.find((candidate) => candidate.getAttribute("data-safety-signal") === match.safetySignalId);
    if (panel) panel.hidden = false;
    announce(match.safetySignalId === "immediate_personal_danger"
      ? "已停止自助路由，请优先寻求当地紧急服务或可信赖的人"
      : "已停止自助路由，请寻求相应的专业支持");
  }

  function render(match) {
    if (match.state === "idle") showIdle();
    else if (match.state === "needs_input") showNeedsInput();
    else if (match.state === "matched") showMatched(match);
    else if (match.state === "clarify") showClarify(match);
    else if (match.state === "safety_stop") showSafetyStop(match);
    else showUnavailable();
  }

  function runMatch() {
    if (!payload) {
      showUnavailable();
      return;
    }
    clearTransientMessages();
    render(matcher({
      query: input?.value ?? "",
      shortcutIntentId: selectedShortcutIntentId,
      routerData: payload
    }));
  }

  function reset() {
    selectedShortcutIntentId = null;
    clarificationCount = 0;
    setShortcutSelection(null);
    if (payload) showIdle({ clearInput: true });
    else {
      if (input) input.value = "";
      showUnavailable();
    }
  }

  if (form) {
    form.addEventListener("submit", (event) => {
      event.preventDefault();
      runMatch();
    });
    form.addEventListener("reset", reset);
  }

  for (const button of shortcutButtons) {
    button.addEventListener("click", () => {
      const intentId = button.getAttribute("data-shortcut-intent");
      if (!intentId) return;
      if (selectedShortcutIntentId === intentId) {
        runMatch();
        return;
      }
      setShortcutSelection(intentId);
      const problemType = payload?.problem_types.find(({ id }) => id === intentId);
      if (hint) hint.textContent = `已选择“${problemType?.clarify_label ?? intentId}”，可继续补充后提交`;
    });
  }

  for (const button of clarifyButtons) {
    button.addEventListener("click", () => {
      if (button.hidden || clarificationCount >= 1) return;
      const intentId = button.getAttribute("data-clarify-option");
      if (!intentId) return;
      clarificationCount += 1;
      setShortcutSelection(intentId);
      runMatch();
    });
  }

  if (copyButton) {
    copyButton.addEventListener("click", async () => {
      const text = copyText?.value ?? copyText?.textContent ?? "";
      try {
        const writeText = view?.navigator?.clipboard?.writeText;
        if (typeof writeText !== "function") throw new Error("clipboard unavailable");
        await writeText.call(view.navigator.clipboard, text);
        copyButton.textContent = "已复制";
        if (copyStatus) copyStatus.textContent = "已复制";
      } catch {
        if (copyText) {
          copyText.focus();
          copyText.selectionStart = 0;
          copyText.selectionEnd = text.length;
        }
        if (copyStatus) copyStatus.textContent = "复制失败，请手动复制已选文本";
      }
    });
  }

  view?.addEventListener?.("pagehide", reset);
  if (payload) showIdle();
  else showUnavailable();

  return Object.freeze({ reset });
}

export function bootRouter(root = document) {
  return createRouterController({ root });
}
