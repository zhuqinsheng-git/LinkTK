// Module: Receive-area log, filtering, copy, follow, and counters.
// Owns: timestamps, ANSI rendering, log entries, keywords, follow, counters, and the traffic graph.
// Depends on: core, lib, autosave, toast.
// Called by: serial, network, app.js.

import { ACTIVITY_SAMPLE_COUNT, APP_STARTED_AT, LOG_MERGE_IDLE_MS, MAX_AGENT_EVENTS, MAX_AGENT_EVENT_BYTES, MAX_LOG_ENTRIES, MAX_PENDING_BYTES, textEncoder } from "../core/constants.js";
import { els } from "../core/dom.js";
import { formatNumber, t, tCount } from "../core/i18n.js";
import { persistSettings } from "../core/settings.js";
import { state } from "../core/state.js";
import { appendHexText, bytesToAscii, bytesToHex, formatBytes, formatClockTime, formatRate } from "../lib/format.js";
import { createAnsiStyle, parseAnsiText } from "../lib/ansi.js";
import { downloadBlob } from "../lib/download.js";
import { queueAutoSaveChunk } from "./autosave.js";
import { showToast } from "./toast.js";

function normalizeTimestampMode(value) {
  return value === "elapsed" || value === "relative" ? value : "absolute";
}

function getTimestampMode(kind) {
  return kind === "network" ? state.networkTimestampMode : state.timestampMode;
}

function updateTimestampModeButtons(kind, { disabled = false } = {}) {
  const network = kind === "network";
  const mode = network ? state.networkTimestampMode : state.timestampMode;
  const buttons = network ? els.networkTimestampModeButtons : els.timestampModeButtons;

  buttons.forEach((button) => {
    const active = button.dataset[network ? "networkTimestampMode" : "timestampMode"] === mode;
    button.classList.toggle("is-active", active);
    button.setAttribute("aria-pressed", String(active));
    button.disabled = disabled;
  });
}

function setTimestampMode(kind, value, { persist = true } = {}) {
  const mode = normalizeTimestampMode(value);
  if (kind === "network") {
    state.networkTimestampMode = mode;
  } else {
    state.timestampMode = mode;
  }
  updateTimestampModeButtons(kind, {
    disabled: kind === "network" ? !state.networkTimestamp : !state.timestamp,
  });
  if (persist) persistSettings();
}

function formatTimestamp(date = new Date(), mode = state.timestampMode, source = "serial") {
  const safeDate = date instanceof Date && !Number.isNaN(date.getTime()) ? date : new Date();
  const normalizedMode = normalizeTimestampMode(mode);

  if (normalizedMode === "absolute") return formatClockTime(safeDate);

  if (normalizedMode === "relative") {
    const lastKey = source === "network" ? "networkLastTimestampAt" : "lastTimestampAt";
    const previous = Number(state[lastKey]) || 0;
    state[lastKey] = safeDate.getTime();
    if (!previous) return "+0ms";
    const delta = Math.max(0, safeDate.getTime() - previous);
    return delta < 1000 ? `+${delta}ms` : `+${(delta / 1000).toFixed(3)}s`;
  }

  const origin =
    source === "network"
      ? state.networkConnectedAt || APP_STARTED_AT
      : state.connectedAt || APP_STARTED_AT;
  const delta = Math.max(0, safeDate.getTime() - origin);
  const totalMilliseconds = delta;
  const hours = Math.floor(totalMilliseconds / 3600000);
  const minutes = Math.floor((totalMilliseconds % 3600000) / 60000);
  const seconds = Math.floor((totalMilliseconds % 60000) / 1000);
  const milliseconds = totalMilliseconds % 1000;
  const core = `${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}.${String(milliseconds).padStart(3, "0")}`;
  return hours ? `+${String(hours).padStart(2, "0")}:${core}` : `+${core}`;
}

