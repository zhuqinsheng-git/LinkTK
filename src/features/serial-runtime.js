// Module: Serial connection runtime, read loop, sending, and auto-send.
// Owns: port selection/refresh, connection lifecycle, the read loop, payload sending, and auto-send.
// Depends on: core, serial, log-view, payload, bridge, response-test, macro, toast; UI callbacks are injected by app.js.
// Called by: app.js wiring and the serial UI.

import { createAnsiStyle } from "../lib/ansi.js";
import { MAX_PENDING_BYTES, textEncoder } from "../core/constants.js";
import { $, els } from "../core/dom.js";
import { errorMessage } from "../core/errors.js";
import { t } from "../core/i18n.js";
import { defaultSettings, persistSettings } from "../core/settings.js";
import { state } from "../core/state.js";
import { getAgentStatusSnapshot } from "../agent/runtime.js";
import { enqueueBridgeTask, stopBridge } from "./bridge.js";
import { markActivity, processBytes, recordAgentTraffic, resetAgentTrafficDecoders, updateCounters } from "./log-view.js";
import { recordLogMacroCommand, recordTerminalMacroPayload, stopMacroPlayback, stopMacroRecording } from "./macro.js";
import { buildPayload, normalizeAutoSendCount } from "./payload.js";
import { cancelResponseTest, observeResponseTest } from "./response-test.js";
import { applySignalState, buildPortLabels, createPortName, ensureSerialAvailable, getPortName, readSerialOptions, refreshSystemSerialPorts, setPortDetails } from "./serial.js";
import { showToast } from "./toast.js";
import { addSendHistoryEntry } from "./send-history.js";

let updateConnectionUI = null;

function initializeSerialRuntime({
  updateConnectionUI: updateConnectionUICallback,
} = {}) {
  if (typeof updateConnectionUICallback !== "function") {
    throw new TypeError("initializeSerialRuntime requires updateConnectionUI.");
  }
  updateConnectionUI = updateConnectionUICallback;
}



function updatePortSelection() {
  const selectedIndex = Number.parseInt(els.portSelect.value, 10);
  state.selectedPort = Number.isInteger(selectedIndex) ? state.ports[selectedIndex] || null : null;

  if (!state.selectedPort) {
    els.portStateBadge.textContent = t("serial.portState.none");
    setPortDetails(
      state.ports.length ? t("serial.port.selectPrompt") : t("serial.port.noneSelected"),
      t("serial.port.chooseHint"),
      false,
    );
  } else {
    const portName = getPortName(state.selectedPort, selectedIndex);
    els.portStateBadge.textContent = state.connected ? t("common.connected") : t("serial.portState.selected");
    setPortDetails(portName.title, portName.meta, true);
  }

  updateConnectionUI();
}

async function refreshPorts(preferredPort = null) {
  if (!state.supported) return;

  try {
    await refreshSystemSerialPorts();
    const ports = await navigator.serial.getPorts();
    const candidate = preferredPort || state.selectedPort || state.activePort;
    state.ports = ports;
    state.portLabels = buildPortLabels(ports);
    els.portSelect.replaceChildren();

    if (!ports.length) {
      const option = document.createElement("option");
      option.value = "";
      option.textContent = t("serial.port.noPaired");
      els.portSelect.append(option);
      els.portSelect.disabled = true;
    } else {
      const placeholder = document.createElement("option");
      placeholder.value = "";
      placeholder.textContent = t("serial.port.placeholder");
      els.portSelect.append(placeholder);

      ports.forEach((port, index) => {
        const info = getPortName(port, index);
        const option = document.createElement("option");
        option.value = String(index);
        option.textContent = info.optionLabel || `${info.title} · ${info.meta}`;
        els.portSelect.append(option);
      });

      const candidateIndex = candidate ? ports.indexOf(candidate) : -1;
      const selectedIndex = candidateIndex >= 0 ? candidateIndex : 0;
      els.portSelect.value = String(selectedIndex);
    }
  } catch (error) {
    showToast(errorMessage(error, t("serial.error.listFailed")), "error");
  }

  updatePortSelection();
}

async function requestPort() {
  if (!ensureSerialAvailable()) return;

  try {
    const port = await navigator.serial.requestPort();
    await refreshPorts(port);
    showToast(t("serial.paired"), "success");
  } catch (error) {
    if (error?.name !== "NotFoundError") {
      showToast(errorMessage(error, t("serial.error.selectFailed")), "error");
    }
  }
}

