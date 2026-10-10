// Module: Serial and network log auto-save.
// Owns: directory authorization, the settings dialog, file rotation, the write queue, and flushing.
// Depends on: core, state, settings, errors, i18n, toast.
// Called by: log-view, app.js, and the network log feature.

import { AUTO_SAVE_FLUSH_MS, DEFAULT_AUTO_SAVE_MINUTES, DEFAULT_AUTO_SAVE_SIZE_KB, textEncoder } from "../core/constants.js";
import { els } from "../core/dom.js";
import { errorMessage } from "../core/errors.js";
import { t } from "../core/i18n.js";
import { persistSettings } from "../core/settings.js";
import { state } from "../core/state.js";
import { showToast } from "./toast.js";

function normalizeAutoSaveLimit(mode, value) {
  const maximum = mode === "time" ? 24 * 60 : 1024 * 1024;
  const fallback = mode === "time" ? DEFAULT_AUTO_SAVE_MINUTES : DEFAULT_AUTO_SAVE_SIZE_KB;
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(1, Math.min(maximum, parsed));
}

function supportsAutoSaveDirectory() {
  return typeof window.showDirectoryPicker === "function";
}

function updateAutoSaveLimitUI() {
  const mode = els.autoSaveRotationMode.value === "time" ? "time" : "size";
  const current = normalizeAutoSaveLimit(mode, els.autoSaveLimitInput.value);
  els.autoSaveLimitLabel.textContent =
    mode === "time" ? t("autosave.limitTime") : t("autosave.limitSize");
  els.autoSaveLimitUnit.textContent =
    mode === "time" ? t("autosave.unit.minutes") : "KB";
  els.autoSaveLimitInput.min = "1";
  els.autoSaveLimitInput.max = mode === "time" ? String(24 * 60) : String(1024 * 1024);
  els.autoSaveLimitInput.value = String(current);
}

function updateAutoSaveDialogUI() {
  const supported = supportsAutoSaveDirectory();
  const hasHandle = Boolean(state.autoSaveDirectoryHandle);
  const name = state.autoSaveDirectoryHandle?.name || state.autoSaveDirectoryName;
  els.autoSaveEnabledToggle.disabled = !supported;
  els.chooseAutoSaveDirectoryButton.disabled = !supported;
  els.autoSaveRotationMode.disabled = !supported;
  els.autoSaveLimitInput.disabled = !supported;
  els.saveAutoSaveButton.disabled = !supported;
  els.autoSaveDirectoryName.textContent = name || t("autosave.dirNone");
  els.autoSaveStatusText.textContent = supported
    ? hasHandle
      ? state.autoSaveFiles.serial || state.autoSaveFiles.network
        ? t("autosave.state.writing")
        : t("autosave.state.chosenPending")
      : name
        ? t("autosave.state.reopened")
        : t("autosave.state.needFolder")
    : t("autosave.state.unsupported");
  els.autoSaveSupportText.textContent = supported
    ? t("autosave.supportHint")
    : t("autosave.supportBrowser");
}

function openAutoSaveDialog() {
  els.autoSaveEnabledToggle.checked = state.autoSaveEnabled;
  els.autoSaveRotationMode.value = state.autoSaveRotationMode;
  els.autoSaveLimitInput.value = String(state.autoSaveLimit);
  updateAutoSaveLimitUI();
  updateAutoSaveDialogUI();
  if (!els.autoSaveDialog.open) els.autoSaveDialog.showModal();
}

function closeAutoSaveDialog() {
  if (els.autoSaveDialog.open) els.autoSaveDialog.close();
}

async function chooseAutoSaveDirectory() {
  if (!supportsAutoSaveDirectory()) {
    showToast(t("autosave.error.unsupported"), "error");
    return null;
  }

  try {
    const handle = await window.showDirectoryPicker({ mode: "readwrite" });
    if (handle?.requestPermission) {
      const permission = await handle.requestPermission({ mode: "readwrite" });
      if (permission !== "granted") throw new Error(t("autosave.error.permission"));
    }
    state.autoSaveDirectoryHandle = handle;
    state.autoSaveDirectoryName = handle.name || t("autosave.dirChosen");
    updateAutoSaveDialogUI();
    return handle;
  } catch (error) {
    if (error?.name !== "AbortError") {
      showToast(errorMessage(error, t("autosave.error.chooseFailed")), "error");
    }
    return null;
  }
}

