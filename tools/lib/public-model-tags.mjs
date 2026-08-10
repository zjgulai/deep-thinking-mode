const CSS_COLOR_FRAGMENT = /^#?(?:[0-9a-f]{3}|[0-9a-f]{4}|[0-9a-f]{6}|[0-9a-f]{8});?$/i;

export function sanitizePublicModelTags(tags) {
  if (!Array.isArray(tags)) return [];

  return [...new Set(
    tags
      .map((tag) => String(tag ?? "").trim())
      .filter((tag) => tag && !CSS_COLOR_FRAGMENT.test(tag)),
  )];
}
