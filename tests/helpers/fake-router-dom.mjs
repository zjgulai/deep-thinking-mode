function matchesSelector(node, selector) {
  const match = /^\[([^=\]]+)(?:="([^"]*)")?\]$/u.exec(selector);
  if (!match) throw new Error(`Unsupported fake DOM selector: ${selector}`);
  const [, name, expected] = match;
  const actual = node.getAttribute(name);
  return expected === undefined ? actual !== null : actual === expected;
}

class FakeEventTarget {
  #listeners = new Map();

  addEventListener(type, listener) {
    const listeners = this.#listeners.get(type) ?? [];
    listeners.push(listener);
    this.#listeners.set(type, listeners);
  }

  removeEventListener(type, listener) {
    const listeners = this.#listeners.get(type) ?? [];
    this.#listeners.set(type, listeners.filter((candidate) => candidate !== listener));
  }

  listenerCount(type) {
    return (this.#listeners.get(type) ?? []).length;
  }

  dispatchEvent(event) {
    const dispatched = typeof event === "string" ? { type: event } : event;
    dispatched.target ??= this;
    dispatched.currentTarget = this;
    dispatched.defaultPrevented ??= false;
    dispatched.preventDefault ??= () => { dispatched.defaultPrevented = true; };
    for (const listener of [...(this.#listeners.get(dispatched.type) ?? [])]) listener(dispatched);
    return !dispatched.defaultPrevented;
  }
}

export class FakeRouterNode extends FakeEventTarget {
  constructor({ attributes = {}, children = [], hidden = false, textContent = "", value = "" } = {}) {
    super();
    this.attributes = new Map(Object.entries(attributes));
    this.children = children;
    this.hidden = hidden;
    this.textContent = textContent;
    this.value = value;
    this.focused = false;
    this.scrollCalls = [];
    this.selectionStart = null;
    this.selectionEnd = null;
  }

  querySelector(selector) {
    return this.querySelectorAll(selector)[0] ?? null;
  }

  querySelectorAll(selector) {
    const matches = [];
    const visit = (node) => {
      for (const child of node.children) {
        if (matchesSelector(child, selector)) matches.push(child);
        visit(child);
      }
    };
    visit(this);
    return matches;
  }

  setAttribute(name, value) {
    this.attributes.set(name, String(value));
  }

  getAttribute(name) {
    return this.attributes.has(name) ? this.attributes.get(name) : null;
  }

  focus() {
    this.focused = true;
  }

  scrollIntoView(options) {
    this.scrollCalls.push(options);
  }
}

function node(attribute, value = "", options = {}) {
  return new FakeRouterNode({
    ...options,
    attributes: { [`data-${attribute}`]: value, ...(options.attributes ?? {}) }
  });
}

export function createFakeRouterDom({ payload, payloadNodePresent = true, reducedMotion = false, clipboardWrite, omit = [] } = {}) {
  const input = node("router-input");
  const form = node("router-form");
  const live = node("router-live");
  const hint = node("router-hint");
  const title = node("router-result-title", "", { hidden: true, attributes: { tabindex: "-1" } });
  const examples = node("router-examples");
  const shortcuts = node("router-shortcuts");
  const results = node("router-results", "", { hidden: true });
  const clarify = node("router-clarify", "", { hidden: true });
  const clarifyQuestion = node("router-clarify-question");
  const safety = node("router-safety", "", { hidden: true });
  const unavailable = node("router-unavailable", "", { hidden: true });
  const copyButton = node("router-copy");
  const copyStatus = node("router-copy-status");
  const copyText = node("router-copy-text", "", { value: "结构化提问内容" });
  const routeCards = (payload?.route_keys ?? []).map((routeKey) => node("route-key", routeKey, {
    hidden: true,
    attributes: { "data-initial-kind": "hidden" }
  }));
  const shortcutButtons = ["diagnosis", "planning", "decision", "creative", "research", "reflection", "communication", "clarification"]
    .map((id) => node("shortcut-intent", id, { attributes: { "aria-pressed": "false" } }));
  const clarifyButtons = ["diagnosis", "planning", "decision", "creative", "research", "reflection", "communication", "clarification"]
    .map((id) => node("clarify-option", id, { hidden: true }));
  const safetyPanels = ["high_stakes_financial_instruction", "immediate_personal_danger", "legal_advice_with_deadline", "medical_diagnosis_or_treatment"]
    .map((id) => node("safety-signal", id, { hidden: true }));
  const safetyFacts = node("safety-facts", "", { hidden: true });
  const payloadNode = node("router-payload", "", {
    textContent: payload === undefined ? "" : JSON.stringify(payload)
  });

  const omitSet = new Set(omit);
  const entries = [
    ...(payloadNodePresent ? [["payload", payloadNode]] : []),
    ["form", form],
    ["input", input],
    ["live", live],
    ["hint", hint],
    ["title", title],
    ["examples", examples],
    ["shortcuts", shortcuts],
    ["results", results],
    ["clarify", clarify],
    ["clarifyQuestion", clarifyQuestion],
    ["safety", safety],
    ["safetyFacts", safetyFacts],
    ["unavailable", unavailable],
    ["copyButton", copyButton],
    ["copyStatus", copyStatus],
    ["copyText", copyText],
    ...shortcutButtons.map((button) => [`shortcut:${button.getAttribute("data-shortcut-intent")}`, button]),
    ...clarifyButtons.map((button) => [`clarifyOption:${button.getAttribute("data-clarify-option")}`, button]),
    ...safetyPanels.map((panel) => [`safetyPanel:${panel.getAttribute("data-safety-signal")}`, panel]),
    ...routeCards.map((card) => [`route:${card.getAttribute("data-route-key")}`, card])
  ];
  const root = new FakeRouterNode({ children: entries.filter(([key]) => !omitSet.has(key)).map(([, child]) => child) });
  const view = new FakeEventTarget();
  view.matchMedia = () => ({ matches: reducedMotion });
  view.navigator = {
    clipboard: {
      writeText: clipboardWrite ?? (async () => undefined)
    }
  };
  root.defaultView = view;

  return {
    root,
    view,
    nodes: {
      clarify,
      clarifyButtons,
      clarifyQuestion,
      copyButton,
      copyStatus,
      copyText,
      examples,
      form,
      hint,
      input,
      live,
      payloadNode,
      results,
      routeCards,
      safety,
      safetyFacts,
      safetyPanels,
      shortcutButtons,
      shortcuts,
      title,
      unavailable
    }
  };
}

export function dispatch(node, type) {
  const event = { type, defaultPrevented: false };
  node.dispatchEvent(event);
  return event;
}
