import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import {
  bootRouter,
  createRouterController,
  parseRouterPayload
} from "../tools/site-assets/router-controller.mjs";
import { matchRoute } from "../tools/site-assets/router-engine.mjs";
import {
  FakeRouterNode,
  createFakeRouterDom,
  dispatch
} from "./helpers/fake-router-dom.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const ROUTER_SOURCE = JSON.parse(await readFile(join(ROOT, "chain-protocols/agent-router-index.json"), "utf8"));
const GOLDEN_CASES = JSON.parse(await readFile(join(ROOT, "tests/fixtures/router/router-golden-cases.json"), "utf8"));
const ROUTER_DATA = {
  schema_version: ROUTER_SOURCE.schema_version,
  problem_types: ROUTER_SOURCE.problem_types,
  agent_stages: ROUTER_SOURCE.agent_stages,
  safety_signals: ROUTER_SOURCE.safety_signals,
  route_keys: ROUTER_SOURCE.routes.map(({ problem_type_id: problemTypeId, agent_stage_id: agentStageId }) => `${problemTypeId}::${agentStageId}`)
};

function clone(value) {
  return structuredClone(value);
}

function payloadNode(payload) {
  return new FakeRouterNode({ textContent: JSON.stringify(payload) });
}

function result(state, overrides = {}) {
  return {
    state,
    problemTypeId: null,
    auxiliaryProblemTypeIds: [],
    agentStageId: null,
    evidence: {
      matchedPositivePhrases: [],
      matchedNegativePhrases: [],
      closestExample: null,
      shortcutIntentId: null
    },
    clarificationOptionIds: [],
    safetySignalId: null,
    ...overrides
  };
}

function controllerFixture(options = {}) {
  const dom = createFakeRouterDom({ payload: ROUTER_DATA, ...options });
  const calls = [];
  const respond = options.matcher ?? (() => result("needs_input"));
  const matcher = (request) => {
    calls.push(request);
    return respond(request);
  };
  const controller = createRouterController({ root: dom.root, matcher });
  return { ...dom, calls, controller };
}

function visibleRouteKeys(nodes) {
  return nodes.routeCards
    .filter((card) => !card.hidden)
    .map((card) => card.getAttribute("data-route-key"));
}

test("parseRouterPayload accepts the real compact 8x8x4 Router payload", () => {
  assert.equal(ROUTER_DATA.problem_types.length, 8);
  assert.equal(ROUTER_DATA.agent_stages.length, 8);
  assert.equal(ROUTER_DATA.safety_signals.length, 4);
  assert.equal(ROUTER_DATA.route_keys.length, 23);
  assert.deepEqual(parseRouterPayload(payloadNode(ROUTER_DATA)), ROUTER_DATA);
});

test("parseRouterPayload rejects missing, extra, and prototype-looking keys at every schema level", () => {
  const cases = [];
  const missingTop = clone(ROUTER_DATA);
  delete missingTop.route_keys;
  cases.push(missingTop, { ...ROUTER_DATA, extra: true });
  for (const [collection, index] of [["problem_types", 0], ["agent_stages", 0], ["safety_signals", 0]]) {
    const extra = clone(ROUTER_DATA);
    extra[collection][index].extra = true;
    cases.push(extra);
  }
  const extraPhrase = clone(ROUTER_DATA);
  extraPhrase.problem_types[0].positive_phrases[0].extra = true;
  cases.push(extraPhrase);
  const protoText = JSON.stringify(ROUTER_DATA).replace("{", "{\"__proto__\":{},");

  for (const invalid of [null, new FakeRouterNode({ textContent: "{" }), ...cases.map(payloadNode), new FakeRouterNode({ textContent: protoText })]) {
    assert.equal(parseRouterPayload(invalid), null);
  }
});

test("parseRouterPayload freezes canonical IDs, counts, ordering, priorities, and route keys", () => {
  const mutations = [];
  for (const collection of ["problem_types", "agent_stages", "safety_signals", "route_keys"]) {
    const reversed = clone(ROUTER_DATA);
    reversed[collection].reverse();
    mutations.push(reversed);
  }
  const wrongProblemId = clone(ROUTER_DATA);
  wrongProblemId.problem_types[0].id = "unknown";
  const duplicateProblemId = clone(ROUTER_DATA);
  duplicateProblemId.problem_types[1].id = duplicateProblemId.problem_types[0].id;
  const wrongProblemPriority = clone(ROUTER_DATA);
  wrongProblemPriority.problem_types[0].priority = 11;
  const wrongStageId = clone(ROUTER_DATA);
  wrongStageId.agent_stages[0].id = "unknown";
  const wrongStagePriority = clone(ROUTER_DATA);
  wrongStagePriority.agent_stages[0].priority = 11;
  const wrongSafetyId = clone(ROUTER_DATA);
  wrongSafetyId.safety_signals[0].id = "unknown";
  const wrongRoute = clone(ROUTER_DATA);
  wrongRoute.route_keys[0] = "diagnosis::unknown";
  mutations.push(wrongProblemId, duplicateProblemId, wrongProblemPriority, wrongStageId, wrongStagePriority, wrongSafetyId, wrongRoute);

  for (const payload of mutations) assert.equal(parseRouterPayload(payloadNode(payload)), null);
});

