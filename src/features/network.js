// Module: Network connection status, log, counters, sending, and auto-send.
// Owns: the shared TCP/UDP/SSH network log model, the peer list, payload sending, and auto-send.
// Depends on: core, log-view, payload, toast, errors.
// Called by: app.js, bridge, and agent network commands.

import { ACTIVITY_SAMPLE_COUNT, LOG_MERGE_IDLE_MS, MAX_CONNECTION_PRESETS, MAX_LOG_ENTRIES, NETWORK_PEER_COLORS, textEncoder } from "../core/constants.js";
import { $, els } from "../core/dom.js";
import { errorMessage } from "../core/errors.js";
import { formatNumber, t, tCount } from "../core/i18n.js";
import { state } from "../core/state.js";
import { appendHexText, bytesToAscii, bytesToHex, formatBytes, formatRate } from "../lib/format.js";
import { downloadBlob } from "../lib/download.js";
import { queueAutoSaveChunk } from "./autosave.js";
import { applyKeywordHighlight, createEntryContent, formatTimestamp, joinLogEntries, recordNetworkAgentTraffic, renderEntryData, resetAgentTrafficDecoders, splitSegmentsByLine, updateKeywordEntryVisibility } from "./log-view.js";
import { buildNetworkPayload, normalizeAutoSendCount } from "./payload.js";
import { showToast } from "./toast.js";

function normalizeNetworkProtocol(value) {
  return ["tcp", "udp", "ssh"].includes(value) ? value : "tcp";
}

function normalizePort(value, fallback) {
  const port = Number.parseInt(value, 10);
  return Number.isInteger(port) && port >= 1 && port <= 65535 ? port : fallback;
}

function normalizeNetworkConnectionPresets(value) {
  const presets = Array.isArray(value) ? value : [];
  return presets
    .slice(0, MAX_CONNECTION_PRESETS)
    .map((preset, index) => {
      const port = Number(preset?.port);
      if (!Number.isInteger(port) || port < 1 || port > 65535) return null;
      return {
        id: String(preset?.id || `network-preset-${index + 1}-${Date.now()}`),
        name: String(preset?.name || t("net.preset.defaultName", { index: index + 1 })).slice(0, 80),
        protocol: preset?.protocol === "udp" ? "udp" : "tcp",
        role: preset?.role === "client" ? "client" : "server",
        host: String(preset?.host || "127.0.0.1").slice(0, 120),
        port,
      };
    })
    .filter(Boolean);
}

function setNetworkStatus(stateName, message) {
  state.networkState = stateName;
  els.networkStateBadge.dataset.state = stateName;
  els.networkStateBadge.textContent =
    stateName === "connected"
      ? t("common.connected")
      : stateName === "connecting"
        ? t("common.connecting")
        : stateName === "error"
          ? t("common.error")
          : t("common.disconnected");

  els.networkDetails.classList.toggle("is-ready", stateName === "connected");
  const line = $(".port-details__line", els.networkDetails);
  const detail = $("p", els.networkDetails);
  line?.classList.toggle("is-ready", stateName === "connected");
  if (detail) detail.textContent = message;

  els.networkStreamState.textContent =
    stateName === "connected"
      ? t("common.online")
      : stateName === "connecting"
        ? t("common.connecting")
        : t("net.stream.idle");
  els.networkStreamState.classList.toggle("mini-badge--idle", stateName !== "connected");
  els.networkTitleDot.classList.toggle("is-live", stateName === "connected");
}

