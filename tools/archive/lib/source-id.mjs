import { createHmac } from "node:crypto";

import { sha256 } from "./hash.mjs";

function sourceIdError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

export function sourceIdForLocator({ privateKey, locatorType, locator, existingLocatorSha256BySourceId } = {}) {
  if (!Buffer.isBuffer(privateKey) || privateKey.length !== 32) {
    throw new TypeError("privateKey must be a 32-byte Buffer");
  }
  if ((locatorType !== "url" && locatorType !== "raw") || typeof locator !== "string" || locator.length === 0) {
    throw new TypeError("locatorType must be url or raw and locator must be a non-empty string");
  }

  const privateLocator = `${locatorType}\0${locator}`;
  const locatorSha256 = sha256(privateLocator);
  const sourceId = `src_${createHmac("sha256", privateKey).update(privateLocator).digest("hex").slice(0, 32)}`;
  const knownLocatorSha256 = existingLocatorSha256BySourceId?.get(sourceId);
  if (knownLocatorSha256 !== undefined && knownLocatorSha256 !== locatorSha256) {
    throw sourceIdError("SOURCE_ID_COLLISION", "a different locator already has this source ID");
  }
  return { sourceId, locatorSha256 };
}
