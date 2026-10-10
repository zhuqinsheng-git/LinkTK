// Module: Workspace, connection state, and view controls.
// Owns: workspace switching, connection state, log/terminal views, receive/send modes, toggles, panels, advanced settings, compatibility notices, and shortcuts.
// Depends on: core, bridge, connection-presets, log-view, macro, network, quick-send, response-test, serial, ssh, template, terminal, toast, ymodem.
// Called by: app.js initialization and event binding.

import { $, els } from "../core/dom.js";
import { t } from "../core/i18n.js";
import { persistSettings } from "../core/settings.js";
import { state } from "../core/state.js";
import { updateBridgeUI } from "./bridge.js";
import { updateConnectionPresetControls } from "./connection-presets.js";
import { applyTerminalKeywordSearch, clearLog, scrollToLatest, updateTimestampModeButtons } from "./log-view.js";
import { stopMacroPlayback, stopMacroRecording, updateMacroUI } from "./macro.js";
import { clearNetworkLog, stopNetworkAutoSend } from "./network.js";
import { initializeNetworkBridge, sendNetworkPayload, updateNetworkUI } from "./network-runtime.js";
import { updateQuickCommandModeUI } from "./quick-send.js";
import { updateResponseTestUI } from "./response-test.js";
import { getPortName, readSerialOptions, setPortDetails } from "./serial.js";
import { handleSend, hasSendPayload, stopAutoSend } from "./serial-runtime.js";
import { initializeSshBridge } from "./ssh-runtime.js";
import { fitSshTerminal, initializeSshTerminal } from "./ssh.js";
import { updateTemplateButtonUI } from "./template.js";
import { fitTerminal } from "./terminal.js";
import { showToast } from "./toast.js";
import { updateYmodemUI } from "./ymodem.js";

const LOCKED_WHEN_CONNECTED_ELEMENTS = [
  els.baudRate,
  els.dataBits,
  els.stopBits,
  els.parity,
  els.flowControl,
];

function setConsoleView(view, { focus = true, persist = true } = {}) {
  const nextView = view === "terminal" ? "terminal" : "log";
  if (state.macroRecording && state.macroRecordingMode !== nextView) {
    stopMacroRecording({ notify: false });
  }
  if (state.macroPlaybackActive) {
    stopMacroPlayback();
  }
  state.consoleView = nextView;
  els.receivePanel.dataset.consoleView = nextView;
  els.consoleViewButtons.forEach((button) => {
    const active = button.dataset.consoleView === nextView;
    button.classList.toggle("is-active", active);
    button.setAttribute("aria-selected", String(active));
  });

  els.terminalControls.hidden = nextView !== "terminal";
  els.terminalViewport.hidden = nextView !== "terminal";
  els.terminalFooter.hidden = nextView !== "terminal";
  els.terminalViewport.setAttribute("aria-hidden", String(nextView !== "terminal"));
  els.consoleTitle.textContent =
    nextView === "terminal" ? t("serial.terminal.aria") : t("serial.console.receiveTitle");
  els.clearButton.title = nextView === "terminal" ? t("serial.toolbar.clearTerminal") : t("serial.toolbar.clear");
  els.clearButton.setAttribute("aria-label", els.clearButton.title);
  updateConnectionUI();

  if (nextView === "terminal") {
    fitTerminal({ focus, respectActiveTextEntry: true });
    requestAnimationFrame(() => {
      state.terminal?.scrollToBottom();
      applyTerminalKeywordSearch();
    });
  } else {
    state.terminalSearchAddon?.clearActiveDecoration();
    if (focus) els.consoleViewport.focus();
  }

  if (persist) persistSettings();
}

function setSendPanelCollapsed(collapsed, { persist = true } = {}) {
  state.sendPanelCollapsed = Boolean(collapsed);
  els.sendPanel.classList.toggle("is-collapsed", state.sendPanelCollapsed);
  els.toggleSendPanelButton.setAttribute("aria-pressed", String(state.sendPanelCollapsed));
  els.toggleSendPanelButton.title = state.sendPanelCollapsed
    ? t("serial.send.expand")
    : t("serial.send.collapse");
  els.toggleSendPanelButton.setAttribute("aria-label", els.toggleSendPanelButton.title);
  if (state.consoleView === "terminal") {
    fitTerminal();
  } else if (state.autoScroll) {
    scrollToLatest();
  }
  if (persist) persistSettings();
}