function updateNetworkHeaderStatus() {
  if (state.networkProtocol === "ssh") {
    let sshLabel = t("common.disconnected");
    if (state.sshState === "connecting") {
      sshLabel = t("common.connecting");
    } else if (state.sshState === "error") {
      sshLabel = t("common.connectionError");
    } else if (state.sshState === "connected") {
      sshLabel = t("ssh.state.connected");
    }
    els.networkHeaderStatus.dataset.state = state.sshState;
    els.networkHeaderStatusText.textContent = sshLabel;
    els.networkHeaderStatus.title = t("ssh.headerStatus.title", { status: sshLabel });
    els.networkHeaderStatus.setAttribute(
      "aria-label",
      t("ssh.headerStatus.aria", { status: sshLabel }),
    );
    return;
  }

  const server = state.networkRole === "server";
  let label = t("common.disconnected");

  if (state.networkState === "connecting") {
    label = t("common.connecting");
  } else if (state.networkState === "error") {
    label = t("common.connectionError");
  } else if (state.networkState === "connected") {
    if (server && state.networkProtocol === "tcp") {
      label = t("net.status.clients", { count: state.networkConnections });
    } else if (server) {
      label = t("net.status.listening");
    } else {
      label = t("common.connected");
    }
  }

  els.networkHeaderStatus.dataset.state = state.networkState;
  els.networkHeaderStatusText.textContent = label;
  els.networkHeaderStatus.title = t("net.headerStatus.title", { status: label });
  els.networkHeaderStatus.setAttribute(
    "aria-label",
    t("net.headerStatus.aria", { status: label }),
  );
}

function processNetworkData(bytes, remote, at = Date.now()) {
  const data =
    state.networkReceiveMode === "hex"
      ? bytesToHex(bytes)
      : state.networkDecoder.decode(bytes, { stream: true });
  appendNetworkEntry("rx", data, remote, at, { bytes });
}

function registerNetworkPeer(remote) {
  if (!remote) return "";
  if (state.networkPeerColors.has(remote)) {
    return state.networkPeerColors.get(remote);
  }

  const color = NETWORK_PEER_COLORS[state.networkPeerOrder.length % NETWORK_PEER_COLORS.length];
  state.networkPeerColors.set(remote, color);
  state.networkPeerOrder.push(remote);
  renderNetworkPeerList();
  return color;
}

function renderNetworkPeerList() {
  els.networkPeerList.replaceChildren();
  els.networkPeerList.hidden = state.networkPeerOrder.length === 0;

  state.networkPeerOrder.forEach((remote) => {
    const item = document.createElement("span");
    item.className = "network-peer";
    item.dataset.remote = remote;
    item.style.setProperty("--peer-color", state.networkPeerColors.get(remote));

    const swatch = document.createElement("span");
    swatch.className = "network-peer__swatch";
    swatch.setAttribute("aria-hidden", "true");

    const label = document.createElement("span");
    label.className = "network-peer__label";
    label.textContent = remote;

    item.append(swatch, label);
    els.networkPeerList.append(item);
  });
}

