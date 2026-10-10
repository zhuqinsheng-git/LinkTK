// Module: Local settings read, apply, and serial settings reset.
// Owns: compatibility-tolerant settings reading, state/DOM initialization, and default serial settings restore.
// Depends on: core, agent/catalog, autosave, log-view, macro, network, payload, quick-send, send-history, serial, ssh, template, toast, view-controls, ymodem.
// Called by: app.js initialization and reset entry points.

import { LEGACY_SETTINGS_KEYS, SETTINGS_KEY } from "../core/constants.js";
import { els } from "../core/dom.js";
import { t } from "../core/i18n.js";
import { defaultSettings, persistSettings } from "../core/settings.js";
import { state } from "../core/state.js";
import { normalizeDeviceProfiles, normalizeTaskTemplates } from "../agent/catalog.js";
import { normalizeAutoSaveLimit } from "./autosave.js";
import { normalizeTimestampMode } from "./log-view.js";
import { normalizeMacros, renderMacroList, setMacroCollapsed } from "./macro.js";
import { normalizeNetworkConnectionPresets, normalizeNetworkProtocol, normalizePort } from "./network.js";
import { normalizeAutoSendCount } from "./payload.js";
import { normalizeQuickCommands, renderQuickCommandList } from "./quick-send.js";
import { normalizeSendHistory } from "./send-history.js";
import { normalizeSerialConnectionPresets, setBaudRateValue } from "./serial.js";
import { normalizeSshPresets } from "./ssh.js";
import { normalizeTemplateCustomVariables } from "./template.js";
import { showToast } from "./toast.js";
import { updateReceiveModeUI, updateSendModeUI } from "./view-controls.js";
import { setYmodemCollapsed, setYmodemMode } from "./ymodem.js";

function readStoredSettings() {
  try {
    const stored =
      localStorage.getItem(SETTINGS_KEY) ||
      LEGACY_SETTINGS_KEYS.map((key) => localStorage.getItem(key)).find(Boolean) ||
      "{}";
    const parsed = JSON.parse(stored);
    return { ...defaultSettings, ...parsed };
  } catch {
    return { ...defaultSettings };
  }
}

