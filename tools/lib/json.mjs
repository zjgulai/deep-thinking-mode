import { types } from "node:util";

const INVALID_CODE = "CANONICAL_JSON_INVALID";

function invalid() {
  const error = new TypeError("Value cannot be represented as canonical JSON");
  error.code = INVALID_CODE;
  throw error;
}

function serializeArray(value, ancestors) {
  const ownKeys = Reflect.ownKeys(value);
  if (ownKeys.length !== value.length + 1 || ownKeys.some((key) => typeof key === "symbol")) {
    invalid();
  }

  const allowedKeys = new Set(["length"]);
  for (let index = 0; index < value.length; index += 1) {
    allowedKeys.add(String(index));
  }
  if (ownKeys.some((key) => !allowedKeys.has(key))) {
    invalid();
  }

  const items = [];
  for (let index = 0; index < value.length; index += 1) {
    const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
    if (descriptor === undefined || !Object.hasOwn(descriptor, "value")) {
      invalid();
    }
    items.push(serialize(descriptor.value, ancestors));
  }
  return `[${items.join(",")}]`;
}

function serializeObject(value, ancestors) {
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    invalid();
  }

  const ownKeys = Reflect.ownKeys(value);
  if (ownKeys.some((key) => typeof key === "symbol")) {
    invalid();
  }

  const members = [];
  for (const key of ownKeys.sort()) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (descriptor === undefined || !Object.hasOwn(descriptor, "value")) {
      invalid();
    }
    members.push(`${JSON.stringify(key)}:${serialize(descriptor.value, ancestors)}`);
  }
  return `{${members.join(",")}}`;
}

function serialize(value, ancestors) {
  if (value === null) return "null";

  switch (typeof value) {
    case "string":
      return JSON.stringify(value);
    case "boolean":
      return value ? "true" : "false";
    case "number":
      if (!Number.isFinite(value)) invalid();
      return JSON.stringify(value);
    case "object":
      if (types.isProxy(value)) invalid();
      if (ancestors.has(value)) invalid();
      ancestors.add(value);
      try {
        return Array.isArray(value)
          ? serializeArray(value, ancestors)
          : serializeObject(value, ancestors);
      } finally {
        ancestors.delete(value);
      }
    default:
      invalid();
  }
}

export function canonicalJsonBytes(value) {
  return Buffer.from(serialize(value, new Set()), "utf8");
}

export function canonicalJsonDocumentBytes(value) {
  return Buffer.concat([canonicalJsonBytes(value), Buffer.from([0x0a])]);
}
