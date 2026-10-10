// Module: Send-box history and arrow-key navigation for serial and network.
// Owns: history read/write, draft and index state, persistence, and key handling.
// Depends on: core/state, core/settings; UI callbacks are injected by app.js.
// Called by: serial-runtime, network-runtime, and app.js event binding.

import { MAX_SEND_HISTORY } from "../core/constants.js";
import { els } from "../core/dom.js";
import { persistSettings } from "../core/settings.js";
import { state } from "../core/state.js";

let updateConnectionUI = null;
let updateNetworkUI = null;

function initializeSendHistory({
  updateConnectionUI: updateConnectionUICallback,
  updateNetworkUI: updateNetworkUICallback,
} = {}) {
  if (
    typeof updateConnectionUICallback !== "function" ||
    typeof updateNetworkUICallback !== "function"
  ) {
    throw new TypeError(
      "initializeSendHistory requires updateConnectionUI and updateNetworkUI.",
    );
  }
  updateConnectionUI = updateConnectionUICallback;
  updateNetworkUI = updateNetworkUICallback;
}

function normalizeSendHistory(value) {
  const history = Array.isArray(value) ? value : [];
  return history
    .slice(0, MAX_SEND_HISTORY)
    .map((entry) => String(entry ?? "").slice(0, 8192))
    .filter((entry) => entry.trim());
}

function getSendHistory(kind) {
  return kind === "network" ? state.networkSendHistory : state.serialSendHistory;
}

function getSendHistoryIndex(kind) {
  return kind === "network" ? state.networkSendHistoryIndex : state.serialSendHistoryIndex;
}

function setSendHistoryIndex(kind, index) {
  if (kind === "network") {
    state.networkSendHistoryIndex = index;
  } else {
    state.serialSendHistoryIndex = index;
  }
}

function getSendHistoryDraft(kind) {
  return kind === "network" ? state.networkSendHistoryDraft : state.serialSendHistoryDraft;
}

function setSendHistoryDraft(kind, draft) {
  if (kind === "network") {
    state.networkSendHistoryDraft = draft;
  } else {
    state.serialSendHistoryDraft = draft;
  }
}

function resetSendHistoryNavigation(kind) {
  setSendHistoryIndex(kind, null);
  setSendHistoryDraft(kind, "");
}

function addSendHistoryEntry(kind, value) {
  const entry = String(value ?? "").slice(0, 8192);
  if (!entry.trim()) {
    resetSendHistoryNavigation(kind);
    return;
  }

  const history = getSendHistory(kind);
  if (history.at(-1) !== entry) history.push(entry);
  if (history.length > MAX_SEND_HISTORY) {
    history.splice(0, history.length - MAX_SEND_HISTORY);
  }
  resetSendHistoryNavigation(kind);
  persistSettings();
}

function handleSendHistoryKeydown(event, kind) {
  if (
    (event.key !== "ArrowUp" && event.key !== "ArrowDown") ||
    event.shiftKey ||
    event.ctrlKey ||
    event.altKey ||
    event.metaKey
  ) {
    return false;
  }

  const history = getSendHistory(kind);
  if (!history.length) return false;

  const input = kind === "network" ? els.networkSendInput : els.sendInput;
  const start = input.selectionStart ?? input.value.length;
  const end = input.selectionEnd ?? start;
  if (start !== end) return false;

  let index = getSendHistoryIndex(kind);
  if (event.key === "ArrowUp") {
    if (input.value.slice(0, start).includes("\n")) return false;
    if (index === null) {
      setSendHistoryDraft(kind, input.value);
      index = history.length - 1;
    } else {
      index = Math.max(0, index - 1);
    }
    setSendHistoryIndex(kind, index);
    input.value = history[index];
  } else {
    if (index === null) return false;
    if (input.value.slice(start).includes("\n")) return false;
    if (index >= history.length - 1) {
      input.value = getSendHistoryDraft(kind);
      resetSendHistoryNavigation(kind);
    } else {
      index += 1;
      setSendHistoryIndex(kind, index);
      input.value = history[index];
    }
  }

  input.setSelectionRange(input.value.length, input.value.length);
  if (kind === "network") {
    updateNetworkUI();
  } else {
    updateConnectionUI();
  }
  event.preventDefault();
  return true;
}

export { addSendHistoryEntry, getSendHistory, getSendHistoryDraft, getSendHistoryIndex, handleSendHistoryKeydown, initializeSendHistory, normalizeSendHistory, resetSendHistoryNavigation, setSendHistoryDraft, setSendHistoryIndex };
