// Module: YMODEM panel, progress, and log UI.
// Owns: mode switching, file selection, the progress bar, the state badge, and the log.
// Depends on: core, lib/format.js, macro, toast.
// Called by: app.js; the transfer session itself is wired up by app.js.

import { els } from "../core/dom.js";
import { t } from "../core/i18n.js";
import { persistSettings } from "../core/settings.js";
import { state } from "../core/state.js";
import { formatBytes } from "../lib/format.js";
import { updateMacroUI } from "./macro.js";

function setYmodemCollapsed(collapsed, { persist = true } = {}) {
  state.ymodemCollapsed = Boolean(collapsed);
  els.ymodemSection.classList.toggle("is-collapsed", state.ymodemCollapsed);
  els.ymodemToggleButton.setAttribute("aria-expanded", String(!state.ymodemCollapsed));
  if (persist) persistSettings();
}

function setYmodemMode(mode, { persist = true } = {}) {
  state.ymodemMode = mode === "receive" ? "receive" : "send";
  els.ymodemModeButtons.forEach((button) => {
    const active = button.dataset.ymodemMode === state.ymodemMode;
    button.classList.toggle("is-active", active);
    button.setAttribute("aria-selected", String(active));
  });
  els.ymodemSendPane.hidden = state.ymodemMode !== "send";
  els.ymodemReceivePane.hidden = state.ymodemMode !== "receive";
  updateYmodemUI();
  if (persist) persistSettings();
}

function setYmodemBadge(text, stateName = "idle") {
  els.ymodemStateBadge.textContent = text;
  els.ymodemStateBadge.dataset.state = stateName;
}

function appendYmodemLog(message, level = "info") {
  const line = document.createElement("span");
  line.className = `ymodem-log__line ymodem-log__line--${level}`;
  line.textContent = message;
  els.ymodemLog.append(line);

  while (els.ymodemLog.childElementCount > 20) {
    els.ymodemLog.firstElementChild?.remove();
  }
  els.ymodemLog.scrollTop = els.ymodemLog.scrollHeight;
}

function resetYmodemProgress(message = t("ymodem.progress.waiting")) {
  els.ymodemProgress.value = 0;
  els.ymodemProgress.textContent = "0%";
  els.ymodemProgressText.textContent = message;
  els.ymodemProgressValue.textContent = "0%";
}

function updateYmodemProgress(event) {
  const percent = Math.max(0, Math.min(100, Number(event.percent) || 0));
  const transferred = Number(event.transferred) || 0;
  const total = Number(event.total);
  let message = t("ymodem.progress.waiting");

  if (event.phase === "waiting") {
    message =
      event.direction === "send"
        ? t("ymodem.progress.waitReceiver")
        : t("ymodem.progress.waitHeader");
  } else if (event.phase === "sending") {
    message = t("ymodem.progress.sending", {
      transferred: formatBytes(transferred),
      total: formatBytes(total),
    });
  } else if (event.phase === "receiving") {
    message = Number.isFinite(total)
      ? t("ymodem.progress.receiving", {
          transferred: formatBytes(transferred),
          total: formatBytes(total),
        })
      : t("ymodem.progress.received", { transferred: formatBytes(transferred) });
  } else if (event.phase === "complete") {
    message = t("ymodem.progress.done");
  }

  els.ymodemProgress.value = percent;
  els.ymodemProgress.textContent = `${percent.toFixed(0)}%`;
  els.ymodemProgressText.textContent = message;
  els.ymodemProgressValue.textContent = `${percent.toFixed(0)}%`;
}

function updateYmodemUI() {
  const connected = state.connected;
  const busy = state.ymodemBusy;
  const hasFile = Boolean(state.ymodemFile);

  els.ymodemChooseFileButton.disabled = busy || !state.supported;
  els.ymodemBlockSize.disabled = busy;
  els.ymodemSendButton.disabled = !connected || busy || !hasFile;
  els.ymodemReceiveButton.disabled = !connected || busy;
  els.ymodemCancelButton.hidden = !busy;
  els.ymodemModeButtons.forEach((button) => {
    button.disabled = busy;
  });
  updateMacroUI();
}

function handleYmodemFileSelection() {
  const file = els.ymodemFileInput.files?.[0] || null;
  state.ymodemFile = file;
  els.ymodemFileName.textContent = file?.name || t("ymodem.file.none");
  els.ymodemFileMeta.textContent = file
    ? formatBytes(file.size)
    : t("ymodem.file.waiting");
  updateYmodemUI();
}

export { appendYmodemLog, handleYmodemFileSelection, resetYmodemProgress, setYmodemBadge, setYmodemCollapsed, setYmodemMode, updateYmodemProgress, updateYmodemUI };
