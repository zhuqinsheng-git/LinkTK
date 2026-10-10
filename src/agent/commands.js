// Module: transport adapters and event operations for AI commands.
// Owns: serial/network/SSH queries, sends, waits, file transfers, and transaction rollback primitives.
// Depends on: core, lib, agent/events.js, agent/runtime.js, agent/operations.js, features.
// Called by: app.js command dispatcher.

import { AGENT_READ_COMMANDS, MAX_SSH_AGENT_RESPONSE_BYTES, MAX_SSH_AGENT_TRANSFER_BYTES, MAX_SSH_LOCAL_TRANSFER_BYTES, MAX_TRANSACTION_BACKUP_BYTES, SSH_AGENT_CHUNK_BYTES } from "../core/constants.js";
import { $, els } from "../core/dom.js";
import { t, tCount } from "../core/i18n.js";
import { state } from "../core/state.js";
import { base64ToBytes, bytesToBase64 } from "../lib/encoding.js";
import { bytesToHex, formatBytes } from "../lib/format.js";
import { joinSshPath, normalizeSshPath, parentSshPath, sshAgentFileName } from "../lib/ssh-path.js";
import { recordSshTraffic } from "../features/log-view.js";
import { sendNetworkData } from "../features/network.js";
import { getSerialPortSummary } from "../features/serial.js";
import { beginSshFileTransfer, finishSshFileTransfer, initializeSshTerminal, loadSshDirectory, updateSshFileProgress } from "../features/ssh.js";
import { showToast } from "../features/toast.js";
import { agentEventsText, agentPatternMatcher, buildAgentPayload, delay, getNetworkAgentEventsSince, getSshEventsSince, serializeAgentEvent, sshEventsText, waitForNetworkAgentEvents, waitForSshEvents } from "./events.js";
import { revokeAgentUploadApproval } from "./operations.js";
import { getAgentStatusSnapshot } from "./runtime.js";

function getSerialPresetForAgent(params = {}) {
  const presetId = String(params.presetId || "").trim();
  const name = String(params.name || params.alias || "").trim();
  if (presetId) {
    return state.serialConnectionPresets.find((preset) => preset.id === presetId) || null;
  }
  if (!name) return null;
  const exact = state.serialConnectionPresets.find((preset) => preset.name === name);
  if (exact) return exact;
  const expected = name.toLowerCase();
  return (
    state.serialConnectionPresets.find(
      (preset) => preset.name.toLowerCase() === expected,
    ) || null
  );
}

function listSerialPresetsForAgent() {
  return {
    presets: state.serialConnectionPresets.map((preset) => ({ ...preset })),
  };
}

function resolveSerialPortForAgent(params = {}, preset = null) {
  if (!state.ports.length) {
    const systemHint = state.systemSerialPorts.length
      ? t("serialAgent.systemPortsDetected", {
          ports: state.systemSerialPorts
            .map((port) => port.name)
            .filter(Boolean)
            .join(t("common.listSeparator")),
        })
      : "";
    throw new Error(t("serialAgent.noAuthorizedPorts", { hint: systemHint }));
  }

  const requestedIndex = Number(params.portIndex);
  if (Number.isInteger(requestedIndex) && requestedIndex >= 0 && requestedIndex < state.ports.length) {
    return requestedIndex;
  }

  const requested = String(
    params.portName || params.portLabel || params.port || preset?.portLabel || "",
  ).trim();
  if (requested) {
    const expected = requested.toLowerCase();
    const index = state.ports.findIndex((port, portIndex) => {
      const summary = getSerialPortSummary(port, portIndex);
      return [
        summary.label,
        summary.title,
        summary.meta,
      ].some((value) => {
        const normalized = String(value || "").toLowerCase();
        return normalized === expected || normalized.includes(expected);
      });
    });
    if (index >= 0) return index;
    throw new Error(t("serialAgent.portNotFound", { name: requested }));
  }

  if (state.ports.length === 1) return 0;
  throw new Error(t("serialAgent.multiplePorts"));
}

function getNetworkPresetForAgent(params = {}) {
  const presetId = String(params.presetId || "").trim();
  const name = String(params.name || params.alias || "").trim();
  if (presetId) {
    return state.networkConnectionPresets.find((preset) => preset.id === presetId) || null;
  }
  if (!name) return null;
  const exact = state.networkConnectionPresets.find((preset) => preset.name === name);
  if (exact) return exact;
  const expected = name.toLowerCase();
  return (
    state.networkConnectionPresets.find(
      (preset) => preset.name.toLowerCase() === expected,
    ) || null
  );
}