test("parseRouterPayload rejects duplicate, intersecting, empty, or out-of-range phrases", () => {
  const duplicatePositive = clone(ROUTER_DATA);
  duplicatePositive.problem_types[0].positive_phrases.push(clone(duplicatePositive.problem_types[0].positive_phrases[0]));
  const duplicateNegative = clone(ROUTER_DATA);
  duplicateNegative.problem_types[0].negative_phrases.push(clone(duplicateNegative.problem_types[0].negative_phrases[0]));
  const intersecting = clone(ROUTER_DATA);
  intersecting.problem_types[0].negative_phrases.push(clone(intersecting.problem_types[0].positive_phrases[0]));
  const emptyText = clone(ROUTER_DATA);
  emptyText.problem_types[0].positive_phrases[0].text = "";
  const badWeight = clone(ROUTER_DATA);
  badWeight.problem_types[0].positive_phrases[0].weight = 11;
  const duplicateExample = clone(ROUTER_DATA);
  duplicateExample.problem_types[0].examples.push(duplicateExample.problem_types[0].examples[0]);
  const duplicateSafetyPhrase = clone(ROUTER_DATA);
  duplicateSafetyPhrase.safety_signals[0].phrases.push(duplicateSafetyPhrase.safety_signals[0].phrases[0]);
  const normalizedDuplicate = clone(ROUTER_DATA);
  normalizedDuplicate.problem_types[0].positive_phrases.push({ text: "原 因", weight: 8 });
  const normalizedIntersection = clone(ROUTER_DATA);
  normalizedIntersection.problem_types[0].negative_phrases.push({ text: "原 因", weight: 8 });
  const normalizedSafetyDuplicate = clone(ROUTER_DATA);
  normalizedSafetyDuplicate.safety_signals[0].phrases.push("把 全部积蓄马上买入");

  for (const payload of [
    duplicatePositive,
    duplicateNegative,
    intersecting,
    emptyText,
    badWeight,
    duplicateExample,
    duplicateSafetyPhrase,
    normalizedDuplicate,
    normalizedIntersection,
    normalizedSafetyDuplicate
  ]) {
    assert.equal(parseRouterPayload(payloadNode(payload)), null);
  }
});

test("initialization is idle with examples and shortcuts visible while every result surface is hidden", () => {
  const { nodes, calls } = controllerFixture();
  assert.equal(nodes.examples.hidden, false);
  assert.equal(nodes.shortcuts.hidden, false);
  assert.equal(nodes.results.hidden, true);
  assert.equal(nodes.clarify.hidden, true);
  assert.equal(nodes.safety.hidden, true);
  assert.equal(nodes.title.hidden, true);
  assert.ok(nodes.routeCards.every((card) => card.hidden));
  assert.equal(nodes.live.textContent, "");
  assert.equal(calls.length, 0);
});

test("empty or one-character submissions enter needs_input, keep input focus, and never scroll", () => {
  for (const query of ["", "！", "a"]) {
    const { nodes } = controllerFixture({ matcher: () => result("needs_input") });
    nodes.input.value = query;
    const event = dispatch(nodes.form, "submit");
    assert.equal(event.defaultPrevented, true);
    assert.equal(nodes.live.textContent, "需要补充");
    assert.equal(nodes.input.focused, true);
    assert.equal(nodes.title.scrollCalls.length, 0);
  }
});

test("matched shows one exact core route and at most two exact auxiliary routes, then focuses and scrolls the title", () => {
  const { nodes } = controllerFixture({ matcher: matchRoute });
  nodes.input.value = "研究两个方案后做出选择和取舍";
  dispatch(nodes.form, "submit");

  assert.deepEqual(
    visibleRouteKeys(nodes),
    ["planning::intent", "decision::intent", "research::intent"]
  );
  assert.deepEqual(
    nodes.routeCards.filter((card) => !card.hidden).map((card) => card.getAttribute("data-route-kind")),
    ["auxiliary", "core", "auxiliary"]
  );
  assert.equal(nodes.routeCards.find((card) => card.getAttribute("data-route-key") === "diagnosis::cot_step").hidden, true);
  assert.equal(nodes.live.textContent, "已匹配 3 条路径");
  assert.equal(nodes.title.focused, true);
  assert.deepEqual(nodes.title.scrollCalls, [{ behavior: "smooth", block: "start" }]);
});

test("matched respects reduced motion by using auto scrolling", () => {
  const { nodes } = controllerFixture({
    reducedMotion: true,
    matcher: matchRoute
  });
  nodes.input.value = "需要制定计划，把任务排优先级";
  dispatch(nodes.form, "submit");
  assert.deepEqual(nodes.title.scrollCalls, [{ behavior: "auto", block: "start" }]);
});

test("clarify shows the canonical options and one button answer reruns exactly once", () => {
  const { nodes, calls } = controllerFixture({ matcher: matchRoute });
  nodes.input.value = "有点乱";
  dispatch(nodes.form, "submit");

  assert.equal(nodes.live.textContent, "需要澄清");
  assert.deepEqual(nodes.clarifyButtons.filter((button) => !button.hidden).map((button) => button.getAttribute("data-clarify-option")), ["diagnosis", "planning"]);
  dispatch(nodes.clarifyButtons[1], "click");
  assert.equal(calls.length, 2);
  assert.equal(calls[1].shortcutIntentId, "planning");
  assert.equal(nodes.clarify.hidden, true);
  assert.deepEqual(visibleRouteKeys(nodes), ["planning::intent"]);

  dispatch(nodes.clarifyButtons[0], "click");
  assert.equal(calls.length, 2);
});