function appendNetworkEntry(
  direction,
  data,
  remote = "",
  at = Date.now(),
  { forceNew = false, splitLines = true, bytes = null } = {},
) {
  if (!data) return;

  const mode = direction === "tx" ? state.networkSendMode : state.networkReceiveMode;
  if (splitLines && state.networkTimestamp && mode === "text" && data.includes("\n")) {
    splitSegmentsByLine(null, data).forEach((line, index) => {
      appendNetworkEntry(direction, line.data, remote, at, {
        forceNew: forceNew || index > 0,
        splitLines: false,
        bytes: textEncoder.encode(line.data),
      });
    });
    return;
  }

  const rawBytes = bytes instanceof Uint8Array ? bytes : textEncoder.encode(data);
  const hex = bytesToHex(rawBytes);
  const ascii = bytesToAscii(rawBytes);
  const previous = state.networkEntries.at(-1);
  const now = Date.now();
  const continuesGroup =
    previous &&
    direction !== "sys" &&
    previous.direction === direction &&
    previous.remote === remote &&
    previous.mode === mode;
  const canMerge =
    !forceNew &&
    continuesGroup &&
    now - previous.updatedAt <= LOG_MERGE_IDLE_MS &&
    !previous.data.endsWith("\n") &&
    !data.startsWith("\n");
  const renderedData = data;

  if (canMerge) {
    previous.data += renderedData;
    previous.updatedAt = Date.now();
    previous.hex = appendHexText(previous.hex, hex);
    previous.ascii = previous.mode === "hex" ? `${previous.ascii || ""}${ascii}` : previous.ascii;
    renderEntryData(previous, []);
    applyKeywordHighlight(previous.dataElement);
    updateKeywordEntryVisibility(previous, previous.dataElement.closest(".log-entry"));
    queueAutoSaveChunk("network", renderedData, { newEntry: false });
    if (state.networkAutoScroll && !state.networkFollowSuspended) scrollNetworkToLatest();
    return;
  }

  const element = document.createElement("div");
  element.className = `log-entry log-entry--${direction}`;
  element.classList.toggle("is-group-continuation", Boolean(continuesGroup));
  element.title = t("logEntry.copyHint");

  const peerColor = direction === "rx" && remote ? registerNetworkPeer(remote) : "";
  const peerMarker = document.createElement("span");
  peerMarker.className = "log-entry__remote-color";
  peerMarker.classList.toggle("is-placeholder", !peerColor || Boolean(continuesGroup));
  if (peerColor) {
    peerMarker.style.setProperty("--peer-color", peerColor);
    peerMarker.dataset.remote = remote;
  }

  const entryTime = formatTimestamp(new Date(at), state.networkTimestampMode, "network");
  const groupLastTime = continuesGroup ? previous.groupLastTime || previous.time : "";
  const showTime =
    state.networkTimestamp && (!continuesGroup || entryTime !== groupLastTime);
  const time = document.createElement("span");
  time.className = "log-entry__time";
  time.textContent = showTime ? entryTime : "";
  time.title = showTime ? t("logEntry.copyTimeHint") : "";

  const label = document.createElement("span");
  label.className = "log-entry__direction";
  label.classList.toggle("is-placeholder", Boolean(continuesGroup));
  label.textContent = continuesGroup
    ? ""
    : direction === "rx"
      ? "RX"
      : direction === "tx"
        ? "TX"
        : "SYS";

  const entry = {
    source: "network",
    direction,
    remote,
    mode,
    data: renderedData,
    hex,
    ascii,
    updatedAt: Date.now(),
    time: entryTime,
    showTime,
    groupContinuation: Boolean(continuesGroup),
    groupLastTime: showTime ? entryTime : groupLastTime,
    dataElement: null,
    alternateElement: null,
    segments: [],
  };
  const content = createEntryContent(entry, []);
  renderEntryData(entry, []);

  element.append(peerMarker, time, label, content);
  els.networkLogContent.append(element);
  els.networkEmptyState.hidden = true;

  state.networkEntries.push(entry);
  applyKeywordHighlight(entry.dataElement);
  updateKeywordEntryVisibility(entry, element);
  queueAutoSaveChunk(
    "network",
    `${showTime ? `[${entryTime}] ` : ""}${direction.toUpperCase().padEnd(3, " ")} ${renderedData}`,
    { newEntry: true },
  );

  while (state.networkEntries.length > MAX_LOG_ENTRIES) {
    state.networkEntries.shift();
    els.networkLogContent.firstElementChild?.remove();
  }

  if (state.networkAutoScroll && !state.networkFollowSuspended) scrollNetworkToLatest();
}

function scrollNetworkToLatest() {
  requestAnimationFrame(() => {
    els.networkViewport.scrollTop = els.networkViewport.scrollHeight;
  });
}

function updateNetworkFollowUI() {
  els.networkFollowLatestButton.hidden = !(
    state.networkAutoScroll && state.networkFollowSuspended
  );
}

function resumeNetworkFollowing() {
  state.networkFollowSuspended = false;
  updateNetworkFollowUI();
  scrollNetworkToLatest();
}

function updateNetworkCounters() {
  els.networkRxCounter.textContent = formatBytes(state.networkRxBytes);
  els.networkTxCounter.textContent = formatBytes(state.networkTxBytes);
  els.networkLinkCounter.textContent = String(state.networkConnections);
  els.networkPacketReadout.textContent = tCount("net.metrics.frames", state.networkFrames, {
    count: formatNumber(state.networkFrames),
  });
}

function hasNetworkSendPayload() {
  if (state.networkSendMode === "hex") return Boolean(els.networkSendInput.value.trim());
  return Boolean(els.networkSendInput.value) || els.networkLineEnding.value !== "none";
}

function readNetworkConfig() {
  const host = els.networkHost.value.trim() || "127.0.0.1";
  const port = Number.parseInt(els.networkPort.value, 10);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(t("net.error.portRange"));
  }
  return { host, port };
}