function listNetworkPresetsForAgent() {
  return {
    presets: state.networkConnectionPresets.map((preset) => ({ ...preset })),
  };
}

async function waitForNetworkAgentConnection({
  connected = true,
  timeoutMs = 20000,
  signal,
} = {}) {
  const timeout = Math.max(1000, Math.min(60000, Number(timeoutMs) || 20000));
  const startedAt = performance.now();
  while (performance.now() - startedAt < timeout) {
    if (signal?.aborted) {
      throw new DOMException(t("agent.cancelled"), "AbortError");
    }
    if (connected && state.networkConnected) return true;
    if (!connected && !state.networkConnected && state.networkState !== "connecting") {
      return true;
    }
    if (state.networkState === "error" && connected) {
      const detail = $("p", els.networkDetails)?.textContent?.trim();
      throw new Error(detail || t("netAgent.connectFailed"));
    }
    await new Promise((resolve) => window.setTimeout(resolve, 80));
  }
  throw new Error(
    connected ? t("netAgent.connectTimeout") : t("netAgent.disconnectTimeout"),
  );
}

async function sendNetworkAgentPayload(params = {}) {
  const payload = buildAgentPayload(params, "network");
  if (!payload.byteLength) throw new Error(t("agent.sendEmptyPayload"));
  const sent = await sendNetworkData(payload, { actor: "agent" });
  if (!sent) throw new Error(t("netAgent.sendFailed"));
  return {
    bytesSent: payload.byteLength,
    hex: bytesToHex(payload),
    sequence: state.networkAgentEventSequence,
  };
}

async function readNetworkAgentEvents(params = {}, context = {}) {
  const limit = Math.max(1, Math.min(1000, Number(params.limit) || 200));
  const since = Number.isFinite(Number(params.since))
    ? Number(params.since)
    : Math.max(0, state.networkAgentEventSequence - limit);
  const timeoutMs = Math.max(0, Math.min(120000, Number(params.timeoutMs) || 0));
  if (timeoutMs > 0) {
    await waitForNetworkAgentEvents({
      since,
      direction: "all",
      timeoutMs,
      signal: context.signal,
    });
  }
  const events = getNetworkAgentEventsSince(since, { limit, direction: "all" });
  const output = agentEventsText(events);
  return {
    cursor: state.networkAgentEventSequence,
    truncated: output.truncated,
    text: output.text,
    events: events.map(serializeAgentEvent),
  };
}

async function waitForNetworkAgentResponse(params = {}, context = {}) {
  const timeoutMs = Math.max(10, Math.min(120000, Number(params.timeoutMs) || 5000));
  const since = Number.isFinite(Number(params.since))
    ? Number(params.since)
    : state.networkAgentEventSequence;
  const direction = ["rx", "tx", "all"].includes(params.direction)
    ? params.direction
    : "rx";
  const matcher = agentPatternMatcher(params);
  const result = await waitForNetworkAgentEvents({
    since,
    direction,
    timeoutMs,
    predicate: (events) => matcher(agentEventsText(events).text),
    signal: context.signal,
  });
  const output = agentEventsText(result.events);
  return {
    matched: result.matched,
    timedOut: result.timedOut,
    cursor: state.networkAgentEventSequence,
    text: output.text,
    truncated: output.truncated,
    events: result.events.map(serializeAgentEvent),
  };
}

async function execNetworkAgentCommand(params = {}, context = {}) {
  const timeoutMs = Math.max(10, Math.min(120000, Number(params.timeoutMs) || 5000));
  const captureMs = Math.max(0, Math.min(5000, Number(params.captureMs) || 0));
  const baseline = state.networkAgentEventSequence;
  const sent = await sendNetworkAgentPayload(params);
  const pattern = String(params.pattern || "");
  const matcher = agentPatternMatcher(params);
  const result = await waitForNetworkAgentEvents({
    since: baseline,
    direction: "rx",
    timeoutMs,
    predicate: (events) => matcher(agentEventsText(events).text),
    signal: context.signal,
  });
  if (result.matched && captureMs > 0) await delay(captureMs, context.signal);

  const events = getNetworkAgentEventsSince(baseline, { direction: "rx", limit: 1000 });
  const output = agentEventsText(events);
  return {
    sent,
    baseline,
    cursor: state.networkAgentEventSequence,
    matched: result.matched,
    timedOut: result.timedOut,
    pattern,
    text: output.text,
    truncated: output.truncated,
    events: events.map(serializeAgentEvent),
  };
}

