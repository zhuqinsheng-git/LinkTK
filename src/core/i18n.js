// Module: locale state and message lookup (browser and Node safe).
// Owns: current locale, flattened catalogs, t()/tCount() interpolation, Intl number/date helpers, applyI18n() DOM pass.
// Depends on: locales/en.js and locales/zh-CN.js only. Never import core/dom.js or core/state.js here —
// they touch window at module scope and would break plain Node imports (tests/i18n.mjs relies on this).
// Used by: every module that renders user-visible text.

import { messages as enMessages } from "./locales/en.js";
import { messages as zhCNMessages } from "./locales/zh-CN.js";

const DEFAULT_LOCALE = "en";
const SUPPORTED_LOCALES = Object.freeze(["en", "zh-CN"]);

function flatten(source, prefix = "", target = new Map()) {
  for (const [key, value] of Object.entries(source)) {
    const path = prefix ? `${prefix}.${key}` : key;
    if (value && typeof value === "object") {
      flatten(value, path, target);
    } else {
      target.set(path, String(value));
    }
  }
  return target;
}

const catalogs = new Map([
  ["en", flatten(enMessages)],
  ["zh-CN", flatten(zhCNMessages)],
]);

let locale = DEFAULT_LOCALE;
const listeners = new Set();
const warnedKeys = new Set();

function normalizeLocale(value) {
  return SUPPORTED_LOCALES.includes(value) ? value : DEFAULT_LOCALE;
}

function lookup(key) {
  return catalogs.get(locale).get(key) ?? catalogs.get(DEFAULT_LOCALE).get(key);
}

function t(key, params) {
  const template = lookup(key);
  if (template === undefined) {
    if (!warnedKeys.has(key)) {
      warnedKeys.add(key);
      console.warn(`[i18n] missing message: ${String(key)}`);
    }
    return key;
  }
  if (!params) return template;
  return template.replace(/\{(\w+)\}/g, (match, name) =>
    Object.prototype.hasOwnProperty.call(params, name) ? String(params[name]) : match,
  );
}

// Plural-aware lookup. Callers pass the raw count; it is formatted for the active
// locale before interpolation. Templates must be whole sentences ("{count} steps")
// — never concatenate a number key with a separate unit key.
function tCount(key, count, params) {
  const suffix = count === 1 ? "one" : "other";
  return t(`${key}.${suffix}`, { count: formatNumber(count), ...params });
}

function intlLocale() {
  return locale === "zh-CN" ? "zh-CN" : "en-US";
}

function formatNumber(value, options) {
  return new Intl.NumberFormat(intlLocale(), options).format(value);
}

function formatDateTime(value, options) {
  return new Intl.DateTimeFormat(intlLocale(), options).format(value);
}

function getLocale() {
  return locale;
}

function setLocale(next) {
  const normalized = normalizeLocale(next);
  const changed = normalized !== locale;
  locale = normalized;
  if (typeof document !== "undefined" && document.documentElement) {
    document.documentElement.lang = locale;
  }
  if (changed) {
    for (const listener of [...listeners]) listener(locale);
  }
  return locale;
}

function onLocaleChange(listener) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function applyAttr(root, dataAttribute, targetAttribute) {
  for (const element of root.querySelectorAll(`[${dataAttribute}]`)) {
    element.setAttribute(targetAttribute, t(element.getAttribute(dataAttribute)));
  }
}

// Rewrites the static marked nodes of the given root. Only textContent is used —
// innerHTML would wipe icon children, so every marked element must own its text.
function applyI18n(root) {
  if (typeof document === "undefined") return;
  const scope = root || document;
  for (const element of scope.querySelectorAll("[data-i18n]")) {
    element.textContent = t(element.getAttribute("data-i18n"));
  }
  applyAttr(scope, "data-i18n-title", "title");
  applyAttr(scope, "data-i18n-placeholder", "placeholder");
  applyAttr(scope, "data-i18n-aria-label", "aria-label");
  applyAttr(scope, "data-i18n-short-label", "data-short-label");
}

export {
  SUPPORTED_LOCALES,
  applyI18n,
  formatDateTime,
  formatNumber,
  getLocale,
  onLocaleChange,
  setLocale,
  t,
  tCount,
};
