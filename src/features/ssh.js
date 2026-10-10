// Module: SSH presets, quick paths, terminal, and the SFTP file panel.
// Owns: SSH preset rendering, the xterm session terminal, directory browsing, and the file transfer UI.
// Depends on: core, xterm, log-view, toast, errors.
// Called by: app.js and the agent SSH commands.

import { FitAddon } from "@xterm/addon-fit";
import { Terminal } from "@xterm/xterm";
import { Folder, Plus, X, createIcons } from "lucide";
import { MAX_CONNECTION_PRESETS, MAX_SSH_QUICK_PATHS } from "../core/constants.js";
import { $, $$, createLucideIcon, els } from "../core/dom.js";
import { errorMessage } from "../core/errors.js";
import { getLocale, t, tCount } from "../core/i18n.js";
import { persistSettings } from "../core/settings.js";
import { state } from "../core/state.js";
import { TERMINAL_THEME } from "../core/terminal-theme.js";
import { downloadBlob } from "../lib/download.js";
import { formatBytes } from "../lib/format.js";
import { formatSshFileSize, formatSshFileTime, joinSshPath, normalizeSshPath, parentSshPath } from "../lib/ssh-path.js";
import { recordSshTraffic } from "./log-view.js";
import { showToast } from "./toast.js";

function initializeSshTerminal() {
  if (state.sshTerminal) return;

  const monoFont = getComputedStyle(document.documentElement).getPropertyValue("--font-mono").trim();
  const terminal = new Terminal({
    allowTransparency: false,
    cursorBlink: true,
    cursorStyle: "block",
    fontFamily: monoFont || "Consolas, monospace",
    fontSize: 14,
    fontWeight: "400",
    lineHeight: 1.15,
    screenReaderMode: true,
    scrollback: 12000,
    smoothScrollDuration: 80,
    theme: TERMINAL_THEME,
  });
  const fitAddon = new FitAddon();
  terminal.loadAddon(fitAddon);
  terminal.open(els.sshTerminalMount);
  terminal.onData((data) => {
    if (!state.sshConnected) return;
    recordSshTraffic("tx", new TextEncoder().encode(data), "user");
    void state.sshBridge?.input(data).catch(() => {});
  });
  terminal.onResize(({ cols, rows }) => {
    if (!state.sshConnected) return;
    void state.sshBridge?.resize(cols, rows).catch(() => {});
  });

  state.sshTerminal = terminal;
  state.sshTerminalFitAddon = fitAddon;
  state.sshTerminalResizeObserver = new ResizeObserver(() => fitSshTerminal());
  state.sshTerminalResizeObserver.observe(els.sshTerminalViewport);
}

function fitSshTerminal({ focus = false } = {}) {
  if (
    !state.sshTerminal ||
    !state.sshTerminalFitAddon ||
    state.networkProtocol !== "ssh" ||
    els.sshTerminalPanel.hidden
  ) {
    return;
  }

  requestAnimationFrame(() => {
    try {
      state.sshTerminalFitAddon.fit();
      if (focus) state.sshTerminal.focus();
    } catch {
      // The SSH terminal may be between visibility and layout states.
    }
  });
}

function normalizeSshQuickPaths(value) {
  const paths = Array.isArray(value) ? value : [];
  const seen = new Set();
  return paths
    .map((path) => String(path ?? "").trim().replace(/\\/g, "/"))
    .filter((path) => {
      if (!path.startsWith("/") || path.includes("\0") || seen.has(path)) return false;
      seen.add(path);
      return true;
    })
    .slice(0, MAX_SSH_QUICK_PATHS);
}

function normalizeSshPresets(value) {
  const presets = Array.isArray(value) ? value : [];
  return presets
    .slice(0, MAX_CONNECTION_PRESETS)
    .map((preset, index) => {
      const port = Number(preset?.port);
      const host = String(preset?.host || "").trim();
      const username = String(preset?.username || "").trim();
      if (!host || !username || !Number.isInteger(port) || port < 1 || port > 65535) {
        return null;
      }
      return {
        id: String(preset?.id || `ssh-preset-${index + 1}-${Date.now()}`),
        alias: String(preset?.alias || `${username}@${host}:${port}`).slice(0, 80),
        host: host.slice(0, 255),
        port,
        username: username.slice(0, 120),
        password: String(preset?.password || "").slice(0, 512),
        quickPaths: normalizeSshQuickPaths(preset?.quickPaths),
      };
    })
    .filter(Boolean);
}

