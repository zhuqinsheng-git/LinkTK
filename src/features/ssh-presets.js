// Module: SSH connection presets and quick path management.
// Owns: preset save/apply/delete, quick path add/remove, and control syncing.
// Depends on: core, ssh, network-runtime, toast.
// Called by: app.js, ssh-runtime, and the SSH workspace events.

import { MAX_CONNECTION_PRESETS } from "../core/constants.js";
import { els } from "../core/dom.js";
import { errorMessage } from "../core/errors.js";
import { t } from "../core/i18n.js";
import { persistSettings } from "../core/settings.js";
import { state } from "../core/state.js";
import { normalizeSshPath } from "../lib/ssh-path.js";
import { updateNetworkUI } from "./network-runtime.js";
import { getActiveSshPreset, normalizeSshQuickPaths, readSshConfig, renderSshPresets, renderSshQuickPaths, sshPresetsLocked, updateSshPresetControls } from "./ssh.js"
import { showToast } from "./toast.js"

function addCurrentSshQuickPath() {
  const preset = getActiveSshPreset();
  if (!preset) {
    showToast(t("ssh.preset.required"), "info");
    return;
  }
  const path = normalizeSshPath(state.sshFilePath);
  if (!path.startsWith("/")) {
    showToast(t("ssh.file.pathNotAbsolute"), "info");
    return;
  }
  preset.quickPaths = normalizeSshQuickPaths([path, ...(preset.quickPaths || [])]);
  persistSettings();
  renderSshQuickPaths();
  showToast(t("ssh.file.pathAdded", { path }), "success");
}

function removeSshQuickPath(path) {
  const preset = getActiveSshPreset();
  if (!preset) return;
  preset.quickPaths = normalizeSshQuickPaths(
    (preset.quickPaths || []).filter((entry) => entry !== path),
  );
  persistSettings();
  renderSshQuickPaths();
  showToast(t("ssh.file.pathRemoved", { path }), "success");
}

function saveSshPreset() {
  if (sshPresetsLocked()) {
    showToast(t("ssh.preset.locked"), "info");
    return;
  }

  let config;
  try {
    config = readSshConfig({ allowEmptyPassword: true });
  } catch (error) {
    showToast(errorMessage(error, t("ssh.error.invalidConfig")), "error");
    return;
  }

  const aliasInput = els.sshAlias.value.trim().slice(0, 80);
  const alias = aliasInput || `${config.username}@${config.host}:${config.port}`;
  const existingIndex = state.sshPresets.findIndex(
    (preset) =>
      preset.host === config.host &&
      preset.port === config.port &&
      preset.username === config.username,
  );
  const preset = {
    id:
      existingIndex >= 0
        ? state.sshPresets[existingIndex].id
        : crypto.randomUUID?.() || `ssh-preset-${Date.now()}-${Math.random()}`,
    alias,
    host: config.host,
    port: config.port,
    username: config.username,
    password: state.sshSavePassword ? config.password : "",
    quickPaths:
      existingIndex >= 0
        ? normalizeSshQuickPaths(state.sshPresets[existingIndex].quickPaths)
        : [],
  };

  if (existingIndex >= 0) {
    state.sshPresets.splice(existingIndex, 1);
  } else if (state.sshPresets.length >= MAX_CONNECTION_PRESETS) {
    showToast(t("ssh.preset.limit", { count: MAX_CONNECTION_PRESETS }), "info");
    return;
  }

  state.sshPresets.unshift(preset);
  state.sshAlias = alias;
  els.sshAlias.value = alias;
  renderSshPresets();
  els.sshPresetSelect.value = preset.id;
  state.sshActivePresetId = preset.id;
  renderSshQuickPaths();
  updateSshPresetControls();
  persistSettings();
  showToast(
    state.sshSavePassword
      ? t("ssh.preset.savedWithPassword")
      : t("ssh.preset.saved"),
    "success",
  );
}

function applySshPreset() {
  if (sshPresetsLocked()) return;
  const preset = state.sshPresets.find((item) => item.id === els.sshPresetSelect.value);
  if (!preset) {
    updateSshPresetControls();
    return;
  }

  state.sshAlias = preset.alias;
  state.sshHost = preset.host;
  state.sshPort = preset.port;
  state.sshUsername = preset.username;
  els.sshAlias.value = preset.alias;
  els.sshHost.value = preset.host;
  els.sshPort.value = String(preset.port);
  els.sshUsername.value = preset.username;
  els.sshPassword.value = preset.password || "";
  state.sshActivePresetId = preset.id;
  renderSshQuickPaths();
  updateNetworkUI();
  persistSettings();
  showToast(t("ssh.preset.applied", { alias: preset.alias }), "success");
}

function deleteSshPreset() {
  if (sshPresetsLocked()) return;
  const index = state.sshPresets.findIndex(
    (preset) => preset.id === els.sshPresetSelect.value,
  );
  if (index < 0) return;
  const [removed] = state.sshPresets.splice(index, 1);
  els.sshPresetSelect.value = "";
  if (state.sshActivePresetId === removed.id) state.sshActivePresetId = "";
  renderSshPresets();
  renderSshQuickPaths();
  persistSettings();
  showToast(t("ssh.preset.deleted", { alias: removed.alias }), "success");
}

export { addCurrentSshQuickPath, applySshPreset, deleteSshPreset, removeSshQuickPath, saveSshPreset };
