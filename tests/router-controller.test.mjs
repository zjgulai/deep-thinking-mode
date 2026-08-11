import assert from "node:assert/strict";
import test from "node:test";

import {
  bootRouter,
  createRouterController,
  parseRouterPayload
} from "../tools/site-assets/router-controller.mjs";
import {
  FakeRouterNode,
  createFakeRouterDom,
  dispatch
} from "./helpers/fake-router-dom.mjs";

const ROUTER_DATA = {
  schema_version: "2.0-router",
  problem_types: [
    { id: "diagnosis", label: "诊断根因", priority: 10, positive_phrases: [{ text: "原因", weight: 8 }], negative_phrases: [], examples: ["找出原因"], clarify_label: "找原因" },
    { id: "planning", label: "制定计划", priority: 20, positive_phrases: [{ text: "计划", weight: 8 }], negative_phrases: [], examples: ["制定计划"], clarify_label: "做计划" },
    { id: "decision", label: "辅助决策", priority: 30, positive_phrases: [{ text: "选择", weight: 8 }], negative_phrases: [], examples: ["做出选择"], clarify_label: "做选择" },
    { id: "creative", label: "探索创新", priority: 40, positive_phrases: [{ text: "创新", weight: 8 }], negative_phrases: [], examples: ["探索创新"], clarify_label: "想创新" },
    { id: "research", label: "深度研究", priority: 50, positive_phrases: [{ text: "研究", weight: 8 }], negative_phrases: [], examples: ["深度研究"], clarify_label: "做研究" }
  ],
  agent_stages: [{ id: "intent", label: "意图", priority: 10, positive_phrases: [{ text: "需要", weight: 8 }] }],
  safety_signals: [
    { id: "high_stakes_financial_instruction", label: "高风险财务指令", message: "请寻求专业支持", phrases: ["全部积蓄"] },
    { id: "immediate_personal_danger", label: "紧急人身危险", message: "请优先寻求当地紧急服务", phrases: ["伤害自己"] },
    { id: "legal_advice_with_deadline", label: "紧迫法律意见", message: "请寻求法律专业支持", phrases: ["法律期限"] },
    { id: "medical_diagnosis_or_treatment", label: "医疗诊疗", message: "请寻求医疗专业支持", phrases: ["诊断症状"] }
  ]
};

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

test("parseRouterPayload accepts the compact V2 matcher payload and rejects malformed schemas", () => {
  const valid = new FakeRouterNode({ textContent: JSON.stringify(ROUTER_DATA) });
  assert.deepEqual(parseRouterPayload(valid), ROUTER_DATA);
  const invalidPayloads = [
    { ...ROUTER_DATA, problem_types: [ROUTER_DATA.problem_types[0]] },
    { ...ROUTER_DATA, problem_types: ROUTER_DATA.problem_types.map((entry, index) => index === 0 ? { ...entry, priority: 0 } : entry) },
    { ...ROUTER_DATA, problem_types: ROUTER_DATA.problem_types.map((entry, index) => index === 0 ? { ...entry, clarify_label: "" } : entry) },
    { ...ROUTER_DATA, problem_types: ROUTER_DATA.problem_types.map((entry, index) => index === 0 ? { ...entry, examples: [] } : entry) },
    { ...ROUTER_DATA, problem_types: ROUTER_DATA.problem_types.map((entry, index) => index === 0 ? { ...entry, positive_phrases: [] } : entry) },
    { ...ROUTER_DATA, problem_types: ROUTER_DATA.problem_types.map((entry, index) => index === 0 ? { ...entry, positive_phrases: [{ text: "", weight: 8 }] } : entry) },
    { ...ROUTER_DATA, problem_types: ROUTER_DATA.problem_types.map((entry, index) => index === 0 ? { ...entry, positive_phrases: [{ text: "原因", weight: 11 }] } : entry) },
    { ...ROUTER_DATA, agent_stages: [{ ...ROUTER_DATA.agent_stages[0], priority: -1 }] },
    { ...ROUTER_DATA, safety_signals: [{ id: "immediate_personal_danger", phrases: [] }] },
    { ...ROUTER_DATA, safety_signals: ROUTER_DATA.safety_signals.map((entry, index) => index === 0 ? { ...entry, id: "unknown_safety" } : entry) }
  ];
  for (const invalid of [
    null,
    new FakeRouterNode({ textContent: "{" }),
    new FakeRouterNode({ textContent: JSON.stringify({ ...ROUTER_DATA, schema_version: "1.0-router" }) }),
    new FakeRouterNode({ textContent: JSON.stringify({ ...ROUTER_DATA, problem_types: [] }) }),
    new FakeRouterNode({ textContent: JSON.stringify({ ...ROUTER_DATA, safety_signals: "unsafe" }) }),
    ...invalidPayloads.map((payload) => new FakeRouterNode({ textContent: JSON.stringify(payload) }))
  ]) assert.equal(parseRouterPayload(invalid), null);
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
  const matched = result("matched", {
    problemTypeId: "diagnosis",
    auxiliaryProblemTypeIds: ["planning", "decision", "creative"],
    agentStageId: "intent"
  });
  const { nodes } = controllerFixture({ matcher: () => matched });
  nodes.input.value = "项目延期需要找原因";
  dispatch(nodes.form, "submit");

  assert.deepEqual(
    nodes.routeCards.filter((card) => !card.hidden).map((card) => card.getAttribute("data-route-key")),
    ["diagnosis::intent", "planning::intent", "decision::intent"]
  );
  assert.deepEqual(
    nodes.routeCards.filter((card) => !card.hidden).map((card) => card.getAttribute("data-route-kind")),
    ["core", "auxiliary", "auxiliary"]
  );
  assert.equal(nodes.routeCards.find((card) => card.getAttribute("data-route-key") === "diagnosis::planning").hidden, true);
  assert.equal(nodes.live.textContent, "已匹配 3 条路径");
  assert.equal(nodes.title.focused, true);
  assert.deepEqual(nodes.title.scrollCalls, [{ behavior: "smooth", block: "start" }]);
});