function joinLogEntries(entries, formatter) {
  let content = "";
  entries.forEach((entry) => {
    if (content && !content.endsWith("\n")) content += "\n";
    content += formatter(entry);
  });
  return content;
}

function applyAnsiStyle(element, style) {
  let foreground = style.foreground;
  let background = style.background;

  if (style.inverse) {
    const invertedForeground = background || "#173a5e";
    const invertedBackground = foreground || "#f5f5f5";
    foreground = invertedForeground;
    background = invertedBackground;
  }

  if (foreground) element.style.color = foreground;
  if (background) element.style.backgroundColor = background;
  if (style.bold) element.style.fontWeight = "700";
  if (style.dim) element.style.opacity = "0.7";
  if (style.italic) element.style.fontStyle = "italic";
  if (style.underline) element.style.textDecoration = "underline";
  if (style.strike) {
    element.style.textDecoration = element.style.textDecoration
      ? `${element.style.textDecoration} line-through`
      : "line-through";
  }
  if (style.hidden) element.style.visibility = "hidden";
}

function splitSegmentsByLine(segments, fallbackData) {
  const source = segments?.length ? segments : [{ text: fallbackData, style: null }];
  const lines = [];
  let line = { data: "", segments: [] };

  const append = (text, style) => {
    if (!text) return;
    line.data += text;
    const previous = line.segments.at(-1);
    if (previous && previous.style === style) {
      previous.text += text;
    } else {
      line.segments.push({ text, style });
    }
  };

  const flush = () => {
    lines.push(line);
    line = { data: "", segments: [] };
  };

  source.forEach((segment) => {
    let start = 0;
    while (start < segment.text.length) {
      const newline = segment.text.indexOf("\n", start);
      if (newline === -1) {
        append(segment.text.slice(start), segment.style);
        break;
      }
      append(segment.text.slice(start, newline + 1), segment.style);
      flush();
      start = newline + 1;
    }
  });

  if (line.data || !lines.length) lines.push(line);
  return lines;
}

function resetAgentTrafficDecoders(channel = "") {
  if (!channel) {
    state.agentTrafficDecoders.clear();
    return;
  }
  const prefix = `${channel}:`;
  [...state.agentTrafficDecoders.keys()].forEach((key) => {
    if (key.startsWith(prefix)) state.agentTrafficDecoders.delete(key);
  });
}

function decodeAgentTrafficText(channel, direction, bytes) {
  const key = `${channel}:${direction}`;
  let decoder = state.agentTrafficDecoders.get(key);
  if (!decoder) {
    decoder = new TextDecoder("utf-8", { fatal: false });
    state.agentTrafficDecoders.set(key, decoder);
  }
  return decoder.decode(bytes, { stream: true });
}

function recordAgentTraffic(direction, bytes, actor = "user") {
  if (!(bytes instanceof Uint8Array) || !bytes.byteLength) return;
  const copy = bytes.slice();
  const event = {
    sequence: state.agentEventSequence + 1,
    direction,
    actor,
    at: Date.now(),
    bytes: copy,
    text: decodeAgentTrafficText("serial", direction, copy),
  };
  state.agentEventSequence = event.sequence;
  state.agentEventBytes += copy.byteLength;
  state.agentEvents.push(event);

  while (
    state.agentEvents.length > MAX_AGENT_EVENTS ||
    (state.agentEventBytes > MAX_AGENT_EVENT_BYTES && state.agentEvents.length > 1)
  ) {
    const removed = state.agentEvents.shift();
    state.agentEventBytes -= removed?.bytes?.byteLength || 0;
  }
}

