// i18n test: catalog invariants in plain Node (key parity, source reference
// coverage, CJK leak scan) plus a browser pass over the language switcher
// (default English, runtime switch, persistence, no reload).
import { spawn } from "node:child_process";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright-core";

import { getLocale, setLocale, t } from "../src/core/i18n.js";
import { messages as enMessages } from "../src/core/locales/en.js";
import { messages as zhMessages } from "../src/core/locales/zh-CN.js";

const root = fileURLToPath(new URL("..", import.meta.url));
const port = 4174;
const baseUrl = `http://127.0.0.1:${port}`;
const edgeCandidates = [
  "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
  "C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe",
  "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
  "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
];
const browserPath = edgeCandidates.find(existsSync);

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

const CJK_PATTERN = /[\u4e00-\u9fff]/;

function flatEntries(source, prefix = "", target = new Map()) {
  for (const [key, value] of Object.entries(source)) {
    const path = prefix ? `${prefix}.${key}` : key;
    if (value && typeof value === "object") flatEntries(value, path, target);
    else target.set(path, String(value));
  }
  return target;
}

// Files that legitimately keep CJK literals. The language switcher shows each
// option in its own language ("English" / "中文"), so that one stays literal.
const CJK_WHITELIST = [
  { file: "index.html", pattern: /<option value="zh-CN">/ },
];

function isCjkWhitelisted(relativePath, line) {
  return CJK_WHITELIST.some((entry) => entry.file === relativePath && entry.pattern.test(line));
}

function walkSourceFiles(directory, target = []) {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (entry.name !== "locales") walkSourceFiles(join(directory, entry.name), target);
    } else if (entry.name.endsWith(".js")) {
      target.push(join(directory, entry.name));
    }
  }
  return target;
}

// Every key referenced by index.html data-i18n* attributes and every t()/tCount()
// call in src/ must resolve in the en catalog — a typo would otherwise render the
// raw key at runtime and in the English UI.
function checkSourceReferences(en) {
  const html = readFileSync(join(root, "index.html"), "utf8");
  const htmlKeys = new Set();
  for (const match of html.matchAll(/data-i18n(?:-[a-z-]+)?="([^"]+)"/g)) {
    htmlKeys.add(match[1]);
  }
  const problems = [];
  for (const key of htmlKeys) {
    if (!en.has(key)) problems.push(`index.html: ${key}`);
  }

  const scanTargets = [
    { relativePath: "index.html", text: html },
    ...walkSourceFiles(join(root, "src")).map((file) => ({
      relativePath: relative(root, file).split(sep).join("/"),
      text: readFileSync(file, "utf8"),
    })),
  ];

  const cjkLines = [];
  for (const { relativePath, text } of scanTargets) {
    text.split(/\r?\n/).forEach((line, index) => {
      for (const match of line.matchAll(/\bt\(\s*"([^"]+)"/g)) {
        if (!en.has(match[1])) problems.push(`${relativePath}:${index + 1}: ${match[1]}`);
      }
      for (const match of line.matchAll(/\btCount\(\s*"([^"]+)"/g)) {
        for (const suffix of ["one", "other"]) {
          if (!en.has(`${match[1]}.${suffix}`)) {
            problems.push(`${relativePath}:${index + 1}: ${match[1]}.${suffix}`);
          }
        }
      }
      if (CJK_PATTERN.test(line) && !isCjkWhitelisted(relativePath, line)) {
        cjkLines.push(`${relativePath}:${index + 1}`);
      }
    });
  }

  assert(problems.length === 0, `Message keys missing from en.js:\n  ${problems.join("\n  ")}`);
  assert(
    cjkLines.length === 0,
    `Unexpected CJK literals (outside locales/ and the whitelist):\n  ${cjkLines.join("\n  ")}`,
  );
}

function checkCatalogInvariants() {
  const en = flatEntries(enMessages);
  const zh = flatEntries(zhMessages);
  const enKeys = [...en.keys()].sort();
  const zhKeys = [...zh.keys()].sort();
  assert(
    JSON.stringify(enKeys) === JSON.stringify(zhKeys),
    `Catalog key sets differ:\n  only en: ${enKeys.filter((key) => !zh.has(key)).join(", ")}\n  only zh: ${zhKeys.filter((key) => !en.has(key)).join(", ")}`,
  );
  for (const [key, value] of en) {
    assert(!CJK_PATTERN.test(value), `en.js value for "${key}" contains CJK characters.`);
  }
  for (const [key, value] of zh) {
    assert(value.length > 0, `zh-CN.js value for "${key}" is empty.`);
  }

  checkSourceReferences(en);

  setLocale("zh-CN");
  assert(getLocale() === "zh-CN", "setLocale('zh-CN') did not stick.");
  assert(t("language.label") === zh.get("language.label"), "t() did not return the zh-CN value.");
  setLocale("en");
  assert(t("language.label") === en.get("language.label"), "t() did not return the English value.");
  setLocale("bogus");
  assert(getLocale() === "en", "setLocale() must normalize unsupported values to 'en'.");
  assert(t("no.such.key") === "no.such.key", "t() must fall back to the raw key.");
  console.log("i18n catalog invariants passed.");
}

