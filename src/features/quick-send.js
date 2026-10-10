// Module: Serial and network quick send lists.
// Owns: quick item normalization, panel rendering, add/edit/delete, event binding, collapsed state, and the actual send entry points.
// Depends on: lucide, core, payload, network, serial-runtime, toast.
// Called by: app.js and layout.js.

import { SendHorizontal, Trash2, createIcons } from "lucide";
import { MAX_QUICK_COMMANDS } from "../core/constants.js";
import { $, $$, createLucideIcon, els } from "../core/dom.js";
import { errorMessage } from "../core/errors.js";
import { t } from "../core/i18n.js";
import { persistSettings } from "../core/settings.js";
import { state } from "../core/state.js";
import { sendNetworkData } from "./network.js";
import { buildPayloadFromValue } from "./payload.js";
import { sendPayload } from "./serial-runtime.js";
import { showToast } from "./toast.js";

function setQuickSendCollapsed(collapsed, { persist = true } = {}) {
  state.quickSendCollapsed = Boolean(collapsed);
  els.quickSendSection.classList.toggle("is-collapsed", state.quickSendCollapsed);
  els.quickSendToggleButton.setAttribute("aria-expanded", String(!state.quickSendCollapsed));
  if (persist) persistSettings();
}

function setNetworkQuickSendCollapsed(collapsed, { persist = true } = {}) {
  state.networkQuickSendCollapsed = Boolean(collapsed);
  els.networkQuickSendSection.classList.toggle("is-collapsed", state.networkQuickSendCollapsed);
  els.networkQuickSendToggleButton.setAttribute(
    "aria-expanded",
    String(!state.networkQuickSendCollapsed),
  );
  if (persist) persistSettings();
}

function normalizeQuickCommands(value) {
  const commands = Array.isArray(value) ? value : [];
  const normalized = commands
    .slice(0, MAX_QUICK_COMMANDS)
    .map((command) => String(command ?? ""));
  return normalized.length ? normalized : [""];
}

function getQuickCommands(kind) {
  return kind === "network" ? state.networkQuickCommands : state.serialQuickCommands;
}

function getQuickCommandElements(kind) {
  return kind === "network"
    ? {
        list: els.networkQuickCommandList,
        count: els.networkQuickSendCount,
        addButton: els.addNetworkQuickCommandButton,
      }
    : {
        list: els.quickCommandList,
        count: els.quickSendCount,
        addButton: els.addQuickCommandButton,
      };
}

function isQuickCommandConnected(kind) {
  return kind === "network" ? state.networkConnected : state.connected;
}

function renderQuickCommandList(kind) {
  const commands = getQuickCommands(kind);
  const { list, count, addButton } = getQuickCommandElements(kind);
  const fragment = document.createDocumentFragment();

  commands.forEach((command, index) => {
    const row = document.createElement("div");
    row.className = "quick-command-row";
    row.dataset.index = String(index);

    const input = document.createElement("input");
    input.className = "quick-command-input";
    input.type = "text";
    input.value = command;
    input.spellcheck = false;
    input.dataset.quickIndex = String(index);
    input.placeholder = t("quickSend.placeholder");
    input.setAttribute("aria-label", t("quickSend.ariaIndex", { index: index + 1 }));

    const sendButton = document.createElement("button");
    sendButton.className = "quick-command-action quick-command-action--send";
    sendButton.type = "button";
    sendButton.dataset.quickAction = "send";
    sendButton.title = t("quickSend.sendItemTitle");
    sendButton.setAttribute("aria-label", t("quickSend.sendItemAria", { index: index + 1 }));
    sendButton.append(createLucideIcon("send-horizontal"));

    const deleteButton = document.createElement("button");
    deleteButton.className = "quick-command-action quick-command-action--delete";
    deleteButton.type = "button";
    deleteButton.dataset.quickAction = "delete";
    deleteButton.title = commands.length > 1 ? t("quickSend.deleteItemTitle") : t("quickSend.keepOneTitle");
    deleteButton.setAttribute("aria-label", t("quickSend.deleteItemAria", { index: index + 1 }));
    deleteButton.append(createLucideIcon("trash-2"));

    row.append(input, sendButton, deleteButton);
    fragment.append(row);
  });

  list.replaceChildren(fragment);
  count.textContent = `${commands.length} / ${MAX_QUICK_COMMANDS}`;
  addButton.disabled = commands.length >= MAX_QUICK_COMMANDS;
  updateQuickCommandModeUI(kind);
  createIcons({ icons: { SendHorizontal, Trash2 } });
}