function recordNetworkAgentTraffic(direction, bytes, actor = "user") {
  if (!(bytes instanceof Uint8Array) || !bytes.byteLength) return;
  const copy = bytes.slice();
  const event = {
    sequence: state.networkAgentEventSequence + 1,
    direction,
    actor,
    at: Date.now(),
    bytes: copy,
    text: decodeAgentTrafficText("network", direction, copy),
  };
  state.networkAgentEventSequence = event.sequence;
  state.networkAgentEventBytes += copy.byteLength;
  state.networkAgentEvents.push(event);

  while (
    state.networkAgentEvents.length > MAX_AGENT_EVENTS ||
    (state.networkAgentEventBytes > MAX_AGENT_EVENT_BYTES &&
      state.networkAgentEvents.length > 1)
  ) {
    const removed = state.networkAgentEvents.shift();
    state.networkAgentEventBytes -= removed?.bytes?.byteLength || 0;
  }
}

function recordSshTraffic(direction, bytes, actor = "user") {
  if (!(bytes instanceof Uint8Array) || !bytes.byteLength) return;
  const copy = bytes.slice();
  const event = {
    sequence: state.sshOutputSequence + 1,
    direction,
    actor,
    at: Date.now(),
    bytes: copy,
    text: decodeAgentTrafficText("ssh", direction, copy),
  };
  state.sshOutputSequence = event.sequence;
  state.sshOutputBytes += copy.byteLength;
  state.sshOutputEvents.push(event);

  while (
    state.sshOutputEvents.length > MAX_AGENT_EVENTS ||
    (state.sshOutputBytes > MAX_AGENT_EVENT_BYTES && state.sshOutputEvents.length > 1)
  ) {
    const removed = state.sshOutputEvents.shift();
    state.sshOutputBytes -= removed?.bytes?.byteLength || 0;
  }
}

function createEntryContent(entry, segments) {
  const content = document.createElement("span");
  content.className = "log-entry__content";

  const data = document.createElement("span");
  data.className = "log-entry__data";
  entry.dataElement = data;

  const alternate = document.createElement("span");
  alternate.className = "log-entry__alternate";
  alternate.title = entry.mode === "hex" ? t("logEntry.asciiPreview") : t("logEntry.hexBytes");
  entry.alternateElement = alternate;

  content.append(data, alternate);
  return content;
}

function renderEntryData(entry, segments = entry.segments || []) {
  if (!entry.dataElement) return;
  entry.dataElement.replaceChildren();
  appendDataContent(entry.dataElement, entry.data, segments);

  if (!entry.alternateElement) return;
  entry.alternateElement.textContent =
    entry.mode === "hex" ? entry.ascii || "" : entry.hex || "";
}

function appendProcessedBytes(
  direction,
  data,
  segments,
  { forceNew = false, bytes = null, actor = "user" } = {},
) {
  const entrySegments = state.ansiColors && state.receiveMode === "text" ? segments : null;
  const rawBytes = bytes instanceof Uint8Array ? bytes : textEncoder.encode(data);
  const hex = bytesToHex(rawBytes);
  const ascii = bytesToAscii(rawBytes);
  const previous = state.entries.at(-1);
  const now = Date.now();
  const continuesGroup =
    previous &&
    (direction === "rx" || direction === "tx") &&
    previous.direction === direction &&
    previous.actor === actor &&
    previous.mode === state.receiveMode &&
    previous.ansiColors === state.ansiColors;
  const canMerge =
    !forceNew &&
    continuesGroup &&
    now - previous.updatedAt <= LOG_MERGE_IDLE_MS &&
    !previous.data.endsWith("\n") &&
    !data.startsWith("\n");

  if (canMerge) {
    previous.data += data;
    previous.updatedAt = Date.now();
    previous.hex = appendHexText(previous.hex, hex);
    previous.ascii = previous.mode === "hex" ? `${previous.ascii || ""}${ascii}` : previous.ascii;
    if (entrySegments?.length) {
      previous.segments = [...(previous.segments || []), ...entrySegments];
    }
    renderEntryData(previous, previous.segments || []);
    applyKeywordHighlight(previous.dataElement);
    updateKeywordEntryVisibility(previous, previous.dataElement.closest(".log-entry"));
    queueAutoSaveChunk("serial", data, { newEntry: false });
    if (state.autoScroll && !state.followSuspended) scrollToLatest();
    return;
  }

  const entryTime = formatTimestamp();
  const groupLastTime = continuesGroup ? previous.groupLastTime || previous.time : "";
  const showTime = state.timestamp && (!continuesGroup || entryTime !== groupLastTime);
  const entry = {
    source: "serial",
    direction,
    actor,
    mode: state.receiveMode,
    ansiColors: state.ansiColors,
    time: entryTime,
    showTime,
    groupContinuation: Boolean(continuesGroup),
    groupLastTime: showTime ? entryTime : groupLastTime,
    updatedAt: Date.now(),
    data,
    hex,
    ascii,
    segments: entrySegments ? [...entrySegments] : [],
    dataElement: null,
    alternateElement: null,
  };

  state.entries.push(entry);
  appendEntry(entry, entrySegments);
  queueAutoSaveChunk(
    "serial",
    `${showTime ? `[${entryTime}] ` : ""}${(actor === "agent" ? "AI TX" : direction.toUpperCase()).padEnd(5, " ")} ${data}`,
    { newEntry: true },
  );

  if (state.entries.length > MAX_LOG_ENTRIES) {
    state.entries.shift();
    els.logContent.firstElementChild?.remove();
  }
}

