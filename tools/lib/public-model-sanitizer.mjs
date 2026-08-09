const WECHAT_URL = /https?:\/\/mp\.weixin\.qq\.com\/[\w?=&%./\\-]*/giu;
const WECHAT_MARKDOWN_LINK = /\[[^\]]*\]\(https?:\/\/mp\.weixin\.qq\.com\/[^)]*\)/giu;
const INGESTION_HEADER = /\s*=+\s*原创\s+正方形SQUARE\s+\d{4}-\d{2}-\d{2}(?:\s+\d{2}:\d{2})?(?:\s+上海)?\s*>?\s*原文地址\s*:[\s\S]*?(?=\n\n【|，从而|$)/gu;
const LOOSE_HEADER = /\s*=+\s*原创\s+正方形SQUARE(?:\s+\d{4}-\d{2}-\d{2})?(?:\s+\d{2}:\d{2})?(?:\s+上海)?/gu;
const SOURCE_LABEL = />?\s*原文地址\s*:\s*/gu;

export const PUBLIC_MODEL_RESIDUE_PATTERNS = Object.freeze([
  /mp\.weixin\.qq\.com/iu,
  /原创\s+正方形SQUARE/iu,
  /原文地址\s*:\s*\[?https?:\/\//iu,
]);

export function hasPublicModelResidue(value) {
  return typeof value === "string" && PUBLIC_MODEL_RESIDUE_PATTERNS.some((pattern) => pattern.test(value));
}

export function stripPublicModelResidue(value) {
  if (typeof value !== "string") return value;
  const hadResidue = hasPublicModelResidue(value);
  if (!hadResidue) return value;
  let result = value
    .replace(INGESTION_HEADER, "")
    .replace(WECHAT_MARKDOWN_LINK, "")
    .replace(WECHAT_URL, "")
    .replace(LOOSE_HEADER, "")
    .replace(SOURCE_LABEL, "")
    .replace(/[ \t]+\n/gu, "\n")
    .replace(/[ \t]{2,}/gu, " ")
    .replace(/\n{3,}/gu, "\n\n")
    .trim();
  if (!result) result = "原始来源链接已从公开语义字段移除；请通过来源索引复核。";
  return result;
}

function cleanTree(value) {
  if (typeof value === "string") return stripPublicModelResidue(value);
  if (Array.isArray(value)) return value.map(cleanTree);
  if (value && typeof value === "object") {
    for (const [key, child] of Object.entries(value)) value[key] = cleanTree(child);
  }
  return value;
}

function cleanDefinition(model) {
  const triggers = (model.when_to_use?.triggers ?? []).slice(0, 2);
  const actions = (model.reasoning_steps ?? []).map((step) => step.action).filter(Boolean).slice(0, 2);
  const purpose = triggers.length ? `处理“${triggers.join("”或“")}”` : "组织复杂问题";
  const method = actions.length ? actions.join("；") : "明确问题、检查假设并形成可验证结论";
  return `「${model.meta.name}」是一套用于${purpose}的结构化思考方法。核心做法是：${method}。`;
}

function cleanSystemPrompt(model, original, definition) {
  const marker = original.indexOf("【推理协议】");
  let protocol = marker >= 0 ? stripPublicModelResidue(original.slice(marker)) : "";
  if (!protocol || !protocol.startsWith("【推理协议】")) {
    const steps = (model.reasoning_steps ?? []).map((step, index) => `${index + 1}. ${step.action}`).join("\n");
    protocol = `【推理协议】\n${steps}`;
  }
  return `【认知模式】你现在运行「${model.meta.name}」思维框架。核心定义：${definition}\n\n${protocol}`;
}

export function sanitizeV3Model(model) {
  const coreWasDirty = hasPublicModelResidue(model.core_definition);
  const withWasDirty = hasPublicModelResidue(model.before_after?.with_model);
  const promptWasDirty = hasPublicModelResidue(model.codex_integration?.system_prompt);
  const originalPrompt = model.codex_integration?.system_prompt ?? "";

  cleanTree(model);
  if (coreWasDirty) model.core_definition = cleanDefinition(model);
  if (withWasDirty) {
    const trigger = model.when_to_use?.triggers?.[0] || "当前问题";
    model.before_after.with_model = `运用「${model.meta.name}」后，可以围绕“${trigger}”按既定步骤分析，并在检查点验证关键假设。`;
  }
  if (promptWasDirty) model.codex_integration.system_prompt = cleanSystemPrompt(model, originalPrompt, model.core_definition);
  return model;
}

export function sanitizeV2Model(model, matchingV3) {
  const coreWasDirty = hasPublicModelResidue(model.engine?.core_question);
  cleanTree(model);
  if (coreWasDirty && matchingV3?.core_definition) model.engine.core_question = matchingV3.core_definition;
  return model;
}

export function findPublicModelResidue(value, path = "$", findings = []) {
  if (typeof value === "string") {
    if (hasPublicModelResidue(value)) findings.push(path);
    return findings;
  }
  if (Array.isArray(value)) {
    value.forEach((item, index) => findPublicModelResidue(item, `${path}[${index}]`, findings));
    return findings;
  }
  if (value && typeof value === "object") {
    for (const [key, child] of Object.entries(value)) findPublicModelResidue(child, `${path}.${key}`, findings);
  }
  return findings;
}
