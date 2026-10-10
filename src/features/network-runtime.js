// Module: TCP/UDP network runtime and workspace state.
// Owns: bridge client lifecycle, status events, sending, receiving, and pause.
// Depends on: core, network, log-view, bridge, payload, ssh, send-history, toast; UI callbacks are injected by app.js.
// Called by: app.js wiring and network workspace events.

import { NetworkBridgeClient } from "../network.js";
import { MAX_PENDING_BYTES } from "../core/constants.js";
import { $, els } from "../core/dom.js";
import { errorMessage } from "../core/errors.js";
import { t } from "../core/i18n.js";
import { persistSettings } from "../core/settings.js";
import { state } from "../core/state.js";
import { enqueueBridgeTask, stopBridge, updateBridgeUI } from "./bridge.js";
import { recordNetworkAgentTraffic, resetAgentTrafficDecoders, updateTimestampModeButtons } from "./log-view.js";
import { appendNetworkEntry, hasNetworkSendPayload, normalizeNetworkProtocol, processNetworkData, readNetworkConfig, registerNetworkPeer, renderNetworkPeerList, sendNetworkData, setNetworkStatus, stopNetworkAutoSend, updateNetworkAutoSendUI, updateNetworkCounters, updateNetworkHeaderStatus } from "./network.js";
import { buildNetworkPayload } from "./payload.js";
import { updateQuickCommandModeUI } from "./quick-send.js";
import { cancelResponseTest, observeResponseTest, updateResponseTestUI } from "./response-test.js";
import { addSendHistoryEntry } from "./send-history.js";
import { fitSshTerminal, initializeSshTerminal, updateSshPresetControls } from "./ssh.js";
import { updateTemplateButtonUI } from "./template.js";
import { showToast } from "./toast.js";

let initializeSshBridge = null;
let toggleSshConnection = null;
let updateConnectionPresetControls = null;

function initializeNetworkRuntime({
  initializeSshBridge: initializeSshBridgeCallback,
  toggleSshConnection: toggleSshConnectionCallback,
  updateConnectionPresetControls: updateConnectionPresetControlsCallback,
} = {}) {
  if (
    typeof initializeSshBridgeCallback !== "function" ||
    typeof toggleSshConnectionCallback !== "function" ||
    typeof updateConnectionPresetControlsCallback !== "function"
  ) {
    throw new TypeError(
      "initializeNetworkRuntime requires initializeSshBridge, toggleSshConnection, and updateConnectionPresetControls.",
    );
  }
  initializeSshBridge = initializeSshBridgeCallback;
  toggleSshConnection = toggleSshConnectionCallback;
  updateConnectionPresetControls = updateConnectionPresetControlsCallback;
}

function initializeNetworkBridge() {
  if (state.networkBridge) return;

  state.networkBridge = new NetworkBridgeClient({
    onReady: () => {
      state.networkBridgeReady = true;
      if (state.networkState === "idle") {
        setNetworkStatus("idle", t("net.status.bridgeReady"));
      }
      updateNetworkUI();
    },
    onStatus: handleNetworkStatus,
    onData: handleNetworkData,
    onError: (message) => {
      state.networkState = "error";
      resetAgentTrafficDecoders("network");
      setNetworkStatus("error", message);
      showToast(message, "error");
    },
    onClose: () => {
      state.networkBridgeReady = false;
      state.networkConnected = false;
      resetAgentTrafficDecoders("network");
      setNetworkStatus("idle", t("net.status.bridgeClosed"));
      updateNetworkUI();
    },
  });
}

function setNetworkProtocol(value, { persist = true } = {}) {
  const nextProtocol = normalizeNetworkProtocol(value);
  if (nextProtocol === state.networkProtocol) return;
  if (state.sshConnected || state.sshState === "connecting") return;

  stopBridge({ silent: true });
  state.networkProtocol = nextProtocol;
  if (nextProtocol === "ssh") {
    initializeSshBridge();
    initializeSshTerminal();
  }
  updateNetworkUI();
  if (persist) persistSettings();
  if (nextProtocol === "ssh") fitSshTerminal();
}