test("a second consecutive submit after clarify falls back to shortcuts instead of asking again", () => {
  const { nodes, calls } = controllerFixture({
    matcher: () => result("clarify", { agentStageId: "intent", clarificationOptionIds: ["diagnosis", "planning"] })
  });
  nodes.input.value = "需要帮助";
  dispatch(nodes.form, "submit");
  assert.equal(nodes.clarify.hidden, false);
  assert.equal(nodes.clarifyButtons.filter((button) => !button.hidden).length, 2);

  nodes.input.value = "再补充一点背景";
  dispatch(nodes.form, "submit");
  assert.equal(calls.length, 2);
  assert.equal(nodes.clarify.hidden, true);
  assert.equal(nodes.shortcuts.hidden, false);
});

test("safety_stop hides every route and chain surface and exposes only its boundary plus the facts checklist", () => {
  const { nodes } = controllerFixture({
    matcher: () => result("safety_stop", { safetySignalId: "immediate_personal_danger" })
  });
  nodes.input.value = "我正在伤害自己";
  dispatch(nodes.form, "submit");

  assert.equal(nodes.live.textContent, "已停止自助路由，请优先寻求当地紧急服务或可信赖的人");
  assert.equal(nodes.results.hidden, true);
  assert.ok(nodes.routeCards.every((card) => card.hidden));
  assert.equal(nodes.safety.hidden, false);
  assert.equal(nodes.safetyFacts.hidden, false);
  assert.deepEqual(nodes.safetyPanels.filter((panel) => !panel.hidden).map((panel) => panel.getAttribute("data-safety-signal")), ["immediate_personal_danger"]);
});

test("a shortcut selects on first click and matches on a second click or later submit", () => {
  const { nodes, calls } = controllerFixture({
    matcher: (request) => result("matched", {
      problemTypeId: request.shortcutIntentId,
      agentStageId: "intent",
      evidence: { ...result("idle").evidence, shortcutIntentId: request.shortcutIntentId }
    })
  });
  const planning = nodes.shortcutButtons[1];
  dispatch(planning, "click");
  assert.equal(planning.getAttribute("aria-pressed"), "true");
  assert.equal(nodes.hint.textContent, "已选择“我想规划下一步”，可继续补充后提交");
  assert.equal(nodes.live.textContent, "");
  assert.equal(calls.length, 0);

  dispatch(planning, "click");
  assert.equal(calls.length, 1);
  assert.equal(calls[0].shortcutIntentId, "planning");

  const second = controllerFixture({
    matcher: (request) => result("matched", {
      problemTypeId: request.shortcutIntentId,
      agentStageId: "intent",
      evidence: { ...result("idle").evidence, shortcutIntentId: request.shortcutIntentId }
    })
  });
  dispatch(second.nodes.shortcutButtons[0], "click");
  second.nodes.input.value = "还有背景";
  dispatch(second.nodes.form, "submit");
  assert.equal(second.calls.length, 1);
  assert.equal(second.calls[0].shortcutIntentId, "diagnosis");
});

test("reset and pagehide clear input, shortcut state, clarification state, and visible results", () => {
  const { nodes, view, calls } = controllerFixture({ matcher: matchRoute });
  nodes.input.value = "有点乱";
  dispatch(nodes.form, "submit");
  assert.equal(nodes.clarify.hidden, false);
  dispatch(nodes.form, "reset");
  assert.equal(nodes.input.value, "");
  assert.ok(nodes.shortcutButtons.every((button) => button.getAttribute("aria-pressed") === "false"));
  assert.equal(nodes.examples.hidden, false);
  assert.equal(nodes.results.hidden, true);

  dispatch(nodes.shortcutButtons[1], "click");
  dispatch(nodes.form, "reset");
  assert.ok(nodes.shortcutButtons.every((button) => button.getAttribute("aria-pressed") === "false"));

  nodes.input.value = "有点乱";
  dispatch(nodes.form, "submit");
  assert.equal(nodes.clarify.hidden, false);
  dispatch(nodes.clarifyButtons[0], "click");
  assert.equal(calls.length, 3);
  view.dispatchEvent("pagehide");
  assert.equal(nodes.input.value, "");
  assert.ok(nodes.routeCards.every((card) => card.hidden));
  assert.ok(nodes.shortcutButtons.every((button) => button.getAttribute("aria-pressed") === "false"));

  view.dispatchEvent("pageshow");
  nodes.input.value = "有点乱";
  dispatch(nodes.form, "submit");
  assert.equal(nodes.clarify.hidden, false);
  dispatch(nodes.clarifyButtons[0], "click");
  assert.equal(calls.length, 5);
});

test("missing, broken, or invalid payload fails closed without invoking the matcher", () => {
  for (const payloadText of [null, "{", JSON.stringify({ schema_version: "2.0-router", problem_types: [] })]) {
    const dom = createFakeRouterDom({ payload: ROUTER_DATA, payloadNodePresent: payloadText !== null });
    if (payloadText !== null) dom.nodes.payloadNode.textContent = payloadText;
    let calls = 0;
    createRouterController({ root: dom.root, matcher: () => { calls += 1; return result("matched"); } });
    dom.nodes.input.value = "有效输入";
    dispatch(dom.nodes.form, "submit");
    assert.equal(calls, 0);
    assert.equal(dom.nodes.unavailable.hidden, false);
    assert.equal(dom.nodes.live.textContent, "路由数据不可用");
    dispatch(dom.nodes.form, "reset");
    assert.equal(dom.nodes.unavailable.hidden, false);
    assert.equal(dom.nodes.shortcuts.hidden, true);
    dom.view.dispatchEvent("pagehide");
    assert.equal(dom.nodes.unavailable.hidden, false);
    assert.equal(dom.nodes.live.textContent, "路由数据不可用");
  }
});

