import type { BrowserActStep, BrowserSnapshotNode } from "@rakazo/adapter-kit";

export interface EvaluatedDomSnapshot {
  url: string;
  title: string;
  loading: boolean;
  tree: string;
  elements: BrowserSnapshotNode[];
}

export function buildDomSnapshotExpression(query?: string): string {
  const serializedQuery = JSON.stringify((query ?? "").trim().toLowerCase());
  return `(() => {
    const query = ${serializedQuery};
    const SELECTOR = [
      "a[href]",
      "button",
      "input:not([type='hidden'])",
      "select",
      "textarea",
      "summary",
      "[role='button']",
      "[role='link']",
      "[role='textbox']",
      "[role='checkbox']",
      "[role='radio']",
      "[role='combobox']",
      "[role='menuitem']",
      "[role='tab']",
      "[contenteditable='true']"
    ].join(",");

    function isVisible(el) {
      if (!el || !(el instanceof Element)) return false;
      if (el.closest("[hidden], [aria-hidden='true']")) return false;
      const style = window.getComputedStyle(el);
      if (style.display === "none" || style.visibility === "hidden" || Number(style.opacity) === 0) {
        return false;
      }
      const rect = el.getBoundingClientRect();
      return rect.width > 1 && rect.height > 1;
    }

    function clean(text, max = 140) {
      const normalized = String(text || "").replace(/\\s+/g, " ").trim();
      return normalized.length > max ? normalized.slice(0, max - 1) + "…" : normalized;
    }

    function roleOf(el) {
      const explicit = el.getAttribute("role");
      if (explicit) return explicit.toLowerCase();
      const tag = el.tagName.toLowerCase();
      if (tag === "a") return "link";
      if (tag === "button" || tag === "summary") return "button";
      if (tag === "select") return "combobox";
      if (tag === "textarea") return "textbox";
      if (tag === "input") {
        const type = (el.getAttribute("type") || "text").toLowerCase();
        if (type === "checkbox") return "checkbox";
        if (type === "radio") return "radio";
        if (type === "submit" || type === "button" || type === "reset") return "button";
        if (type === "file") return "button";
        return "textbox";
      }
      return "textbox";
    }

    function labelOf(el) {
      const aria = el.getAttribute("aria-label");
      if (aria && aria.trim()) return clean(aria);
      const labelledBy = el.getAttribute("aria-labelledby");
      if (labelledBy) {
        const parts = labelledBy
          .split(/\\s+/)
          .map((id) => document.getElementById(id)?.textContent || "")
          .join(" ");
        if (parts.trim()) return clean(parts);
      }
      if ("labels" in el && el.labels && el.labels.length > 0) {
        const text = Array.from(el.labels).map((l) => l.textContent || "").join(" ");
        if (text.trim()) return clean(text);
      }
      const placeholder = el.getAttribute("placeholder");
      if (placeholder && placeholder.trim()) return clean(placeholder);
      const title = el.getAttribute("title");
      if (title && title.trim()) return clean(title);
      if (el.tagName.toLowerCase() === "input") {
        const val = el.getAttribute("value") || el.getAttribute("name") || el.getAttribute("type") || "";
        return clean(val);
      }
      return clean(el.innerText || el.textContent || "");
    }

    let counter = Number(window.__vnbotRefSeq || 0);
    const candidates = Array.from(document.querySelectorAll(SELECTOR)).filter(isVisible);
    const allElements = [];

    for (const el of candidates) {
      let ref = el.getAttribute("data-vnbot-ref");
      if (!ref) {
        counter += 1;
        ref = "e" + counter;
        el.setAttribute("data-vnbot-ref", ref);
      }
      const tag = el.tagName.toLowerCase();
      const role = roleOf(el);
      const name = labelOf(el);
      const secret =
        el.getAttribute("data-vnbot-secret") === "1" ||
        (tag === "input" && (el.getAttribute("type") || "").toLowerCase() === "password");

      let value;
      if (!secret) {
        if (tag === "input") {
          const type = (el.getAttribute("type") || "text").toLowerCase();
          if (type === "checkbox" || type === "radio") {
            value = el.checked ? "checked" : "unchecked";
          } else if (type !== "button" && type !== "submit" && type !== "reset" && type !== "file") {
            value = clean(el.value || "", 120);
          }
        } else if (tag === "textarea") {
          value = clean(el.value || "", 120);
        } else if (tag === "select") {
          const selected = el.selectedOptions && el.selectedOptions[0];
          value = clean(selected ? selected.textContent || selected.value : el.value || "", 120);
        } else if (el.getAttribute("contenteditable") === "true") {
          value = clean(el.textContent || "", 120);
        }
      }

      const item = {
        ref,
        role,
        name,
        tag,
        ...(value ? { value } : {})
      };
      if (tag === "select" && el.options) {
        const total = el.options.length;
        const opts = Array.from(el.options).slice(0, 40).map((opt) => ({
          label: clean(opt.textContent || opt.label || opt.value, 80),
          value: String(opt.value || ""),
          ...(opt.selected ? { selected: true } : {}),
          ...(opt.disabled ? { disabled: true } : {})
        }));
        item.options = opts;
        if (total > opts.length) item.optionsTotal = total;
      }

      const hay = (role + " " + name + " " + (value || "") + " " + (el.getAttribute("href") || "")).toLowerCase();
      if (!query || hay.includes(query)) {
        allElements.push(item);
      }
    }
    window.__vnbotRefSeq = counter;

    const shown = allElements.slice(0, 80);
    const controlLines = shown.length
      ? shown.map((el) => {
          const v = el.value !== undefined && el.value !== "" ? " value=" + JSON.stringify(el.value) : "";
          return "- " + el.role + " " + JSON.stringify(el.name) + " [" + el.ref + "]" + v;
        }).join("\\n")
      : "(no interactive elements)";

    const bodyText = clean(document.body ? document.body.innerText || "" : "", 3500);
    const tree = bodyText
      ? controlLines + "\\n\\nPage text:\\n" + bodyText
      : controlLines;

    return {
      url: String(window.location.href || "about:blank"),
      title: String(document.title || ""),
      loading: document.readyState !== "complete",
      tree: tree.slice(0, 10000),
      elements: shown
    };
  })()`;
}

