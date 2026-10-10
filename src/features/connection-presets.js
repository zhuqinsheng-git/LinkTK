// Module: Saving, applying, and deleting serial and TCP/UDP connection presets.
// Owns: preset select controls, signature dedupe, rendering, and persistence.
// Depends on: core, serial, network-runtime, payload, i18n, toast; the serial UI callback is injected by app.js.
// Called by: app.js, network-runtime, and the connection workbench events.

import { MAX_CONNECTION_PRESETS } from "../core/constants.js";
import { els } from "../core/dom.js";
import { errorMessage } from "../core/errors.js";
import { t } from "../core/i18n.js";
import { persistSettings } from "../core/settings.js";
import { state } from "../core/state.js";
import { updateNetworkUI } from "./network-runtime.js";
import { readNetworkConfig } from "./network.js";
import { readSerialOptions, setBaudRateValue } from "./serial.js";
import { updatePortSelection } from "./serial-runtime.js";
import { showToast } from "./toast.js";

let updateConnectionUI = null;

function initializeConnectionPresets({
  updateConnectionUI: updateConnectionUICallback,
} = {}) {
  if (typeof updateConnectionUICallback !== "function") {
    throw new TypeError("initializeConnectionPresets requires updateConnectionUI.");
  }
  updateConnectionUI = updateConnectionUICallback;
}

function getConnectionPresetElements(kind) {
  return kind === "network"
    ? {
        select: els.networkPresetSelect,
        saveButton: els.saveNetworkPresetButton,
        deleteButton: els.deleteNetworkPresetButton,
        presets: state.networkConnectionPresets,
      }
    : {
        select: els.serialPresetSelect,
        saveButton: els.saveSerialPresetButton,
        deleteButton: els.deleteSerialPresetButton,
        presets: state.serialConnectionPresets,
      };
}

function connectionPresetsLocked(kind) {
  return kind === "network"
    ? state.networkConnected || state.networkState === "connecting"
    : state.connected || state.connecting || state.closing || state.ymodemBusy;
}

function updateConnectionPresetControls(kind) {
  const { select, saveButton, deleteButton, presets } = getConnectionPresetElements(kind);
  const locked = connectionPresetsLocked(kind);
  select.disabled = locked || presets.length === 0;
  saveButton.disabled = locked;
  deleteButton.disabled = locked || !select.value;
}

function renderConnectionPresets(kind) {
  const { select, presets } = getConnectionPresetElements(kind);
  const currentId = select.value;
  const placeholder = document.createElement("option");
  placeholder.value = "";
  placeholder.textContent = t(
    kind === "network" ? "net.preset.emptyOption" : "serial.preset.emptyOption",
  );
  select.replaceChildren(placeholder);
  presets.forEach((preset) => {
    const option = document.createElement("option");
    option.value = preset.id;
    option.textContent = preset.name;
    select.append(option);
  });
  if (presets.some((preset) => preset.id === currentId)) select.value = currentId;
  updateConnectionPresetControls(kind);
}

function createConnectionPresetId(kind) {
  return (
    crypto.randomUUID?.() ||
    `${kind}-preset-${Date.now()}-${Math.random().toString(16).slice(2)}`
  );
}

function serialPresetSignature(preset) {
  return [
    preset.portLabel,
    preset.baudRate,
    preset.dataBits,
    preset.stopBits,
    preset.parity,
    preset.flowControl,
    preset.dtr,
    preset.rts,
  ].join("|");
}

function networkPresetSignature(preset) {
  return [preset.protocol, preset.role, preset.host, preset.port].join("|");
}