function getYmodemAgentStatus() {
  return {
    ...getAgentStatusSnapshot().ymodem,
    connected: state.connected,
    supported: state.supported,
  };
}

function ensureAgentSshConnected() {
  if (!state.sshConnected || !state.sshBridge) {
    throw new Error(t("sshAgent.notConnected"));
  }
}

function writeSshAgentNotice(message) {
  initializeSshTerminal();
  state.sshTerminal?.writeln(`\x1b[36m[AI]\x1b[0m ${String(message || "")}`);
}

function getSshPresetForAgent(params = {}) {
  const id = String(params.presetId || "").trim();
  const alias = String(params.alias || "").trim();
  if (id) return state.sshPresets.find((preset) => preset.id === id) || null;
  if (!alias) return null;
  const exact = state.sshPresets.find((preset) => preset.alias === alias);
  if (exact) return exact;
  const expected = alias.toLowerCase();
  return (
    state.sshPresets.find((preset) => preset.alias.toLowerCase() === expected) || null
  );
}

function listSshPresetsForAgent() {
  return {
    activePresetId: state.sshActivePresetId,
    presets: state.sshPresets.map((preset) => ({
      id: preset.id,
      alias: preset.alias,
      host: preset.host,
      port: preset.port,
      username: preset.username,
      hasSavedPassword: Boolean(preset.password),
      quickPaths: Array.isArray(preset.quickPaths) ? [...preset.quickPaths] : [],
    })),
  };
}

async function waitForAgentSshConnection(timeoutMs = 20000) {
  const timeout = Math.max(1000, Math.min(60000, Number(timeoutMs) || 20000));
  const startedAt = performance.now();
  while (performance.now() - startedAt < timeout) {
    if (state.sshConnected) return true;
    if (state.sshState === "error" || state.sshState === "closed") break;
    await new Promise((resolve) => window.setTimeout(resolve, 100));
  }
  const detail = $("p", els.networkDetails)?.textContent?.trim();
  throw new Error(detail || t("sshAgent.connectTimeout"));
}

async function sendSshAgentPayload(params = {}) {
  ensureAgentSshConnected();
  const payload = buildAgentPayload(params, "ssh");
  if (!payload.byteLength) throw new Error(t("agent.sendEmptyPayload"));
  const text = new TextDecoder("utf-8", { fatal: false }).decode(payload);
  writeSshAgentNotice(text.replace(/\r?\n$/, ""));
  recordSshTraffic("tx", payload, "agent");
  await state.sshBridge.input(text);
  return {
    bytesSent: payload.byteLength,
    hex: bytesToHex(payload),
    sequence: state.sshOutputSequence,
  };
}

async function readSshAgentEvents(params = {}, context = {}) {
  ensureAgentSshConnected();
  const limit = Math.max(1, Math.min(1000, Number(params.limit) || 200));
  const hasSince = Number.isFinite(Number(params.since));
  const since = hasSince
    ? Number(params.since)
    : Math.max(0, state.sshOutputSequence - limit);
  const timeoutMs = Math.max(0, Math.min(120000, Number(params.timeoutMs) || 0));
  if (timeoutMs > 0) {
    await waitForSshEvents({
      since,
      direction: "all",
      timeoutMs,
      signal: context.signal,
    });
  }
  const events = getSshEventsSince(since, { limit, direction: "all" });
  const output = sshEventsText(events);
  return {
    cursor: state.sshOutputSequence,
    truncated: output.truncated,
    text: output.text,
    events: events.map(serializeAgentEvent),
  };
}

