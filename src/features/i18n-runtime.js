// Module: i18n bootstrap and runtime language switching.
// Owns: initial locale setup, the topbar language selector, the meta description,
//       and the panel re-render sequence that runs when the language changes.
// Depends on: core/i18n.js, core/dom.js, core/settings.js and the feature modules that render localizable text.
// Used by: app.js initialize().

import { applyI18n, getLocale, onLocaleChange, setLocale, t } from "../core/i18n.js";
import { els } from "../core/dom.js";
import { persistSettings } from "../core/settings.js";
import { state } from "../core/state.js";
import { renderAgentActivity, updateAgentLeaseSummary, updateAgentUI } from "../agent/runtime.js";
import { updateAutoSaveDialogUI, updateAutoSaveLimitUI } from "./autosave.js";
import { updateBridgeUI } from "./bridge.js";
import { renderConnectionPresets } from "./connection-presets.js";
import { openDisplaySettingsDialog, updateCounters, updateMetrics } from "./log-view.js";
import { renderMacroList, updateMacroUI } from "./macro.js";
import { updateNetworkCounters, updateNetworkMetrics } from "./network.js";
import { updateNetworkUI } from "./network-runtime.js";
import { renderQuickCommandList } from "./quick-send.js";
import { updateResponseTestUI } from "./response-test.js";
import { fitSshTerminal, renderSshPresets, renderSshQuickPaths } from "./ssh.js";
import { updateTemplateButtonUI } from "./template.js";
import { fitTerminal } from "./terminal.js";
import { setConsoleView, updateConnectionUI, updateReceiveModeUI, updateSendModeUI } from "./view-controls.js";
import { handleYmodemFileSelection, updateYmodemUI } from "./ymodem.js";

function updateMetaDescription() {
  const meta = document.querySelector('meta[name="description"]');
  if (meta) meta.setAttribute("content", t("meta.description"));
}

// Re-renders every node whose text is written by JavaScript. Static [data-i18n]
// nodes are handled by applyI18n() in one pass — including the <dialog> elements,
// which are always present in the DOM whether open or not.
function applyLocale() {
  applyI18n(document);
  updateMetaDescription();
  updateConnectionUI();
  updateReceiveModeUI();
  updateSendModeUI();
  setConsoleView(state.consoleView, { focus: false, persist: false });
  updateCounters();
  updateMetrics();
  updateNetworkUI();
  updateNetworkCounters();
  updateNetworkMetrics();
  updateBridgeUI();
  renderQuickCommandList("serial");
  renderQuickCommandList("network");
  renderConnectionPresets("serial");
  renderConnectionPresets("network");
  renderSshPresets();
  renderSshQuickPaths();
  renderMacroList();
  updateMacroUI();
  renderAgentActivity();
  updateAgentUI();
  updateAgentLeaseSummary();
  updateAutoSaveLimitUI();
  updateAutoSaveDialogUI();
  updateResponseTestUI();
  updateTemplateButtonUI("serial");
  updateTemplateButtonUI("network");
  updateYmodemUI();
  if (state.ymodemFile && els.ymodemFileInput.files?.[0]) {
    handleYmodemFileSelection();
  }
  if (els.displaySettingsDialog.open) {
    const section = els.displaySettingsSections.find((element) => !element.hidden);
    openDisplaySettingsDialog(section?.dataset.displayTarget === "network" ? "network" : "serial");
  }
  fitTerminal();
  fitSshTerminal();
}

// Must run before applySettings() and before the first update*() call in
// app.js initialize() — text rendered before the locale is applied would stay
// in the wrong language until the next re-render.
function initializeI18n(initialLocale) {
  setLocale(initialLocale);
  applyI18n(document);
  updateMetaDescription();
  if (els.uiLanguageSelect) {
    els.uiLanguageSelect.value = getLocale();
    els.uiLanguageSelect.addEventListener("change", (event) => {
      setLocale(event.target.value);
    });
  }
  onLocaleChange(() => {
    els.uiLanguageSelect.value = getLocale();
    applyLocale();
    persistSettings();
  });
}

export { applyLocale, initializeI18n };