function sshPresetsLocked() {
  return state.sshConnected || state.sshState === "connecting";
}

function updateSshPresetControls() {
  const locked = sshPresetsLocked();
  els.sshPresetSelect.disabled = locked || state.sshPresets.length === 0;
  els.saveSshPresetButton.disabled = locked;
  els.deleteSshPresetButton.disabled = locked || !els.sshPresetSelect.value;
}

function renderSshPresets() {
  const currentId = els.sshPresetSelect.value;
  const placeholder = document.createElement("option");
  placeholder.value = "";
  placeholder.textContent = t("ssh.preset.emptyOption");
  els.sshPresetSelect.replaceChildren(placeholder);
  state.sshPresets.forEach((preset) => {
    const option = document.createElement("option");
    option.value = preset.id;
    option.textContent = preset.alias;
    els.sshPresetSelect.append(option);
  });
  if (state.sshPresets.some((preset) => preset.id === currentId)) {
    els.sshPresetSelect.value = currentId;
  }
  updateSshPresetControls();
}

function getActiveSshPreset() {
  const active = state.sshPresets.find((preset) => preset.id === state.sshActivePresetId);
  if (active) return active;
  const selected = state.sshPresets.find(
    (preset) => preset.id === els.sshPresetSelect.value,
  );
  if (selected) return selected;
  return (
    state.sshPresets.find(
      (preset) =>
        preset.host === state.sshHost &&
        Number(preset.port) === Number(state.sshPort) &&
        preset.username === state.sshUsername,
    ) || null
  );
}

function renderSshQuickPaths() {
  if (!els.sshFilePlaceList || !els.sshFilePresetLabel) return;
  const preset = getActiveSshPreset();
  const paths = preset ? normalizeSshQuickPaths(preset.quickPaths) : [];
  const currentPath = normalizeSshPath(state.sshFilePath || ".");
  els.sshFilePresetLabel.textContent = preset?.alias || t("ssh.file.presetNone");
  els.sshFileAddPlaceButton.disabled =
    !preset || !currentPath.startsWith("/") || paths.includes(currentPath);
  els.sshFileAddPlaceButton.title = !preset
    ? t("ssh.file.addPlaceNeedsPreset")
    : !currentPath.startsWith("/")
      ? t("ssh.file.pathNotAbsoluteTitle")
      : paths.includes(currentPath)
        ? t("ssh.file.pathAlreadySaved")
        : t("ssh.file.addPlace");

  els.sshFilePlaceList.replaceChildren();
  paths.forEach((path) => {
    const item = document.createElement("div");
    item.className = "ssh-file-place-item";
    item.dataset.path = path;

    const openButton = document.createElement("button");
    openButton.type = "button";
    openButton.className = "ssh-file-place-open";
    openButton.title = path;

    const folderIcon = createLucideIcon("folder");
    const label = document.createElement("span");
    label.textContent = path;
    openButton.append(folderIcon, label);

    const deleteButton = document.createElement("button");
    deleteButton.type = "button";
    deleteButton.className = "ssh-file-place-delete";
    deleteButton.title = t("ssh.file.removePlace", { path });
    deleteButton.setAttribute("aria-label", deleteButton.title);
    const closeIcon = createLucideIcon("x");
    deleteButton.append(closeIcon);

    item.append(openButton, deleteButton);
    els.sshFilePlaceList.append(item);
  });
  els.sshFilePlaceEmpty.hidden = paths.length > 0;
  createIcons({ icons: { Folder, Plus, X } });
}

function readSshConfig({ allowEmptyPassword = false } = {}) {
  const host = els.sshHost.value.trim();
  const port = Number.parseInt(els.sshPort.value, 10);
  const username = els.sshUsername.value.trim();
  const password = els.sshPassword.value;

  if (!host) throw new Error(t("ssh.error.hostRequired"));
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(t("ssh.error.portRange"));
  }
  if (!username) throw new Error(t("ssh.error.usernameRequired"));
  if (!allowEmptyPassword && !password) throw new Error(t("ssh.error.passwordRequired"));

  return { host, port, username, password };
}

