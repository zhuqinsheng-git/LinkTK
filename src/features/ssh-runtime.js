// Module: SSH bridge client, connection lifecycle, and workspace state.
// Owns: SSH client events, the connect dialog, the status summary, and connection toggling.
// Depends on: core, ssh, log-view, network-runtime, agent operations, toast.
// Called by: app.js wiring and the network workspace events.

import { SshBridgeClient } from "../ssh.js";
import { $, els } from "../core/dom.js";
import { errorMessage } from "../core/errors.js";
import { t } from "../core/i18n.js";
import { persistSettings } from "../core/settings.js";
import { state } from "../core/state.js";
import { clearAgentUploadApprovals } from "./../agent/operations.js";
import { resetAgentTrafficDecoders, recordSshTraffic } from "./log-view.js";
import { updateNetworkUI } from "./network-runtime.js";
import { normalizePort } from "./network.js";
import { fitSshTerminal, initializeSshTerminal, readSshConfig, renderSshPresets, updateSshFileControls, updateSshPresetControls } from "./ssh.js";
import { showToast } from "./toast.js"

function initializeSshBridge() {
  if (state.sshBridge) return;

  state.sshBridge = new SshBridgeClient({
    onReady: () => {
      state.sshBridgeReady = true;
      if (state.sshState === "idle") {
        setSshStatus("idle", t("ssh.status.bridgeReady"));
      }
      updateNetworkUI();
    },
    onStatus: handleSshStatus,
    onData: (bytes) => {
      if (!bytes.byteLength) return;
      recordSshTraffic("rx", bytes, "ssh");
      initializeSshTerminal();
      state.sshTerminal?.write(bytes);
    },
    onExit: (message) => {
      const detail = Number.isInteger(message.code)
        ? t("ssh.terminalExitCode", { code: message.code })
        : "";
      clearAgentUploadApprovals();
      state.sshTerminal?.write(
        `\r\n\x1b[90m${t("ssh.terminalSessionEnded", { detail })}\x1b[0m\r\n`,
      );
      setSshStatus("closed", t("ssh.status.sessionEnded"));
      updateNetworkUI();
    },
    onError: (message) => {
      setSshStatus("error", message);
      updateNetworkUI();
      showToast(message, "error");
    },
    onClose: () => {
      state.sshBridgeReady = false;
      state.sshConnected = false;
      clearAgentUploadApprovals();
      resetAgentTrafficDecoders("ssh");
      if (state.sshState !== "error") {
        setSshStatus("idle", t("ssh.status.bridgeClosed"));
      }
      updateNetworkUI();
    },
  });
}

function updateSshConnectionSummary() {
  if (!els.sshConnectionSummary) return;
  const endpoint = `${state.sshUsername || "root"}@${state.sshHost || "192.168.1.2"}:${state.sshPort || 22}`;
  els.sshSummaryAlias.textContent = state.sshAlias || t("ssh.summary.none");
  els.sshSummaryEndpoint.textContent = endpoint;
  if (state.sshState === "connected") {
    els.sshSummaryStatus.textContent = state.sshFingerprint
      ? t("ssh.summary.connectedFingerprint", {
          fingerprint: state.sshFingerprint.slice(0, 12),
        })
      : t("common.connected");
  } else if (state.sshState === "connecting") {
    els.sshSummaryStatus.textContent = t("ssh.summary.connecting");
  } else if (state.sshState === "error") {
    els.sshSummaryStatus.textContent = t("ssh.summary.connectFailed");
  } else if (state.sshState === "closed") {
    els.sshSummaryStatus.textContent = t("ssh.summary.sessionEnded");
  } else {
    els.sshSummaryStatus.textContent = t("ssh.summary.setupHint");
  }
}

function setSshStatus(stateName, message, { fingerprint = "" } = {}) {
  const nextState = ["idle", "connecting", "connected", "error", "closed"].includes(stateName)
    ? stateName
    : "idle";
  if (nextState !== "connected") resetAgentTrafficDecoders("ssh");
  state.sshState = nextState;
  state.sshConnected = nextState === "connected";
  if (nextState === "connected" && !state.sshConnectedAt) {
    state.sshConnectedAt = Date.now();
  }
  if (nextState !== "connected" && nextState !== "connecting") {
    state.sshConnectedAt = 0;
  }
  if (fingerprint) state.sshFingerprint = String(fingerprint);
  if (nextState === "error") {
    state.sshConnectDialogPending = false;
  } else if (nextState === "connected" && state.sshConnectDialogPending) {
    state.sshConnectDialogPending = false;
    if (els.sshConnectDialog.open) els.sshConnectDialog.close();
  }

  els.networkStateBadge.dataset.state = nextState;
  els.networkStateBadge.textContent =
    nextState === "connected"
      ? t("common.connected")
      : nextState === "connecting"
        ? t("common.connecting")
        : nextState === "error"
          ? t("common.error")
          : t("common.disconnected");

  const ready = nextState === "connected";
  els.networkDetails.classList.toggle("is-ready", ready);
  const line = $(".port-details__line", els.networkDetails);
  const detail = $("p", els.networkDetails);
  line?.classList.toggle("is-ready", ready);
  if (detail) detail.textContent = message;

  els.sshStreamState.textContent =
    nextState === "connected"
      ? t("common.online")
      : nextState === "connecting"
        ? t("common.connecting")
        : nextState === "error"
          ? t("common.error")
          : t("ssh.stream.idle");
  els.sshStreamState.classList.toggle("mini-badge--idle", nextState !== "connected");
  els.sshTitleDot.classList.toggle("is-live", ready);

  const endpoint =
    state.sshHost && state.sshUsername
      ? `${state.sshUsername}@${state.sshHost}:${state.sshPort}`
      : t("ssh.footer.notConnected");
  els.sshEndpointLabel.textContent = endpoint;
  els.sshFingerprintLabel.textContent = state.sshFingerprint
    ? t("ssh.footer.fingerprint", { fingerprint: state.sshFingerprint })
    : t("ssh.footer.fingerprintNone");
  updateSshConnectionSummary();
  els.sshFileButton.disabled = !ready || state.sshFileBusy;
  updateSshPresetControls();
  if (!ready) {
    if (state.sshFileAbortController) {
      state.sshFileAbortController.abort();
    }
    if (els.sshFileDialog.open) {
      els.sshFileDialog.close();
    }
  } else {
    updateSshFileControls();
  }
}