function processBytes(direction, bytes, { forceNew = false, actor = "user" } = {}) {
  if (!bytes.byteLength) return;

  let data;
  let segments = null;

  if (state.receiveMode === "hex") {
    data = bytesToHex(bytes);
  } else {
    const decoded = state.decoders[direction].decode(bytes, { stream: true });
    const combined = state.ansiRemainders[direction] + decoded;
    const parsed = parseAnsiText(combined, state.ansiStyles[direction]);
    if (parsed.remainder) {
      state.ansiRemainders[direction] = combined;
      return;
    }
    state.ansiRemainders[direction] = "";
    state.ansiStyles[direction] = parsed.style;
    segments = parsed.segments;
    data = segments.map((segment) => segment.text).join("");
  }

  if (!data) return;

  if (state.timestamp && state.receiveMode === "text" && data.includes("\n")) {
    splitSegmentsByLine(segments, data).forEach((line, index) => {
      appendProcessedBytes(direction, line.data, line.segments, {
        forceNew: forceNew || index > 0,
        bytes: textEncoder.encode(line.data),
        actor,
      });
    });
    return;
  }

  appendProcessedBytes(direction, data, segments, { forceNew, bytes, actor });
}

function fallbackCopyText(text) {
  const textarea = document.createElement("textarea");
  textarea.value = text;
  textarea.setAttribute("readonly", "");
  textarea.style.position = "fixed";
  textarea.style.top = "-1000px";
  textarea.style.opacity = "0";
  document.body.append(textarea);
  textarea.select();
  const copied = document.execCommand("copy");
  textarea.remove();
  return copied;
}

async function copyTextToClipboard(text, successMessage) {
  const value = String(text ?? "");
  if (!value) return false;

  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(value);
    } else if (!fallbackCopyText(value)) {
      throw new Error("clipboard unavailable");
    }
  } catch {
    if (!fallbackCopyText(value)) {
      showToast(t("toast.copyFailed"), "error");
      return false;
    }
  }

  showToast(successMessage, "success");
  return true;
}

function handleLogCopyClick(event) {
  const row = event.target.closest(".log-entry");
  if (!row || !event.currentTarget.contains(row)) return;

  const selection = window.getSelection();
  if (selection?.toString().trim()) return;

  const time = event.target.closest(".log-entry__time");
  const timeText = time?.textContent?.trim() || "";
  if (timeText) {
    void copyTextToClipboard(timeText, t("toast.timestampCopied"));
    return;
  }

  const data = row.querySelector(".log-entry__data");
  const dataText = data?.textContent || "";
  if (dataText) void copyTextToClipboard(dataText, t("toast.logCopied"));
}