test("missing required DOM or frozen option collections stays inert and never calls matcher", () => {
  const omissions = [
    "form", "input", "live", "hint", "title", "examples", "shortcuts", "results", "clarify",
    "clarifyQuestion", "safety", "safetyFacts", "unavailable", "copyButton", "copyStatus", "copyText",
    "shortcut:clarification", "clarifyOption:clarification", "safetyPanel:medical_diagnosis_or_treatment",
    "route:diagnosis::intent"
  ];
  for (const omitted of omissions) {
    const dom = createFakeRouterDom({ payload: ROUTER_DATA, omit: [omitted] });
    let calls = 0;
    const controller = createRouterController({ root: dom.root, matcher: () => { calls += 1; return result("matched"); } });
    const submitEvent = dispatch(dom.nodes.form, "submit");
    assert.equal(submitEvent.defaultPrevented, omitted !== "form", omitted);
    assert.doesNotThrow(() => dispatch(dom.nodes.shortcutButtons[0], "click"), omitted);
    assert.equal(calls, 0, omitted);
    if (omitted !== "unavailable") assert.equal(dom.nodes.unavailable.hidden, false, omitted);
    assert.ok(controller);
  }
});

test("duplicate frozen shortcut, clarify, safety, or route nodes fail closed before binding", () => {
  for (const collection of ["shortcutButtons", "clarifyButtons", "safetyPanels", "routeCards"]) {
    const dom = createFakeRouterDom({ payload: ROUTER_DATA });
    dom.root.children.push(dom.nodes[collection][0]);
    let calls = 0;
    createRouterController({ root: dom.root, matcher: () => { calls += 1; return result("matched"); } });
    dispatch(dom.nodes.form, "submit");
    assert.equal(calls, 0, collection);
    assert.equal(dom.nodes.unavailable.hidden, false, collection);
  }
});

test("every required singleton must appear exactly once and every form still blocks native submit", () => {
  const singletonNames = [
    "payloadNode", "form", "input", "live", "hint", "title", "examples", "shortcuts", "results",
    "clarify", "clarifyQuestion", "safety", "safetyFacts", "unavailable", "copyButton", "copyStatus", "copyText"
  ];
  for (const singletonName of singletonNames) {
    const dom = createFakeRouterDom({ payload: ROUTER_DATA });
    const original = dom.nodes[singletonName];
    const duplicate = new FakeRouterNode({
      attributes: Object.fromEntries(original.attributes),
      hidden: original.hidden,
      textContent: original.textContent,
      value: original.value
    });
    dom.root.children.push(duplicate);
    let calls = 0;
    createRouterController({ root: dom.root, matcher: () => { calls += 1; return result("needs_input"); } });
    const firstSubmit = dispatch(dom.nodes.form, "submit");
    assert.equal(firstSubmit.defaultPrevented, true, singletonName);
    if (singletonName === "form") {
      const secondSubmit = dispatch(duplicate, "submit");
      assert.equal(secondSubmit.defaultPrevented, true, "second form");
    }
    assert.equal(calls, 0, singletonName);
    assert.equal(dom.nodes.unavailable.hidden, false, singletonName);
  }
});

test("required singleton selectors cannot alias the same DOM node", () => {
  const dom = createFakeRouterDom({ payload: ROUTER_DATA });
  dom.root.children = dom.root.children.filter((child) => child !== dom.nodes.input);
  dom.nodes.form.setAttribute("data-router-input", "");
  let calls = 0;
  createRouterController({ root: dom.root, matcher: () => { calls += 1; return result("needs_input"); } });
  const submitEvent = dispatch(dom.nodes.form, "submit");
  assert.equal(submitEvent.defaultPrevented, true);
  assert.equal(calls, 0);
  assert.equal(dom.nodes.unavailable.hidden, false);
});

test("contract nodes cannot alias across singleton, shortcut, clarify, safety, and route collections", () => {
  const aliases = [
    {
      label: "form aliases diagnosis shortcut",
      apply(dom) {
        const shortcut = dom.nodes.shortcutButtons[0];
        dom.root.children = dom.root.children.filter((child) => child !== shortcut);
        dom.nodes.form.setAttribute("data-shortcut-intent", "diagnosis");
      }
    },
    {
      label: "diagnosis shortcut aliases diagnosis clarification",
      apply(dom) {
        const clarifyButton = dom.nodes.clarifyButtons[0];
        dom.root.children = dom.root.children.filter((child) => child !== clarifyButton);
        dom.nodes.shortcutButtons[0].setAttribute("data-clarify-option", "diagnosis");
      }
    },
    {
      label: "first safety panel aliases first route card",
      apply(dom) {
        const routeCard = dom.nodes.routeCards[0];
        dom.root.children = dom.root.children.filter((child) => child !== routeCard);
        dom.nodes.safetyPanels[0].setAttribute("data-route-key", "diagnosis::intent");
      }
    }
  ];

  for (const alias of aliases) {
    const dom = createFakeRouterDom({ payload: ROUTER_DATA });
    alias.apply(dom);
    let calls = 0;
    createRouterController({
      root: dom.root,
      matcher: (request) => {
        calls += 1;
        return matchRoute(request);
      }
    });
    dom.nodes.input.value = "为什么失败了";
    const submitEvent = dispatch(dom.nodes.form, "submit");
    assert.equal(submitEvent.defaultPrevented, true, alias.label);
    assert.equal(calls, 0, alias.label);
    assert.equal(dom.nodes.unavailable.hidden, false, alias.label);
  }
});