function handleSshStatus(message) {
  if (message.host) state.sshHost = String(message.host);
  if (message.port) state.sshPort = normalizePort(message.port, state.sshPort);
  const nextState = message.state === "connected" ? "connected" : message.state;
  setSshStatus(nextState, message.message || t("ssh.status.updated"), {
    fingerprint: message.fingerprint || "",
  });
  updateNetworkUI();
  if (nextState === "connected") {
    initializeSshTerminal();
    fitSshTerminal({ focus: true });
  }
}

function openSshConnectDialog() {
  if (state.networkProtocol !== "ssh" || state.sshConnected) return;
  state.sshConnectDialogPending = false;
  els.sshAlias.value = state.sshAlias;
  els.sshHost.value = state.sshHost;
  els.sshPort.value = String(state.sshPort);
  els.sshUsername.value = state.sshUsername;
  els.sshSavePasswordToggle.checked = state.sshSavePassword;
  renderSshPresets();
  updateNetworkUI();
  if (!els.sshConnectDialog.open) els.sshConnectDialog.showModal();
  window.setTimeout(() => els.sshHost.focus(), 0);
}

function closeSshConnectDialog() {
  state.sshConnectDialogPending = false;
  if (els.sshConnectDialog.open) els.sshConnectDialog.close();
  updateNetworkUI();
}

async function connectSshFromDialog() {
  if (state.sshConnected || state.sshState === "connecting") return;
  state.sshConnectDialogPending = true;
  updateNetworkUI();
  await toggleSshConnection();
  if (state.sshState !== "connected" && state.sshState !== "connecting") {
    state.sshConnectDialogPending = false;
  }
  updateNetworkUI();
}

async function toggleSshConnection() {
  initializeSshBridge();
  initializeSshTerminal();

  try {
    if (state.sshConnected) {
      setSshStatus("connecting", t("ssh.disconnecting"));
      updateNetworkUI();
      await state.sshBridge.disconnect();
      clearAgentUploadApprovals();
      setSshStatus("idle", t("ssh.status.stopped"));
      updateNetworkUI();
      return;
    }

    clearAgentUploadApprovals();
    const config = readSshConfig();
    state.sshHost = config.host;
    state.sshPort = config.port;
    state.sshUsername = config.username;
    state.sshActivePresetId =
      state.sshPresets.find(
        (preset) =>
          preset.host === config.host &&
          Number(preset.port) === config.port &&
          preset.username === config.username,
      )?.id || "";
    state.sshFingerprint = "";
    els.sshHost.value = state.sshHost;
    els.sshPort.value = String(state.sshPort);
    els.sshUsername.value = state.sshUsername;

    const connectLabel = t("ssh.connectingTo", {
      username: config.username,
      host: config.host,
      port: config.port,
    });
    state.sshTerminal?.reset();
    state.sshTerminal?.writeln(`\x1b[90m${connectLabel}\x1b[0m`);
    setSshStatus("connecting", connectLabel);
    updateNetworkUI();
    persistSettings();

    await state.sshBridge.connect();
    try {
      state.sshTerminalFitAddon.fit();
    } catch {
      // The terminal can use its current dimensions while the panel settles.
    }
    const cols = state.sshTerminal?.cols || 80;
    const rows = state.sshTerminal?.rows || 24;
    await state.sshBridge.connectSession({ ...config, cols, rows });
  } catch (error) {
    const message = errorMessage(error, t("ssh.error.connectFailed"));
    setSshStatus("error", message);
    updateNetworkUI();
    showToast(message, "error");
  }
}

export { closeSshConnectDialog, connectSshFromDialog, handleSshStatus, initializeSshBridge, openSshConnectDialog, setSshStatus, toggleSshConnection, updateSshConnectionSummary };