function appendEntry(entry, segments) {
  const element = document.createElement("div");
  element.className = `log-entry log-entry--${entry.direction}`;
  element.classList.toggle("is-agent", entry.actor === "agent");
  element.classList.toggle("is-group-continuation", entry.groupContinuation);
  element.title = t("logEntry.copyHint");

  const time = document.createElement("span");
  time.className = "log-entry__time";
  time.textContent = entry.showTime ? entry.time : "";
  time.title = entry.showTime ? t("logEntry.copyTimeHint") : "";

  const direction = document.createElement("span");
  direction.className = "log-entry__direction";
  direction.classList.toggle("is-placeholder", entry.groupContinuation);
  direction.textContent = entry.groupContinuation
    ? ""
    : entry.actor === "agent"
      ? "AI"
      : entry.direction === "rx"
        ? "RX"
        : entry.direction === "tx"
          ? "TX"
          : "SYS";

  const content = createEntryContent(entry, segments);
  renderEntryData(entry, segments || entry.segments || []);

  element.append(time, direction, content);
  els.logContent.append(element);

  applyKeywordHighlight(entry.dataElement);
  updateKeywordEntryVisibility(entry, element);
  els.emptyState.hidden = state.entries.length > 0;
  if (state.autoScroll && !state.followSuspended) scrollToLatest();
}

function appendDataContent(dataElement, data, segments) {
  if (segments?.length) {
    segments.forEach((segment) => {
      const segmentElement = document.createElement("span");
      segmentElement.textContent = segment.text;
      applyAnsiStyle(segmentElement, segment.style);
      dataElement.append(segmentElement);
    });
  } else {
    dataElement.append(document.createTextNode(data));
  }
}