async function connectSelectedPort({ throwOnError = false } = {}) {
  if (!ensureSerialAvailable()) {
    if (throwOnError) throw new Error(t("serial.error.unsupported"));
    return false;
  }
  if (state.connected) return getAgentStatusSnapshot().serial;
  if (state.connecting) {
    if (throwOnError) throw new Error(t("serial.error.connecting"));
    return false;
  }

  let port = state.selectedPort;
  if (!port) {
    if (throwOnError) {
      throw new Error(t("serial.error.noSelectionForAgent"));
    }
    await requestPort();
    port = state.selectedPort;
  }
  if (!port) return false;

  let options;
  try {
    options = readSerialOptions();
  } catch (error) {
    if (throwOnError) throw error;
    showToast(errorMessage(error), "error");
    return false;
  }

  state.connecting = true;
  updateConnectionUI();

  try {
    await port.open(options);
    state.activePort = port;
    state.connected = true;
    state.connectedAt = Date.now();
    state.lastTimestampAt = 0;
    state.closing = false;
    state.decoders.rx = new TextDecoder("utf-8", { fatal: false });
    state.decoders.tx = new TextDecoder("utf-8", { fatal: false });
    resetAgentTrafficDecoders("serial");
    state.ansiRemainders.rx = "";
    state.ansiRemainders.tx = "";
    state.ansiStyles.rx = createAnsiStyle();
    state.ansiStyles.tx = createAnsiStyle();
    state.writer = port.writable ? port.writable.getWriter() : null;

    await applySignalState();
    updateConnectionUI();
    state.readTask = readLoop();
    showToast(t("serial.opened", { baud: options.baudRate }), "success");
    return getAgentStatusSnapshot().serial;
  } catch (error) {
    state.errors += 1;
    updateCounters();
    showToast(errorMessage(error, t("serial.error.openFailed")), "error");
    if (throwOnError) throw error;
    return false;
  } finally {
    state.connecting = false;
    updateConnectionUI();
  }
}

async function disconnectPort({ reason = "manual", notify = true } = {}) {
  if (!state.activePort || state.closing) return;

  state.closing = true;
  stopBridge({ silent: true });
  if (state.ymodemSession?.active) {
    await state.ymodemSession.cancel({
      sendCan: reason === "manual",
      reason: reason === "manual" ? t("serial.closedByUser") : t("serial.disconnected"),
    });
  }
  stopAutoSend();
  if (state.responseTest.active && state.responseTest.kind === "serial") {
    cancelResponseTest({ reason: t("response.serialAborted") });
  }
  if (state.macroRecording) {
    stopMacroRecording({ notify: false });
  }
  if (state.macroPlaybackActive) {
    stopMacroPlayback();
  }
  const port = state.activePort;
  const wasConnected = state.connected;
  state.connected = false;
  updateConnectionUI();

  try {
    if (state.reader) {
      await state.reader.cancel().catch(() => {});
    }
    if (state.readTask) {
      await state.readTask.catch(() => {});
    }
  } finally {
    state.reader = null;
    state.readTask = null;
  }

  try {
    if (state.writer) {
      await state.writer.close().catch(() => {});
      state.writer.releaseLock();
    }
  } catch {
    // Some USB serial adapters disappear before the writer can close.
  } finally {
    state.writer = null;
  }

  try {
    await port.close();
  } catch {
    // A removed USB device is already closed.
  }

  state.activePort = null;
  state.closing = false;
  state.decoders.rx = new TextDecoder("utf-8", { fatal: false });
  state.decoders.tx = new TextDecoder("utf-8", { fatal: false });
  resetAgentTrafficDecoders("serial");
  state.ansiRemainders.rx = "";
  state.ansiRemainders.tx = "";
  state.ansiStyles.rx = createAnsiStyle();
  state.ansiStyles.tx = createAnsiStyle();
  updateConnectionUI();

  if (notify && wasConnected && reason === "manual") {
    showToast(t("serial.closed"), "info");
  }
}

async function readLoop() {
  while (state.connected && state.activePort?.readable) {
    const reader = state.activePort.readable.getReader();
    state.reader = reader;

    try {
      while (state.connected) {
        const { value, done } = await reader.read();
        if (done) break;
        if (value?.byteLength) {
          handleIncomingBytes(value);
        }
      }
    } catch (error) {
      if (!state.closing) {
        state.errors += 1;
        updateCounters();
        showToast(errorMessage(error, t("serial.error.readInterrupted")), "error");
        void disconnectPort({ reason: "read-error", notify: false });
      }
    } finally {
      reader.releaseLock();
      if (state.reader === reader) state.reader = null;
    }
  }
}

function handleIncomingBytes(bytes) {
  state.rxBytes += bytes.byteLength;
  state.rxFrames += 1;
  markActivity();
  updateCounters();
  observeResponseTest("serial", bytes);

  if (state.ymodemSession?.active) {
    state.ymodemSession.push(bytes);
    return;
  }

  recordAgentTraffic("rx", bytes);

  if (state.bridgeActive && state.bridgeSerialToNetwork) {
    enqueueBridgeTask("serial-to-network", bytes);
  }

  if (state.terminal) {
    state.terminal.write(bytes, () => {
      if (state.consoleView === "terminal") {
        requestAnimationFrame(() => {
          state.terminal?.scrollToBottom();
          state.terminal?.refresh(0, state.terminal.rows - 1);
        });
      }
    });
  }

  if (state.paused) {
    const copy = bytes.slice();
    state.pendingEntries.push(copy);
    state.pendingBytes += copy.byteLength;

    while (state.pendingBytes > MAX_PENDING_BYTES && state.pendingEntries.length > 1) {
      state.pendingBytes -= state.pendingEntries.shift().byteLength;
    }
    return;
  }

  processBytes("rx", bytes);
}

