async function sendNetworkData(payload, { actor = "user" } = {}) {
  if (!state.networkConnected || !state.networkBridge) {
    showToast(t("net.error.notConnected"), "error");
    return false;
  }

  if (!payload.byteLength) {
    showToast(t("net.error.emptyPayload"), "info");
    return false;
  }

  try {
    await state.networkBridge.send(payload);
    recordNetworkAgentTraffic("tx", payload, actor);
    state.networkTxBytes += payload.byteLength;
    state.networkFrames += 1;
    state.networkLastActivityAt = Date.now();
    updateNetworkCounters();
    appendNetworkEntry(
      "tx",
      state.networkSendMode === "hex"
        ? bytesToHex(payload)
        : new TextDecoder("utf-8", { fatal: false }).decode(payload),
      "local",
      Date.now(),
      { forceNew: true, bytes: payload },
    );
    return true;
  } catch (error) {
    showToast(errorMessage(error, t("net.error.sendFailed")), "error");
    return false;
  }
}

function startNetworkAutoSend() {
  if (!state.networkConnected) {
    showToast(t("net.error.notConnected"), "error");
    return;
  }

  try {
    buildNetworkPayload({ consumeTemplateCounter: false });
  } catch (error) {
    showToast(errorMessage(error), "error");
    return;
  }

  const interval = Math.max(
    10,
    Number.parseInt(els.networkAutoSendInterval.value, 10) || 1000,
  );
  const count = normalizeAutoSendCount(els.networkAutoSendCount.value);
  els.networkAutoSendInterval.value = String(interval);
  els.networkAutoSendCount.value = String(count);
  state.networkAutoSendCount = count;
  state.networkAutoSendRemaining = count;
  state.networkAutoSendRunning = true;
  updateNetworkAutoSendUI();
  scheduleNetworkAutoSend(interval);
}

function scheduleNetworkAutoSend(interval) {
  state.networkAutoSendTimer = window.setTimeout(async () => {
    if (!state.networkAutoSendRunning || !state.networkConnected) {
      stopNetworkAutoSend();
      return;
    }

    let payload;
    try {
      payload = buildNetworkPayload();
    } catch (error) {
      showToast(errorMessage(error), "error");
      stopNetworkAutoSend();
      return;
    }

    const sent = await sendNetworkData(payload);
    if (sent && state.networkAutoSendRunning) {
      if (state.networkAutoSendRemaining > 0) {
        state.networkAutoSendRemaining -= 1;
        updateNetworkAutoSendUI();
        if (state.networkAutoSendRemaining === 0) {
          stopNetworkAutoSend({
            silent: false,
            message: t("net.autoSend.completed"),
          });
          return;
        }
      }
      scheduleNetworkAutoSend(interval);
    } else if (!sent) {
      stopNetworkAutoSend();
    }
  }, interval);
}

function stopNetworkAutoSend({ silent = true, message = "" } = {}) {
  if (state.networkAutoSendTimer) {
    window.clearTimeout(state.networkAutoSendTimer);
    state.networkAutoSendTimer = null;
  }
  const wasRunning = state.networkAutoSendRunning;
  state.networkAutoSendRunning = false;
  state.networkAutoSendRemaining = 0;
  updateNetworkAutoSendUI();
  if (wasRunning && !silent) showToast(message || t("net.autoSend.stopped"), "info");
}

function updateNetworkAutoSendUI() {
  els.networkAutoSendButton.setAttribute(
    "aria-pressed",
    String(state.networkAutoSendRunning),
  );
  const remaining =
    state.networkAutoSendRunning && state.networkAutoSendRemaining > 0
      ? state.networkAutoSendRemaining
      : 0;
  $("span", els.networkAutoSendButton).textContent = state.networkAutoSendRunning
    ? remaining > 0
      ? t("net.autoSend.stopWithRemaining", { count: remaining })
      : t("net.autoSend.stop")
    : t("net.send.autoSendStart");
  els.networkAutoSendButton.title = state.networkAutoSendRunning
    ? remaining > 0
      ? t("net.autoSend.stopTitleRemaining", { count: remaining })
      : t("net.autoSend.stopTitle")
    : t("net.autoSend.startTitle");
}

