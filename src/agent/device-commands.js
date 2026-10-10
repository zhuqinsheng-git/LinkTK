// Module: AI device command adapters for serial, network, SSH, and YMODEM.
// Owns: connection switching, payload sending, event reading, and YMODEM result wrapping.
// Depends on: core, agent, serial-runtime, network-runtime, ssh-runtime, ymodem-runtime.
// Called by: app.js executeAgentCommand dispatcher.

import { MAX_SSH_AGENT_RESPONSE_BYTES, MAX_SSH_AGENT_TRANSFER_BYTES } from "../core/constants.js";
import { els } from "../core/dom.js";
import { t } from "../core/i18n.js";
import { persistSettings } from "../core/settings.js";
import { state } from "../core/state.js";
import { bytesToHex } from "../lib/format.js";
import { base64ToBytes, bytesToBase64 } from "../lib/encoding.js";
import { getAgentStatusSnapshot, getAgentPortName } from "./runtime.js";
import { buildAgentPayload } from "./events.js";
import { getBridgeAgentStatus, getNetworkPresetForAgent, getSerialPresetForAgent, getSshPresetForAgent, resolveSerialPortForAgent, waitForAgentSshConnection, waitForNetworkAgentConnection } from "./commands.js";
import { initializeNetworkBridge, setNetworkProtocol, updateNetworkUI } from "../features/network-runtime.js";
import { normalizeNetworkProtocol, normalizePort, setNetworkStatus } from "../features/network.js";
import { connectSelectedPort, disconnectPort, refreshPorts, sendPayload, updatePortSelection } from "../features/serial-runtime.js";
import { toggleSshConnection } from "../features/ssh-runtime.js";
import { runYmodemTransfer } from "../features/ymodem-runtime.js";
import { getSerialPortSummary, setBaudRateValue } from "../features/serial.js";
import { normalizeMacroNumber } from "../features/macro.js";
import { setYmodemMode } from "../features/ymodem.js";
import { resetAgentTrafficDecoders } from "../features/log-view.js";
import { startBridge, stopBridge } from "../features/bridge.js";

let updateConnectionUI = null;
let setWorkspaceMode = null;

function initializeAgentDeviceCommands({
  updateConnectionUI: updateConnectionUICallback,
  setWorkspaceMode: setWorkspaceModeCallback,
} = {}) {
  if (
    typeof updateConnectionUICallback !== "function" ||
    typeof setWorkspaceModeCallback !== "function"
  ) {
    throw new TypeError(
      "initializeAgentDeviceCommands requires updateConnectionUI and setWorkspaceMode.",
    );
  }
  updateConnectionUI = updateConnectionUICallback;
  setWorkspaceMode = setWorkspaceModeCallback;
}

async function sendAgentPayload(params = {}) {
  const payload = buildAgentPayload(params, "serial");
  if (!payload.byteLength) throw new Error(t("agent.sendEmptyPayload"));
  const sent = await sendPayload(payload, {
    actor: "agent",
    separateLog: true,
  });
  if (!sent) throw new Error(t("agent.sendFailed"));
  return {
    bytesSent: payload.byteLength,
    hex: bytesToHex(payload),
    sequence: state.agentEventSequence,
  };
}

async function listSerialPortsForAgent() {
  if (!state.supported) {
    return {
      supported: false,
      authorizedPorts: [],
      systemPorts: [],
      message: t("serialAgent.notSupported"),
    };
  }
  await refreshPorts();
  return {
    supported: true,
    connected: state.connected,
    activePort: getAgentPortName(state.activePort) || "",
    authorizedPorts: state.ports.map(getSerialPortSummary),
    systemPorts: state.systemSerialPorts.map((port) => ({ ...port })),
    presets: state.serialConnectionPresets.length,
  };
}

async function connectSerialForAgent(params = {}, context = {}) {
  if (!state.supported) throw new Error(t("serialAgent.notSupported"));
  const preset = getSerialPresetForAgent(params);
  if ((params.presetId || params.name || params.alias) && !preset) {
    throw new Error(t("serialAgent.presetNotFound"));
  }
  if (state.connected && (params.forceReconnect || preset || params.portIndex !== undefined)) {
    await disconnectPort({ reason: "manual", notify: false });
  }
  if (state.connected) return { ...getAgentStatusSnapshot().serial, reused: true };
  if (context.signal?.aborted) throw new DOMException(t("agent.cancelled"), "AbortError");

  await refreshPorts();
  const portIndex = resolveSerialPortForAgent(params, preset);
  els.portSelect.value = String(portIndex);
  updatePortSelection();

  const baudRate = normalizeMacroNumber(
    params.baudRate ?? preset?.baudRate,
    Number.parseInt(els.baudRate.value, 10) || 115200,
    10000000,
  );
  setBaudRateValue(baudRate);
  els.dataBits.value = String(Number(params.dataBits ?? preset?.dataBits) === 7 ? 7 : 8);
  els.stopBits.value = String(Number(params.stopBits ?? preset?.stopBits) === 2 ? 2 : 1);
  els.parity.value = ["none", "even", "odd"].includes(params.parity ?? preset?.parity)
    ? params.parity ?? preset.parity
    : "none";
  els.flowControl.value =
    (params.flowControl ?? preset?.flowControl) === "hardware" ? "hardware" : "none";
  els.dtrToggle.checked = (params.dtr ?? preset?.dtr ?? true) !== false;
  els.rtsToggle.checked = (params.rts ?? preset?.rts ?? true) !== false;
  persistSettings();
  updateConnectionUI();
  return connectSelectedPort({ throwOnError: true });
}