export interface DomStepPlan {
  status: "click_point" | "applied" | "upload_ready" | "stale" | "refused";
  x?: number;
  y?: number;
  typeText?: string;
  selector?: string;
  error?: string;
}

export function buildPrepareActStepExpression(step: BrowserActStep): string {
  const payload = JSON.stringify(step);
  return `(() => {
    const step = ${payload};
    const REOPEN_SAVED_SITE = "Open the saved site with browser_navigate, then fill again.";
    const REOPEN_MERCHANT_SITE = "Open the merchant's checkout with browser_navigate, then fill again.";
    const CARD_AUTOCOMPLETE = {
      number: "cc-number",
      expiry: "cc-exp",
      cvc: "cc-csc",
      postal_code: "postal-code"
    };

    const isCard = step.field === "card";
    if (step.origin || isCard) {
      const notHttps = isCard
        ? "A card can only be filled on HTTPS. " + REOPEN_MERCHANT_SITE
        : "Website logins can only be filled on HTTPS. " + REOPEN_SAVED_SITE;
      let pageUrl;
      let savedUrl;
      try {
        pageUrl = new URL(window.location.href);
        savedUrl = new URL(step.origin || "");
      } catch {
        return { status: "refused", error: notHttps };
      }
      if (savedUrl.protocol !== "https:" || pageUrl.protocol !== "https:") {
        return { status: "refused", error: notHttps };
      }
      if (pageUrl.origin !== savedUrl.origin) {
        return {
          status: "refused",
          error: isCard
            ? "The page is not on the merchant's site for this purchase. " + REOPEN_MERCHANT_SITE
            : "This login is saved for " + savedUrl.origin + "; the page is on " + pageUrl.origin + ". " + REOPEN_SAVED_SITE
        };
      }
    }

    let el = null;
    if (step.ref !== undefined) {
      el = document.querySelector("[data-vnbot-ref=" + JSON.stringify(step.ref) + "]");
      if (!el) {
        return {
          status: "stale",
          error: 'Stale element ref "' + step.ref + '": the page has changed since that snapshot. Use a ref from the page below.'
        };
      }
    } else if ("cardField" in step && step.cardField) {
      const token = CARD_AUTOCOMPLETE[step.cardField];
      const matches = Array.from(document.querySelectorAll("input")).filter((input) => {
        const t = (input.type || "text").toLowerCase();
        if (t !== "text" && t !== "tel" && t !== "password") return false;
        if (input.disabled || input.readOnly) return false;
        const ac = (input.getAttribute("autocomplete") || "").toLowerCase().split(/\\s+/);
        return ac.includes(token);
      });
      if (matches.length === 0) {
        return {
          status: "refused",
          error: "No field for this card detail was found on the page. Pass its ref from browser_snapshot."
        };
      }
      if (matches.length > 1) {
        return {
          status: "refused",
          error: "More than one field on the page takes this card detail. Pass its ref from browser_snapshot."
        };
      }
      el = matches[0];
      if (!el.getAttribute("data-vnbot-ref")) {
        const seq = Number(window.__vnbotRefSeq || 0) + 1;
        window.__vnbotRefSeq = seq;
        el.setAttribute("data-vnbot-ref", "e" + seq);
      }
    } else {
      return { status: "refused", error: "Element ref is required." };
    }

    if (el.disabled || el.getAttribute("aria-disabled") === "true") {
      return {
        status: "refused",
        error: "That control is disabled, so nothing happened. Pick another control from this snapshot."
      };
    }

    el.scrollIntoView({ block: "center", inline: "center", behavior: "instant" });

    if (step.kind === "upload") {
      if (el.tagName.toLowerCase() !== "input" || (el.getAttribute("type") || "").toLowerCase() !== "file") {
        return { status: "refused", error: "upload needs a file upload element from browser_snapshot" };
      }
      if (Array.isArray(step.paths) && step.paths.length > 1 && !el.multiple) {
        return { status: "refused", error: "This file upload accepts one file" };
      }
      return {
        status: "upload_ready",
        selector: "[data-vnbot-ref=" + JSON.stringify(el.getAttribute("data-vnbot-ref")) + "]"
      };
    }

    if (step.kind === "click") {
      const rect = el.getBoundingClientRect();
      if (rect.width <= 0 || rect.height <= 0) {
        el.click();
        return { status: "applied" };
      }
      return {
        status: "click_point",
        x: Math.round(rect.left + rect.width / 2),
        y: Math.round(rect.top + rect.height / 2)
      };
    }

    if (step.kind === "fill" || step.kind === "type") {
      const tag = el.tagName.toLowerCase();
      if (step.field === "password" && (tag !== "input" || (el.type || "").toLowerCase() !== "password")) {
        return { status: "refused", error: "A saved password can only be typed into a password field." };
      }
      if (step.origin || isCard || step.field === "password") {
        el.setAttribute("data-vnbot-secret", "1");
      }
      if (tag === "select") {
        const target = String(step.text || "");
        const option = Array.from(el.options).find(
          (opt) => opt.value === target || (opt.textContent || "").trim() === target,
        );
        if (!option || option.disabled) {
          return { status: "refused", error: "No enabled option matched " + JSON.stringify(target) };
        }
        el.value = option.value;
        el.dispatchEvent(new Event("input", { bubbles: true }));
        el.dispatchEvent(new Event("change", { bubbles: true }));
        return { status: "applied" };
      }
      el.focus();
      if (tag === "input" || tag === "textarea") {
        const proto = tag === "textarea" ? window.HTMLTextAreaElement.prototype : window.HTMLInputElement.prototype;
        const setter = Object.getOwnPropertyDescriptor(proto, "value")?.set;
        const nextVal = step.kind === "fill" ? String(step.text || "") : String(el.value || "") + String(step.text || "");
        if (setter) setter.call(el, nextVal);
        else el.value = nextVal;
        el.dispatchEvent(new InputEvent("input", { bubbles: true, data: String(step.text || ""), inputType: "insertText" }));
        el.dispatchEvent(new Event("change", { bubbles: true }));
        return { status: "applied" };
      }
      if (step.kind === "fill") {
        el.textContent = "";
      }
      return { status: "applied", typeText: String(step.text || "") };
    }

    return { status: "refused", error: "Unsupported browser action: " + String(step.kind) };
  })()`;
}