async function waitForSshAgentEvents(params = {}, context = {}) {
  ensureAgentSshConnected();
  const timeoutMs = Math.max(10, Math.min(120000, Number(params.timeoutMs) || 5000));
  const since = Number.isFinite(Number(params.since))
    ? Number(params.since)
    : state.sshOutputSequence;
  const direction = ["rx", "tx", "all"].includes(params.direction)
    ? params.direction
    : "rx";
  const matcher = agentPatternMatcher(params);
  const result = await waitForSshEvents({
    since,
    direction,
    timeoutMs,
    predicate: (events) => matcher(sshEventsText(events).text),
    signal: context.signal,
  });
  const output = sshEventsText(result.events);
  return {
    matched: result.matched,
    timedOut: result.timedOut,
    cursor: state.sshOutputSequence,
    text: output.text,
    truncated: output.truncated,
    events: result.events.map(serializeAgentEvent),
  };
}

async function execSshAgentCommand(params = {}, context = {}) {
  ensureAgentSshConnected();
  const timeoutMs = Math.max(10, Math.min(120000, Number(params.timeoutMs) || 5000));
  const captureMs = Math.max(0, Math.min(5000, Number(params.captureMs) || 0));
  const baseline = state.sshOutputSequence;
  const sent = await sendSshAgentPayload(params);
  const pattern = String(params.pattern || "");
  const matcher = agentPatternMatcher(params);
  const result = await waitForSshEvents({
    since: baseline,
    direction: "rx",
    timeoutMs,
    predicate: (events) => matcher(sshEventsText(events).text),
    signal: context.signal,
  });
  if (result.matched && captureMs > 0) await delay(captureMs, context.signal);

  const events = getSshEventsSince(baseline, { direction: "rx", limit: 1000 });
  const output = sshEventsText(events);
  return {
    sent,
    baseline,
    cursor: state.sshOutputSequence,
    matched: result.matched,
    timedOut: result.timedOut,
    pattern,
    text: output.text,
    truncated: output.truncated,
    events: events.map(serializeAgentEvent),
  };
}

function requireSafeSshAgentPath(value, { allowRelative = true } = {}) {
  const path = normalizeSshPath(value);
  if (!path || path === "/" || (!allowRelative && path === ".")) {
    throw new Error(t("sshAgent.pathNotAllowed"));
  }
  return path;
}

async function openSshFilePanelForAgent(path = state.sshFilePath) {
  ensureAgentSshConnected();
  const normalized = normalizeSshPath(path);
  state.sshFilePath = normalized;
  els.sshFilePath.value = normalized;
  state.sshFileSelected = null;
  updateSshFileProgress(null);
  if (!els.sshFileDialog.open) els.sshFileDialog.showModal();
  await loadSshDirectory(normalized);
}

async function listSshDirectoryForAgent(params = {}) {
  ensureAgentSshConnected();
  const path = normalizeSshPath(params.path || state.sshFilePath || ".");
  if (!els.sshFileDialog.open) {
    await openSshFilePanelForAgent(path);
  } else if (path !== state.sshFilePath) {
    await loadSshDirectory(path);
  }
  els.sshFileStatus.textContent = tCount("sshAgent.readItems", state.sshFileEntries.length);
  return {
    path: state.sshFilePath,
    entries: state.sshFileEntries.map((entry) => ({
      name: entry.name,
      path: entry.path,
      size: entry.size,
      mtime: entry.mtime,
      isDirectory: entry.isDirectory,
    })),
  };
}

async function makeSshDirectoryForAgent(params = {}) {
  ensureAgentSshConnected();
  const path = requireSafeSshAgentPath(params.path);
  if (!els.sshFileDialog.open) {
    await openSshFilePanelForAgent(parentSshPath(path));
  }
  await state.sshBridge.makeDirectory(path);
  await loadSshDirectory(parentSshPath(path));
  showToast(t("sshAgent.mkdirDone", { path }), "success");
  return { path };
}

async function renameSshEntryForAgent(params = {}) {
  ensureAgentSshConnected();
  const from = requireSafeSshAgentPath(params.from);
  const to = requireSafeSshAgentPath(params.to);
  if (!els.sshFileDialog.open) {
    await openSshFilePanelForAgent(parentSshPath(from));
  }
  await state.sshBridge.renameEntry(from, to);
  if (els.sshFileDialog.open) await loadSshDirectory(parentSshPath(to));
  showToast(t("sshAgent.renameDone", { from, to }), "success");
  return { from, to };
}