function updateQuickCommandModeUI(kind) {
  const { list } = getQuickCommandElements(kind);
  const mode = kind === "network" ? state.networkSendMode : state.sendMode;
  const placeholder = mode === "hex" ? t("quickSend.placeholderHex") : t("quickSend.placeholder");

  $$(".quick-command-input", list).forEach((input) => {
    input.placeholder = placeholder;
  });
  updateQuickCommandButtons(kind);
}

function updateQuickCommandButtons(kind) {
  const commands = getQuickCommands(kind);
  const { list } = getQuickCommandElements(kind);
  const connected = isQuickCommandConnected(kind);
  const blockedByYmodem = kind !== "network" && state.ymodemBusy;

  $$(".quick-command-row", list).forEach((row, index) => {
    const sendButton = $('[data-quick-action="send"]', row);
    const deleteButton = $('[data-quick-action="delete"]', row);
    if (sendButton) {
      sendButton.disabled =
        !connected || blockedByYmodem || !String(commands[index] || "").trim();
    }
    if (deleteButton) {
      deleteButton.disabled = commands.length <= 1;
    }
  });
}

function handleQuickCommandInput(kind, index, value) {
  const commands = getQuickCommands(kind);
  if (!Number.isInteger(index) || index < 0 || index >= commands.length) return;
  commands[index] = value;
  updateQuickCommandButtons(kind);
  persistSettings();
}

function addQuickCommand(kind) {
  const commands = getQuickCommands(kind);
  if (commands.length >= MAX_QUICK_COMMANDS) {
    showToast(t("quickSend.limit", { count: MAX_QUICK_COMMANDS }), "info");
    return;
  }

  commands.push("");
  persistSettings();
  renderQuickCommandList(kind);
  const { list } = getQuickCommandElements(kind);
  const nextInput = $(`[data-quick-index="${commands.length - 1}"]`, list);
  nextInput?.focus();
}

function deleteQuickCommand(kind, index) {
  const commands = getQuickCommands(kind);
  if (commands.length <= 1 || index < 0 || index >= commands.length) return;
  commands.splice(index, 1);
  persistSettings();
  renderQuickCommandList(kind);
}

async function sendQuickCommand(kind, index) {
  const commands = getQuickCommands(kind);
  const source = commands[index] ?? "";
  const network = kind === "network";

  if (!isQuickCommandConnected(kind)) {
    showToast(network ? t("net.error.notConnected") : t("serial.openPortFirst"), "error");
    return;
  }

  let payload;
  try {
    payload = buildPayloadFromValue(
      source,
      network ? state.networkSendMode : state.sendMode,
      network ? els.networkLineEnding.value : els.lineEnding.value,
      { templateKind: kind },
    );
  } catch (error) {
    showToast(errorMessage(error), "error");
    return;
  }

  if (!payload.byteLength) {
    showToast(t("common.emptyPayload"), "info");
    return;
  }

  if (network) {
    await sendNetworkData(payload);
  } else {
    await sendPayload(payload);
  }
}

function bindQuickCommandList(kind, list) {
  list.addEventListener("input", (event) => {
    const input = event.target.closest(".quick-command-input");
    if (!input) return;
    handleQuickCommandInput(kind, Number.parseInt(input.dataset.quickIndex, 10), input.value);
  });

  list.addEventListener("click", (event) => {
    const action = event.target.closest("[data-quick-action]");
    if (!action) return;
    const row = action.closest(".quick-command-row");
    const index = Number.parseInt(row?.dataset.index, 10);
    if (!Number.isInteger(index)) return;

    if (action.dataset.quickAction === "send") {
      void sendQuickCommand(kind, index);
    } else if (action.dataset.quickAction === "delete") {
      deleteQuickCommand(kind, index);
    }
  });

  list.addEventListener("keydown", (event) => {
    if (event.key !== "Enter" || event.isComposing) return;
    const input = event.target.closest(".quick-command-input");
    if (!input) return;
    event.preventDefault();
    void sendQuickCommand(kind, Number.parseInt(input.dataset.quickIndex, 10));
  });
}

export { addQuickCommand, bindQuickCommandList, deleteQuickCommand, getQuickCommandElements, getQuickCommands, handleQuickCommandInput, isQuickCommandConnected, normalizeQuickCommands, renderQuickCommandList, sendQuickCommand, setNetworkQuickSendCollapsed, setQuickSendCollapsed, updateQuickCommandButtons, updateQuickCommandModeUI };