test("matched respects reduced motion by using auto scrolling", () => {
  const { nodes } = controllerFixture({
    reducedMotion: true,
    matcher: () => result("matched", { problemTypeId: "creative", agentStageId: "planning" })
  });
  nodes.input.value = "需要创新计划";
  dispatch(nodes.form, "submit");
  assert.deepEqual(nodes.title.scrollCalls, [{ behavior: "auto", block: "start" }]);
});

test("clarify shows only two to four options, reruns once, then falls back to all shortcuts without recursion", () => {
  const responses = [
    result("clarify", { agentStageId: "intent", clarificationOptionIds: ["diagnosis", "planning", "decision", "creative", "research"] }),
    result("clarify", { agentStageId: "intent", clarificationOptionIds: ["diagnosis", "planning"] })
  ];
  const { nodes, calls } = controllerFixture({ matcher: (request) => responses.shift() });
  nodes.input.value = "有点乱";
  dispatch(nodes.form, "submit");

  assert.equal(nodes.live.textContent, "需要澄清");
  assert.deepEqual(nodes.clarifyButtons.filter((button) => !button.hidden).map((button) => button.getAttribute("data-clarify-option")), ["diagnosis", "planning", "decision", "creative"]);
  dispatch(nodes.clarifyButtons[1], "click");
  assert.equal(calls.length, 2);
  assert.equal(calls[1].shortcutIntentId, "planning");
  assert.equal(nodes.clarify.hidden, true);
  assert.equal(nodes.shortcuts.hidden, false);
  assert.ok(nodes.shortcutButtons.every((button) => !button.hidden));

  dispatch(nodes.clarifyButtons[0], "click");
  assert.equal(calls.length, 2);
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
    matcher: (request) => result("matched", { problemTypeId: request.shortcutIntentId, agentStageId: "intent" })
  });
  const planning = nodes.shortcutButtons[1];
  dispatch(planning, "click");
  assert.equal(planning.getAttribute("aria-pressed"), "true");
  assert.equal(nodes.hint.textContent, "已选择“做计划”，可继续补充后提交");
  assert.equal(nodes.live.textContent, "");
  assert.equal(calls.length, 0);

  dispatch(planning, "click");
  assert.equal(calls.length, 1);
  assert.equal(calls[0].shortcutIntentId, "planning");

  const second = controllerFixture({ matcher: (request) => result("matched", { problemTypeId: request.shortcutIntentId, agentStageId: "intent" }) });
  dispatch(second.nodes.shortcutButtons[0], "click");
  second.nodes.input.value = "还有背景";
  dispatch(second.nodes.form, "submit");
  assert.equal(second.calls.length, 1);
  assert.equal(second.calls[0].shortcutIntentId, "diagnosis");
});

test("reset and pagehide clear input, shortcut state, clarification state, and visible results", () => {
  const { nodes, view, calls } = controllerFixture({
    matcher: () => result("clarify", { clarificationOptionIds: ["diagnosis", "planning"] })
  });
  nodes.input.value = "有点乱";
  dispatch(nodes.shortcutButtons[1], "click");
  dispatch(nodes.form, "submit");
  dispatch(nodes.clarifyButtons[0], "click");
  assert.equal(nodes.clarify.hidden, true);
  dispatch(nodes.form, "reset");
  assert.equal(nodes.input.value, "");
  assert.ok(nodes.shortcutButtons.every((button) => button.getAttribute("aria-pressed") === "false"));
  assert.equal(nodes.examples.hidden, false);
  assert.equal(nodes.results.hidden, true);

  nodes.input.value = "第二次";
  dispatch(nodes.form, "submit");
  assert.equal(nodes.clarify.hidden, false);
  dispatch(nodes.clarifyButtons[0], "click");
  assert.equal(calls.length, 4);
  view.dispatchEvent("pagehide");
  assert.equal(nodes.input.value, "");
  assert.ok(nodes.routeCards.every((card) => card.hidden));
  assert.ok(nodes.shortcutButtons.every((button) => button.getAttribute("aria-pressed") === "false"));

  nodes.input.value = "第三次";
  dispatch(nodes.form, "submit");
  assert.equal(nodes.clarify.hidden, false);
  dispatch(nodes.clarifyButtons[0], "click");
  assert.equal(calls.length, 6);
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

test("bootRouter binds the supplied document root", () => {
  const { root, nodes } = createFakeRouterDom({ payload: ROUTER_DATA });
  const controller = bootRouter(root);
  assert.ok(controller);
  assert.equal(nodes.examples.hidden, false);
});
