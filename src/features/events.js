// Module: Global DOM event binding.
// Owns: status pill explanations, the serial option element list, and bindEvents.
// Depends on: core DOM/state and the public operations of each feature.
// Called by: app.js during initialization, which calls bindEvents().

import { createAnsiStyle } from "../lib/ansi.js";
import { parentSshPath } from "../lib/ssh-path.js";
import { $$, els } from "../core/dom.js";
import { errorMessage } from "../core/errors.js";
import { t } from "../core/i18n.js";
import { defaultSettings, persistSettings } from "../core/settings.js";
import { state } from "../core/state.js";
import { closeBridgeDialog, openBridgeDialog, toggleBridge, updateBridgeUI } from "./bridge.js";
import { applyConnectionPreset, deleteConnectionPreset, saveConnectionPreset } from "./connection-presets.js";
import { applyMobileLayoutDefaults, setControlPanelGroup, setNetworkSendPanelCollapsed, setPortSectionCollapsed, setSerialSettingsCollapsed } from "./layout.js";
import { applyKeywordStateToLogs, applyTerminalKeywordSearch, closeDisplaySettingsDialog, closeFilterConfigDialog, handleLogCopyClick, openDisplaySettingsDialog, openFilterConfigDialog, resumeFollowing, saveLog, scrollToLatest, setKeywordOption, setKeywordQuery, setTimestampMode, toggleKeywordFilter, togglePause, updateCounters, updateFollowUI } from "./log-view.js";
import { closeMacroEditor, deleteMacro, openMacroEditor, saveMacroEditor, setMacroCollapsed, startMacroRecording, stopMacroPlayback, stopMacroRecording } from "./macro.js";
import { playMacro } from "./macro-runtime.js";
import { clearNetworkLog, normalizePort, resumeNetworkFollowing, saveNetworkLog, scrollNetworkToLatest, startNetworkAutoSend, stopNetworkAutoSend, updateNetworkFollowUI } from "./network.js";
import { sendNetworkPayload, setNetworkProtocol, toggleNetworkConnection, toggleNetworkPause, updateNetworkUI } from "./network-runtime.js";
import { normalizeAutoSendCount } from "./payload.js";
import { addQuickCommand, bindQuickCommandList, setNetworkQuickSendCollapsed, setQuickSendCollapsed } from "./quick-send.js";
import { closeResponseTestDialog, openResponseTestDialog, startResponseTest } from "./response-test.js";
import { handleSendHistoryKeydown, resetSendHistoryNavigation } from "./send-history.js";
import { connectSelectedPort, disconnectPort, handleSend, refreshPorts, requestPort, startAutoSend, stopAutoSend, updatePortSelection } from "./serial-runtime.js";
import { applySignalState } from "./serial.js";
import { resetSerialSettings } from "./settings-runtime.js";
import { closeSshFileDialog, createSshDirectory, deleteSelectedSshEntry, downloadSelectedSshFile, fitSshTerminal, loadSshDirectory, openSshFileDialog, renameSelectedSshEntry, selectSshFile, uploadSshFiles } from "./ssh.js";
import { addCurrentSshQuickPath, applySshPreset, deleteSshPreset, removeSshQuickPath, saveSshPreset } from "./ssh-presets.js";
import { closeSshConnectDialog, connectSshFromDialog, openSshConnectDialog } from "./ssh-runtime.js";
import { addTemplateVariable, closeTemplateVariablesDialog, deleteTemplateVariable, insertCustomTemplateToken, insertTemplateToken, openTemplateVariablesDialog, saveTemplateVariables } from "./template.js";
import { fitTerminal } from "./terminal.js";
import { showToast } from "./toast.js";
import { clearCurrentView, closeAdvancedSerialSettings, handleGlobalShortcut, openAdvancedSerialSettings, setConsoleView, setSendPanelCollapsed, setWorkspaceMode, updateConnectionUI, updateReceiveModeUI, updateSendModeUI, updateTogglesUI } from "./view-controls.js";
import { handleYmodemFileSelection, setYmodemCollapsed, setYmodemMode } from "./ymodem.js";
import { cancelYmodemTransfer, startYmodemReceive, startYmodemSend } from "./ymodem-runtime.js";
import { runAgentTaskFromUI } from "../agent/bridge-controller.js";
import { cancelAgentOperation, clearAgentUploadApprovals, getAgentOperationForStatus, settleAgentApproval } from "../agent/operations.js";
import { publishAgentState, renderAgentActivity, updateAgentUI } from "../agent/runtime.js";
import { closeAgentActivityDialog, closeAgentDeviceProfileDialog, copyMcpConfigToClipboard, deleteAgentDeviceProfileFromDialog, deleteAgentTaskFromUI, openAgentActivityDialog, openAgentDeviceProfileDialog, renameAgentSession, saveAgentDeviceProfileFromDialog, saveAgentTaskFromOperationFromUI, setAgentActivityView, setAgentPaused, showAgentEvidence } from "../agent/ui.js";
import { chooseAutoSaveDirectory, closeAutoSaveDialog, flushAutoSave, openAutoSaveDialog, saveAutoSaveSettings, updateAutoSaveLimitUI } from "./autosave.js";