test("matcher throws and malformed frozen results fail closed without leaking partial UI", () => {
  const malformed = [
    null,
    { ...result("needs_input"), extra: true },
    (() => { const value = result("needs_input"); delete value.auxiliaryProblemTypeIds; return value; })(),
    { ...result("unknown") },
    result("needs_input", { problemTypeId: "diagnosis" }),
    result("matched", { problemTypeId: "unknown", agentStageId: "intent" }),
    result("matched", { problemTypeId: "diagnosis", auxiliaryProblemTypeIds: ["planning", "planning"], agentStageId: "intent" }),
    result("matched", { problemTypeId: "diagnosis", auxiliaryProblemTypeIds: ["planning", "decision", "creative"], agentStageId: "intent" }),
    result("matched", { problemTypeId: "diagnosis", auxiliaryProblemTypeIds: [], agentStageId: "unknown" }),
    result("matched", { problemTypeId: "diagnosis", auxiliaryProblemTypeIds: [], agentStageId: "intent" }),
    result("matched", {
      problemTypeId: "diagnosis",
      auxiliaryProblemTypeIds: [],
      agentStageId: "intent",
      evidence: { ...result("idle").evidence, shortcutIntentId: "diagnosis" }
    }),
    result("matched", {
      problemTypeId: "diagnosis",
      auxiliaryProblemTypeIds: [],
      agentStageId: "planning",
      evidence: { ...result("idle").evidence, matchedPositivePhrases: ["原因"] }
    }),
    result("clarify", { agentStageId: "intent", clarificationOptionIds: ["diagnosis"] }),
    result("clarify", { agentStageId: "intent", clarificationOptionIds: ["diagnosis", "unknown"] }),
    result("safety_stop", { safetySignalId: "unknown" }),
    { ...result("needs_input"), evidence: { ...result("needs_input").evidence, extra: true } }
  ];

  for (const response of malformed) {
    const { nodes, calls } = controllerFixture({ matcher: () => response });
    nodes.input.value = "有效输入";
    assert.doesNotThrow(() => dispatch(nodes.form, "submit"));
    assert.equal(calls.length, 1);
    assert.equal(nodes.unavailable.hidden, false);
    assert.equal(nodes.results.hidden, true);
    assert.equal(nodes.safety.hidden, true);
    assert.ok(nodes.routeCards.every((card) => card.hidden));
  }

  const throwing = controllerFixture({ matcher: () => { throw new Error("matcher failed"); } });
  throwing.nodes.input.value = "有效输入";
  assert.doesNotThrow(() => dispatch(throwing.nodes.form, "submit"));
  assert.equal(throwing.calls.length, 1);
  assert.equal(throwing.nodes.unavailable.hidden, false);
});

test("matched fails closed when known IDs do not resolve to every declared exact route key", () => {
  const { nodes, calls } = controllerFixture({
    matcher: () => result("matched", {
      problemTypeId: "diagnosis",
      auxiliaryProblemTypeIds: ["planning"],
      agentStageId: "cot_step",
      evidence: { ...result("idle").evidence, shortcutIntentId: "diagnosis" }
    })
  });
  dispatch(nodes.shortcutButtons[0], "click");
  dispatch(nodes.shortcutButtons[0], "click");
  assert.equal(calls.length, 1);
  assert.equal(nodes.unavailable.hidden, false);
  assert.ok(nodes.routeCards.every((card) => card.hidden));
  assert.equal(nodes.live.textContent, "路由数据不可用");
});

test("matched requires shortcut evidence exactly when the selected shortcut becomes core", () => {
  const { nodes, calls } = controllerFixture({
    matcher: () => result("matched", {
      problemTypeId: "diagnosis",
      auxiliaryProblemTypeIds: [],
      agentStageId: "intent",
      evidence: { ...result("idle").evidence, matchedPositivePhrases: ["为什么", "失败了"] }
    })
  });
  dispatch(nodes.shortcutButtons[0], "click");
  nodes.input.value = "为什么失败了";
  dispatch(nodes.form, "submit");
  assert.equal(calls.length, 1);
  assert.equal(nodes.unavailable.hidden, false);
  assert.ok(nodes.routeCards.every((card) => card.hidden));
});