function sshFileSelectedEntry() {
  return (
    state.sshFileEntries.find((entry) => entry.path === state.sshFileSelected) || null
  );
}

function renderSshFileList() {
  const entries = [...state.sshFileEntries].sort((left, right) => {
    if (left.isDirectory !== right.isDirectory) return left.isDirectory ? -1 : 1;
    return left.name.localeCompare(right.name, getLocale(), {
      numeric: true,
      sensitivity: "base",
    });
  });
  state.sshFileEntries = entries;
  els.sshFileList.replaceChildren();
  entries.forEach((entry, index) => {
    const row = document.createElement("button");
    row.type = "button";
    row.className = "ssh-file-row";
    row.dataset.sshFileIndex = String(index);
    row.setAttribute("role", "option");
    row.setAttribute("aria-selected", String(entry.path === state.sshFileSelected));
    row.classList.toggle("is-selected", entry.path === state.sshFileSelected);

    const kind = document.createElement("span");
    kind.className = `ssh-file-row__kind${entry.isDirectory ? " is-directory" : ""}`;
    kind.setAttribute("aria-hidden", "true");

    const name = document.createElement("strong");
    name.className = "ssh-file-row__name";
    name.textContent = entry.name;

    const size = document.createElement("span");
    size.className = "ssh-file-row__size";
    size.textContent = formatSshFileSize(entry.size, entry.isDirectory);

    const modified = document.createElement("span");
    modified.className = "ssh-file-row__modified";
    modified.textContent = formatSshFileTime(entry.mtime);

    row.append(kind, name, size, modified);
    els.sshFileList.append(row);
  });
  els.sshFileList.hidden = entries.length === 0;
  els.sshFileEmpty.hidden = entries.length > 0;
  updateSshFileControls();
}

function selectSshFile(path) {
  state.sshFileSelected = path;
  $$("[data-ssh-file-index]", els.sshFileList).forEach((row) => {
    const entry = state.sshFileEntries[Number.parseInt(row.dataset.sshFileIndex, 10)];
    const selected = entry?.path === path;
    row.classList.toggle("is-selected", selected);
    row.setAttribute("aria-selected", String(selected));
  });
  updateSshFileControls();
}

function updateSshFileProgress(progress) {
  if (!progress) {
    els.sshFileProgress.hidden = true;
    els.sshFileProgressBar.value = 0;
    els.sshFileProgressText.textContent = t("ssh.file.transferWaiting");
    els.sshFileProgressValue.textContent = "0%";
    return;
  }
  const total = Math.max(0, Number(progress.total) || 0);
  const done = Math.max(0, Number(progress.done) || 0);
  const percent = total > 0 ? Math.min(100, Math.round((done / total) * 100)) : 0;
  els.sshFileProgress.hidden = false;
  els.sshFileProgressBar.value = percent;
  els.sshFileProgressText.textContent = progress.label || t("ssh.file.transferring");
  els.sshFileProgressValue.textContent =
    total > 0
      ? `${formatBytes(done)} / ${formatBytes(total)} · ${percent}%`
      : formatBytes(done);
}

function updateSshFileControls() {
  const connected = state.sshConnected;
  const busy = state.sshFileBusy;
  const selected = sshFileSelectedEntry();
  els.sshFilePath.disabled = !connected || busy;
  els.sshFileGoButton.disabled = !connected || busy;
  els.sshFileParentButton.disabled = !connected || busy;
  els.sshFileRefreshButton.disabled = !connected || busy;
  els.sshFileUploadButton.disabled = !connected || busy;
  els.sshFileMkdirButton.disabled = !connected || busy;
  els.sshFileDownloadButton.disabled = !connected || busy || !selected || selected.isDirectory;
  els.sshFileRenameButton.disabled = !connected || busy || !selected;
  els.sshFileDeleteButton.disabled = !connected || busy || !selected;
  els.sshFileCancelButton.hidden = !state.sshFileAbortController;
  els.sshFileButton.disabled = !connected || busy;
}

function setSshFileBusy(busy) {
  state.sshFileBusy = Boolean(busy);
  els.sshFileStatus.classList.toggle("is-busy", state.sshFileBusy);
  updateSshFileControls();
}