export function buildPurchaseCheckExpression(request: {
  actions?: Array<{ kind: string; ref?: string }>;
  desktop?: boolean;
  enter?: boolean;
  points?: Array<{ x: number; y: number }>;
  unplaced?: boolean;
}): string {
  const serialized = JSON.stringify(request);
  return `(() => {
    const req = ${serialized};
    const BUY_RE = /\\b(place order|complete order|buy now|pay now|complete purchase|confirm and pay|submit order|thanh toán|đặt hàng|mua ngay)\\b/i;
    const AMOUNT_RE = /(?:\\$|€|£|₫|USD|VND)\\s?\\d[\\d.,]*|\\d[\\d.,]*\\s?(?:₫|đ|VND|USD)/i;

    function labelFor(el) {
      if (!el || !(el instanceof Element)) return "";
      return String(
        el.getAttribute("aria-label") ||
          el.innerText ||
          el.textContent ||
          el.getAttribute("value") ||
          ""
      ).replace(/\\s+/g, " ").trim().slice(0, 120);
    }

    const targets = [];
    if (Array.isArray(req.actions)) {
      req.actions.forEach((act, idx) => {
        if (act && act.kind === "click" && act.ref) {
          const el = document.querySelector("[data-vnbot-ref=" + JSON.stringify(act.ref) + "]");
          if (el) targets.push({ step: idx, el });
        }
      });
    }
    if (Array.isArray(req.points)) {
      req.points.forEach((pt, idx) => {
        const hit = document.elementFromPoint(pt.x, pt.y);
        const btn = hit?.closest("button, a, input[type='submit'], input[type='button'], [role='button']") || hit;
        if (btn) targets.push({ step: idx, el: btn });
      });
    }
    if (req.enter && document.activeElement) {
      const form = document.activeElement.closest("form");
      const submit = form?.querySelector("button[type='submit'], input[type='submit'], button:not([type])") || document.activeElement;
      if (submit) targets.push({ step: 0, el: submit });
    }

    const matchedSteps = [];
    let matchedLabel = "";
    for (const item of targets) {
      const label = labelFor(item.el);
      if (BUY_RE.test(label)) {
        matchedSteps.push(item.step);
        if (!matchedLabel) matchedLabel = label;
      }
    }
    if (matchedSteps.length === 0) {
      return { ok: true, purchase: null };
    }
    const buttonAmount = matchedLabel.match(AMOUNT_RE)?.[0] || "";
    const pageText = document.body ? document.body.innerText || "" : "";
    const pageAmount = pageText.match(AMOUNT_RE)?.[0] || "";
    return {
      ok: true,
      site: window.location.hostname || "",
      purchase: {
        steps: matchedSteps,
        label: matchedLabel,
        amount: buttonAmount || pageAmount,
        amountFrom: buttonAmount ? "button" : "page"
      }
    };
  })()`;
}