test("matched evidence must exactly equal the engine score entry for the current request", () => {
  const exactEvidence = {
    matchedPositivePhrases: ["为什么", "失败了"],
    matchedNegativePhrases: [],
    closestExample: null,
    shortcutIntentId: null
  };
  const injectedNegative = { ...exactEvidence, matchedNegativePhrases: ["不需要找出原因"] };
  const injectedExample = { ...exactEvidence, closestExample: ROUTER_DATA.problem_types[0].examples[0] };
  const reversedPositiveOrder = { ...exactEvidence, matchedPositivePhrases: ["失败了", "为什么"] };

  for (const evidence of [injectedNegative, injectedExample, reversedPositiveOrder]) {
    const { nodes } = controllerFixture({
      matcher: () => result("matched", {
        problemTypeId: "diagnosis",
        auxiliaryProblemTypeIds: [],
        agentStageId: "intent",
        evidence
      })
    });
    nodes.input.value = "为什么失败了";
    dispatch(nodes.form, "submit");
    assert.equal(nodes.unavailable.hidden, false);
    assert.ok(nodes.routeCards.every((card) => card.hidden));
  }
});

test("injected matcher results must equal the canonical engine result for the whole request", () => {
  const cases = [
    {
      label: "8:8 ambiguity forged as matched",
      query: "需要创新计划",
      mutate: () => result("matched", {
        problemTypeId: "planning",
        agentStageId: "intent",
        evidence: { ...result("idle").evidence, matchedPositivePhrases: ["计划"] }
      })
    },
    {
      label: "canonical auxiliary route omitted",
      query: "这两个方案我该不该继续",
      mutate: (reference) => ({ ...reference, auxiliaryProblemTypeIds: [] })
    },
    {
      label: "canonical auxiliary route forged",
      query: "这两个方案我该不该继续",
      mutate: (reference) => ({ ...reference, auxiliaryProblemTypeIds: ["diagnosis"] })
    },
    {
      label: "route-aware resolved stage changed",
      query: "总结这轮工作",
      mutate: (reference) => ({ ...reference, agentStageId: "synthesis" })
    },
    {
      label: "canonical evidence changed",
      query: "为什么失败了",
      mutate: (reference) => ({
        ...reference,
        evidence: { ...reference.evidence, closestExample: ROUTER_DATA.problem_types[0].examples[0] }
      })
    },
    {
      label: "clarification order changed",
      query: "有点乱",
      mutate: (reference) => ({ ...reference, clarificationOptionIds: [...reference.clarificationOptionIds].reverse() })
    },
    {
      label: "safety boundary changed",
      query: "我正在伤害自己",
      mutate: (reference) => ({ ...reference, safetySignalId: "medical_diagnosis_or_treatment" })
    }
  ];

  for (const { label, query, mutate } of cases) {
    const reference = matchRoute({ query, shortcutIntentId: null, routerData: ROUTER_DATA });
    const { nodes } = controllerFixture({ matcher: () => mutate(reference) });
    nodes.input.value = query;
    dispatch(nodes.form, "submit");
    assert.equal(nodes.unavailable.hidden, false, label);
    assert.ok(nodes.routeCards.every((card) => card.hidden), label);
    assert.equal(nodes.safety.hidden, true, label);
  }
});

test("real compact payload renders all 96 golden engine cases without rejecting canonical matches", () => {
  let matchedCount = 0;
  let matchedUnavailableCount = 0;
  const productionRegressionIds = new Set();

  for (const goldenCase of GOLDEN_CASES) {
    const dom = createFakeRouterDom({ payload: ROUTER_DATA });
    const controller = createRouterController({ root: dom.root });
    dom.nodes.input.value = goldenCase.input;
    dispatch(dom.nodes.form, "submit");

    if (goldenCase.expected_state === "matched") {
      matchedCount += 1;
      if (!dom.nodes.unavailable.hidden) matchedUnavailableCount += 1;
      assert.ok(
        visibleRouteKeys(dom.nodes).includes(`${goldenCase.expected_problem_type_id}::${goldenCase.expected_agent_stage_id}`),
        goldenCase.id
      );
    } else if (goldenCase.expected_state === "clarify") {
      assert.equal(dom.nodes.clarify.hidden, false, goldenCase.id);
    } else {
      assert.equal(dom.nodes.safety.hidden, false, goldenCase.id);
    }

    if (goldenCase.id.startsWith("production-regression-")) productionRegressionIds.add(goldenCase.id);
    if (goldenCase.id === "production-regression-05") {
      assert.ok(visibleRouteKeys(dom.nodes).includes("communication::synthesis"));
    }
    controller.destroy();
  }

  assert.equal(GOLDEN_CASES.length, 96);
  assert.equal(matchedCount, 80);
  assert.equal(matchedUnavailableCount, 0);
  assert.equal(productionRegressionIds.size, 7);
});

test("a non-clarify terminal result starts a fresh clarification round", () => {
  const terminals = [
    { label: "matched", query: "为什么失败了" },
    { label: "safety_stop", query: "我正在伤害自己" },
    { label: "unavailable", query: "有效输入", invalid: true },
    { label: "needs_input", query: "a" }
  ];

  for (const terminal of terminals) {
    let injectInvalid = false;
    const { nodes, calls } = controllerFixture({
      matcher: (request) => {
        if (injectInvalid) {
          injectInvalid = false;
          return null;
        }
        return matchRoute(request);
      }
    });
    nodes.input.value = "有点乱";
    dispatch(nodes.form, "submit");
    assert.equal(nodes.clarify.hidden, false, terminal.label);
    nodes.input.value = terminal.query;
    injectInvalid = terminal.invalid === true;
    dispatch(nodes.form, "submit");
    nodes.input.value = "有点乱";
    dispatch(nodes.form, "submit");
    assert.equal(calls.length, 3);
    assert.equal(nodes.clarify.hidden, false, terminal.label);
    assert.equal(nodes.clarifyButtons.filter((button) => !button.hidden).length, 2);
    assert.equal(nodes.shortcuts.hidden, true);
  }
});