function setWorkspaceMode(mode, { persist = true } = {}) {
  if (state.macroRecording) {
    stopMacroRecording({ notify: false });
  }
  if (state.macroPlaybackActive) {
    stopMacroPlayback();
  }
  state.workspaceMode = mode === "network" ? "network" : "serial";
  document.body.dataset.workspace = state.workspaceMode;
  els.workspaceSwitchButtons.forEach((button) => {
    const active = button.dataset.workspaceMode === state.workspaceMode;
    button.classList.toggle("is-active", active);
    button.setAttribute("aria-selected", String(active));
  });
  els.serialWorkspace.hidden = state.workspaceMode !== "serial";
  els.networkWorkspace.hidden = state.workspaceMode !== "network";

  if (state.workspaceMode === "network") {
    initializeNetworkBridge();
    void state.networkBridge?.connect().catch(() => {});
    if (state.networkProtocol === "ssh") {
      initializeSshBridge();
      initializeSshTerminal();
    }
  }

  updateNetworkUI();
  if (state.networkProtocol === "ssh") fitSshTerminal();
  if (persist) persistSettings();
}

function updateConnectionUI() {
  const connected = state.connected;
  const connecting = state.connecting;
  const selected = Boolean(state.selectedPort);

  els.headerStatus.dataset.state = connected ? "connected" : "disconnected";
  els.headerStatusText.textContent = connected
    ? t("common.connected")
    : connecting
      ? t("common.opening")
      : t("common.disconnected");
  els.headerStatus.title = t("serial.headerStatus", { status: els.headerStatusText.textContent });
  els.headerStatus.setAttribute("aria-label", els.headerStatus.title);

  els.connectButton.disabled = !state.supported || connecting || (!connected && !selected);
  els.connectButton.classList.toggle("is-connected", connected);
  $("span", els.connectButton).textContent = connected
    ? t("serial.port.close")
    : connecting
      ? t("serial.port.opening")
      : t("serial.port.open");

  els.requestPortButton.disabled = !state.supported || connected || connecting;
  els.refreshPortsButton.disabled = !state.supported || connected || connecting;
  els.portSelect.disabled = !state.supported || connected || !state.ports.length;

  LOCKED_WHEN_CONNECTED_ELEMENTS.forEach((element) => {
    element.disabled = connected || connecting;
  });
  els.lineEnding.disabled = state.sendMode === "hex";

  updateQuickCommandModeUI("serial");
  updateConnectionPresetControls("serial");

  els.sendButton.disabled = !connected || state.ymodemBusy || !hasSendPayload();
  els.autoSendButton.disabled = !connected || state.ymodemBusy;
  els.clearInputButton.disabled = !els.sendInput.value;
  updateMacroUI();
  updateResponseTestUI();

  els.streamState.textContent =
    state.consoleView === "terminal"
      ? connected
        ? t("serial.terminal.state.online")
        : t("serial.terminal.state.idle")
      : connected
        ? t("serial.stream.receiving")
        : state.paused
          ? t("serial.stream.paused")
          : t("serial.stream.idle");
  els.streamState.classList.toggle("mini-badge--idle", !connected);
  els.streamDot.classList.toggle("is-live", connected);
  els.terminalStateLabel.textContent = connected
    ? t("serial.terminal.state.onlineBaud", {
        baud: Number.parseInt(els.baudRate.value, 10) || 115200,
      })
    : t("serial.terminal.state.idle");

  if (connected) {
    const index = state.ports.indexOf(state.activePort);
    const name = getPortName(state.activePort, index >= 0 ? index : 0);
    setPortDetails(
      name.title,
      `${readSerialOptions().baudRate} baud · ${els.dataBits.value}${els.parity.value === "none" ? "N" : els.parity.value === "even" ? "E" : "O"}${els.stopBits.value}`,
      true,
    );
    els.portStateBadge.textContent = t("common.connected");
  } else if (state.selectedPort) {
    const index = state.ports.indexOf(state.selectedPort);
    const name = getPortName(state.selectedPort, index >= 0 ? index : 0);
    setPortDetails(name.title, name.meta, true);
    els.portStateBadge.textContent = t("serial.portState.selected");
  } else {
    els.portStateBadge.textContent = state.ports.length
      ? t("serial.portState.none")
      : t("serial.portState.unauthorized");
  }

  updateYmodemUI();
  updateBridgeUI();
}

function clearCurrentView() {
  if (state.consoleView === "terminal") {
    state.terminal?.reset();
    fitTerminal();
    showToast(t("serial.terminal.resetToast"), "info");
    return;
  }
  clearLog();
}