function handleNetworkStatus(message) {
  if (message.protocol) state.networkProtocol = message.protocol;
  if (message.role) state.networkRole = message.role;
  if (message.host) state.networkHost = message.host;
  if (message.port) state.networkPort = Number(message.port);
  if (message.remote) registerNetworkPeer(message.remote);
  if (Number.isFinite(message.connections)) {
    state.networkConnections = Number(message.connections);
  } else if (message.state === "connected") {
    state.networkConnections = 1;
  } else if (message.state === "idle" || message.state === "closed") {
    state.networkConnections = 0;
  }

  const wasNetworkConnected = state.networkConnected;
  state.networkConnected = message.state === "connected";
  if (state.networkConnected && !wasNetworkConnected) {
    state.networkConnectedAt = Number(message.at) || Date.now();
    state.networkLastTimestampAt = 0;
  }
  if (!state.networkConnected) stopNetworkAutoSend();
  if (!state.networkConnected) stopBridge({ silent: true });
  if (
    !state.networkConnected &&
    state.responseTest.active &&
    state.responseTest.kind === "network"
  ) {
    cancelResponseTest({ reason: t("net.responseTest.aborted") });
  }
  setNetworkStatus(message.state, message.message || t("net.status.updated"));
  appendNetworkEntry("sys", message.message || t("net.status.updated"), "", message.at);
  updateNetworkCounters();
  updateNetworkUI();
}

function handleNetworkData(bytes, remote, at = Date.now()) {
  if (!bytes.byteLength) return;

  recordNetworkAgentTraffic("rx", bytes);
  state.networkRxBytes += bytes.byteLength;
  state.networkFrames += 1;
  state.networkLastActivityAt = Date.now();
  updateNetworkCounters();
  observeResponseTest("network", bytes);

  if (state.bridgeActive && state.bridgeNetworkToSerial) {
    enqueueBridgeTask("network-to-serial", bytes);
  }

  if (state.networkPaused) {
    const copy = bytes.slice();
    state.networkPendingEntries.push({ bytes: copy, remote, at });
    state.networkPendingBytes += copy.byteLength;

    while (
      state.networkPendingBytes > MAX_PENDING_BYTES &&
      state.networkPendingEntries.length > 1
    ) {
      state.networkPendingBytes -= state.networkPendingEntries.shift().bytes.byteLength;
    }
    return;
  }

  processNetworkData(bytes, remote, at);
}

function updateNetworkUI() {
  const sshMode = state.networkProtocol === "ssh";
  const connected = sshMode ? state.sshConnected : state.networkConnected;
  const busy = sshMode
    ? state.sshState === "connecting"
    : state.networkState === "connecting";
  const protocolLocked = connected || busy;

  els.networkProtocolButtons.forEach((button) => {
    const active = button.dataset.networkProtocol === state.networkProtocol;
    button.classList.toggle("is-active", active);
    button.setAttribute("aria-selected", String(active));
    button.disabled = protocolLocked;
  });
  els.networkRoleButtons.forEach((button) => {
    const active = button.dataset.networkRole === state.networkRole;
    button.classList.toggle("is-active", active);
    button.setAttribute("aria-selected", String(active));
    button.disabled = connected || busy;
  });

  els.networkRoleGroup.hidden = sshMode;
  els.networkTcpFields.hidden = sshMode;
  els.sshConnectionSummary.hidden = !sshMode;
  els.networkPresetPicker.hidden = sshMode;
  els.networkQuickSendSection.hidden = sshMode;
  els.networkStatsSection.hidden = sshMode;
  els.networkMonitorPanel.hidden = sshMode;
  els.sshTerminalPanel.hidden = !sshMode;
  els.networkSendPanel.hidden = sshMode;
  if (!sshMode && els.sshConnectDialog.open) {
    els.sshConnectDialog.close();
  }

  const server = state.networkRole === "server";
  els.networkHostLabel.textContent = server ? t("net.field.hostListen") : t("net.field.hostTarget");
  els.networkPortLabel.textContent = server ? t("net.field.portListen") : t("net.field.portTarget");
  els.networkHost.disabled = connected || busy;
  els.networkPort.disabled = connected || busy;
  els.networkConnectButton.disabled = busy;
  els.networkConnectButton.classList.toggle("button--primary", !connected);
  els.networkConnectButton.classList.toggle("button--secondary", connected);
  $("span", els.networkConnectButton).textContent = sshMode
    ? connected
      ? t("ssh.disconnect")
      : busy
        ? t("ssh.connect.connecting")
        : t("ssh.connect.button")
    : connected
      ? server
        ? t("net.connect.stopServer")
        : t("net.connect.disconnect")
      : server
        ? t("net.connect.server")
        : t("net.connect.connect");

  [
    els.sshAlias,
    els.sshHost,
    els.sshPort,
    els.sshUsername,
    els.sshPassword,
    els.sshSavePasswordToggle,
  ].forEach((element) => {
    element.disabled = connected || busy;
  });
  els.confirmSshConnectDialogButton.disabled = connected || busy;

  els.networkReceiveModeButtons.forEach((button) => {
    const active = button.dataset.networkReceiveMode === state.networkReceiveMode;
    button.classList.toggle("is-active", active);
  });
  els.networkSendModeButtons.forEach((button) => {
    const active = button.dataset.networkSendMode === state.networkSendMode;
    button.classList.toggle("is-active", active);
  });
  state.networkShowRx = els.networkShowRxToggle.checked;
  state.networkShowTx = els.networkShowTxToggle.checked;
  state.networkShowSys = els.networkShowSysToggle.checked;
  state.networkDualMode = els.networkDualModeToggle.checked;
  updateTimestampModeButtons("network", { disabled: !state.networkTimestamp });
  els.networkLogContent.classList.toggle("is-dual", state.networkDualMode);
  els.networkReceiveModeLabel.textContent =
    state.networkReceiveMode === "hex"
      ? state.networkDualMode
        ? "HEX + ASCII"
        : t("net.displayMode.hex")
      : state.networkDualMode
        ? t("net.displayMode.textHex")
        : t("net.displayMode.text");
  els.networkSendInput.placeholder =
    state.networkSendMode === "hex" ? t("net.send.placeholderHex") : t("net.send.placeholder");
  els.networkLineEnding.disabled = state.networkSendMode === "hex";
  els.networkSendButton.disabled = !connected || !hasNetworkSendPayload();
  els.networkClearInputButton.disabled = !els.networkSendInput.value;
  els.networkAutoSendButton.disabled = !connected;
  els.networkConnectButton.disabled = busy;
  if (!sshMode) updateConnectionPresetControls("network");
  if (sshMode) updateSshPresetControls();
  els.networkStreamState.textContent = state.networkPaused
    ? t("net.stream.paused")
    : connected
      ? t("common.online")
      : busy
        ? t("common.connecting")
        : t("net.stream.idle");
  els.networkStreamState.classList.toggle("mini-badge--idle", !connected || state.networkPaused);
  updateNetworkAutoSendUI();
  updateQuickCommandModeUI("network");
  updateTemplateButtonUI("network");
  updateNetworkHeaderStatus();
  updateBridgeUI();
  updateResponseTestUI();
  if (sshMode) fitSshTerminal();
}