async function loadSshDirectory(path = state.sshFilePath, { announce = false } = {}) {
  if (!state.sshConnected || !state.sshBridge) {
    throw new Error(t("ssh.error.notConnected"));
  }
  const normalizedPath = normalizeSshPath(path);
  setSshFileBusy(true);
  els.sshFileStatus.textContent = t("ssh.file.reading", { path: normalizedPath });
  try {
    const result = await state.sshBridge.listDirectory(normalizedPath);
    state.sshFilePath = normalizeSshPath(result.path || normalizedPath);
    state.sshFileEntries = (Array.isArray(result.entries) ? result.entries : []).map(
      (entry) => ({
        name: String(entry.name || ""),
        path: joinSshPath(state.sshFilePath, String(entry.name || "")),
        size: Number(entry.size) || 0,
        mtime: Number(entry.mtime) || 0,
        isDirectory: Boolean(entry.isDirectory),
      }),
    );
    state.sshFileSelected = null;
    els.sshFilePath.value = state.sshFilePath;
    renderSshFileList();
    renderSshQuickPaths();
    els.sshFileStatus.textContent = tCount("ssh.file.itemCount", state.sshFileEntries.length);
    if (announce) showToast(t("ssh.file.refreshed"), "success");
  } finally {
    setSshFileBusy(false);
  }
}

function openSshFileDialog() {
  if (!state.sshConnected || !state.sshBridge) {
    showToast(t("ssh.error.connectFirst"), "info");
    return;
  }
  state.sshFilePath = normalizeSshPath(state.sshFilePath || ".");
  els.sshFilePath.value = state.sshFilePath;
  state.sshFileSelected = null;
  updateSshFileProgress(null);
  renderSshQuickPaths();
  if (!els.sshFileDialog.open) els.sshFileDialog.showModal();
  void loadSshDirectory(state.sshFilePath).catch((error) => {
    const message = errorMessage(error, t("ssh.file.readDirFailed"));
    els.sshFileStatus.textContent = message;
    showToast(message, "error");
  });
}

function closeSshFileDialog({ force = false } = {}) {
  if (state.sshFileAbortController && !force) {
    if (!window.confirm(t("ssh.file.confirmCancelClose"))) return;
  }
  if (state.sshFileAbortController) {
    state.sshFileAbortController.abort();
  }
  if (els.sshFileDialog.open) els.sshFileDialog.close();
}

function beginSshFileTransfer(label) {
  const controller = new AbortController();
  state.sshFileAbortController = controller;
  state.sshFileTransfer = label;
  updateSshFileProgress({ label, done: 0, total: 0 });
  setSshFileBusy(true);
  return controller;
}

function finishSshFileTransfer() {
  state.sshFileAbortController = null;
  state.sshFileTransfer = null;
  updateSshFileProgress(null);
  setSshFileBusy(false);
}

async function uploadSshFiles(fileList) {
  const files = [...fileList];
  if (!files.length || !state.sshConnected || !state.sshBridge) return;
  const conflicts = files.filter((file) =>
    state.sshFileEntries.some((entry) => entry.name === file.name),
  );
  if (
    conflicts.length &&
    !window.confirm(
      t("ssh.file.confirmOverwrite", {
        list: conflicts.map((file) => file.name).join("\n"),
      }),
    )
  ) {
    return;
  }

  const controller = beginSshFileTransfer(tCount("ssh.file.uploadFiles", files.length));
  try {
    for (const file of files) {
      await state.sshBridge.uploadFile(file, joinSshPath(state.sshFilePath, file.name), {
        signal: controller.signal,
        overwrite: conflicts.some((conflict) => conflict.name === file.name),
        onProgress: ({ uploaded, total, name }) => {
          updateSshFileProgress({
            label: t("ssh.file.uploadLabel", { name }),
            done: uploaded,
            total,
          });
        },
      });
    }
    await loadSshDirectory(state.sshFilePath);
    showToast(tCount("ssh.file.uploadDone", files.length), "success");
  } catch (error) {
    if (error?.name === "AbortError") {
      showToast(t("ssh.file.uploadCancelled"), "info");
    } else {
      const message = errorMessage(error, t("ssh.file.uploadFailed"));
      els.sshFileStatus.textContent = message;
      showToast(message, "error");
    }
  } finally {
    els.sshFileUploadInput.value = "";
    finishSshFileTransfer();
  }
}