function applySettings(settings) {
  setBaudRateValue(settings.baudRate);
  els.dataBits.value = settings.dataBits;
  els.stopBits.value = settings.stopBits;
  els.parity.value = settings.parity;
  els.flowControl.value = settings.flowControl;
  els.dtrToggle.checked = Boolean(settings.dtr);
  els.rtsToggle.checked = Boolean(settings.rts);
  els.lineEnding.value = settings.lineEnding;
  els.showRxToggle.checked = Boolean(settings.showRx);
  els.showTxToggle.checked = Boolean(settings.showTx);
  els.showSysToggle.checked = Boolean(settings.showSys);
  els.timestampToggle.checked = Boolean(settings.timestamp);
  els.autoScrollToggle.checked = Boolean(settings.autoScroll);
  els.ansiToggle.checked = Boolean(settings.ansiColors);
  els.dualModeToggle.checked = Boolean(settings.dualMode);
  els.autoSendCount.value = String(normalizeAutoSendCount(settings.autoSendCount));
  els.terminalLocalEcho.checked = Boolean(settings.terminalLocalEcho);
  state.sendPanelCollapsed = Boolean(settings.sendPanelCollapsed);
  state.quickSendCollapsed = Boolean(settings.quickSendCollapsed);
  state.controlPanelGroup = ["connection", "commands", "automation", "transfer"].includes(
    settings.controlPanelGroup,
  )
    ? settings.controlPanelGroup
    : "connection";
  state.serialConnectionPresets = normalizeSerialConnectionPresets(settings.serialConnectionPresets);
  state.serialQuickCommands = normalizeQuickCommands(settings.serialQuickCommands);
  state.serialSendHistory = normalizeSendHistory(settings.serialSendHistory);
  state.templateCustomVariables = normalizeTemplateCustomVariables(
    settings.templateCustomVariables,
  );
  state.responseExpected = String(settings.responseExpected || "OK").slice(0, 200);
  state.responseTimeout = Math.max(
    10,
    Math.min(120000, Number(settings.responseTimeout) || 1000),
  );
  state.responseCaseSensitive = Boolean(settings.responseCaseSensitive);
  state.autoSendCount = normalizeAutoSendCount(settings.autoSendCount);
  state.macroCollapsed = Boolean(settings.macroCollapsed);
  state.macros = normalizeMacros(settings.macros);
  state.ymodemMode = settings.ymodemMode === "receive" ? "receive" : "send";
  state.ymodemBlockSize = Number(settings.ymodemBlockSize) === 128 ? 128 : 1024;
  state.ymodemCollapsed = Boolean(settings.ymodemCollapsed);
  state.workspaceMode = settings.workspaceMode === "network" ? "network" : "serial";
  state.networkProtocol = normalizeNetworkProtocol(settings.networkProtocol);
  state.networkRole = settings.networkRole === "client" ? "client" : "server";
  state.networkHost = String(settings.networkHost || "127.0.0.1");
  state.networkPort = normalizePort(settings.networkPort, 9000);
  state.sshAlias = String(settings.sshAlias || "").slice(0, 80);
  state.sshHost = String(settings.sshHost || defaultSettings.sshHost).slice(0, 255);
  state.sshPort = normalizePort(settings.sshPort, defaultSettings.sshPort);
  state.sshUsername = String(
    settings.sshUsername || defaultSettings.sshUsername,
  ).slice(0, 120);
  state.sshSavePassword = Boolean(settings.sshSavePassword);
  state.sshPresets = normalizeSshPresets(settings.sshPresets);
  state.networkReceiveMode = settings.networkReceiveMode === "hex" ? "hex" : "text";
  state.networkSendMode = settings.networkSendMode === "hex" ? "hex" : "text";
  state.networkShowRx = Boolean(settings.networkShowRx);
  state.networkShowTx = Boolean(settings.networkShowTx);
  state.networkShowSys = Boolean(settings.networkShowSys);
  els.networkShowRxToggle.checked = Boolean(settings.networkShowRx);
  els.networkShowTxToggle.checked = Boolean(settings.networkShowTx);
  els.networkShowSysToggle.checked = Boolean(settings.networkShowSys);
  state.networkTimestamp = Boolean(settings.networkTimestamp);
  state.networkTimestampMode = normalizeTimestampMode(settings.networkTimestampMode);
  state.networkAutoScroll = Boolean(settings.networkAutoScroll);
  state.networkDualMode = Boolean(settings.networkDualMode);
  state.networkAutoSendCount = normalizeAutoSendCount(settings.networkAutoSendCount);
  state.keywordQuery = String(settings.keywordQuery || "");
  state.keywordFilter = Boolean(settings.keywordFilter);
  state.keywordCaseSensitive = Boolean(settings.keywordCaseSensitive);
  state.keywordWholeWord = Boolean(settings.keywordWholeWord);
  state.networkSendPanelCollapsed = Boolean(settings.networkSendPanelCollapsed);
  state.networkQuickSendCollapsed = Boolean(settings.networkQuickSendCollapsed);
  state.networkConnectionPresets = normalizeNetworkConnectionPresets(
    settings.networkConnectionPresets,
  );
  state.deviceProfiles = normalizeDeviceProfiles(settings.deviceProfiles);
  state.activeDeviceProfileId = String(settings.activeDeviceProfileId || "").slice(0, 120);
  if (
    state.activeDeviceProfileId &&
    !state.deviceProfiles.some((profile) => profile.id === state.activeDeviceProfileId)
  ) {
    state.activeDeviceProfileId = "";
  }
  state.taskTemplates = normalizeTaskTemplates(settings.taskTemplates);
  state.networkQuickCommands = normalizeQuickCommands(settings.networkQuickCommands);
  state.networkSendHistory = normalizeSendHistory(settings.networkSendHistory);
  state.autoSaveEnabled = Boolean(settings.autoSaveEnabled);
  state.autoSaveRotationMode = settings.autoSaveRotationMode === "time" ? "time" : "size";
  state.autoSaveLimit = normalizeAutoSaveLimit(
    state.autoSaveRotationMode,
    settings.autoSaveLimit,
  );
  state.autoSaveDirectoryName = String(settings.autoSaveDirectoryName || "");
  state.bridgeSerialToNetwork = Boolean(settings.bridgeSerialToNetwork);
  state.bridgeNetworkToSerial = Boolean(settings.bridgeNetworkToSerial);
  state.agentApprovalMode = ["read-only", "confirm-writes", "trusted"].includes(
    settings.agentApprovalMode,
  )
    ? settings.agentApprovalMode
    : "confirm-writes";
  els.networkHost.value = state.networkHost;
  els.networkPort.value = String(state.networkPort);
  els.sshAlias.value = state.sshAlias;
  els.sshHost.value = state.sshHost;
  els.sshPort.value = String(state.sshPort);
  els.sshUsername.value = state.sshUsername;
  els.sshSavePasswordToggle.checked = state.sshSavePassword;
  els.networkTimestampToggle.checked = state.networkTimestamp;
  els.networkAutoScrollToggle.checked = state.networkAutoScroll;
  els.networkDualModeToggle.checked = state.networkDualMode;
  els.networkAutoSendCount.value = String(state.networkAutoSendCount);
  els.autoSaveEnabledToggle.checked = state.autoSaveEnabled;
  els.autoSaveRotationMode.value = state.autoSaveRotationMode;
  els.autoSaveLimitInput.value = String(state.autoSaveLimit);
  els.autoSaveDirectoryName.textContent = state.autoSaveDirectoryName || t("autosave.dirNone");
  els.bridgeSerialToNetworkToggle.checked = state.bridgeSerialToNetwork;
  els.bridgeNetworkToSerialToggle.checked = state.bridgeNetworkToSerial;

  state.receiveMode = settings.receiveMode === "hex" ? "hex" : "text";
  state.sendMode = settings.sendMode === "hex" ? "hex" : "text";
  state.showRx = Boolean(settings.showRx);
  state.showTx = Boolean(settings.showTx);
  state.showSys = Boolean(settings.showSys);
  state.timestamp = Boolean(settings.timestamp);
  state.timestampMode = normalizeTimestampMode(settings.timestampMode);
  state.autoScroll = Boolean(settings.autoScroll);
  state.ansiColors = Boolean(settings.ansiColors);
  state.dualMode = Boolean(settings.dualMode);
  state.consoleView = settings.consoleView === "terminal" ? "terminal" : "log";
  state.terminalLocalEcho = Boolean(settings.terminalLocalEcho);
}