test("normal states hide unavailable and remain mutually exclusive across matched, safety, invalid, and needs_input", () => {
  let injectInvalid = false;
  const { nodes } = controllerFixture({
    matcher: (request) => injectInvalid ? null : matchRoute(request)
  });
  nodes.input.value = "这两个方案我该不该继续";

  dispatch(nodes.form, "submit");
  assert.equal(nodes.unavailable.hidden, true);
  assert.equal(nodes.results.hidden, false);
  assert.equal(nodes.routeCards.filter((card) => !card.hidden).length, 2);

  nodes.input.value = "我正在伤害自己";
  dispatch(nodes.form, "submit");
  assert.equal(nodes.unavailable.hidden, true);
  assert.equal(nodes.results.hidden, true);
  assert.equal(nodes.safety.hidden, false);
  assert.ok(nodes.routeCards.every((card) => card.hidden));

  injectInvalid = true;
  dispatch(nodes.form, "submit");
  assert.equal(nodes.unavailable.hidden, false);
  assert.equal(nodes.safety.hidden, true);
  assert.ok(nodes.routeCards.every((card) => card.hidden));

  injectInvalid = false;
  nodes.input.value = "a";
  dispatch(nodes.form, "submit");
  assert.equal(nodes.unavailable.hidden, true);
  assert.equal(nodes.results.hidden, true);
  assert.equal(nodes.safety.hidden, true);
  assert.ok(nodes.routeCards.every((card) => card.hidden));
});

test("copy success reports completion while failure focuses and selects the complete fallback text", async () => {
  const successWrites = [];
  const success = controllerFixture({ clipboardWrite: async (text) => { successWrites.push(text); } });
  dispatch(success.nodes.copyButton, "click");
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(successWrites, ["结构化提问内容"]);
  assert.equal(success.nodes.copyButton.textContent, "已复制");
  assert.equal(success.nodes.copyStatus.textContent, "已复制");
  assert.equal(success.nodes.live.textContent, "");

  const failure = controllerFixture({ clipboardWrite: async () => { throw new Error("denied"); } });
  dispatch(failure.nodes.copyButton, "click");
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(failure.nodes.copyText.focused, true);
  assert.equal(failure.nodes.copyText.selectionStart, 0);
  assert.equal(failure.nodes.copyText.selectionEnd, failure.nodes.copyText.value.length);
  assert.equal(failure.nodes.copyStatus.textContent, "复制失败，请手动复制已选文本");
  assert.equal(failure.nodes.live.textContent, "");
});

test("pagehide deactivates handlers and pageshow reactivates a clean controller", () => {
  const { nodes, view, calls } = controllerFixture({ matcher: matchRoute });
  nodes.input.value = "离页前输入";
  view.dispatchEvent("pagehide");
  assert.equal(nodes.input.value, "");
  nodes.input.value = "不应执行";
  const inactiveSubmit = dispatch(nodes.form, "submit");
  assert.equal(inactiveSubmit.defaultPrevented, true);
  dispatch(nodes.shortcutButtons[0], "click");
  assert.equal(calls.length, 0);
  assert.equal(nodes.shortcutButtons[0].getAttribute("aria-pressed"), "false");

  view.dispatchEvent("pageshow");
  assert.equal(nodes.input.value, "");
  nodes.input.value = "可以再次执行";
  dispatch(nodes.form, "submit");
  assert.equal(calls.length, 1);
});

test("deferred clipboard completion cannot mutate or focus after pagehide or destroy", async () => {
  let resolveCopy;
  const pendingCopy = new Promise((resolve) => { resolveCopy = resolve; });
  const pageHidden = controllerFixture({ clipboardWrite: () => pendingCopy });
  dispatch(pageHidden.nodes.copyButton, "click");
  pageHidden.view.dispatchEvent("pagehide");
  pageHidden.view.dispatchEvent("pageshow");
  resolveCopy();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(pageHidden.nodes.copyStatus.textContent, "");
  assert.equal(pageHidden.nodes.copyButton.textContent, "");
  assert.equal(pageHidden.nodes.copyText.focused, false);

  let rejectCopy;
  const rejectedCopy = new Promise((resolve, reject) => { rejectCopy = reject; });
  const destroyed = controllerFixture({ clipboardWrite: () => rejectedCopy });
  dispatch(destroyed.nodes.copyButton, "click");
  destroyed.controller.destroy();
  rejectCopy(new Error("denied later"));
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(destroyed.nodes.copyStatus.textContent, "");
  assert.equal(destroyed.nodes.copyText.focused, false);
});