async function saveAutoSaveSettings() {
  const enabled = els.autoSaveEnabledToggle.checked;
  if (enabled && !state.autoSaveDirectoryHandle) {
    const handle = await chooseAutoSaveDirectory();
    if (!handle) return;
  }

  if (!enabled) {
    await Promise.all([flushAutoSave("serial"), flushAutoSave("network")]);
  }

  state.autoSaveEnabled = enabled;
  state.autoSaveRotationMode =
    els.autoSaveRotationMode.value === "time" ? "time" : "size";
  state.autoSaveLimit = normalizeAutoSaveLimit(
    state.autoSaveRotationMode,
    els.autoSaveLimitInput.value,
  );
  persistSettings();
  updateAutoSaveDialogUI();
  closeAutoSaveDialog();
  showToast(
    state.autoSaveEnabled ? t("autosave.enabled") : t("autosave.disabled"),
    "success",
  );
}

function autoSaveFileStamp() {
  return new Date()
    .toISOString()
    .replace(/[-:]/g, "")
    .replace(/\..+/, "")
    .replace("T", "-");
}

function shouldRotateAutoSaveFile(kind, nextBytes = 0) {
  const file = state.autoSaveFiles[kind];
  if (!file) return false;
  if (state.autoSaveRotationMode === "time") {
    return Date.now() - file.startedAt >= state.autoSaveLimit * 60 * 1000;
  }
  return file.size > 0 && file.size + nextBytes > state.autoSaveLimit * 1024;
}

async function createAutoSaveFile(kind) {
  if (!state.autoSaveDirectoryHandle) throw new Error(t("autosave.error.noFolder"));
  const sequence = state.autoSaveSequence[kind];
  state.autoSaveSequence[kind] = sequence + 1;
  const name = `${kind}-log-${autoSaveFileStamp()}-${String(sequence).padStart(3, "0")}.txt`;
  const handle = await state.autoSaveDirectoryHandle.getFileHandle(name, { create: true });
  const file = {
    handle,
    name,
    size: 0,
    startedAt: Date.now(),
  };
  state.autoSaveFiles[kind] = file;
  return file;
}

async function rotateAutoSaveFile(kind) {
  state.autoSaveFiles[kind] = null;
  if (!state.autoSaveEnabled || !state.autoSaveDirectoryHandle) return;
  try {
    await createAutoSaveFile(kind);
  } catch (error) {
    state.autoSaveEnabled = false;
    updateAutoSaveDialogUI();
    showToast(errorMessage(error, t("autosave.error.createFailed")), "error");
  }
}

function queueAutoSaveChunk(kind, text) {
  if (!state.autoSaveEnabled || !state.autoSaveDirectoryHandle || !text) return;
  state.autoSaveBuffers[kind] += text;
  if (state.autoSaveTimers[kind]) {
    window.clearTimeout(state.autoSaveTimers[kind]);
  }
  state.autoSaveTimers[kind] = window.setTimeout(() => {
    state.autoSaveTimers[kind] = null;
    void flushAutoSave(kind);
  }, AUTO_SAVE_FLUSH_MS);
}

function flushAutoSave(kind) {
  const text = state.autoSaveBuffers[kind];
  state.autoSaveBuffers[kind] = "";
  if (!text || !state.autoSaveEnabled || !state.autoSaveDirectoryHandle) {
    return state.autoSaveQueues[kind];
  }

  const byteLength = textEncoder.encode(text).byteLength;
  state.autoSaveQueues[kind] = state.autoSaveQueues[kind]
    .then(async () => {
      if (!state.autoSaveEnabled || !state.autoSaveDirectoryHandle) return;
      let file = state.autoSaveFiles[kind];
      if (!file || shouldRotateAutoSaveFile(kind, byteLength)) {
        file = await createAutoSaveFile(kind);
      }
      const writable = await file.handle.createWritable({ keepExistingData: true });
      await writable.seek(file.size);
      await writable.write(text);
      await writable.close();
      file.size += byteLength;
      updateAutoSaveDialogUI();
    })
    .catch((error) => {
      state.autoSaveEnabled = false;
      updateAutoSaveDialogUI();
      showToast(errorMessage(error, t("autosave.error.writeFailed")), "error");
    });

  return state.autoSaveQueues[kind];
}

export { autoSaveFileStamp, chooseAutoSaveDirectory, closeAutoSaveDialog, createAutoSaveFile, flushAutoSave, normalizeAutoSaveLimit, openAutoSaveDialog, queueAutoSaveChunk, rotateAutoSaveFile, saveAutoSaveSettings, shouldRotateAutoSaveFile, supportsAutoSaveDirectory, updateAutoSaveDialogUI, updateAutoSaveLimitUI };