const SERIAL_OPTION_ELEMENTS = [
  els.baudRate,
  els.dataBits,
  els.stopBits,
  els.parity,
  els.flowControl,
  els.dtrToggle,
  els.rtsToggle,
];

function bindStatusPillExplanation(element) {
  if (!element) return;
  element.classList.add("status-pill--interactive");
  element.tabIndex = 0;
  element.setAttribute("role", "button");
  const showExplanation = () => {
    const label = element
      .querySelector("span:not(.status-pill__lamp)")
      ?.textContent?.trim();
    const explanation = String(element.title || label || "").trim();
    showToast(explanation || t("common.noExplanation"), "info");
  };
  element.addEventListener("click", showExplanation);
  element.addEventListener("keydown", (event) => {
    if (event.key !== "Enter" && event.key !== " ") return;
    event.preventDefault();
    showExplanation();
  });
}

function bindEvents() {
  [
    els.agentState,
    els.headerStatus,
    els.networkHeaderStatus,
  ].forEach((element) => bindStatusPillExplanation(element));
  els.serialControlTabs.forEach((button) => {
    button.addEventListener("click", () => {
      setControlPanelGroup(button.dataset.serialControlGroup);
    });
  });
  els.portSectionToggleButton?.addEventListener("click", () => {
    setPortSectionCollapsed(!els.portSection.classList.contains("is-collapsed"));
  });
  els.serialSettingsToggleButton?.addEventListener("click", () => {
    setSerialSettingsCollapsed(!els.serialSettingsSection.classList.contains("is-collapsed"));
  });
  window.matchMedia("(max-width: 680px)").addEventListener("change", applyMobileLayoutDefaults);

  els.agentActivityButton.addEventListener("click", openAgentActivityDialog);
  els.agentActivityTabButtons.forEach((button) => {
    button.addEventListener("click", () => {
      setAgentActivityView(button.dataset.agentActivityView, { focus: true });
    });
  });
  els.agentCopyMcpConfigButton?.addEventListener("click", () => {
    void copyMcpConfigToClipboard();
  });
  els.closeAgentActivityButton.addEventListener("click", closeAgentActivityDialog);
  $$("[data-close-agent-activity]").forEach((button) => {
    button.addEventListener("click", closeAgentActivityDialog);
  });
  els.agentActivityDialog.addEventListener("cancel", (event) => {
    event.preventDefault();
    closeAgentActivityDialog();
  });
  els.agentActivityDialog.addEventListener("close", () => {
    state.agentActivityOpen = false;
    if (state.agentActivityLeaseTimer) {
      window.clearInterval(state.agentActivityLeaseTimer);
      state.agentActivityLeaseTimer = null;
    }
  });
  els.agentActivityDialog.addEventListener("click", (event) => {
    if (event.target === els.agentActivityDialog) closeAgentActivityDialog();
  });
  els.agentActivityList.addEventListener("click", (event) => {
    const button = event.target.closest("[data-agent-action]");
    if (!button) return;
    const operationId = button.dataset.operationId || "";
    if (button.dataset.agentAction === "evidence") showAgentEvidence(operationId);
    if (button.dataset.agentAction === "save-task") {
      saveAgentTaskFromOperationFromUI(operationId);
    }
  });
  els.agentTaskList.addEventListener("click", (event) => {
    const button = event.target.closest("[data-agent-action]");
    if (!button) return;
    const taskId = button.dataset.taskId || "";
    if (button.dataset.agentAction === "run-task") runAgentTaskFromUI(taskId);
    if (button.dataset.agentAction === "delete-task") deleteAgentTaskFromUI(taskId);
  });
  els.agentDeviceProfileButton.addEventListener("click", () =>
    openAgentDeviceProfileDialog(),
  );
  els.agentProfileSelect?.addEventListener("change", () => {
    openAgentDeviceProfileDialog(els.agentProfileSelect.value);
  });
  els.agentCreateTaskButton.addEventListener("click", () => {
    const operation = getAgentOperationForStatus("");
    if (!operation) {
      showToast(t("agent.tasks.noneToSave"), "info");
      return;
    }
    saveAgentTaskFromOperationFromUI(operation.id);
  });
  els.agentProfileSaveButton.addEventListener("click", saveAgentDeviceProfileFromDialog);
  els.agentProfileDeleteButton.addEventListener("click", deleteAgentDeviceProfileFromDialog);
  $$("[data-close-agent-profile]").forEach((button) => {
    button.addEventListener("click", closeAgentDeviceProfileDialog);
  });
  els.agentDeviceProfileDialog.addEventListener("cancel", (event) => {
    event.preventDefault();
    closeAgentDeviceProfileDialog();
  });
  els.agentDeviceProfileDialog.addEventListener("click", (event) => {
    if (event.target === els.agentDeviceProfileDialog) closeAgentDeviceProfileDialog();
  });
  els.agentSessionRenameButton.addEventListener("click", renameAgentSession);
  els.agentPauseButton.addEventListener("click", () => {
    setAgentPaused(!state.agentPaused);
  });
  els.agentCancelOperationButton.addEventListener("click", () => {
    try {
      cancelAgentOperation();
      showToast(t("agent.cancelRequested"), "info");
    } catch (error) {
      showToast(errorMessage(error, t("agent.cancelFailed")), "error");
    }
  });
  els.agentClearActivityButton.addEventListener("click", () => {
    state.agentActivity = [];
    state.agentActivityLastSeenSequence = state.agentOperationSequence;
    state.agentActivityExpanded.clear();
    renderAgentActivity();
  });
  els.agentApprovalMode.addEventListener("change", () => {
    state.agentApprovalMode = ["read-only", "confirm-writes", "trusted"].includes(
      els.agentApprovalMode.value,
    )
      ? els.agentApprovalMode.value
      : "confirm-writes";
    if (state.agentApprovalMode !== "confirm-writes") {
      clearAgentUploadApprovals();
    }
    persistSettings();
    publishAgentState();
    updateAgentUI();
  });
  els.agentApprovalAllowButton.addEventListener("click", () => {
    settleAgentApproval(true);
  });
  els.agentApprovalDenyButton.addEventListener("click", () => {
    settleAgentApproval(false);
  });
  els.agentApprovalDialog.addEventListener("cancel", (event) => {
    event.preventDefault();
    settleAgentApproval(false);
  });

  els.workspaceSwitchButtons.forEach((button) => {
    button.addEventListener("click", () => setWorkspaceMode(button.dataset.workspaceMode));
  });

  els.consoleViewButtons.forEach((button) => {
    button.addEventListener("click", () => {
      setConsoleView(button.dataset.consoleView);
    });
  });
  els.terminalLocalEcho.addEventListener("change", () => {
    state.terminalLocalEcho = els.terminalLocalEcho.checked;
    persistSettings();
  });
  els.terminalKeywordInput.addEventListener("input", () => {
    setKeywordQuery(els.terminalKeywordInput.value);
  });
  els.terminalKeywordInput.addEventListener("keydown", (event) => {
    if (event.key !== "Enter") return;
    event.preventDefault();
    applyTerminalKeywordSearch({ direction: event.shiftKey ? "previous" : "next" });
  });
  els.terminalKeywordPreviousButton.addEventListener("click", () => {
    applyTerminalKeywordSearch({ direction: "previous" });
    els.terminal?.focus();
  });
  els.terminalKeywordNextButton.addEventListener("click", () => {
    applyTerminalKeywordSearch({ direction: "next" });
    els.terminal?.focus();
  });

  els.bridgeButton.addEventListener("click", openBridgeDialog);
  els.closeBridgeDialogButton.addEventListener("click", closeBridgeDialog);
  els.confirmBridgeDialogButton.addEventListener("click", closeBridgeDialog);
  els.bridgeToggleButton.addEventListener("click", toggleBridge);
  els.bridgeDialog.addEventListener("click", (event) => {
    if (event.target === els.bridgeDialog) closeBridgeDialog();
  });
  els.bridgeSerialToNetworkToggle.addEventListener("change", () => {
    state.bridgeSerialToNetwork = els.bridgeSerialToNetworkToggle.checked;
    persistSettings();
    updateBridgeUI();
  });
  els.bridgeNetworkToSerialToggle.addEventListener("change", () => {
    state.bridgeNetworkToSerial = els.bridgeNetworkToSerialToggle.checked;
    persistSettings();
    updateBridgeUI();
  });

  els.portSelect.addEventListener("change", updatePortSelection);
  els.requestPortButton.addEventListener("click", requestPort);
  els.refreshPortsButton.addEventListener("click", async () => {
    await refreshPorts();
    showToast(t("serial.portsRefreshed"), "info");
  });
  els.connectButton.addEventListener("click", () => {
    if (state.connected) {
      void disconnectPort();
    } else {
      void connectSelectedPort();
    }
  });
  els.restoreDefaultsButton.addEventListener("click", resetSerialSettings);
  els.openAdvancedSerialSettingsButton.addEventListener("click", openAdvancedSerialSettings);
  els.closeAdvancedSerialSettingsButton.addEventListener("click", closeAdvancedSerialSettings);
  els.confirmAdvancedSerialSettingsButton.addEventListener("click", closeAdvancedSerialSettings);
  els.advancedSerialSettingsDialog.addEventListener("click", (event) => {
    if (event.target === els.advancedSerialSettingsDialog) {
      closeAdvancedSerialSettings();
    }
  });

  SERIAL_OPTION_ELEMENTS.forEach((element) => {
    element.addEventListener("change", () => {
      persistSettings();
      if (state.connected && (element === els.dtrToggle || element === els.rtsToggle)) {
        void applySignalState();
      }
    });
  });

  els.receiveModeButtons.forEach((button) => {
    button.addEventListener("click", () => {
      state.receiveMode = button.dataset.receiveMode;
      updateReceiveModeUI();
      persistSettings();
    });
  });

  els.sendModeButtons.forEach((button) => {
    button.addEventListener("click", () => {
      state.sendMode = button.dataset.sendMode;
      updateSendModeUI();
      persistSettings();
    });
  });

  [
    els.showRxToggle,
    els.showTxToggle,
    els.showSysToggle,
    els.timestampToggle,
    els.dualModeToggle,
  ].forEach((element) => {
    element.addEventListener("change", () => {
      updateTogglesUI();
      persistSettings();
      updateReceiveModeUI();
      applyKeywordStateToLogs();
    });
  });

  els.timestampModeButtons.forEach((button) => {
    button.addEventListener("click", () => {
      setTimestampMode("serial", button.dataset.timestampMode);
    });
  });

  [els.autoScrollToggle, els.ansiToggle].forEach((element) => {
    element.addEventListener("change", () => {
      updateTogglesUI();
      state.ansiRemainders.rx = "";
      state.ansiRemainders.tx = "";
      state.ansiStyles.rx = createAnsiStyle();
      state.ansiStyles.tx = createAnsiStyle();
      persistSettings();
      updateReceiveModeUI();
      applyKeywordStateToLogs();
      state.followSuspended = false;
      updateFollowUI();
      if (state.autoScroll) scrollToLatest();
    });
  });

  els.serialDisplaySettingsButton.addEventListener("click", () =>
    openDisplaySettingsDialog("serial"),
  );
  els.networkDisplaySettingsButton.addEventListener("click", () =>
    openDisplaySettingsDialog("network"),
  );
  els.closeDisplaySettingsButton.addEventListener("click", closeDisplaySettingsDialog);
  els.confirmDisplaySettingsButton.addEventListener("click", closeDisplaySettingsDialog);

  [els.keywordInput, els.networkKeywordInput].forEach((input) => {
    input.addEventListener("input", () => setKeywordQuery(input.value));
  });
  els.filterConfigButtons.forEach((button) => {
    button.addEventListener("click", openFilterConfigDialog);
  });
  els.closeFilterConfigButton.addEventListener("click", closeFilterConfigDialog);
  els.confirmFilterConfigButton.addEventListener("click", closeFilterConfigDialog);
  els.filterConfigDialog.addEventListener("click", (event) => {
    if (event.target === els.filterConfigDialog) closeFilterConfigDialog();
  });
  els.keywordCaseSensitiveToggle.addEventListener("change", () => {
    setKeywordOption("case", els.keywordCaseSensitiveToggle.checked);
  });
  els.keywordWholeWordToggle.addEventListener("change", () => {
    setKeywordOption("whole-word", els.keywordWholeWordToggle.checked);
  });
  [els.keywordFilterButton, els.networkKeywordFilterButton].forEach((button) => {
    button.addEventListener("click", toggleKeywordFilter);
  });
  [els.logContent, els.networkLogContent].forEach((root) => {
    root.addEventListener("click", handleLogCopyClick);
  });

  els.followLatestButton.addEventListener("click", resumeFollowing);

  els.lineEnding.addEventListener("change", () => {
    persistSettings();
    updateConnectionUI();
  });

  els.pauseButton.addEventListener("click", togglePause);
  els.autoSaveButton.addEventListener("click", openAutoSaveDialog);
  els.closeAutoSaveButton.addEventListener("click", closeAutoSaveDialog);
  els.cancelAutoSaveButton.addEventListener("click", closeAutoSaveDialog);
  els.saveAutoSaveButton.addEventListener("click", () => void saveAutoSaveSettings());
  els.chooseAutoSaveDirectoryButton.addEventListener("click", () =>
    void chooseAutoSaveDirectory(),
  );
  els.autoSaveRotationMode.addEventListener("change", updateAutoSaveLimitUI);
  els.autoSaveDialog.addEventListener("click", (event) => {
    if (event.target === els.autoSaveDialog) closeAutoSaveDialog();
  });
  els.saveButton.addEventListener("click", saveLog);
  els.clearButton.addEventListener("click", clearCurrentView);
  els.clearInputButton.addEventListener("click", () => {
    els.sendInput.value = "";
    resetSendHistoryNavigation("serial");
    updateConnectionUI();
  });
  els.toggleSendPanelButton.addEventListener("click", () => {
    setSendPanelCollapsed(!state.sendPanelCollapsed);
  });
  els.quickSendToggleButton.addEventListener("click", () => {
    setQuickSendCollapsed(!state.quickSendCollapsed);
  });
  els.addQuickCommandButton.addEventListener("click", () => addQuickCommand("serial"));
  bindQuickCommandList("serial", els.quickCommandList);
  els.serialTemplateButton.addEventListener("click", () =>
    openTemplateVariablesDialog("serial"),
  );
  els.networkTemplateButton.addEventListener("click", () =>
    openTemplateVariablesDialog("network"),
  );
  els.closeTemplateVariablesButton.addEventListener("click", closeTemplateVariablesDialog);
  els.cancelTemplateVariablesButton.addEventListener("click", closeTemplateVariablesDialog);
  els.saveTemplateVariablesButton.addEventListener("click", saveTemplateVariables);
  els.addTemplateVariableButton.addEventListener("click", addTemplateVariable);
  els.templateBuiltinList.addEventListener("click", (event) => {
    const button = event.target.closest("[data-template-token]");
    if (button) insertTemplateToken(button.dataset.templateToken);
  });
  els.templateVariableList.addEventListener("input", (event) => {
    const input = event.target.closest("[data-template-field]");
    const row = input?.closest(".template-variable-row");
    const index = Number.parseInt(row?.dataset.index, 10);
    const variable = state.templateDraftVariables[index];
    if (!input || !variable) return;
    variable[input.dataset.templateField] = input.value;
  });
  els.templateVariableList.addEventListener("click", (event) => {
    const action = event.target.closest("[data-template-action]");
    const row = action?.closest(".template-variable-row");
    const index = Number.parseInt(row?.dataset.index, 10);
    if (!action || !Number.isInteger(index)) return;
    if (action.dataset.templateAction === "insert") {
      insertCustomTemplateToken(index);
    } else if (action.dataset.templateAction === "delete") {
      deleteTemplateVariable(index);
    }
  });
  els.templateVariablesDialog.addEventListener("click", (event) => {
    if (event.target === els.templateVariablesDialog) closeTemplateVariablesDialog();
  });
  els.templateVariablesDialog.addEventListener("close", () => {
    state.templateDraftVariables = [];
  });
  els.serialResponseTestButton.addEventListener("click", () =>
    openResponseTestDialog("serial"),
  );
  els.networkResponseTestButton.addEventListener("click", () =>
    openResponseTestDialog("network"),
  );
  els.closeResponseTestButton.addEventListener("click", closeResponseTestDialog);
  els.closeResponseTestDialogButton.addEventListener("click", closeResponseTestDialog);
  els.startResponseTestButton.addEventListener("click", () => void startResponseTest());
  els.responseExpectedInput.addEventListener("input", () => {
    state.responseExpected = els.responseExpectedInput.value.slice(0, 200);
    persistSettings();
  });
  els.responseTimeoutInput.addEventListener("change", () => {
    state.responseTimeout = Math.max(
      10,
      Math.min(120000, Number.parseInt(els.responseTimeoutInput.value, 10) || 1000),
    );
    els.responseTimeoutInput.value = String(state.responseTimeout);
    persistSettings();
  });
  els.responseCaseSensitiveToggle.addEventListener("change", () => {
    state.responseCaseSensitive = els.responseCaseSensitiveToggle.checked;
    persistSettings();
  });
  els.responseTestDialog.addEventListener("click", (event) => {
    if (event.target === els.responseTestDialog) closeResponseTestDialog();
  });
  els.macroToggleButton.addEventListener("click", () => {
    setMacroCollapsed(!state.macroCollapsed);
  });
  els.macroRecordButton.addEventListener("click", () => {
    if (state.macroRecording) {
      stopMacroRecording();
    } else {
      startMacroRecording();
    }
  });
  els.macroStopButton.addEventListener("click", stopMacroPlayback);
  els.macroList.addEventListener("click", (event) => {
    const action = event.target.closest("[data-macro-action]");
    const row = action?.closest(".macro-item");
    const macroId = row?.dataset.macroId;
    if (!action || !macroId) return;

    if (action.dataset.macroAction === "play") {
      void playMacro(macroId);
    } else if (action.dataset.macroAction === "edit") {
      openMacroEditor(macroId);
    } else if (action.dataset.macroAction === "delete") {
      deleteMacro(macroId);
    }
  });
  els.closeMacroEditorButton.addEventListener("click", closeMacroEditor);
  els.macroEditorCancelButton.addEventListener("click", closeMacroEditor);
  els.macroEditorSaveButton.addEventListener("click", saveMacroEditor);
  els.macroEditorDialog.addEventListener("click", (event) => {
    if (event.target === els.macroEditorDialog) {
      closeMacroEditor();
    }
  });
  els.macroEditorDialog.addEventListener("close", () => {
    state.macroEditingId = null;
  });
  els.networkQuickSendToggleButton.addEventListener("click", () => {
    setNetworkQuickSendCollapsed(!state.networkQuickSendCollapsed);
  });
  els.addNetworkQuickCommandButton.addEventListener("click", () => addQuickCommand("network"));
  bindQuickCommandList("network", els.networkQuickCommandList);

  els.ymodemModeButtons.forEach((button) => {
    button.addEventListener("click", () => setYmodemMode(button.dataset.ymodemMode));
  });
  els.ymodemToggleButton.addEventListener("click", () => {
    setYmodemCollapsed(!state.ymodemCollapsed);
  });
  els.ymodemChooseFileButton.addEventListener("click", () => els.ymodemFileInput.click());
  els.ymodemFileInput.addEventListener("change", handleYmodemFileSelection);
  els.ymodemBlockSize.addEventListener("change", () => {
    state.ymodemBlockSize = Number.parseInt(els.ymodemBlockSize.value, 10) === 128 ? 128 : 1024;
    persistSettings();
  });
  els.ymodemSendButton.addEventListener("click", () => void startYmodemSend());
  els.ymodemReceiveButton.addEventListener("click", () => void startYmodemReceive());
  els.ymodemCancelButton.addEventListener("click", () => void cancelYmodemTransfer());

  els.networkProtocolButtons.forEach((button) => {
    button.addEventListener("click", () => {
      setNetworkProtocol(button.dataset.networkProtocol);
    });
  });
  els.networkRoleButtons.forEach((button) => {
    button.addEventListener("click", () => {
      state.networkRole = button.dataset.networkRole === "client" ? "client" : "server";
      updateNetworkUI();
      persistSettings();
    });
  });
  els.serialPresetSelect.addEventListener("change", () => applyConnectionPreset("serial"));
  els.saveSerialPresetButton.addEventListener("click", () => saveConnectionPreset("serial"));
  els.deleteSerialPresetButton.addEventListener("click", () => deleteConnectionPreset("serial"));
  els.networkPresetSelect.addEventListener("change", () => applyConnectionPreset("network"));
  els.saveNetworkPresetButton.addEventListener("click", () => saveConnectionPreset("network"));
  els.deleteNetworkPresetButton.addEventListener("click", () =>
    deleteConnectionPreset("network"),
  );
  els.networkConnectButton.addEventListener("click", () => {
    if (
      state.networkProtocol === "ssh" &&
      !state.sshConnected &&
      state.sshState !== "connecting"
    ) {
      openSshConnectDialog();
      return;
    }
    void toggleNetworkConnection();
  });
  els.closeSshConnectDialogButton.addEventListener("click", closeSshConnectDialog);
  els.cancelSshConnectDialogButton.addEventListener("click", closeSshConnectDialog);
  els.confirmSshConnectDialogButton.addEventListener("click", () =>
    void connectSshFromDialog(),
  );
  els.sshConnectDialog.addEventListener("cancel", (event) => {
    event.preventDefault();
    closeSshConnectDialog();
  });
  els.sshConnectDialog.addEventListener("click", (event) => {
    if (event.target === els.sshConnectDialog) closeSshConnectDialog();
  });
  els.sshConnectDialog.addEventListener("close", () => {
    state.sshConnectDialogPending = false;
  });
  els.sshClearButton.addEventListener("click", () => {
    state.sshTerminal?.clear();
    state.sshTerminal?.focus();
  });
  els.sshFileButton.addEventListener("click", openSshFileDialog);
  els.closeSshFileButton.addEventListener("click", () => closeSshFileDialog());
  $$("[data-close-ssh-file]").forEach((button) => {
    button.addEventListener("click", () => closeSshFileDialog());
  });
  els.sshFileDialog.addEventListener("cancel", (event) => {
    event.preventDefault();
    closeSshFileDialog();
  });
  els.sshFileDialog.addEventListener("click", (event) => {
    if (event.target === els.sshFileDialog) closeSshFileDialog();
  });
  els.sshFileGoButton.addEventListener("click", () => {
    void loadSshDirectory(els.sshFilePath.value).catch((error) =>
      showToast(errorMessage(error, t("ssh.file.readDirFailed")), "error"),
    );
  });
  els.sshFilePath.addEventListener("keydown", (event) => {
    if (event.key !== "Enter" || event.isComposing) return;
    event.preventDefault();
    void loadSshDirectory(els.sshFilePath.value).catch((error) =>
      showToast(errorMessage(error, t("ssh.file.readDirFailed")), "error"),
    );
  });
  els.sshFileParentButton.addEventListener("click", () => {
    void loadSshDirectory(parentSshPath(state.sshFilePath)).catch((error) =>
      showToast(errorMessage(error, t("ssh.file.readDirFailed")), "error"),
    );
  });
  els.sshFileRefreshButton.addEventListener("click", () => {
    void loadSshDirectory(state.sshFilePath, { announce: true }).catch((error) =>
      showToast(errorMessage(error, t("ssh.file.refreshDirFailed")), "error"),
    );
  });
  els.sshFileUploadButton.addEventListener("click", () => els.sshFileUploadInput.click());
  els.sshFileUploadInput.addEventListener("change", () => {
    void uploadSshFiles(els.sshFileUploadInput.files);
  });
  els.sshFileDownloadButton.addEventListener("click", () => void downloadSelectedSshFile());
  els.sshFileMkdirButton.addEventListener("click", () => void createSshDirectory());
  els.sshFileRenameButton.addEventListener("click", () => void renameSelectedSshEntry());
  els.sshFileDeleteButton.addEventListener("click", () => void deleteSelectedSshEntry());
  els.sshFileCancelButton.addEventListener("click", () => state.sshFileAbortController?.abort());
  els.sshFileAddPlaceButton.addEventListener("click", addCurrentSshQuickPath);
  els.sshFilePlaceList.addEventListener("click", (event) => {
    const item = event.target.closest(".ssh-file-place-item");
    if (!item) return;
    const path = item.dataset.path || "";
    if (event.target.closest(".ssh-file-place-delete")) {
      removeSshQuickPath(path);
      return;
    }
    if (event.target.closest(".ssh-file-place-open")) {
      void loadSshDirectory(path).catch((error) =>
        showToast(errorMessage(error, t("ssh.file.readDirFailed")), "error"),
      );
    }
  });
  els.sshFileList.addEventListener("click", (event) => {
    const row = event.target.closest("[data-ssh-file-index]");
    if (!row) return;
    const entry = state.sshFileEntries[Number.parseInt(row.dataset.sshFileIndex, 10)];
    if (!entry) return;
    selectSshFile(entry.path);
  });
  els.sshFileList.addEventListener("dblclick", (event) => {
    const row = event.target.closest("[data-ssh-file-index]");
    if (!row) return;
    const entry = state.sshFileEntries[Number.parseInt(row.dataset.sshFileIndex, 10)];
    if (!entry) return;
    if (entry.isDirectory) {
      void loadSshDirectory(entry.path).catch((error) =>
        showToast(errorMessage(error, t("ssh.file.openDirFailed")), "error"),
      );
    } else {
      selectSshFile(entry.path);
      void downloadSelectedSshFile();
    }
  });
  [els.sshAlias, els.sshHost, els.sshPort, els.sshUsername].forEach((input) => {
    input.addEventListener("change", () => {
      state.sshAlias = els.sshAlias.value.trim().slice(0, 80);
      state.sshHost = els.sshHost.value.trim().slice(0, 255) || defaultSettings.sshHost;
      state.sshPort = normalizePort(els.sshPort.value, defaultSettings.sshPort);
      state.sshUsername = els.sshUsername.value.trim().slice(0, 120) || "root";
      els.sshAlias.value = state.sshAlias;
      els.sshHost.value = state.sshHost;
      els.sshPort.value = String(state.sshPort);
      els.sshUsername.value = state.sshUsername;
      persistSettings();
    });
  });
  els.sshSavePasswordToggle.addEventListener("change", () => {
    state.sshSavePassword = els.sshSavePasswordToggle.checked;
    persistSettings();
  });
  els.sshPresetSelect.addEventListener("change", applySshPreset);
  els.saveSshPresetButton.addEventListener("click", saveSshPreset);
  els.deleteSshPresetButton.addEventListener("click", deleteSshPreset);
  [els.sshHost, els.sshPort, els.sshUsername, els.sshPassword].forEach((input) => {
    input.addEventListener("keydown", (event) => {
      if (event.key !== "Enter" || event.isComposing) return;
      event.preventDefault();
      if (!state.sshConnected && state.sshState !== "connecting") {
        void connectSshFromDialog();
      }
    });
  });
  els.networkReceiveModeButtons.forEach((button) => {
    button.addEventListener("click", () => {
      state.networkReceiveMode = button.dataset.networkReceiveMode === "hex" ? "hex" : "text";
      state.networkDecoder = new TextDecoder("utf-8", { fatal: false });
      updateNetworkUI();
      persistSettings();
    });
  });
  els.networkSendModeButtons.forEach((button) => {
    button.addEventListener("click", () => {
      state.networkSendMode = button.dataset.networkSendMode === "hex" ? "hex" : "text";
      updateNetworkUI();
      persistSettings();
    });
  });
  els.networkTimestampToggle.addEventListener("change", () => {
    state.networkTimestamp = els.networkTimestampToggle.checked;
    updateNetworkUI();
    persistSettings();
  });
  els.networkTimestampModeButtons.forEach((button) => {
    button.addEventListener("click", () => {
      setTimestampMode("network", button.dataset.networkTimestampMode);
    });
  });
  [
    els.networkShowRxToggle,
    els.networkShowTxToggle,
    els.networkShowSysToggle,
    els.networkDualModeToggle,
  ].forEach((element) => {
    element.addEventListener("change", () => {
      state.networkShowRx = els.networkShowRxToggle.checked;
      state.networkShowTx = els.networkShowTxToggle.checked;
      state.networkShowSys = els.networkShowSysToggle.checked;
      state.networkDualMode = els.networkDualModeToggle.checked;
      els.networkLogContent.classList.toggle("is-dual", state.networkDualMode);
      applyKeywordStateToLogs();
      updateNetworkUI();
      persistSettings();
    });
  });
  els.networkAutoSaveButton.addEventListener("click", openAutoSaveDialog);
  els.networkAutoScrollToggle.addEventListener("change", () => {
    state.networkAutoScroll = els.networkAutoScrollToggle.checked;
    state.networkFollowSuspended = false;
    updateNetworkFollowUI();
    if (state.networkAutoScroll) scrollNetworkToLatest();
    persistSettings();
  });
  els.networkLineEnding.addEventListener("change", () => {
    updateNetworkUI();
    persistSettings();
  });
  els.networkSendInput.addEventListener("input", () => {
    resetSendHistoryNavigation("network");
    updateNetworkUI();
  });
  els.networkSendInput.addEventListener("keydown", (event) => {
    if (handleSendHistoryKeydown(event, "network")) return;
    if (event.key === "Enter" && (event.ctrlKey || event.metaKey)) {
      event.preventDefault();
      void sendNetworkPayload();
    }
  });
  els.networkSendButton.addEventListener("click", () => void sendNetworkPayload());
  els.networkToggleSendPanelButton.addEventListener("click", () => {
    setNetworkSendPanelCollapsed(!state.networkSendPanelCollapsed);
  });
  els.networkClearInputButton.addEventListener("click", () => {
    els.networkSendInput.value = "";
    resetSendHistoryNavigation("network");
    updateNetworkUI();
  });
  els.networkAutoSendInterval.addEventListener("change", () => {
    const interval = Math.max(
      10,
      Number.parseInt(els.networkAutoSendInterval.value, 10) || 1000,
    );
    els.networkAutoSendInterval.value = String(interval);
    if (state.networkAutoSendRunning) {
      stopNetworkAutoSend();
      startNetworkAutoSend();
    }
  });
  els.networkAutoSendCount.addEventListener("change", () => {
    const count = normalizeAutoSendCount(els.networkAutoSendCount.value);
    els.networkAutoSendCount.value = String(count);
    state.networkAutoSendCount = count;
    if (state.networkAutoSendRunning) {
      stopNetworkAutoSend();
      startNetworkAutoSend();
    }
    persistSettings();
  });
  els.networkAutoSendButton.addEventListener("click", () => {
    if (state.networkAutoSendRunning) {
      stopNetworkAutoSend({ silent: false });
    } else {
      startNetworkAutoSend();
    }
  });
  els.networkPauseButton.addEventListener("click", toggleNetworkPause);
  els.networkFollowLatestButton.addEventListener("click", resumeNetworkFollowing);
  els.networkClearButton.addEventListener("click", clearNetworkLog);
  els.networkSaveButton.addEventListener("click", saveNetworkLog);
  els.networkViewport.addEventListener("scroll", () => {
    const distance = els.networkViewport.scrollHeight - els.networkViewport.scrollTop;
    const atBottom = distance <= els.networkViewport.clientHeight + 72;
    if (!atBottom && state.networkAutoScroll && !state.networkFollowSuspended) {
      state.networkFollowSuspended = true;
      updateNetworkFollowUI();
    } else if (atBottom && state.networkFollowSuspended) {
      state.networkFollowSuspended = false;
      updateNetworkFollowUI();
    }
  });

  els.sendInput.addEventListener("input", () => {
    resetSendHistoryNavigation("serial");
    updateConnectionUI();
  });
  els.sendInput.addEventListener("keydown", (event) => {
    if (handleSendHistoryKeydown(event, "serial")) return;
    if (event.key === "Enter" && (event.ctrlKey || event.metaKey)) {
      event.preventDefault();
      void handleSend();
    }
  });

  els.sendButton.addEventListener("click", handleSend);

  els.autoSendInterval.addEventListener("change", () => {
    const interval = Math.max(10, Number.parseInt(els.autoSendInterval.value, 10) || 1000);
    els.autoSendInterval.value = String(interval);
    if (state.autoSendRunning) {
      stopAutoSend();
      startAutoSend();
    }
  });
  els.autoSendCount.addEventListener("change", () => {
    const count = normalizeAutoSendCount(els.autoSendCount.value);
    els.autoSendCount.value = String(count);
    state.autoSendCount = count;
    if (state.autoSendRunning) {
      stopAutoSend();
      startAutoSend();
    }
    persistSettings();
  });

  els.autoSendButton.addEventListener("click", () => {
    if (state.autoSendRunning) {
      stopAutoSend({ silent: false });
    } else {
      startAutoSend();
    }
  });

  els.consoleViewport.addEventListener("scroll", () => {
    const distance = els.consoleViewport.scrollHeight - els.consoleViewport.scrollTop;
    const atBottom = distance <= els.consoleViewport.clientHeight + 72;
    if (!atBottom && state.autoScroll && !state.followSuspended) {
      state.followSuspended = true;
      updateFollowUI();
    } else if (atBottom && state.followSuspended) {
      state.followSuspended = false;
      updateFollowUI();
    }
  });

  window.addEventListener("beforeunload", () => {
    stopAutoSend();
    stopNetworkAutoSend();
    void flushAutoSave("serial");
    void flushAutoSave("network");
    state.networkBridge?.close();
    state.sshBridge?.close();
    state.agentBridge?.close();
  });

  window.addEventListener("resize", () => {
    fitTerminal();
    fitSshTerminal();
  });
  window.addEventListener("keydown", handleGlobalShortcut, true);

  if (state.supported) {
    navigator.serial.addEventListener("connect", () => void refreshPorts());
    navigator.serial.addEventListener("disconnect", () => {
      void refreshPorts();
      if (state.connected) {
        state.errors += 1;
        updateCounters();
        showToast(t("serial.deviceDisconnected"), "error");
        void disconnectPort({ reason: "device-disconnect", notify: false });
      }
    });
  }
}

export { SERIAL_OPTION_ELEMENTS, bindEvents, bindStatusPillExplanation };