test("older clipboard work cannot overwrite a newer copy or a later Router state", async () => {
  let rejectFirst;
  let resolveSecond;
  const firstCopy = new Promise((resolve, reject) => { rejectFirst = reject; });
  const secondCopy = new Promise((resolve) => { resolveSecond = resolve; });
  let copyCalls = 0;
  const concurrent = controllerFixture({
    clipboardWrite: () => {
      copyCalls += 1;
      return copyCalls === 1 ? firstCopy : secondCopy;
    }
  });
  dispatch(concurrent.nodes.copyButton, "click");
  dispatch(concurrent.nodes.copyButton, "click");
  resolveSecond();
  await new Promise((resolve) => setImmediate(resolve));
  rejectFirst(new Error("older denied"));
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(concurrent.nodes.copyStatus.textContent, "已复制");
  assert.equal(concurrent.nodes.copyText.focused, false);

  let rejectPending;
  const pending = new Promise((resolve, reject) => { rejectPending = reject; });
  const stateChanged = controllerFixture({ clipboardWrite: () => pending });
  dispatch(stateChanged.nodes.copyButton, "click");
  stateChanged.nodes.input.value = "a";
  dispatch(stateChanged.nodes.form, "submit");
  rejectPending(new Error("denied after submit"));
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(stateChanged.nodes.live.textContent, "需要补充");
  assert.equal(stateChanged.nodes.copyStatus.textContent, "");
  assert.equal(stateChanged.nodes.copyText.focused, false);
});

test("bootRouter is idempotent per root, destroy removes listeners, and reboot creates one fresh controller", () => {
  const { root, nodes } = createFakeRouterDom({ payload: ROUTER_DATA });
  const first = bootRouter(root);
  const second = bootRouter(root);
  assert.equal(first, second);
  assert.equal(nodes.form.listenerCount("submit"), 1);
  nodes.input.value = "为什么失败了";
  dispatch(nodes.form, "submit");
  assert.equal(nodes.title.scrollCalls.length, 1);

  first.destroy();
  assert.equal(nodes.form.listenerCount("submit"), 0);
  assert.equal(nodes.form.listenerCount("reset"), 0);
  assert.equal(nodes.shortcutButtons[0].listenerCount("click"), 0);
  assert.equal(nodes.clarifyButtons[0].listenerCount("click"), 0);
  assert.equal(nodes.copyButton.listenerCount("click"), 0);
  assert.equal(root.defaultView.listenerCount("pagehide"), 0);
  assert.equal(root.defaultView.listenerCount("pageshow"), 0);

  const third = bootRouter(root);
  assert.notEqual(third, first);
  assert.equal(nodes.form.listenerCount("submit"), 1);
  nodes.input.value = "为什么失败了";
  dispatch(nodes.form, "submit");
  assert.equal(nodes.title.scrollCalls.length, 2);
});

test("bootRouter replaces an inert owner after missing DOM is repaired", () => {
  const { root, nodes } = createFakeRouterDom({ payload: ROUTER_DATA, omit: ["input"] });
  const inert = bootRouter(root);
  assert.equal(nodes.form.listenerCount("submit"), 1);
  assert.equal(nodes.unavailable.hidden, false);

  root.children.push(nodes.input);
  const repaired = bootRouter(root);
  assert.notEqual(repaired, inert);
  assert.equal(nodes.form.listenerCount("submit"), 1);
  nodes.input.value = "为什么失败了";
  const submitEvent = dispatch(nodes.form, "submit");
  assert.equal(submitEvent.defaultPrevented, true);
  assert.equal(nodes.unavailable.hidden, true);
  assert.deepEqual(visibleRouteKeys(nodes), ["diagnosis::intent"]);
});

test("bootRouter replaces a live owner when its form identity changes", () => {
  const { root, nodes } = createFakeRouterDom({ payload: ROUTER_DATA });
  const first = bootRouter(root);
  const oldForm = nodes.form;
  const replacementForm = new FakeRouterNode({ attributes: { "data-router-form": "" } });
  root.children = root.children.map((child) => child === oldForm ? replacementForm : child);

  const second = bootRouter(root);
  assert.notEqual(second, first);
  assert.equal(oldForm.listenerCount("submit"), 0);
  assert.equal(oldForm.listenerCount("reset"), 0);
  assert.equal(replacementForm.listenerCount("submit"), 1);
  assert.equal(replacementForm.listenerCount("reset"), 1);
  nodes.input.value = "为什么失败了";
  const submitEvent = dispatch(replacementForm, "submit");
  assert.equal(submitEvent.defaultPrevented, true);
  assert.deepEqual(visibleRouteKeys(nodes), ["diagnosis::intent"]);
});

test("createRouterController owns root lifecycle across direct create, boot, destroy, and reboot", () => {
  const directDom = createFakeRouterDom({ payload: ROUTER_DATA });
  let directCalls = 0;
  const direct = createRouterController({
    root: directDom.root,
    matcher: () => { directCalls += 1; return result("needs_input"); }
  });
  const bootedAfterDirect = bootRouter(directDom.root);
  assert.equal(bootedAfterDirect, direct);
  assert.equal(directDom.nodes.form.listenerCount("submit"), 1);
  directDom.nodes.input.value = "a";
  dispatch(directDom.nodes.form, "submit");
  assert.equal(directCalls, 1);

  const bootDom = createFakeRouterDom({ payload: ROUTER_DATA });
  const booted = bootRouter(bootDom.root);
  const createdAfterBoot = createRouterController({ root: bootDom.root, matcher: () => result("needs_input") });
  assert.equal(createdAfterBoot, booted);
  assert.equal(bootDom.nodes.form.listenerCount("submit"), 1);
  booted.destroy();
  assert.equal(bootDom.nodes.form.listenerCount("submit"), 0);
  const rebooted = bootRouter(bootDom.root);
  assert.notEqual(rebooted, booted);
  assert.equal(bootDom.nodes.form.listenerCount("submit"), 1);
  rebooted.destroy();
  assert.equal(bootDom.nodes.form.listenerCount("submit"), 0);
});