function getKeywordTerms() {
  return [
    ...new Set(
      String(state.keywordQuery || "")
        .split(/[,，]/)
        .map((term) => term.trim())
        .filter(Boolean),
    ),
  ];
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function buildKeywordExpression(term) {
  const escaped = escapeRegExp(term);
  if (!state.keywordWholeWord) return escaped;
  const startBoundary = /^[A-Za-z0-9_]/.test(term) ? "(?<![A-Za-z0-9_])" : "";
  const endBoundary = /[A-Za-z0-9_]$/.test(term) ? "(?![A-Za-z0-9_])" : "";
  return `${startBoundary}${escaped}${endBoundary}`;
}

function buildKeywordPattern(terms) {
  if (!terms.length) return null;
  const expression = [...terms]
    .sort((left, right) => right.length - left.length)
    .map(buildKeywordExpression)
    .join("|");
  return new RegExp(expression, state.keywordCaseSensitive ? "g" : "gi");
}

function applyKeywordHighlight(dataElement) {
  if (!dataElement) return;

  dataElement.querySelectorAll("mark.log-keyword-highlight").forEach((mark) => {
    mark.replaceWith(document.createTextNode(mark.textContent || ""));
  });
  dataElement.normalize();

  const pattern = buildKeywordPattern(getKeywordTerms());
  if (!pattern) return;

  const textNodes = [];
  const walker = document.createTreeWalker(dataElement, NodeFilter.SHOW_TEXT);
  while (walker.nextNode()) textNodes.push(walker.currentNode);

  textNodes.forEach((node) => {
    const text = node.nodeValue || "";
    if (!text) return;
    pattern.lastIndex = 0;
    const matches = [...text.matchAll(pattern)];
    if (!matches.length) return;

    const fragment = document.createDocumentFragment();
    let cursor = 0;
    matches.forEach((match) => {
      const index = match.index ?? 0;
      if (index > cursor) {
        fragment.append(document.createTextNode(text.slice(cursor, index)));
      }
      const mark = document.createElement("mark");
      mark.className = "log-keyword-highlight";
      mark.textContent = match[0];
      fragment.append(mark);
      cursor = index + match[0].length;
    });
    fragment.append(document.createTextNode(text.slice(cursor)));
    node.replaceWith(fragment);
  });
}

function entryMatchesKeywords(entry) {
  const pattern = buildKeywordPattern(getKeywordTerms());
  if (!pattern) return true;
  pattern.lastIndex = 0;
  return pattern.test(String(entry.data || ""));
}

function isEntryDirectionVisible(entry) {
  const networkEntry = entry.source === "network";
  if (entry.direction === "rx") return networkEntry ? state.networkShowRx : state.showRx;
  if (entry.direction === "tx") return networkEntry ? state.networkShowTx : state.showTx;
  return networkEntry ? state.networkShowSys : state.showSys;
}

function updateKeywordEntryVisibility(entry, element) {
  if (!element) return;
  const filteredOut =
    !isEntryDirectionVisible(entry) ||
    (state.keywordFilter && getKeywordTerms().length > 0 && !entryMatchesKeywords(entry));
  element.classList.toggle("is-filtered-out", filteredOut);
}

function applyKeywordStateToLogs() {
  [...state.entries, ...state.networkEntries].forEach((entry) => {
    const element = entry.dataElement?.closest(".log-entry");
    applyKeywordHighlight(entry.dataElement);
    updateKeywordEntryVisibility(entry, element);
  });
}

function updateKeywordUI() {
  const hasKeywords = getKeywordTerms().length > 0;
  const hasTerminalResults = Number(els.terminalKeywordNextButton.dataset.resultCount || 0) > 0;
  if (!hasKeywords) state.keywordFilter = false;

  [els.keywordInput, els.networkKeywordInput, els.terminalKeywordInput].forEach((input) => {
    if (input.value !== state.keywordQuery) input.value = state.keywordQuery;
  });
  [els.keywordFilterButton, els.networkKeywordFilterButton].forEach((button) => {
    button.disabled = !hasKeywords;
    button.setAttribute("aria-pressed", String(state.keywordFilter && hasKeywords));
  });
  els.keywordCaseSensitiveToggle.checked = state.keywordCaseSensitive;
  els.keywordWholeWordToggle.checked = state.keywordWholeWord;
  els.filterConfigButtons.forEach((button) => {
    button.setAttribute(
      "aria-pressed",
      String(state.keywordCaseSensitive || state.keywordWholeWord),
    );
  });
  [els.terminalKeywordPreviousButton, els.terminalKeywordNextButton].forEach((button) => {
    button.disabled = !hasKeywords || !hasTerminalResults;
  });
}

function setKeywordQuery(value, { persist = true } = {}) {
  state.keywordQuery = String(value || "");
  updateKeywordUI();
  applyKeywordStateToLogs();
  applyTerminalKeywordSearch();
  if (persist) persistSettings();
}

function toggleKeywordFilter() {
  if (!getKeywordTerms().length) return;
  state.keywordFilter = !state.keywordFilter;
  updateKeywordUI();
  applyKeywordStateToLogs();
  persistSettings();
}

function setKeywordOption(option, active) {
  const nextValue = Boolean(active);
  if (option === "case") {
    state.keywordCaseSensitive = nextValue;
  } else if (option === "whole-word") {
    state.keywordWholeWord = nextValue;
  } else {
    return;
  }
  updateKeywordUI();
  applyKeywordStateToLogs();
  applyTerminalKeywordSearch();
  persistSettings();
}

function openFilterConfigDialog() {
  els.keywordCaseSensitiveToggle.checked = state.keywordCaseSensitive;
  els.keywordWholeWordToggle.checked = state.keywordWholeWord;
  if (!els.filterConfigDialog.open) els.filterConfigDialog.showModal();
}

function closeFilterConfigDialog() {
  if (els.filterConfigDialog.open) els.filterConfigDialog.close();
}

function openDisplaySettingsDialog(kind) {
  const network = kind === "network";
  els.displaySettingsTitle.textContent = network
    ? t("display.title.network")
    : t("display.title.serial");
  els.displaySettingsSections.forEach((section) => {
    section.hidden = section.dataset.displayTarget !== (network ? "network" : "serial");
  });
  updateTimestampModeButtons(network ? "network" : "serial", {
    disabled: !(network ? state.networkTimestamp : state.timestamp),
  });
  if (!els.displaySettingsDialog.open) els.displaySettingsDialog.showModal();
}

function closeDisplaySettingsDialog() {
  if (els.displaySettingsDialog.open) els.displaySettingsDialog.close();
}

function buildTerminalKeywordExpression(terms) {
  return [...terms]
    .sort((left, right) => right.length - left.length)
    .map(escapeRegExp)
    .join("|");
}

function getTerminalSearchOptions() {
  return {
    caseSensitive: state.keywordCaseSensitive,
    regex: true,
    wholeWord: state.keywordWholeWord,
    decorations: {
      matchBackground: "#d7b35f",
      matchBorder: "#d7b35f",
      matchOverviewRuler: "#d7b35f",
      activeMatchBackground: "#9dbb4e",
      activeMatchBorder: "#9dbb4e",
      activeMatchColorOverviewRuler: "#9dbb4e",
    },
  };
}

function resetTerminalSearchResults() {
  els.terminalKeywordNextButton.dataset.resultCount = "0";
  els.terminalKeywordNextButton.dataset.resultIndex = "-1";
}

function applyTerminalKeywordSearch({ direction = "next" } = {}) {
  const searchAddon = state.terminalSearchAddon;
  if (!searchAddon || state.consoleView !== "terminal") return false;

  const terms = getKeywordTerms();
  if (!terms.length) {
    searchAddon.clearDecorations();
    resetTerminalSearchResults();
    return false;
  }

  const expression = buildTerminalKeywordExpression(terms);
  const options = getTerminalSearchOptions();
  return direction === "previous"
    ? searchAddon.findPrevious(expression, options)
    : searchAddon.findNext(expression, options);
}

function scrollToLatest() {
  requestAnimationFrame(() => {
    els.consoleViewport.scrollTop = els.consoleViewport.scrollHeight;
  });
}

function updateFollowUI() {
  els.followLatestButton.hidden = !(state.autoScroll && state.followSuspended);
}

function resumeFollowing() {
  state.followSuspended = false;
  updateFollowUI();
  scrollToLatest();
}

function clearLog() {
  state.entries = [];
  state.pendingEntries = [];
  state.pendingBytes = 0;
  state.ansiRemainders.rx = "";
  state.ansiRemainders.tx = "";
  state.ansiStyles.rx = createAnsiStyle();
  state.ansiStyles.tx = createAnsiStyle();
  state.rxBytes = 0;
  state.txBytes = 0;
  state.errors = 0;
  state.rxFrames = 0;
  state.txFrames = 0;
  state.lastActivityAt = 0;
  state.activity = Array.from({ length: ACTIVITY_SAMPLE_COUNT }, () => ({ rx: 0, tx: 0 }));
  state.followSuspended = false;
  els.logContent.replaceChildren();
  els.emptyState.hidden = false;
  updateCounters();
  updateFollowUI();
  renderActivity(0, 0);
  showToast(t("serial.toast.cleared"), "info");
}

function togglePause() {
  state.paused = !state.paused;
  els.pauseButton.setAttribute("aria-pressed", String(state.paused));
  els.pauseButton.title = state.paused ? t("serial.toolbar.resume") : t("serial.toolbar.pause");
  els.pauseButton.setAttribute("aria-label", els.pauseButton.title);
  els.pauseHint.hidden = !state.paused;

  if (!state.paused) {
    const pending = state.pendingEntries;
    state.pendingEntries = [];
    state.pendingBytes = 0;
    pending.forEach((bytes) => processBytes("rx", bytes));
    showToast(t("serial.toast.resumed"), "info");
  } else {
    showToast(t("serial.toast.paused"), "info");
  }
}

function saveLog() {
  if (!state.entries.length) {
    showToast(t("serial.toast.noDataToSave"), "info");
    return;
  }

  const content = joinLogEntries(state.entries, (entry) => {
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
  downloadBlob(blob, `serial-log-${timestamp}.txt`);
  showToast(t("serial.toast.logSaved"), "success");
}

function updateCounters() {
  els.rxCounter.textContent = formatBytes(state.rxBytes);
  els.txCounter.textContent = formatBytes(state.txBytes);
  els.errorCounter.textContent = String(state.errors);
  els.packetReadout.textContent = tCount("serial.metrics.frames", state.rxFrames, {
    count: formatNumber(state.rxFrames),
  });
}

function markActivity() {
  state.lastActivityAt = Date.now();
}

function updateMetrics() {
  const now = performance.now();
  const elapsed = Math.max(1, now - state.metricLastAt);
  const rxRate = ((state.rxBytes - state.metricLastRx) * 1000) / elapsed;
  const txRate = ((state.txBytes - state.metricLastTx) * 1000) / elapsed;

  state.metricLastAt = now;
  state.metricLastRx = state.rxBytes;
  state.metricLastTx = state.txBytes;

  state.activity.shift();
  state.activity.push({ rx: rxRate, tx: txRate });
  renderActivity(rxRate, txRate);

  els.rateReadout.textContent = formatRate(rxRate);
  els.lastActivityLabel.textContent = state.lastActivityAt
    ? t("serial.metrics.activeAgo", {
        count: Math.max(0, Math.floor((Date.now() - state.lastActivityAt) / 1000)),
      })
    : t("serial.footer.noActivity");
}

function renderActivity(rxRate, txRate) {
  els.activityMeter.replaceChildren();
  const maxRate = Math.max(1, ...state.activity.flatMap((sample) => [sample.rx, sample.tx]));

  state.activity.forEach((sample) => {
    const bar = document.createElement("span");
    const value = Math.max(sample.rx, sample.tx);
    const level = value ? Math.max(1, Math.log2(value + 1) / Math.log2(maxRate + 1)) : 0;
    bar.style.height = `${3 + level * 21}px`;
    bar.style.opacity = value ? String(0.32 + level * 0.68) : "0.2";
    bar.classList.toggle("is-tx", sample.tx > sample.rx);
    els.activityMeter.append(bar);
  });

  if (rxRate === 0 && txRate === 0) {
    els.rateReadout.textContent = "0 B/s";
  }
}

export { appendDataContent, appendEntry, appendProcessedBytes, applyAnsiStyle, applyKeywordHighlight, applyKeywordStateToLogs, applyTerminalKeywordSearch, buildKeywordExpression, buildKeywordPattern, buildTerminalKeywordExpression, clearLog, closeDisplaySettingsDialog, closeFilterConfigDialog, copyTextToClipboard, createEntryContent, decodeAgentTrafficText, entryMatchesKeywords, escapeRegExp, fallbackCopyText, formatTimestamp, getKeywordTerms, getTerminalSearchOptions, getTimestampMode, handleLogCopyClick, isEntryDirectionVisible, joinLogEntries, markActivity, normalizeTimestampMode, openDisplaySettingsDialog, openFilterConfigDialog, processBytes, recordAgentTraffic, recordNetworkAgentTraffic, recordSshTraffic, renderActivity, renderEntryData, resetAgentTrafficDecoders, resetTerminalSearchResults, resumeFollowing, saveLog, scrollToLatest, setKeywordOption, setKeywordQuery, setTimestampMode, splitSegmentsByLine, toggleKeywordFilter, togglePause, updateCounters, updateFollowUI, updateKeywordEntryVisibility, updateKeywordUI, updateMetrics, updateTimestampModeButtons };