async function disconnectSerialForAgent() {
  if (!state.activePort) return getAgentStatusSnapshot().serial;
  await disconnectPort({ reason: "manual", notify: false });
  return getAgentStatusSnapshot().serial;
}

async function connectNetworkForAgent(params = {}, context = {}) {
  const preset = getNetworkPresetForAgent(params);
  if ((params.presetId || params.name || params.alias) && !preset) {
    throw new Error(t("netAgent.presetNotFound"));
  }

  const protocol = normalizeNetworkProtocol(params.protocol || preset?.protocol || state.networkProtocol);
  if (protocol === "ssh") {
    throw new Error(t("netAgent.tcpUdpOnly"));
  }
  const role = String(params.role || preset?.role || state.networkRole) === "server"
    ? "server"
    : "client";
  const host = String(params.host || preset?.host || state.networkHost || "127.0.0.1").trim();
  const port = normalizePort(params.port || preset?.port || state.networkPort, 9000);
  if (state.sshConnected || state.sshState === "connecting") {
    throw new Error(t("netAgent.sshBusy"));
  }

  const requested = { protocol, role, host, port };
  if (
    state.networkConnected &&
    state.networkProtocol === requested.protocol &&
    state.networkRole === requested.role &&
    state.networkHost === requested.host &&
    Number(state.networkPort) === requested.port
  ) {
    return {
      connected: true,
      reused: true,
      ...getAgentStatusSnapshot().network,
    };
  }

  setWorkspaceMode("network", { persist: false });
  setNetworkProtocol(protocol, { persist: false });
  state.networkRole = role;
  state.networkHost = host;
  state.networkPort = port;
  els.networkHost.value = host;
  els.networkPort.value = String(port);
  persistSettings();
  initializeNetworkBridge();
  await state.networkBridge.connect();

  if (state.networkConnected) {
    await state.networkBridge.stop();
    await waitForNetworkAgentConnection({
      connected: false,
      timeoutMs: 5000,
      signal: context.signal,
    });
  }

  state.networkState = "connecting";
  resetAgentTrafficDecoders("network");
  setNetworkStatus(
    "connecting",
    state.networkRole === "server" ? t("netAgent.startingServer") : t("netAgent.connecting"),
  );
  updateNetworkUI();
  await state.networkBridge.start(requested);
  await waitForNetworkAgentConnection({
    connected: true,
    timeoutMs: params.timeoutMs,
    signal: context.signal,
  });
  return getAgentStatusSnapshot().network;
}

async function disconnectNetworkForAgent(context = {}) {
  initializeNetworkBridge();
  if (!state.networkConnected && state.networkState !== "connecting") {
    return getAgentStatusSnapshot().network;
  }
  await state.networkBridge.stop();
  resetAgentTrafficDecoders("network");
  await waitForNetworkAgentConnection({
    connected: false,
    timeoutMs: 10000,
    signal: context.signal,
  });
  return getAgentStatusSnapshot().network;
}

async function sendYmodemForAgent(params = {}, context = {}) {
  if (!state.connected || !state.writer) throw new Error(t("serialAgent.openPortFirst"));
  const data = base64ToBytes(params.dataBase64);
  if (!data.byteLength) throw new Error(t("ymodemAgent.emptyPayload"));
  if (data.byteLength > MAX_SSH_AGENT_TRANSFER_BYTES) {
    throw new Error(t("ymodemAgent.tooLarge"));
  }
  const filename = String(params.filename || "firmware.bin").trim() || "firmware.bin";
  const blockSize = Number(params.blockSize) === 128 ? 128 : 1024;
  setYmodemMode("send", { persist: false });
  state.ymodemBlockSize = blockSize;
  els.ymodemBlockSize.value = String(blockSize);
  const result = await runYmodemTransfer(
    "send",
    (session) => session.send(data, { filename, blockSize }),
    { signal: context.signal, throwOnError: true },
  );
  return {
    direction: "send",
    filename: result.filename,
    size: result.size,
    blocks: result.blocks,
    blockSize: result.blockSize,
  };
}

