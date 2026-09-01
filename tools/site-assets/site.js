(() => {
  "use strict";

  const navToggle = document.querySelector("[data-nav-toggle]");
  const primaryNav = document.querySelector("[data-primary-nav]");
  if (navToggle && primaryNav) {
    navToggle.addEventListener("click", () => {
      const open = navToggle.getAttribute("aria-expanded") !== "true";
      navToggle.setAttribute("aria-expanded", String(open));
      primaryNav.classList.toggle("is-open", open);
    });
    document.addEventListener("keydown", (event) => {
      if (event.key === "Escape" && primaryNav.classList.contains("is-open")) {
        primaryNav.classList.remove("is-open");
        navToggle.setAttribute("aria-expanded", "false");
        navToggle.focus();
      }
    });
  }

  const toast = document.querySelector("[data-toast]");
  let toastTimer = null;
  function announce(message) {
    if (!toast) return;
    toast.textContent = message;
    toast.classList.add("is-visible");
    window.clearTimeout(toastTimer);
    toastTimer = window.setTimeout(() => toast.classList.remove("is-visible"), 2200);
  }

  async function copyText(text) {
    if (navigator.clipboard && window.isSecureContext) {
      await navigator.clipboard.writeText(text);
      return;
    }
    const textarea = document.createElement("textarea");
    textarea.value = text;
    textarea.setAttribute("readonly", "");
    textarea.style.position = "fixed";
    textarea.style.opacity = "0";
    document.body.append(textarea);
    textarea.select();
    const copied = document.execCommand("copy");
    textarea.remove();
    if (!copied) throw new Error("copy failed");
  }

  for (const button of document.querySelectorAll("[data-copy-target]")) {
    button.addEventListener("click", async () => {
      const target = document.getElementById(button.dataset.copyTarget || "");
      if (!target) return;
      try {
        await copyText(target.textContent || "");
        const original = button.textContent;
        button.textContent = "已复制";
        announce("完整提示词已复制到剪贴板");
        window.setTimeout(() => { button.textContent = original; }, 1800);
      } catch {
        target.focus();
        const selection = window.getSelection();
        const range = document.createRange();
        range.selectNodeContents(target);
        selection.removeAllRanges();
        selection.addRange(range);
        announce("复制失败，已为你选中提示词");
      }
    });
  }

  const modelLibrary = document.querySelector("[data-model-library]");
  if (modelLibrary) {
    const modelUrlPattern = /^[a-z0-9][a-z0-9-]*-[a-f0-9]{12}\.html$/u;
    const input = modelLibrary.querySelector("[data-library-input]");
    const list = modelLibrary.querySelector("[data-library-list]");
    const count = modelLibrary.querySelector("[data-library-count]");
    const empty = modelLibrary.querySelector("[data-filter-empty]");
    const pager = modelLibrary.querySelector("[data-library-pager]");
    const previous = modelLibrary.querySelector("[data-library-previous]");
    const next = modelLibrary.querySelector("[data-library-next]");
    const range = modelLibrary.querySelector("[data-library-range]");
    const pageNumber = modelLibrary.querySelector("[data-library-page-number]");
    const pageCount = modelLibrary.querySelector("[data-library-page-count]");
    const live = modelLibrary.querySelector("[data-library-live]");
    const fallback = modelLibrary.querySelector("[data-library-fallback]");
    const printRange = modelLibrary.querySelector("[data-library-print-range]");
    const payloadNode = modelLibrary.querySelector("[data-model-library-payload]");

    function displayName(value) {
      return String(value || "")
        .replace(/\*\*/g, "")
        .replace(/_+/g, " · ")
        .replace(/\s*#[^\s#]+.*$/u, "")
        .replace(/\s*[·｜]\s*[\p{Script=Han}]$/u, "")
        .replace(/\s+/g, " ")
        .replace(/(?:\s*·\s*)+/g, " · ")
        .replace(/[，、:：\-·｜]\s*$/u, "")
        .trim();
    }

    function plainText(value) {
      return String(value || "")
        .replace(/!\[([^\]]*)\]\([^)]*\)/g, "$1")
        .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
        .replace(/(^|\s)#{1,6}\s*/g, "$1")
        .replace(/[*`~]/g, "")
        .replace(/\s+/g, " ")
        .trim();
    }

    function excerpt(value, limit) {
      const text = plainText(value);
      return text.length > limit ? `${text.slice(0, limit).trimEnd()}…` : text;
    }

    function append(parent, tagName, className, text) {
      const element = document.createElement(tagName);
      if (className) element.className = className;
      if (text !== undefined) element.textContent = text;
      parent.append(element);
      return element;
    }

    function modelCard(model) {
      const article = document.createElement("article");
      article.className = "model-summary";
      const top = append(article, "div", "model-summary-top");
      append(top, "span", "eyebrow", model.skill);
      append(top, "span", "quality", `${model.steps} 步协议`);
      const heading = append(article, "h2");
      const headingLink = append(heading, "a", "", model.title);
      headingLink.setAttribute("href", model.url);
      append(article, "p", "", model.definition);
      if (model.signals) {
        const signal = append(article, "div", "signal-line");
        append(signal, "strong", "", "适用：");
        signal.append(document.createTextNode(model.signals));
      }
      if (model.roles.length) {
        const roles = append(article, "div", "chip-row");
        roles.setAttribute("aria-label", "Agent 角色");
        for (const role of model.roles) append(roles, "span", "chip chip-agent", role);
      }
      const detailLink = append(article, "a", "text-link", "查看完整协议 ");
      detailLink.setAttribute("href", model.url);
      detailLink.setAttribute("aria-label", `查看 ${model.title} 的完整推理协议`);
      const arrow = append(detailLink, "span", "", "→");
      arrow.setAttribute("aria-hidden", "true");
      return article;
    }

    function isStringArray(value) {
      return Array.isArray(value) && value.every((item) => typeof item === "string");
    }

    function isModelRecord(model) {
      return model !== null
        && typeof model === "object"
        && typeof model.name === "string"
        && typeof model.url === "string"
        && modelUrlPattern.test(model.url)
        && typeof model.skill_name === "string"
        && Number.isInteger(model.steps)
        && model.steps >= 0
        && typeof model.core === "string"
        && isStringArray(model.tags)
        && isStringArray(model.triggers)
        && isStringArray(model.role_ids);
    }

    try {
      if (![input, list, count, empty, pager, previous, next, range, pageNumber, pageCount, live, fallback, printRange, payloadNode].every(Boolean)) {
        throw new Error("incomplete model library DOM");
      }
      const payload = JSON.parse(payloadNode?.textContent || "");
      const roleLabels = payload?.role_labels;
      if (payload?.schema !== "model-library.v1"
        || !Number.isInteger(payload.page_size)
        || payload.page_size <= 0
        || !Number.isInteger(payload.search_render_limit)
        || payload.search_render_limit < payload.page_size
        || roleLabels === null
        || typeof roleLabels !== "object"
        || Array.isArray(roleLabels)
        || !Object.values(roleLabels).every((label) => typeof label === "string")
        || !Array.isArray(payload.models)
        || !payload.models.every(isModelRecord)) {
        throw new Error("invalid model library payload");
      }
      const models = payload.models.map((model) => {
        const title = displayName(model.name) || String(model.name || "").trim();
        const triggers = Array.isArray(model.triggers) ? model.triggers : [];
        const roleIds = Array.isArray(model.role_ids) ? model.role_ids : [];
        return {
          title,
          url: model.url,
          skill: displayName(model.skill_name) || "思维模型",
          steps: model.steps,
          definition: excerpt(model.core, 150),
          signals: triggers.slice(0, 2).map((item) => excerpt(item, 54)).join(" · "),
          roles: roleIds.map((role) => (
            Object.prototype.hasOwnProperty.call(roleLabels, role) ? roleLabels[role] : role
          )),
          search: [
            model.name,
            title,
            model.core,
            ...(Array.isArray(model.tags) ? model.tags : []),
            ...triggers,
            ...roleIds,
          ].join(" ").normalize("NFKC").toLowerCase(),
        };
      });
      const pageSize = payload.page_size;
      const searchRenderLimit = payload.search_render_limit;
      let matches = models;
      let page = 0;
      let tokens = [];
      let query = "";

      function render({ replaceCards = true } = {}) {
        const renderAllMatches = tokens.length > 0 && matches.length <= searchRenderLimit;
        const effectivePageSize = renderAllMatches ? Math.max(1, matches.length) : pageSize;
        const totalPages = Math.max(1, Math.ceil(matches.length / effectivePageSize));
        page = Math.min(page, totalPages - 1);
        const start = page * effectivePageSize;
        const visibleModels = matches.slice(start, start + effectivePageSize);

        if (replaceCards) {
          const fragment = document.createDocumentFragment();
          for (const model of visibleModels) fragment.append(modelCard(model));
          list.replaceChildren(fragment);
        }
        count.textContent = String(matches.length);
        empty.hidden = matches.length !== 0;
        pager.hidden = totalPages <= 1;
        previous.disabled = page === 0;
        next.disabled = page >= totalPages - 1;
        const first = matches.length === 0 ? 0 : start + 1;
        const last = start + visibleModels.length;
        range.textContent = `${first}–${last}，共 ${matches.length} 个`;
        printRange.textContent = range.textContent;
        pageNumber.textContent = String(page + 1);
        pageCount.textContent = String(totalPages);
        const queryPrefix = tokens.length > 0 ? `“${query}”` : "";
        live.textContent = matches.length === 0
          ? `${queryPrefix}没有匹配结果`
          : `${queryPrefix}显示第 ${first} 到 ${last} 个，共 ${matches.length} 个结果`;
      }

      function update() {
        const normalizedQuery = input.value.slice(0, 80).normalize("NFKC").trim();
        query = normalizedQuery;
        tokens = [...new Set(normalizedQuery.toLowerCase().split(/\s+/u).filter(Boolean))];
        matches = tokens.length === 0
          ? models
          : models.filter((model) => tokens.every((token) => model.search.includes(token)));
        page = 0;
        render();
      }

      function focusPageStart() {
        const reduceMotion = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false;
        list.focus({ preventScroll: true });
        list.scrollIntoView({
          block: "start",
          behavior: reduceMotion ? "auto" : "smooth",
        });
      }

      input.addEventListener("input", update);
      previous.addEventListener("click", () => {
        if (page === 0) return;
        page -= 1;
        render();
        focusPageStart();
      });
      next.addEventListener("click", () => {
        page += 1;
        render();
        focusPageStart();
      });
      render({ replaceCards: false });
    } catch (error) {
      const visibleCount = list?.querySelectorAll("article").length ?? 0;
      if (input) input.disabled = true;
      if (count) count.textContent = String(visibleCount);
      if (empty) empty.hidden = true;
      if (pager) pager.hidden = true;
      if (fallback) fallback.hidden = false;
      if (printRange) printRange.textContent = `1–${visibleCount}，共 ${visibleCount} 个`;
      if (live) live.textContent = "模型索引不可用，当前仅显示首屏模型";
      console.error(error);
    }
  }

  for (const input of document.querySelectorAll("[data-filter-input]")) {
    if (input.hasAttribute("data-library-input")) continue;
    const scope = input.closest("section") || document;
    const items = [...scope.querySelectorAll("[data-filter-item]")];
    const count = scope.querySelector("[data-filter-count]") || document.querySelector("[data-filter-count]");
    const empty = scope.querySelector("[data-filter-empty]");
    const update = () => {
      const tokens = input.value.trim().toLowerCase().split(/\s+/u).filter(Boolean);
      let visible = 0;
      for (const item of items) {
        const haystack = item.dataset.search || "";
        const match = tokens.every((token) => haystack.includes(token));
        item.hidden = !match;
        if (match) visible += 1;
      }
      if (count) count.textContent = String(visible);
      if (empty) empty.hidden = visible !== 0;
    };
    input.addEventListener("input", update);
    update();
  }

})();