async function toggleNetworkConnection() {
  if (state.networkProtocol === "ssh") {
    await toggleSshConnection();
    return;
  }

  initializeNetworkBridge();

  try {
    if (state.networkConnected) {
      await state.networkBridge.stop();
      resetAgentTrafficDecoders("network");
      return;
    }

    const { host, port } = readNetworkConfig();
    state.networkHost = host;
    state.networkPort = port;
    state.networkState = "connecting";
    resetAgentTrafficDecoders("network");
    setNetworkStatus(
      "connecting",
      state.networkRole === "server"
        ? t("net.status.startingServer")
        : t("net.status.connecting"),
    );
    updateNetworkUI();
    persistSettings();
    await state.networkBridge.start({
      protocol: state.networkProtocol,
      role: state.networkRole,
      host,
      port,
    });
  } catch (error) {
    state.networkState = "error";
    state.networkConnected = false;
    setNetworkStatus("error", errorMessage(error, t("net.error.connectFailed")));
    updateNetworkUI();
    showToast(errorMessage(error, t("net.error.connectFailed")), "error");
  }
}

async function sendNetworkPayload() {
  let payload;
  try {
    payload = buildNetworkPayload();
  } catch (error) {
    showToast(errorMessage(error), "error");
    return;
  }

  const sent = await sendNetworkData(payload);
  if (sent) addSendHistoryEntry("network", els.networkSendInput.value);
}

function toggleNetworkPause() {
  state.networkPaused = !state.networkPaused;
  els.networkPauseButton.setAttribute("aria-pressed", String(state.networkPaused));
  els.networkPauseButton.title = state.networkPaused
    ? t("net.toolbar.resume")
    : t("net.toolbar.pause");
  els.networkPauseButton.setAttribute("aria-label", els.networkPauseButton.title);
  els.networkPauseHint.hidden = !state.networkPaused;

  if (!state.networkPaused) {
    const pending = state.networkPendingEntries;
    state.networkPendingEntries = [];
    state.networkPendingBytes = 0;
    pending.forEach((item) => processNetworkData(item.bytes, item.remote, item.at));
    showToast(t("net.toast.resumed"), "info");
  } else {
    showToast(t("net.toast.paused"), "info");
  }

  updateNetworkUI();
}

export { handleNetworkData, handleNetworkStatus, initializeNetworkBridge, initializeNetworkRuntime, sendNetworkPayload, setNetworkProtocol, toggleNetworkConnection, toggleNetworkPause, updateNetworkUI };
