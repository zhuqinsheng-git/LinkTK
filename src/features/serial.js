// Module: Serial port discovery, configuration, and signal control.
// Owns: port names, authorized-port refresh, serial option reading, and DTR/RTS.
// Depends on: core, lib/format.js, toast.
// Called by: app.js and the agent serial commands.

import { MAX_CONNECTION_PRESETS } from "../core/constants.js";
import { els } from "../core/dom.js";
import { t } from "../core/i18n.js";
import { defaultSettings } from "../core/settings.js";
import { state } from "../core/state.js";
import { formatUsbId } from "../lib/format.js";
import { showToast } from "./toast.js";

function setBaudRateValue(value) {
  const numeric = Number(value);
  const normalized =
    Number.isFinite(numeric) && numeric >= 50
      ? String(numeric)
      : String(defaultSettings.baudRate);
  const exists = [...els.baudRate.options].some((option) => option.value === normalized);

  if (!exists) {
    const option = document.createElement("option");
    option.value = normalized;
    option.textContent = normalized;
    els.baudRate.append(option);
  }
  els.baudRate.value = normalized;
}

function normalizeSerialConnectionPresets(value) {
  const presets = Array.isArray(value) ? value : [];
  return presets
    .slice(0, MAX_CONNECTION_PRESETS)
    .map((preset, index) => {
      const baudRate = Number(preset?.baudRate);
      if (!Number.isFinite(baudRate) || baudRate < 50) return null;
      const parity = ["none", "even", "odd"].includes(preset?.parity)
        ? preset.parity
        : "none";
      const flowControl = preset?.flowControl === "hardware" ? "hardware" : "none";
      return {
        id: String(preset?.id || `serial-preset-${index + 1}-${Date.now()}`),
        name: String(preset?.name || t("serial.preset.defaultName", { index: index + 1 })).slice(0, 80),
        portLabel: String(preset?.portLabel || "").slice(0, 160),
        baudRate,
        dataBits: Number(preset?.dataBits) === 7 ? 7 : 8,
        stopBits: Number(preset?.stopBits) === 2 ? 2 : 1,
        parity,
        flowControl,
        dtr: preset?.dtr !== false,
        rts: preset?.rts !== false,
      };
    })
    .filter(Boolean);
}

function getPortInfo(port) {
  if (!port || typeof port.getInfo !== "function") return {};
  return port.getInfo() || {};
}

function findSystemSerialPort(port, availablePorts) {
  const info = getPortInfo(port);
  const hasUsbIds =
    Number.isFinite(info.usbVendorId) && Number.isFinite(info.usbProductId);
  if (hasUsbIds) {
    const exactIndex = availablePorts.findIndex(
      (candidate) =>
        candidate.vendorId === info.usbVendorId &&
        candidate.productId === info.usbProductId,
    );
    if (exactIndex >= 0) return exactIndex;
    return -1;
  }

  return availablePorts.length === 1 ? 0 : -1;
}

function createPortName(port, index, systemPort = null) {
  const info = getPortInfo(port);
  const identifiers = [];

  if (Number.isFinite(info.usbVendorId)) {
    identifiers.push(`VID ${formatUsbId(info.usbVendorId)}`);
  }
  if (Number.isFinite(info.usbProductId)) {
    identifiers.push(`PID ${formatUsbId(info.usbProductId)}`);
  }

  if (systemPort?.name) {
    return {
      title: systemPort.name,
      meta: systemPort.port
        ? `${systemPort.port} · ${t("serial.port.pairedShort")}`
        : t("serial.port.pairedShort"),
      optionLabel: `${systemPort.name} · ${t("serial.port.pairedShort")}`,
    };
  }

  const title = identifiers.length ? `USB Serial (${identifiers.join(" · ")})` : "USB Serial";
  return {
    title,
    meta: t("serial.port.pairedShort"),
    optionLabel: title,
  };
}

function buildPortLabels(ports) {
  const availablePorts = [...state.systemSerialPorts];
  const labels = new WeakMap();

  ports.forEach((port, index) => {
    const matchIndex = findSystemSerialPort(port, availablePorts);
    const systemPort = matchIndex >= 0 ? availablePorts.splice(matchIndex, 1)[0] : null;
    labels.set(port, createPortName(port, index, systemPort));
  });

  return labels;
}

function getPortName(port, index) {
  return state.portLabels.get(port) || createPortName(port, index);
}

async function refreshSystemSerialPorts() {
  try {
    const response = await fetch("/api/system-serial-ports", {
      headers: { Accept: "application/json" },
      cache: "no-store",
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const ports = await response.json();
    state.systemSerialPorts = Array.isArray(ports) ? ports : [];
  } catch {
    state.systemSerialPorts = [];
  }
}

function setPortDetails(title, meta, ready = false) {
  els.portDetails.replaceChildren();

  const line = document.createElement("span");
  line.className = "port-details__line";

  const content = document.createElement("div");
  const titleElement = document.createElement("strong");
  const metaElement = document.createElement("span");
  titleElement.textContent = title;
  metaElement.textContent = meta;
  content.append(titleElement, metaElement);

  els.portDetails.append(line, content);
  els.portDetails.classList.toggle("is-ready", ready);
}

function readSerialOptions() {
  const baudRate = Number.parseInt(els.baudRate.value, 10);

  if (!Number.isFinite(baudRate) || baudRate < 50) {
    throw new Error(t("serial.error.baudRange"));
  }

  return {
    baudRate,
    dataBits: Number(els.dataBits.value),
    stopBits: Number(els.stopBits.value),
    parity: els.parity.value,
    flowControl: els.flowControl.value,
    bufferSize: 4096,
  };
}

async function applySignalState() {
  if (!state.activePort || typeof state.activePort.setSignals !== "function") return;

  try {
    await state.activePort.setSignals({
      dataTerminalReady: els.dtrToggle.checked,
      requestToSend: els.rtsToggle.checked,
    });
  } catch {
    showToast(t("serial.error.dtrUnsupported"), "info");
  }
}

function ensureSerialAvailable() {
  if (!state.supported) {
    showToast(t("serial.error.webSerialDesktop"), "error");
    return false;
  }
  if (!state.secureContext) {
    showToast(t("serial.error.insecureContext"), "error");
    return false;
  }
  return true;
}

function getSerialPortSummary(port, index) {
  const name = getPortName(port, index);
  const info = getPortInfo(port);
  return {
    index,
    label: name.optionLabel || `${name.title} · ${name.meta}`,
    title: name.title,
    meta: name.meta,
    usbVendorId: Number.isFinite(info.usbVendorId) ? info.usbVendorId : null,
    usbProductId: Number.isFinite(info.usbProductId) ? info.usbProductId : null,
  };
}
export { applySignalState, buildPortLabels, createPortName, ensureSerialAvailable, findSystemSerialPort, getPortInfo, getPortName, getSerialPortSummary, normalizeSerialConnectionPresets, readSerialOptions, refreshSystemSerialPorts, setBaudRateValue, setPortDetails };