async function receiveYmodemForAgent(params = {}, context = {}) {
  if (!state.connected || !state.writer) throw new Error(t("serialAgent.openPortFirst"));
  setYmodemMode("receive", { persist: false });
  const result = await runYmodemTransfer(
    "receive",
    (session) => session.receive(),
    { signal: context.signal, throwOnError: true },
  );
  const includeData = params.includeData !== false;
  const maxBytes = Math.max(
    0,
    Math.min(MAX_SSH_AGENT_RESPONSE_BYTES, Number(params.maxBytes) || MAX_SSH_AGENT_RESPONSE_BYTES),
  );
  const canInclude = includeData && result.size <= maxBytes;
  if (includeData && !canInclude) {
    triggerYmodemDownload(result.filename, result.data);
  }
  return {
    direction: "receive",
    filename: result.filename,
    size: result.size,
    blocks: result.blocks,
    dataBase64: canInclude ? bytesToBase64(result.data) : undefined,
    dataOmitted: !canInclude,
    downloadTriggered: includeData && !canInclude,
  };
}

function triggerYmodemDownload(filename, data) {
  const blob = new Blob([data], { type: "application/octet-stream" });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename || "received.bin";
  document.body.append(anchor);
  anchor.click();
  anchor.remove();
  URL.revokeObjectURL(url);
}

async function connectSshPresetForAgent(params = {}) {
  const preset = getSshPresetForAgent(params);
  if (!preset) throw new Error(t("sshAgent.presetNotFound"));
  const password = String(params.password ?? preset.password ?? "");
  if (!password) {
    throw new Error(t("sshAgent.presetNoPassword", { alias: preset.alias }));
  }
  return connectSshForAgent({
    ...preset,
    presetId: preset.id,
    password,
  });
}

async function connectSshForAgent(params = {}) {
  const preset = getSshPresetForAgent(params);
  const host = String(params.host || preset?.host || "").trim();
  const port = normalizePort(params.port || preset?.port, 22);
  const username = String(params.username || preset?.username || "").trim();
  const password = String(params.password ?? preset?.password ?? "");
  if (!host) throw new Error(t("sshAgent.hostRequired"));
  if (!username) throw new Error(t("sshAgent.usernameRequired"));
  if (!password) throw new Error(t("sshAgent.passwordRequired"));

  const requested = { host, port, username };
  const alreadyConnected =
    state.sshConnected &&
    state.sshHost === requested.host &&
    Number(state.sshPort) === requested.port &&
    state.sshUsername === requested.username;
  if (alreadyConnected) {
    return {
      connected: true,
      reused: true,
      ...getAgentStatusSnapshot().ssh,
    };
  }

  if (state.sshConnected || state.sshState === "connecting") {
    await toggleSshConnection();
  }

  setWorkspaceMode("network", { persist: false });
  setNetworkProtocol("ssh", { persist: false });
  state.sshAlias = String(params.alias || preset?.alias || "").trim().slice(0, 80);
  state.sshHost = host;
  state.sshPort = port;
  state.sshUsername = username;
  state.sshActivePresetId =
    preset?.id ||
    state.sshPresets.find(
      (candidate) =>
        candidate.host === host &&
        Number(candidate.port) === port &&
        candidate.username === username,
    )?.id ||
    "";
  state.sshFingerprint = "";
  els.sshAlias.value = state.sshAlias;
  els.sshHost.value = host;
  els.sshPort.value = String(port);
  els.sshUsername.value = username;
  els.sshPassword.value = password;

  await toggleSshConnection();
  await waitForAgentSshConnection();

  persistSettings();
  return {
    connected: true,
    reused: false,
    ...getAgentStatusSnapshot().ssh,
  };
}

async function disconnectSshForAgent() {
  if (!state.sshConnected && state.sshState !== "connecting") {
    return getAgentStatusSnapshot().ssh;
  }
  await toggleSshConnection();
  return getAgentStatusSnapshot().ssh;
}

function startBridgeForAgent(params = {}) {
  if (params.serialToNetwork !== undefined) {
    state.bridgeSerialToNetwork = Boolean(params.serialToNetwork);
  }
  if (params.networkToSerial !== undefined) {
    state.bridgeNetworkToSerial = Boolean(params.networkToSerial);
  }

  if (state.networkProtocol === "ssh") {
    throw new Error(t("bridgeAgent.sshUnsupported"));
  }
  if (!state.connected || !state.writer) throw new Error(t("serialAgent.openPortFirst"));
  if (!state.networkConnected || !state.networkBridge) {
    throw new Error(t("bridgeAgent.networkRequired"));
  }
  if (!state.bridgeSerialToNetwork && !state.bridgeNetworkToSerial) {
    throw new Error(t("bridgeAgent.directionRequired"));
  }

  startBridge();
  if (!state.bridgeActive) throw new Error(t("bridgeAgent.startFailed"));
  return getBridgeAgentStatus();
}

function stopBridgeForAgent() {
  stopBridge({ silent: false });
  return getBridgeAgentStatus();
}

export { connectNetworkForAgent, connectSerialForAgent, connectSshForAgent, connectSshPresetForAgent, disconnectNetworkForAgent, disconnectSerialForAgent, disconnectSshForAgent, initializeAgentDeviceCommands, listSerialPortsForAgent, receiveYmodemForAgent, sendAgentPayload, sendYmodemForAgent, startBridgeForAgent, stopBridgeForAgent, triggerYmodemDownload };