async function main() {
  if (!browserPath) {
    throw new Error("No Edge or Chrome installation found for the browser test.");
  }
  checkCatalogInvariants();

  const server = spawn(
    process.execPath,
    [join(root, "node_modules", "vite", "bin", "vite.js"), "--host", "127.0.0.1", "--port", String(port)],
    { cwd: root, stdio: ["ignore", "pipe", "pipe"], env: { ...process.env } },
  );
  let serverOutput = "";
  server.stdout.on("data", (chunk) => {
    serverOutput += chunk.toString();
  });
  server.stderr.on("data", (chunk) => {
    serverOutput += chunk.toString();
  });

  let browser;
  try {
    const deadline = Date.now() + 20000;
    while (Date.now() < deadline) {
      try {
        const response = await fetch(baseUrl);
        if (response.ok) break;
      } catch {
        // Server is still starting.
      }
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
    const reachable = await fetch(baseUrl).then(
      (response) => response.ok,
      () => false,
    );
    assert(reachable, `Vite dev server did not start.\n${serverOutput}`);

    browser = await chromium.launch({ executablePath: browserPath, headless: true });
    const context = await browser.newContext({
      viewport: { width: 1440, height: 1000 },
      deviceScaleFactor: 1,
    });
    const page = await context.newPage();
    const pageErrors = [];
    page.on("pageerror", (error) => pageErrors.push(String(error)));
    await page.goto(baseUrl, { waitUntil: "domcontentloaded" });
    await page.waitForSelector("#uiLanguageSelect");

    // 1. Fresh profile (no stored settings) defaults to English.
    const initialLang = await page.evaluate(() => document.documentElement.lang);
    assert(initialLang === "en", `Fresh profile should default to lang="en", got "${initialLang}".`);
    const initialValue = await page.inputValue("#uiLanguageSelect");
    assert(initialValue === "en", `Switcher should show "en" first, got "${initialValue}".`);

    // 2. Switching to zh-CN must not reload the page and must update lang.
    await page.evaluate(() => {
      window.__i18nSentinel = 42;
    });
    await page.selectOption("#uiLanguageSelect", "zh-CN");
    await page.waitForFunction(() => document.documentElement.lang === "zh-CN");
    const sentinel = await page.evaluate(() => window.__i18nSentinel);
    assert(sentinel === 42, "Switching language reloaded the page (sentinel lost).");
    const zhLabel = await page.getAttribute("#uiLanguageSelect", "aria-label");
    // Deliberate Chinese assertion: the suite has switched the UI to zh-CN here,
    // so the switcher's aria-label is expected in Chinese — do not "fix" this.
    assert(zhLabel === "界面语言", `Expected Chinese aria-label after switching, got "${zhLabel}".`);

    // 3. Any later settings write must keep the chosen locale (whitelist check).
    await page.evaluate(() => document.querySelector("#timestampToggle").click());
    const storedAfterToggle = await page.evaluate(() =>
      JSON.parse(localStorage.getItem("linktk.settings.v1") || "{}"),
    );
    assert(
      storedAfterToggle.uiLanguage === "zh-CN",
      `persistSettings dropped uiLanguage (stored: ${JSON.stringify(storedAfterToggle.uiLanguage)}).`,
    );

    // 4. Reload keeps the choice and applies it before first paint.
    await page.reload({ waitUntil: "domcontentloaded" });
    const reloadedLang = await page.evaluate(() => document.documentElement.lang);
    assert(reloadedLang === "zh-CN", `Reload should keep zh-CN, got "${reloadedLang}".`);
    const reloadedValue = await page.inputValue("#uiLanguageSelect");
    assert(reloadedValue === "zh-CN", `Switcher should show zh-CN after reload, got "${reloadedValue}".`);

    // 5. Switching back to English works without a reload too.
    await page.evaluate(() => {
      window.__i18nSentinel = 7;
    });
    await page.selectOption("#uiLanguageSelect", "en");
    await page.waitForFunction(() => document.documentElement.lang === "en");
    const sentinelBack = await page.evaluate(() => window.__i18nSentinel);
    assert(sentinelBack === 7, "Switching back to English reloaded the page.");
    const enLabel = await page.getAttribute("#uiLanguageSelect", "aria-label");
    assert(enLabel === "Interface language", `Expected English aria-label after switching back, got "${enLabel}".`);

    if (pageErrors.length) {
      throw new Error(`Page errors:\n${pageErrors.join("\n")}`);
    }
    console.log(
      "i18n test passed: catalogs are in sync, first run defaults to English, runtime switching, persistence and reload behavior work.",
    );
  } finally {
    await browser?.close();
    server.kill();
  }
}

await main();