function updateReceiveModeUI() {
  els.receiveModeButtons.forEach((button) => {
    button.classList.toggle("is-active", button.dataset.receiveMode === state.receiveMode);
  });
  els.ansiToggle.disabled = state.receiveMode === "hex";
  els.dualModeToggle.disabled = false;
  els.logContent.classList.toggle("is-dual", state.dualMode);
  els.receiveModeLabel.textContent =
    state.receiveMode === "hex"
      ? state.dualMode
        ? "HEX + ASCII"
        : t("serial.displayMode.hex")
      : state.ansiColors
        ? state.dualMode
          ? t("serial.displayMode.textAnsiHex")
          : t("serial.displayMode.textAnsi")
        : state.dualMode
          ? t("serial.displayMode.textHex")
          : t("serial.displayMode.text");
}

function updateSendModeUI() {
  els.sendModeButtons.forEach((button) => {
    button.classList.toggle("is-active", button.dataset.sendMode === state.sendMode);
  });
  els.sendInput.placeholder =
    state.sendMode === "hex" ? t("serial.send.placeholderHex") : t("serial.send.placeholder");
  updateTemplateButtonUI("serial");
  updateConnectionUI();
}

function updateTogglesUI() {
  state.showRx = els.showRxToggle.checked;
  state.showTx = els.showTxToggle.checked;
  state.showSys = els.showSysToggle.checked;
  state.timestamp = els.timestampToggle.checked;
  state.autoScroll = els.autoScrollToggle.checked;
  state.ansiColors = els.ansiToggle.checked;
  state.dualMode = els.dualModeToggle.checked;
  updateTimestampModeButtons("serial", { disabled: !state.timestamp });
  els.logContent.classList.toggle("is-dual", state.dualMode);
}

function openAdvancedSerialSettings() {
  if (els.advancedSerialSettingsDialog.open) return;
  els.advancedSerialSettingsDialog.showModal();
}

function closeAdvancedSerialSettings() {
  if (els.advancedSerialSettingsDialog.open) {
    els.advancedSerialSettingsDialog.close();
  }
}

function configureBrowserNotice() {
  if (!state.supported) {
    els.browserNotice.hidden = false;
    els.browserNoticeText.textContent = t("serial.error.webSerialUnsupported");
    return;
  }

  if (!state.secureContext) {
    els.browserNotice.hidden = false;
    els.browserNoticeText.textContent = t("serial.error.webSerialInsecure");
  }
}

function handleGlobalShortcut(event) {
  const modifier = event.ctrlKey || event.metaKey;
  const key = String(event.key || "").toLowerCase();
  const target = event.target instanceof Element ? event.target : null;
  const openDialog = document.querySelector("dialog[open]");

  if (event.key === "Escape" && !openDialog) {
    if (state.workspaceMode === "network") {
      if (state.networkAutoSendRunning) {
        stopNetworkAutoSend({ silent: false, message: t("net.autoSend.escStopped") });
        event.preventDefault();
      }
    } else if (state.autoSendRunning) {
      stopAutoSend({ silent: false, message: t("serial.autoSend.escStopped") });
      event.preventDefault();
    }
    return;
  }

  if (!modifier || openDialog) return;

  if (key === "enter") {
    if (target && (target === els.sendInput || target === els.networkSendInput)) return;
    if (state.workspaceMode === "network" && state.networkProtocol === "ssh") return;
    event.preventDefault();
    if (state.workspaceMode === "network") {
      void sendNetworkPayload();
    } else if (state.consoleView === "log") {
      void handleSend();
    }
    return;
  }

  if (key === "k") {
    event.preventDefault();
    if (state.workspaceMode === "network" && state.networkProtocol === "ssh") {
      state.sshTerminal?.clear();
    } else if (state.workspaceMode === "network") {
      clearNetworkLog();
    } else {
      clearCurrentView();
    }
    return;
  }

  if (key === "l") {
    event.preventDefault();
    if (state.workspaceMode === "network" && state.networkProtocol === "ssh") {
      state.sshTerminal?.focus();
    } else if (state.workspaceMode === "network") {
      els.networkViewport.focus();
    } else if (state.consoleView === "terminal") {
      state.terminal?.focus();
    } else {
      els.consoleViewport.focus();
    }
  }
}

export { clearCurrentView, closeAdvancedSerialSettings, configureBrowserNotice, handleGlobalShortcut, openAdvancedSerialSettings, setConsoleView, setSendPanelCollapsed, setWorkspaceMode, updateConnectionUI, updateReceiveModeUI, updateSendModeUI, updateTogglesUI };