async function deleteSshEntryForAgent(params = {}) {
  ensureAgentSshConnected();
  const path = requireSafeSshAgentPath(params.path);
  if (!els.sshFileDialog.open) {
    await openSshFilePanelForAgent(parentSshPath(path));
  }
  await state.sshBridge.deleteEntry(path, Boolean(params.isDirectory));
  if (els.sshFileDialog.open) await loadSshDirectory(parentSshPath(path));
  showToast(t("sshAgent.deleteDone", { path }), "success");
  return { path };
}

function beginSshAgentUpload(params = {}) {
  ensureAgentSshConnected();
  const path = requireSafeSshAgentPath(params.path);
  const declaredSize = Math.max(0, Number(params.size) || 0);
  if (declaredSize > MAX_SSH_AGENT_TRANSFER_BYTES) {
    throw new Error(t("sshAgent.uploadTooLarge", { size: formatBytes(MAX_SSH_AGENT_TRANSFER_BYTES) }));
  }
  const uploadId =
    crypto.randomUUID?.() || `ai-upload-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  state.sshAgentUploads.set(uploadId, {
    path,
    declaredSize,
    overwrite: params.overwrite === true,
    chunks: [],
    receivedBytes: 0,
    createdAt: Date.now(),
  });
  els.sshFileStatus.textContent = t("sshAgent.uploadPrepare", { path });
  return { uploadId, path, receivedBytes: 0 };
}

function appendSshAgentUpload(params = {}) {
  ensureAgentSshConnected();
  const uploadId = String(params.uploadId || "");
  const session = state.sshAgentUploads.get(uploadId);
  if (!session) throw new Error(t("sshAgent.uploadSessionGone"));
  const chunk = base64ToBytes(params.dataBase64);
  const nextSize = session.receivedBytes + chunk.byteLength;
  if (nextSize > MAX_SSH_AGENT_TRANSFER_BYTES) {
    state.sshAgentUploads.delete(uploadId);
    revokeAgentUploadApproval(uploadId);
    throw new Error(t("sshAgent.uploadTooLarge", { size: formatBytes(MAX_SSH_AGENT_TRANSFER_BYTES) }));
  }
  session.chunks.push(chunk);
  session.receivedBytes = nextSize;
  els.sshFileStatus.textContent = t("sshAgent.uploadBuffer", {
    size: formatBytes(session.receivedBytes),
  });
  return {
    uploadId,
    path: session.path,
    receivedBytes: session.receivedBytes,
  };
}

async function finishSshAgentUpload(params = {}) {
  ensureAgentSshConnected();
  const uploadId = String(params.uploadId || "");
  const session = state.sshAgentUploads.get(uploadId);
  if (!session) throw new Error(t("sshAgent.uploadSessionGone"));
  if (session.declaredSize && session.receivedBytes !== session.declaredSize) {
    state.sshAgentUploads.delete(uploadId);
    revokeAgentUploadApproval(uploadId);
    throw new Error(
      t("sshAgent.uploadIncomplete", {
        expected: session.declaredSize,
        actual: session.receivedBytes,
      }),
    );
  }

  const fileName = sshAgentFileName(session.path);
  const chunks = session.chunks;
  state.sshAgentUploads.delete(uploadId);
  revokeAgentUploadApproval(uploadId);
  const file = new window.File([...chunks], fileName, {
    type: "application/octet-stream",
  });
  if (!els.sshFileDialog.open) {
    await openSshFilePanelForAgent(parentSshPath(session.path));
  }
  const controller = beginSshFileTransfer(t("sshAgent.uploadLabel", { name: file.name }));
  try {
    const result = await state.sshBridge.uploadFile(file, session.path, {
      signal: controller.signal,
      overwrite: session.overwrite === true,
      onProgress: ({ uploaded, total, name }) => {
        updateSshFileProgress({
          label: t("sshAgent.uploadLabel", { name }),
          done: uploaded,
          total,
        });
      },
    });
    await loadSshDirectory(state.sshFilePath);
    showToast(t("sshAgent.uploadDone", { path: session.path }), "success");
    return { ...result, path: session.path };
  } finally {
    finishSshFileTransfer();
  }
}

async function uploadSshFileForAgent(params = {}) {
  const session = beginSshAgentUpload({
    path: params.path,
    size: base64ToBytes(params.dataBase64).byteLength,
    overwrite: params.overwrite,
  });
  appendSshAgentUpload({
    uploadId: session.uploadId,
    dataBase64: params.dataBase64,
  });
  return finishSshAgentUpload({ uploadId: session.uploadId });
}

async function openSshAgentDownload(params = {}) {
  ensureAgentSshConnected();
  const path = requireSafeSshAgentPath(params.path);
  const maxBytes = Math.max(
    1,
    Math.min(
      MAX_SSH_AGENT_TRANSFER_BYTES,
      Number(params.maxBytes) || MAX_SSH_AGENT_TRANSFER_BYTES,
    ),
  );
  if (!els.sshFileDialog.open) {
    await openSshFilePanelForAgent(parentSshPath(path));
  }
  const controller = beginSshFileTransfer(t("sshAgent.readLabel", { path }));
  try {
    const result = await state.sshBridge.downloadFile(path, {
      signal: controller.signal,
      onProgress: ({ received, total, name }) => {
        updateSshFileProgress({
          label: t("sshAgent.readLabel", { path: name }),
          done: received,
          total,
        });
        if (received > maxBytes) controller.abort();
      },
    });
    const bytes = new Uint8Array(await result.blob.arrayBuffer());
    if (bytes.byteLength > maxBytes) {
      throw new Error(t("sshAgent.downloadTooLarge", { size: formatBytes(maxBytes) }));
    }
    const downloadId =
      crypto.randomUUID?.() || `ai-download-${Date.now()}-${Math.random().toString(16).slice(2)}`;
    state.sshAgentReadSessions.set(downloadId, {
      path,
      name: result.name,
      bytes,
      createdAt: Date.now(),
    });
    els.sshFileStatus.textContent = t("sshAgent.cached", {
      name: result.name,
      size: formatBytes(bytes.byteLength),
    });
    return {
      downloadId,
      path,
      name: result.name,
      size: bytes.byteLength,
    };
  } catch (error) {
    if (error?.name === "AbortError") {
      throw new Error(t("sshAgent.downloadTooLarge", { size: formatBytes(maxBytes) }));
    }
    throw error;
  } finally {
    finishSshFileTransfer();
  }
}

function readSshAgentDownload(params = {}) {
  const downloadId = String(params.downloadId || "");
  const session = state.sshAgentReadSessions.get(downloadId);
  if (!session) throw new Error(t("sshAgent.downloadSessionGone"));
  const offset = Math.max(0, Math.min(session.bytes.byteLength, Number(params.offset) || 0));
  const length = Math.max(
    1,
    Math.min(
      MAX_SSH_AGENT_RESPONSE_BYTES,
      Number(params.length) || SSH_AGENT_CHUNK_BYTES,
    ),
  );
  const chunk = session.bytes.subarray(offset, Math.min(session.bytes.byteLength, offset + length));
  const nextOffset = offset + chunk.byteLength;
  return {
    downloadId,
    path: session.path,
    name: session.name,
    size: session.bytes.byteLength,
    offset,
    nextOffset,
    eof: nextOffset >= session.bytes.byteLength,
    dataBase64: bytesToBase64(chunk),
  };
}

function closeSshAgentDownload(params = {}) {
  const downloadId = String(params.downloadId || "");
  state.sshAgentReadSessions.delete(downloadId);
  return { downloadId, closed: true };
}

async function downloadSshFileToLocalForAgent(params = {}, context = {}) {
  ensureAgentSshConnected();
  const path = requireSafeSshAgentPath(params.path);
  const localPath = String(params.localPath || "").trim();
  if (!localPath) throw new Error(t("sshAgent.localTargetMissing"));
  const maxBytes = Math.max(
    1,
    Math.min(
      MAX_SSH_LOCAL_TRANSFER_BYTES,
      Number(params.maxBytes) || MAX_SSH_LOCAL_TRANSFER_BYTES,
    ),
  );
  if (!els.sshFileDialog.open) {
    await openSshFilePanelForAgent(parentSshPath(path));
  }
  const controller = beginSshFileTransfer(t("sshAgent.downloadLabel", { path }));
  const abortFromContext = () => controller.abort();
  if (context.signal?.aborted) {
    abortFromContext();
  } else {
    context.signal?.addEventListener("abort", abortFromContext, { once: true });
  }
  try {
    if (controller.signal.aborted) {
      throw new DOMException(t("agent.cancelled"), "AbortError");
    }
    const result = await state.sshBridge.downloadToLocal({
      remotePath: path,
      localPath,
      overwrite: Boolean(params.overwrite),
      maxBytes,
      signal: controller.signal,
      onProgress: ({ done, total }) => {
        updateSshFileProgress({
          label: t("sshAgent.downloadLabel", { path }),
          done,
          total,
        });
      },
    });
    if (els.sshFileDialog.open) await loadSshDirectory(state.sshFilePath);
    const bytes = Number(result?.bytes) || 0;
    showToast(t("sshAgent.downloadDone", { size: formatBytes(bytes) }), "success");
    return {
      path,
      localPath: String(result?.localPath || localPath),
      name: String(result?.name || sshAgentFileName(path)),
      bytes,
    };
  } finally {
    context.signal?.removeEventListener("abort", abortFromContext);
    finishSshFileTransfer();
  }
}

async function uploadSshFileFromLocalForAgent(params = {}, context = {}) {
  ensureAgentSshConnected();
  const path = requireSafeSshAgentPath(params.path);
  const localPath = String(params.localPath || "").trim();
  if (!localPath) throw new Error(t("sshAgent.localSourceMissing"));
  if (!els.sshFileDialog.open) {
    await openSshFilePanelForAgent(parentSshPath(path));
  }
  const controller = beginSshFileTransfer(t("sshAgent.uploadLabel", { name: localPath }));
  const abortFromContext = () => controller.abort();
  if (context.signal?.aborted) {
    abortFromContext();
  } else {
    context.signal?.addEventListener("abort", abortFromContext, { once: true });
  }
  try {
    if (controller.signal.aborted) {
      throw new DOMException(t("agent.cancelled"), "AbortError");
    }
    const result = await state.sshBridge.uploadFromLocal({
      localPath,
      remotePath: path,
      size: Number(params.size) || 0,
      overwrite: params.overwrite === true,
      signal: controller.signal,
      onProgress: ({ done, total }) => {
        updateSshFileProgress({
          label: t("sshAgent.uploadLabel", { name: path }),
          done,
          total,
        });
      },
    });
    if (els.sshFileDialog.open) await loadSshDirectory(state.sshFilePath);
    const bytes = Number(result?.bytes) || Number(params.size) || 0;
    showToast(
      t("sshAgent.uploadDoneWithSize", { path, size: formatBytes(bytes) }),
      "success",
    );
    return {
      path,
      localPath,
      name: String(result?.name || sshAgentFileName(path)),
      bytes,
    };
  } finally {
    context.signal?.removeEventListener("abort", abortFromContext);
    finishSshFileTransfer();
  }
}

async function downloadSshFileForAgent(params = {}) {
  const opened = await openSshAgentDownload(params);
  const result = readSshAgentDownload({
    downloadId: opened.downloadId,
    offset: 0,
    length: Math.min(
      MAX_SSH_AGENT_RESPONSE_BYTES,
      Number(params.maxBytes) || MAX_SSH_AGENT_RESPONSE_BYTES,
    ),
  });
  closeSshAgentDownload({ downloadId: opened.downloadId });
  return {
    ...result,
    truncated: !result.eof,
    totalSize: opened.size,
  };
}

async function findSshEntryForAgent(path) {
  ensureAgentSshConnected();
  const normalized = normalizeSshPath(path);
  const parent = parentSshPath(normalized);
  const result = await state.sshBridge.listDirectory(parent);
  const name = normalized.split("/").filter(Boolean).at(-1) || "";
  const entry = (result.entries || []).find((item) => item.name === name) || null;
  return entry ? { ...entry, path: normalized, parent } : null;
}

async function prepareTransactionUndo(step, context = {}) {
  const params = step.params || {};
  if (AGENT_READ_COMMANDS.has(step.command)) {
    return { kind: "not-required", reason: t("agent.undo.readOnlyNoRollback") };
  }

  if (step.command === "sftp_upload") {
    const path = requireSafeSshAgentPath(params.path);
    const entry = await findSshEntryForAgent(path);
    if (!entry) return { kind: "delete-file", path };
    if (entry.isDirectory) {
      return { kind: "unsupported", reason: t("agent.undo.targetIsDirectory") };
    }
    if (entry.size > MAX_TRANSACTION_BACKUP_BYTES) {
      return {
        kind: "unsupported",
        reason: t("agent.undo.backupTooLarge", { size: formatBytes(entry.size) }),
      };
    }
    const result = await state.sshBridge.downloadFile(path, { signal: context.signal });
    return {
      kind: "restore-file",
      path,
      name: result.name,
      bytes: new Uint8Array(await result.blob.arrayBuffer()),
    };
  }

  if (step.command === "sftp_delete") {
    const path = requireSafeSshAgentPath(params.path);
    const entry = await findSshEntryForAgent(path);
    if (!entry) return { kind: "unsupported", reason: t("agent.undo.targetGone") };
    if (entry.isDirectory) {
      const listing = await state.sshBridge.listDirectory(path);
      if ((listing.entries || []).length) {
        return { kind: "unsupported", reason: t("agent.undo.nonEmptyDirectory") };
      }
      return { kind: "mkdir", path };
    }
    if (entry.size > MAX_TRANSACTION_BACKUP_BYTES) {
      return {
        kind: "unsupported",
        reason: t("agent.undo.backupTooLarge", { size: formatBytes(entry.size) }),
      };
    }
    const result = await state.sshBridge.downloadFile(path, { signal: context.signal });
    return {
      kind: "restore-file",
      path,
      name: result.name,
      bytes: new Uint8Array(await result.blob.arrayBuffer()),
    };
  }

  if (step.command === "sftp_rename") {
    return {
      kind: "rename",
      from: requireSafeSshAgentPath(params.to),
      to: requireSafeSshAgentPath(params.from),
    };
  }

  if (step.command === "sftp_mkdir") {
    return { kind: "delete-directory", path: requireSafeSshAgentPath(params.path) };
  }

  return {
    kind: "unsupported",
    reason: t("agent.undo.noGenericAction", { command: step.command }),
  };
}

async function applyTransactionUndo(undo, context = {}) {
  ensureAgentSshConnected();
  if (undo.kind === "restore-file") {
    const file = new window.File([undo.bytes], undo.name || sshAgentFileName(undo.path), {
      type: "application/octet-stream",
    });
    await state.sshBridge.uploadFile(file, undo.path, {
      signal: context.signal,
      overwrite: true,
    });
    return { restored: true, path: undo.path };
  }
  if (undo.kind === "delete-file") {
    await state.sshBridge.deleteEntry(undo.path, false);
    return { deleted: true, path: undo.path };
  }
  if (undo.kind === "rename") {
    await state.sshBridge.renameEntry(undo.from, undo.to);
    return { renamed: true, from: undo.from, to: undo.to };
  }
  if (undo.kind === "mkdir") {
    await state.sshBridge.makeDirectory(undo.path);
    return { created: true, path: undo.path };
  }
  if (undo.kind === "delete-directory") {
    await state.sshBridge.deleteEntry(undo.path, true);
    return { deleted: true, path: undo.path };
  }
  throw new Error(t("agent.undo.unsupportedKind", { kind: undo.kind }));
}

function getBridgeAgentStatus() {
  return {
    ...getAgentStatusSnapshot().bridge,
    serialReady: state.connected && Boolean(state.writer),
    networkReady: state.networkConnected && Boolean(state.networkBridge),
    sshMode: state.networkProtocol === "ssh",
  };
}

export { appendSshAgentUpload, applyTransactionUndo, beginSshAgentUpload, closeSshAgentDownload, deleteSshEntryForAgent, downloadSshFileForAgent, downloadSshFileToLocalForAgent, ensureAgentSshConnected, execNetworkAgentCommand, execSshAgentCommand, findSshEntryForAgent, finishSshAgentUpload, getBridgeAgentStatus, getNetworkPresetForAgent, getSerialPresetForAgent, getSshPresetForAgent, getYmodemAgentStatus, listNetworkPresetsForAgent, listSerialPresetsForAgent, listSshDirectoryForAgent, listSshPresetsForAgent, makeSshDirectoryForAgent, openSshAgentDownload, openSshFilePanelForAgent, prepareTransactionUndo, readNetworkAgentEvents, readSshAgentDownload, readSshAgentEvents, renameSshEntryForAgent, requireSafeSshAgentPath, resolveSerialPortForAgent, sendNetworkAgentPayload, sendSshAgentPayload, uploadSshFileForAgent, uploadSshFileFromLocalForAgent, waitForAgentSshConnection, waitForNetworkAgentConnection, waitForNetworkAgentResponse, waitForSshAgentEvents, writeSshAgentNotice };
