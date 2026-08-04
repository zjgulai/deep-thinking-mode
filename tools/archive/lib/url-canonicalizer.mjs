function urlError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

export function canonicalizeHttpUrl(input) {
  if (typeof input !== "string" || input.length === 0) {
    throw urlError("URL_INVALID", "URL must be a non-empty string");
  }

  let parsed;
  try {
    parsed = new URL(input);
  } catch {
    throw urlError("URL_INVALID", "URL must be valid");
  }
  if ((parsed.protocol !== "http:" && parsed.protocol !== "https:") || parsed.username || parsed.password) {
    throw urlError("URL_INVALID", "URL must be HTTP(S) and must not include credentials");
  }
  parsed.hash = "";
  return parsed.href;
}

export function assertWechatSourceUrl(canonicalUrl) {
  let parsed;
  try {
    parsed = new URL(canonicalUrl);
  } catch {
    throw urlError("WECHAT_SOURCE_URL_INVALID", "WeChat source URL must be valid");
  }
  if (parsed.protocol !== "https:" || parsed.hostname !== "mp.weixin.qq.com") {
    throw urlError("WECHAT_SOURCE_URL_INVALID", "WeChat source URL must use the exact HTTPS host");
  }
}
