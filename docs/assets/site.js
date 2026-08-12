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

  for (const input of document.querySelectorAll("[data-filter-input]")) {
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