async function downloadSelectedSshFile() {
  const entry = sshFileSelectedEntry();
  if (!entry || entry.isDirectory || !state.sshBridge) return;
  const controller = beginSshFileTransfer(t("ssh.file.downloadLabel", { name: entry.name }));
  try {
    const result = await state.sshBridge.downloadFile(entry.path, {
      signal: controller.signal,
      onProgress: ({ received, total }) => {
        updateSshFileProgress({
          label: t("ssh.file.downloadLabel", { name: entry.name }),
          done: received,
          total,
        });
      },
    });
    downloadBlob(result.blob, result.name);
    showToast(t("ssh.file.downloadDone", { name: result.name }), "success");
  } catch (error) {
    if (error?.name === "AbortError") {
      showToast(t("ssh.file.downloadCancelled"), "info");
    } else {
      const message = errorMessage(error, t("ssh.file.downloadFailed"));
      els.sshFileStatus.textContent = message;
      showToast(message, "error");
    }
  } finally {
    finishSshFileTransfer();
  }
}

async function createSshDirectory() {
  if (!state.sshConnected || !state.sshBridge) return;
  const name = window.prompt(t("ssh.file.newFolderPrompt"));
  if (!name?.trim()) return;
  const targetPath = joinSshPath(state.sshFilePath, name.trim());
  setSshFileBusy(true);
  try {
    await state.sshBridge.makeDirectory(targetPath);
    await loadSshDirectory(state.sshFilePath);
    state.sshFileSelected = targetPath;
    renderSshFileList();
    showToast(t("ssh.file.mkdirDone", { path: targetPath }), "success");
  } catch (error) {
    showToast(errorMessage(error, t("ssh.file.mkdirFailed")), "error");
  } finally {
    setSshFileBusy(false);
  }
}

async function renameSelectedSshEntry() {
  const entry = sshFileSelectedEntry();
  if (!entry || !state.sshBridge) return;
  const name = window.prompt(t("ssh.file.renamePrompt"), entry.name);
  if (!name?.trim() || name.trim() === entry.name) return;
  const targetPath = joinSshPath(state.sshFilePath, name.trim());
  setSshFileBusy(true);
  try {
    await state.sshBridge.renameEntry(entry.path, targetPath);
    await loadSshDirectory(state.sshFilePath);
    state.sshFileSelected = targetPath;
    renderSshFileList();
    showToast(t("ssh.file.renameDone", { name: name.trim() }), "success");
  } catch (error) {
    showToast(errorMessage(error, t("ssh.file.renameFailed")), "error");
  } finally {
    setSshFileBusy(false);
  }
}

async function deleteSelectedSshEntry() {
  const entry = sshFileSelectedEntry();
  if (!entry || !state.sshBridge) return;
  const confirmMessage = entry.isDirectory
    ? t("ssh.file.confirmDeleteFolder", { name: entry.name })
    : t("ssh.file.confirmDeleteFile", { name: entry.name });
  if (!window.confirm(confirmMessage)) {
    return;
  }
  setSshFileBusy(true);
  try {
    await state.sshBridge.deleteEntry(entry.path, entry.isDirectory);
    await loadSshDirectory(state.sshFilePath);
    showToast(t("ssh.file.deleteDone", { name: entry.name }), "success");
  } catch (error) {
    showToast(errorMessage(error, t("ssh.file.deleteFailed")), "error");
  } finally {
    setSshFileBusy(false);
  }
}

export { beginSshFileTransfer, closeSshFileDialog, createSshDirectory, deleteSelectedSshEntry, downloadSelectedSshFile, finishSshFileTransfer, fitSshTerminal, getActiveSshPreset, initializeSshTerminal, loadSshDirectory, normalizeSshPresets, normalizeSshQuickPaths, openSshFileDialog, readSshConfig, renameSelectedSshEntry, renderSshFileList, renderSshPresets, renderSshQuickPaths, selectSshFile, setSshFileBusy, sshFileSelectedEntry, sshPresetsLocked, updateSshFileControls, updateSshFileProgress, updateSshPresetControls, uploadSshFiles };
