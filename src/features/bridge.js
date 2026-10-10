// Module: Bidirectional link bridging between serial and TCP/UDP.
// Owns: bridge directions, start/stop state, queues, and byte forwarding both ways.
// Depends on: core, format, log-view, network, i18n, toast.
// Called by: the app.js bridge UI and the Agent command adapter.

import { els } from "../core/dom.js";
import { errorMessage } from "../core/errors.js";
import { t } from "../core/i18n.js";
import { state } from "../core/state.js";
import { formatBytes } from "../lib/format.js";
import { markActivity, recordAgentTraffic, recordNetworkAgentTraffic, updateCounters } from "./log-view.js";
import { updateNetworkCounters } from "./network.js";
import { showToast } from "./toast.js";

function updateBridgeUI() {
  const serialReady = state.connected && Boolean(state.writer);
  const sshMode = state.networkProtocol === "ssh";
  const networkReady = !sshMode && state.networkConnected && Boolean(state.networkBridge);
  const directionSelected = state.bridgeSerialToNetwork || state.bridgeNetworkToSerial;
  const canStart = serialReady && networkReady && directionSelected;

  const serialLabel = state.connected
    ? els.portSelect.selectedOptions?.[0]?.textContent?.trim() || t("common.connected")
    : t("common.disconnected");
  const protocol = state.networkProtocol.toUpperCase();
  const role = state.networkRole === "server" ? t("net.endpoint.server") : t("net.endpoint.client");
  const networkLabel = state.networkConnected
    ? `${protocol} ${role} · ${state.networkHost}:${state.networkPort}`
    : t("common.disconnected");

  els.bridgeSerialEndpoint.textContent = serialLabel;
  els.bridgeNetworkEndpoint.textContent = networkLabel;
  els.bridgeSerialToNetworkCounter.textContent = formatBytes(state.bridgeSerialToNetworkBytes);
  els.bridgeNetworkToSerialCounter.textContent = formatBytes(state.bridgeNetworkToSerialBytes);
  els.bridgeSerialToNetworkToggle.checked = state.bridgeSerialToNetwork;
  els.bridgeNetworkToSerialToggle.checked = state.bridgeNetworkToSerial;
  els.bridgeSerialToNetworkToggle.disabled = state.bridgeActive;
  els.bridgeNetworkToSerialToggle.disabled = state.bridgeActive;

  els.bridgeButtonText.textContent = state.bridgeActive ? t("bridge.stop") : t("common.bridge");
  els.bridgeButton.classList.toggle("is-active", state.bridgeActive);
  els.bridgeButton.disabled = sshMode && !state.bridgeActive;
  els.bridgeButton.title = sshMode ? t("bridge.sshHint") : "";
  els.bridgeToggleButton.textContent = state.bridgeActive ? t("bridge.stop") : t("bridge.start");
  els.bridgeToggleButton.classList.toggle("button--primary", !state.bridgeActive);
  els.bridgeToggleButton.classList.toggle("button--danger", state.bridgeActive);
  els.bridgeToggleButton.disabled = !state.bridgeActive && !canStart;

  if (state.bridgeActive) {
    els.bridgeStatusBadge.dataset.state = "active";
    els.bridgeStatusBadge.textContent = t("bridge.state.active");
    els.bridgeStatusText.textContent = t("bridge.state.activeHint");
  } else if (canStart) {
    els.bridgeStatusBadge.dataset.state = "ready";
    els.bridgeStatusBadge.textContent = t("bridge.state.ready");
    els.bridgeStatusText.textContent = t("bridge.state.readyHint");
  } else {
    els.bridgeStatusBadge.dataset.state = "idle";
    els.bridgeStatusBadge.textContent = t("bridge.state.stopped");
    els.bridgeStatusText.textContent = directionSelected
      ? t("bridge.statusHint")
      : t("bridge.state.selectDirection");
  }
}

function openBridgeDialog() {
  updateBridgeUI();
  if (!els.bridgeDialog.open) els.bridgeDialog.showModal();
}

function closeBridgeDialog() {
  if (els.bridgeDialog.open) els.bridgeDialog.close();
}

function startBridge() {
  if (state.networkProtocol === "ssh") {
    showToast(t("bridgeAgent.sshUnsupported"), "info");
    return;
  }
  if (!state.connected || !state.writer) {
    showToast(t("serial.openPortFirst"), "error");
    return;
  }
  if (!state.networkConnected || !state.networkBridge) {
    showToast(t("net.error.notConnected"), "error");
    return;
  }
  if (!state.bridgeSerialToNetwork && !state.bridgeNetworkToSerial) {
    showToast(t("bridgeAgent.directionRequired"), "error");
    return;
  }

  state.bridgeActive = true;
  updateBridgeUI();
  showToast(t("bridge.started"), "success");
}

function stopBridge({ silent = true, reason = "" } = {}) {
  if (!state.bridgeActive) return;
  state.bridgeActive = false;
  updateBridgeUI();
  if (!silent) showToast(reason || t("bridge.stopped"), "info");
}

function toggleBridge() {
  if (state.bridgeActive) {
    stopBridge({ silent: false });
  } else {
    startBridge();
  }
}

function enqueueBridgeTask(direction, bytes) {
  if (!state.bridgeActive || !bytes.byteLength) return;
  const copy = bytes.slice();

  if (direction === "serial-to-network") {
    if (!state.bridgeSerialToNetwork) return;
    state.bridgeSerialToNetworkQueue = state.bridgeSerialToNetworkQueue
      .then(() => forwardSerialToNetwork(copy))
      .catch(() => {});
  } else {
    if (!state.bridgeNetworkToSerial) return;
    state.bridgeNetworkToSerialQueue = state.bridgeNetworkToSerialQueue
      .then(() => forwardNetworkToSerial(copy))
      .catch(() => {});
  }
}

async function forwardSerialToNetwork(bytes) {
  if (!state.bridgeActive || !state.bridgeSerialToNetwork) return;
  if (!state.networkConnected || !state.networkBridge) {
    stopBridge({ silent: false, reason: t("bridge.stoppedNetwork") });
    return;
  }

  try {
    await state.networkBridge.send(bytes);
    recordNetworkAgentTraffic("tx", bytes, "bridge");
    state.networkTxBytes += bytes.byteLength;
    state.networkFrames += 1;
    state.networkLastActivityAt = Date.now();
    state.bridgeSerialToNetworkBytes += bytes.byteLength;
    updateNetworkCounters();
    updateBridgeUI();
  } catch (error) {
    stopBridge({ silent: true });
    showToast(errorMessage(error, t("bridge.error.serialToNetwork")), "error");
  }
}

async function forwardNetworkToSerial(bytes) {
  if (!state.bridgeActive || !state.bridgeNetworkToSerial) return;
  if (!state.connected || !state.writer || state.ymodemBusy) {
    stopBridge({ silent: false, reason: t("bridge.stoppedSerial") });
    return;
  }

  try {
    await state.writer.write(bytes);
    recordAgentTraffic("tx", bytes, "bridge");
    state.txBytes += bytes.byteLength;
    state.txFrames += 1;
    markActivity();
    state.bridgeNetworkToSerialBytes += bytes.byteLength;
    updateCounters();
    updateBridgeUI();
  } catch (error) {
    state.errors += 1;
    updateCounters();
    stopBridge({ silent: true });
    showToast(errorMessage(error, t("bridge.error.networkToSerial")), "error");
  }
}

export { closeBridgeDialog, enqueueBridgeTask, forwardNetworkToSerial, forwardSerialToNetwork, openBridgeDialog, startBridge, stopBridge, toggleBridge, updateBridgeUI };