function clearNetworkLog() {
  state.networkEntries = [];
  state.networkPendingEntries = [];
  state.networkPendingBytes = 0;
  state.networkPeerColors.clear();
  state.networkPeerOrder = [];
  state.networkDecoder = new TextDecoder("utf-8", { fatal: false });
  resetAgentTrafficDecoders("network");
  state.networkRxBytes = 0;
  state.networkTxBytes = 0;
  state.networkFrames = 0;
  state.networkLastActivityAt = 0;
  state.networkActivity = Array.from({ length: ACTIVITY_SAMPLE_COUNT }, () => ({ rx: 0, tx: 0 }));
  state.networkFollowSuspended = false;
  els.networkLogContent.replaceChildren();
  renderNetworkPeerList();
  els.networkEmptyState.hidden = false;
  updateNetworkCounters();
  updateNetworkFollowUI();
  renderNetworkActivity(0, 0);
  showToast(t("net.toast.cleared"), "info");
}

function saveNetworkLog() {
  if (!state.networkEntries.length) {
    showToast(t("net.toast.noDataToSave"), "info");
    return;
  }

  const content = joinLogEntries(state.networkEntries, (entry) => {
    const time = entry.showTime ? `[${entry.time}] ` : "";
    const direction = entry.groupContinuation
      ? "   "
      : entry.direction.toUpperCase().padEnd(3, " ");
    return `${time}${direction} ${entry.data}`;
  });
  const timestamp = new Date()
    .toISOString()
    .replace(/[-:]/g, "")
    .replace(/\..+/, "")
    .replace("T", "-");
  const blob = new Blob(["\ufeff", content], { type: "text/plain;charset=utf-8" });
  downloadBlob(blob, `network-log-${timestamp}.txt`);
  showToast(t("net.toast.logSaved"), "success");
}

function updateNetworkMetrics() {
  const now = performance.now();
  const elapsed = Math.max(1, now - state.networkMetricLastAt);
  const rxRate = ((state.networkRxBytes - state.networkMetricLastRx) * 1000) / elapsed;
  const txRate = ((state.networkTxBytes - state.networkMetricLastTx) * 1000) / elapsed;

  state.networkMetricLastAt = now;
  state.networkMetricLastRx = state.networkRxBytes;
  state.networkMetricLastTx = state.networkTxBytes;

  state.networkActivity.shift();
  state.networkActivity.push({ rx: rxRate, tx: txRate });
  renderNetworkActivity(rxRate, txRate);
  els.networkRateReadout.textContent = formatRate(rxRate);
  els.networkLastActivityLabel.textContent = state.networkLastActivityAt
    ? t("net.metrics.activeAgo", {
        count: Math.max(0, Math.floor((Date.now() - state.networkLastActivityAt) / 1000)),
      })
    : t("net.footer.noActivity");
}

function renderNetworkActivity(rxRate, txRate) {
  els.networkActivityMeter.replaceChildren();
  const maxRate = Math.max(
    1,
    ...state.networkActivity.flatMap((sample) => [sample.rx, sample.tx]),
  );

  state.networkActivity.forEach((sample) => {
    const bar = document.createElement("span");
    const value = Math.max(sample.rx, sample.tx);
    const level = value ? Math.max(1, Math.log2(value + 1) / Math.log2(maxRate + 1)) : 0;
    bar.style.height = `${3 + level * 21}px`;
    bar.style.opacity = value ? String(0.32 + level * 0.68) : "0.2";
    bar.classList.toggle("is-tx", sample.tx > sample.rx);
    els.networkActivityMeter.append(bar);
  });

  if (rxRate === 0 && txRate === 0) {
    els.networkRateReadout.textContent = "0 B/s";
  }
}

export { appendNetworkEntry, clearNetworkLog, hasNetworkSendPayload, normalizeNetworkConnectionPresets, normalizeNetworkProtocol, normalizePort, processNetworkData, readNetworkConfig, registerNetworkPeer, renderNetworkActivity, renderNetworkPeerList, resumeNetworkFollowing, saveNetworkLog, scheduleNetworkAutoSend, scrollNetworkToLatest, sendNetworkData, setNetworkStatus, startNetworkAutoSend, stopNetworkAutoSend, updateNetworkAutoSendUI, updateNetworkCounters, updateNetworkFollowUI, updateNetworkHeaderStatus, updateNetworkMetrics };