function resetSerialSettings() {
  const serialQuickCommands = [...state.serialQuickCommands];
  const networkQuickCommands = [...state.networkQuickCommands];
  const serialSendHistory = [...state.serialSendHistory];
  const networkSendHistory = [...state.networkSendHistory];
  const macros = state.macros.map((macro) => ({
    ...macro,
    steps: macro.steps.map((step) => ({ ...step })),
  }));
  const templateCustomVariables = state.templateCustomVariables.map((variable) => ({
    ...variable,
  }));
  const macroCollapsed = state.macroCollapsed;
  applySettings(defaultSettings);
  state.serialQuickCommands = serialQuickCommands;
  state.networkQuickCommands = networkQuickCommands;
  state.serialSendHistory = serialSendHistory;
  state.networkSendHistory = networkSendHistory;
  state.macros = macros;
  state.templateCustomVariables = templateCustomVariables;
  state.macroCollapsed = macroCollapsed;
  updateReceiveModeUI();
  updateSendModeUI();
  renderQuickCommandList("serial");
  renderQuickCommandList("network");
  renderMacroList();
  setMacroCollapsed(state.macroCollapsed, { persist: false });
  setYmodemMode(state.ymodemMode, { persist: false });
  setYmodemCollapsed(state.ymodemCollapsed, { persist: false });
  els.ymodemBlockSize.value = String(state.ymodemBlockSize);
  persistSettings();
  showToast(t("settings.resetDone"), "info");
}

export { applySettings, readStoredSettings, resetSerialSettings };