function saveConnectionPreset(kind) {
  if (connectionPresetsLocked(kind)) {
    showToast(t("connectionPreset.locked"), "info");
    return;
  }

  const { select, presets } = getConnectionPresetElements(kind);
  let preset;
  try {
    if (kind === "network") {
      const { host, port } = readNetworkConfig();
      const protocol = state.networkProtocol.toUpperCase();
      const role =
        state.networkRole === "server" ? t("net.endpoint.server") : t("net.endpoint.client");
      preset = {
        id: createConnectionPresetId(kind),
        name: `${protocol} ${role} · ${host}:${port}`,
        protocol: state.networkProtocol,
        role: state.networkRole,
        host,
        port,
      };
    } else {
      const options = readSerialOptions();
      const portLabel =
        els.portSelect.value !== ""
          ? els.portSelect.selectedOptions?.[0]?.textContent?.trim() ||
            t("connectionPreset.portChosen")
          : t("connectionPreset.portNone");
      preset = {
        id: createConnectionPresetId(kind),
        name: `${portLabel} · ${options.baudRate} baud`,
        portLabel,
        ...options,
      };
      delete preset.bufferSize;
      preset.dtr = els.dtrToggle.checked;
      preset.rts = els.rtsToggle.checked;
    }
  } catch (error) {
    showToast(errorMessage(error, t("connectionPreset.error.invalid")), "error");
    return;
  }

  const signature =
    kind === "network" ? networkPresetSignature(preset) : serialPresetSignature(preset);
  const existingIndex = presets.findIndex(
    (item) =>
      (kind === "network" ? networkPresetSignature(item) : serialPresetSignature(item)) ===
      signature,
  );

  if (existingIndex >= 0) {
    preset.id = presets[existingIndex].id;
    preset.name = presets[existingIndex].name;
    presets.splice(existingIndex, 1);
  } else if (presets.length >= MAX_CONNECTION_PRESETS) {
    showToast(t("connectionPreset.limit", { count: MAX_CONNECTION_PRESETS }), "info");
    return;
  }

  presets.unshift(preset);
  renderConnectionPresets(kind);
  select.value = preset.id;
  updateConnectionPresetControls(kind);
  persistSettings();
  showToast(
    existingIndex >= 0 ? t("connectionPreset.updated") : t("connectionPreset.saved"),
    "success",
  );
}

function applyConnectionPreset(kind) {
  if (connectionPresetsLocked(kind)) return;
  const { select, presets } = getConnectionPresetElements(kind);
  const preset = presets.find((item) => item.id === select.value);
  if (!preset) {
    updateConnectionPresetControls(kind);
    return;
  }

  if (kind === "network") {
    state.networkProtocol = preset.protocol;
    state.networkRole = preset.role;
    state.networkHost = preset.host;
    state.networkPort = preset.port;
    els.networkHost.value = preset.host;
    els.networkPort.value = String(preset.port);
    updateNetworkUI();
    persistSettings();
    showToast(t("connectionPreset.networkApplied", { name: preset.name }), "success");
    return;
  }

  setBaudRateValue(preset.baudRate);
  els.dataBits.value = String(preset.dataBits);
  els.stopBits.value = String(preset.stopBits);
  els.parity.value = preset.parity;
  els.flowControl.value = preset.flowControl;
  els.dtrToggle.checked = preset.dtr;
  els.rtsToggle.checked = preset.rts;

  const portOption = [...els.portSelect.options].find(
    (option) => option.value !== "" && option.textContent?.trim() === preset.portLabel,
  );
  if (portOption) {
    els.portSelect.value = portOption.value;
    updatePortSelection();
  }
  updateConnectionUI();
  persistSettings();
  showToast(
    portOption
      ? t("connectionPreset.serialApplied", { name: preset.name })
      : t("connectionPreset.serialUnavailable", {
          port: preset.portLabel || t("connectionPreset.portFallback"),
        }),
    portOption ? "success" : "info",
  );
}

function deleteConnectionPreset(kind) {
  if (connectionPresetsLocked(kind)) return;
  const { select, presets } = getConnectionPresetElements(kind);
  const index = presets.findIndex((preset) => preset.id === select.value);
  if (index < 0) return;
  const [removed] = presets.splice(index, 1);
  select.value = "";
  renderConnectionPresets(kind);
  persistSettings();
  showToast(t("connectionPreset.deleted", { name: removed.name }), "success");
}

export { applyConnectionPreset, connectionPresetsLocked, createConnectionPresetId, deleteConnectionPreset, getConnectionPresetElements, initializeConnectionPresets, networkPresetSignature, renderConnectionPresets, saveConnectionPreset, serialPresetSignature, updateConnectionPresetControls };
