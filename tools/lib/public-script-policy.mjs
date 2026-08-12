import { parse } from "acorn";

export const PUBLIC_SCRIPT_POLICY = Object.freeze({
  "assets/site.js": Object.freeze({
    sourceType: "script",
    htmlTypes: Object.freeze([null, "text/javascript"]),
    sourceUrl: new URL("../site-assets/site.js", import.meta.url),
  }),
  "assets/router-controller.mjs": Object.freeze({
    sourceType: "module",
    htmlTypes: Object.freeze(["module"]),
    sourceUrl: new URL("../site-assets/router-controller.mjs", import.meta.url),
  }),
  "assets/router-engine.mjs": Object.freeze({
    sourceType: "module",
    htmlTypes: Object.freeze(["module"]),
    sourceUrl: new URL("../site-assets/router-engine.mjs", import.meta.url),
  }),
});

export const TRUSTED_PUBLIC_SCRIPTS = Object.freeze(Object.fromEntries(
  Object.entries(PUBLIC_SCRIPT_POLICY).map(([relativePath, policy]) => [
    relativePath,
    policy.sourceUrl,
  ]),
));

const STORAGE_NAMES = new Set([
  "indexedDB",
  "localStorage",
  "sessionStorage",
]);
const DIRECT_CAPABILITY_IDENTIFIERS = new Set([
  "eval",
  "EventSource",
  "fetch",
  "Function",
  "XMLHttpRequest",
  "WebSocket",
]);

function policyError(code, message, node) {
  const line = node?.loc?.start?.line;
  const column = node?.loc?.start?.column;
  const location = line === undefined ? "" : ` at ${line}:${column}`;
  return { code, message: `${message}${location}` };
}

function walkAst(node, visit) {
  if (!node || typeof node !== "object") {
    return;
  }
  if (typeof node.type === "string") {
    visit(node);
  }
  for (const [key, value] of Object.entries(node)) {
    if (key === "loc" || key === "start" || key === "end") {
      continue;
    }
    if (Array.isArray(value)) {
      for (const child of value) {
        walkAst(child, visit);
      }
    } else if (value && typeof value === "object") {
      walkAst(value, visit);
    }
  }
}

function literalString(node) {
  if (node?.type === "Literal" && !node.regex && typeof node.value === "string") {
    return node.value;
  }
  if (
    node?.type === "TemplateLiteral" &&
    node.expressions.length === 0 &&
    node.quasis.length === 1
  ) {
    return node.quasis[0].value.cooked ?? node.quasis[0].value.raw;
  }
  return null;
}

function memberPropertyName(node) {
  if (node?.type !== "MemberExpression") {
    return null;
  }
  if (!node.computed && node.property.type === "Identifier") {
    return node.property.name;
  }
  return literalString(node.property);
}

function isServiceWorkerRegister(node) {
  if (node?.type !== "MemberExpression" || memberPropertyName(node) !== "register") {
    return false;
  }
  return memberPropertyName(node.object) === "serviceWorker";
}

function capabilityName(node) {
  if (node.type === "Identifier") {
    if (STORAGE_NAMES.has(node.name) || DIRECT_CAPABILITY_IDENTIFIERS.has(node.name)) {
      return node.name;
    }
    if (node.name === "serviceWorker" || node.name === "sendBeacon") {
      return node.name;
    }
  }

  const literal = literalString(node);
  if (
    literal !== null &&
    (STORAGE_NAMES.has(literal) || DIRECT_CAPABILITY_IDENTIFIERS.has(literal))
  ) {
    return literal;
  }

  if (node.type === "MemberExpression") {
    const property = memberPropertyName(node);
    if (property !== null && STORAGE_NAMES.has(property)) {
      return property;
    }
    if (property !== null && DIRECT_CAPABILITY_IDENTIFIERS.has(property)) {
      return property;
    }
    if (property === "sendBeacon" || property === "serviceWorker") {
      return property;
    }
    if (
      property === "cookie" &&
      node.object.type === "Identifier" &&
      node.object.name === "document"
    ) {
      return "document.cookie";
    }
    if (isServiceWorkerRegister(node)) {
      return "serviceWorker.register";
    }
  }
  return null;
}

export function auditPublicScript({ source, relativePath }) {
  const sourceType = PUBLIC_SCRIPT_POLICY[relativePath]?.sourceType ??
    (relativePath.endsWith(".mjs") ? "module" : "script");
  let ast;
  try {
    ast = parse(source, {
      ecmaVersion: "latest",
      locations: true,
      sourceType,
    });
  } catch (parseError) {
    return {
      errors: [
        policyError(
          "SCRIPT_SYNTAX_ERROR",
          `${relativePath}: ${parseError.message}`,
        ),
      ],
      imports: [],
    };
  }

  const errors = [];
  const imports = [];
  const seenCapabilities = new Set();

  walkAst(ast, (node) => {
    if (node.type === "ImportExpression") {
      errors.push(
        policyError(
          "DYNAMIC_IMPORT_DENIED",
          `${relativePath}: dynamic import is not allowed`,
          node,
        ),
      );
      return;
    }

    if (
      node.type === "ImportDeclaration" ||
      node.type === "ExportAllDeclaration" ||
      (node.type === "ExportNamedDeclaration" && node.source)
    ) {
      imports.push(node.source.value);
    }

    const capability = capabilityName(node);
    if (capability !== null && !seenCapabilities.has(capability)) {
      seenCapabilities.add(capability);
      errors.push(
        policyError(
          "SCRIPT_CAPABILITY_DENIED",
          `${relativePath}: ${capability} is not allowed in public scripts`,
          node,
        ),
      );
    }
  });

  return { errors, imports };
}
