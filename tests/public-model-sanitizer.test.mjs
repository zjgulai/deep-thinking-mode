import assert from "node:assert/strict";
import test from "node:test";

import {
  findPublicModelResidue,
  hasPublicModelResidue,
  sanitizeV2Model,
  sanitizeV3Model,
  stripPublicModelResidue,
} from "../tools/lib/public-model-sanitizer.mjs";

const dirty = "5Whys分析法 =================== 原创 正方形SQUARE 2026-03-14 15:02 上海 > 原文地址: [https://mp.weixin.qq.com/s/example](https://mp.weixin.qq.com/s/example)";

test("detects and strips WeChat ingestion headers", () => {
  assert.equal(hasPublicModelResidue(dirty), true);
  assert.equal(hasPublicModelResidue(stripPublicModelResidue(dirty)), false);
});

test("rebuilds dirty V3 semantic fields from verified model fields", () => {
  const model = {
    meta: { name: "5 Whys" },
    core_definition: dirty,
    when_to_use: { triggers: ["问题反复发生"], anti_triggers: [] },
    before_after: { without_model: "只处理表象", with_model: `运用后：${dirty}，从而得出结论。` },
    reasoning_steps: [{ step: 1, action: "描述事实", checkpoint: "描述可验证" }],
    scenarios: {},
    codex_integration: { activation: "请分析", system_prompt: `【认知模式】${dirty}\n\n【推理协议】\n1. 描述事实`, skill_hint: "5whys" },
    pitfalls: [],
  };
  sanitizeV3Model(model);
  assert.match(model.core_definition, /问题反复发生/u);
  assert.match(model.core_definition, /描述事实/u);
  assert.match(model.codex_integration.system_prompt, /【推理协议】/u);
  assert.deepEqual(findPublicModelResidue(model), []);
});

test("uses clean V3 definition when a V2 core question is contaminated", () => {
  const v2 = { engine: { core_question: dirty }, meta: {}, codex: {} };
  sanitizeV2Model(v2, { core_definition: "通过连续追问定位可改变的根因。" });
  assert.equal(v2.engine.core_question, "通过连续追问定位可改变的根因。");
  assert.deepEqual(findPublicModelResidue(v2), []);
});