async function sendPayload(
  payload,
  {
    fromAutoSend = false,
    fromYmodem = false,
    recordLog = true,
    separateLog = true,
    actor = "user",
  } = {},
) {
  if ((state.ymodemSession?.active || state.ymodemBusy) && !fromYmodem) {
    if (!fromAutoSend) showToast(t("serial.error.ymodemBusy"), "info");
    return false;
  }

  if (!state.connected || !state.writer) {
    if (!fromAutoSend) showToast(t("serial.openPortFirst"), "error");
    return false;
  }

  if (!payload.byteLength) {
    if (!fromAutoSend) showToast(t("common.emptyPayload"), "info");
    return false;
  }

  try {
    await state.writer.write(payload);
    state.txBytes += payload.byteLength;
    state.txFrames += 1;
    markActivity();
    updateCounters();
    if (recordLog) recordAgentTraffic("tx", payload, actor);

    if (recordLog && !state.paused) {
      processBytes("tx", payload, { forceNew: separateLog, actor });
    }
    return true;
  } catch (error) {
    state.errors += 1;
    updateCounters();
    showToast(errorMessage(error, t("serial.error.sendFailed")), "error");
    stopAutoSend();
    void disconnectPort({ reason: "write-error", notify: false });
    return false;
  }
}

async function handleSend() {
  let payload;
  try {
    payload = buildPayload();
  } catch (error) {
    showToast(errorMessage(error), "error");
    return;
  }

  const sent = await sendPayload(payload);
  if (sent) {
    addSendHistoryEntry("serial", els.sendInput.value);
    if (state.macroRecording && state.macroRecordingMode === "terminal") {
      recordTerminalMacroPayload(payload);
    } else {
      recordLogMacroCommand(payload);
    }
  }
}

function startAutoSend() {
  if (!state.connected) {
    showToast(t("serial.openPortFirst"), "error");
    return;
  }

  try {
    buildPayload({ consumeTemplateCounter: false });
  } catch (error) {
    showToast(errorMessage(error), "error");
    return;
  }

  const interval = Math.max(10, Number.parseInt(els.autoSendInterval.value, 10) || 1000);
  const count = normalizeAutoSendCount(els.autoSendCount.value);
  els.autoSendInterval.value = String(interval);
  els.autoSendCount.value = String(count);
  state.autoSendCount = count;
  state.autoSendRemaining = count;
  state.autoSendRunning = true;
  updateAutoSendUI();
  scheduleAutoSend(interval);
}

function scheduleAutoSend(interval) {
  state.autoSendTimer = window.setTimeout(async () => {
    if (!state.autoSendRunning || !state.connected) {
      stopAutoSend();
      return;
    }

    let payload;
    try {
      payload = buildPayload();
    } catch (error) {
      showToast(errorMessage(error), "error");
      stopAutoSend();
      return;
    }

    const sent = await sendPayload(payload, { fromAutoSend: true });
    if (sent && state.autoSendRunning) {
      if (state.autoSendRemaining > 0) {
        state.autoSendRemaining -= 1;
        updateAutoSendUI();
        if (state.autoSendRemaining === 0) {
          stopAutoSend({ silent: false, message: t("serial.autoSend.completed") });
          return;
        }
      }
      scheduleAutoSend(interval);
    } else if (!sent) {
      stopAutoSend();
    }
  }, interval);
}

function stopAutoSend({ silent = true, message = "" } = {}) {
  if (state.autoSendTimer) {
    window.clearTimeout(state.autoSendTimer);
    state.autoSendTimer = null;
  }
  const wasRunning = state.autoSendRunning;
  state.autoSendRunning = false;
  state.autoSendRemaining = 0;
  updateAutoSendUI();
  if (wasRunning && !silent) showToast(message || t("serial.autoSend.stopped"), "info");
}

function updateAutoSendUI() {
  els.autoSendButton.setAttribute("aria-pressed", String(state.autoSendRunning));
  const remaining =
    state.autoSendRunning && state.autoSendRemaining > 0 ? state.autoSendRemaining : 0;
  $("span", els.autoSendButton).textContent = state.autoSendRunning
    ? remaining > 0
      ? t("serial.autoSend.stopWithRemaining", { count: remaining })
      : t("serial.autoSend.stop")
    : t("serial.send.autoSendStart");
  els.autoSendButton.title = state.autoSendRunning
    ? remaining > 0
      ? t("serial.autoSend.stopTitleRemaining", { count: remaining })
      : t("serial.autoSend.stopTitle")
    : t("serial.autoSend.startTitle");
}

function hasSendPayload() {
  if (state.sendMode === "hex") return Boolean(els.sendInput.value.trim());
  return Boolean(els.sendInput.value) || els.lineEnding.value !== "none";
}

export { connectSelectedPort, disconnectPort, handleIncomingBytes, handleSend, hasSendPayload, initializeSerialRuntime, readLoop, refreshPorts, requestPort, scheduleAutoSend, sendPayload, startAutoSend, stopAutoSend, updateAutoSendUI, updatePortSelection };
