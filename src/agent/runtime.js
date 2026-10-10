// Module: AI session snapshots, state serialization, and activity panel rendering.
// Owns: session/device profile state, status snapshots, operation serialization, and AI UI refresh.
// Depends on: core, features/serial.js, lucide.
// Called by: agent/operations.js and app.js.

import { BookmarkPlus, File, Play, Trash2, createIcons } from "lucide";
import { els } from "../core/dom.js";
import { formatDateTime, t, tCount } from "../core/i18n.js";
import { state } from "../core/state.js";
import { getPortName } from "../features/serial.js";

function getAgentPortName(port) {
  if (!port) return "";
  const index = state.ports.indexOf(port);
  return getPortName(port, index >= 0 ? index : 0).title;
}

function getActiveDeviceProfile() {
  return (
    state.deviceProfiles.find((profile) => profile.id === state.activeDeviceProfileId) ||
    null
  );
}

function resolveAgentEnding(params = {}, transport = "serial", fallback = "lf") {
  if (["none", "lf", "cr", "crlf"].includes(params.ending)) return params.ending;
  const profile = getActiveDeviceProfile();
  if (
    profile &&
    ["any", transport].includes(profile.transport) &&
    ["none", "lf", "cr", "crlf"].includes(profile.lineEnding)
  ) {
    return profile.lineEnding;
  }
  return fallback;
}

function getDeviceProfileSummary(profile = getActiveDeviceProfile()) {
  if (!profile) return t("agent.profile.genericSummary");
  return [
    profile.board || profile.name,
    `${profile.transport.toUpperCase()} · ${profile.shellType.toUpperCase()}`,
    profile.promptPattern ? `prompt ${profile.promptPattern}` : "",
    profile.dangerousPatterns.length
      ? tCount("agent.profile.dangerousPatterns", profile.dangerousPatterns.length)
      : "",
  ]
    .filter(Boolean)
    .join(" · ");
}

function getAgentSessionTarget() {
  if (state.workspaceMode === "network") {
    if (state.networkProtocol === "ssh") {
      const endpoint = `${state.sshUsername || "root"}@${state.sshHost || t("agent.target.unconfigured")}:${state.sshPort || 22}`;
      return state.sshConnected
        ? `SSH · ${state.sshAlias || endpoint}`
        : t("agent.target.sshOffline", { endpoint });
    }
    const protocol = String(state.networkProtocol || "tcp").toUpperCase();
    const role = t(state.networkRole === "client" ? "agent.role.client" : "agent.role.server");
    return t("agent.target.network", {
      protocol,
      role,
      host: state.networkHost || "0.0.0.0",
      port: state.networkPort || 0,
      state: state.networkConnected ? t("common.connected") : t("common.disconnected"),
    });
  }

  const activePort = state.activePort || state.selectedPort;
  const port = getAgentPortName(activePort);
  return port
    ? t("agent.target.serial", {
        port,
        baud: Number.parseInt(els.baudRate.value, 10) || 115200,
      })
    : t("agent.target.serialDisconnected");
}

function getAgentSessionLabel() {
  if (state.agentSessionLabel) return state.agentSessionLabel;
  if (state.workspaceMode === "serial") {
    const activePort = state.activePort || state.selectedPort;
    const portName = getAgentPortName(activePort);
    const com = portName.match(/COM\d+/i)?.[0] || "";
    const chip =
      portName.match(/CH\d{3,4}|CP210\d?|FT232|FTDI|USB[-\s]?SERIAL/i)?.[0] ||
      t("agent.session.serialChip");
    return [chip.replace(/usb[-\s]?serial/i, "USB Serial"), com].filter(Boolean).join(" · ");
  }
  if (state.networkProtocol === "ssh") {
    return state.sshAlias || state.sshHost || t("agent.session.sshConsole");
  }
  return `${String(state.networkProtocol || "network").toUpperCase()} · ${t(
    state.networkRole === "client" ? "agent.role.client" : "agent.role.server",
  )}`;
}

function getActiveAgentOperation() {
  return state.agentActiveOperationId
    ? state.agentOperations.get(state.agentActiveOperationId) || null
    : null;
}

function getAgentControlSnapshot() {
  const activeOperation = getActiveAgentOperation();
  return {
    controllerConnected: state.agentControllerConnected,
    commandActive: state.agentCommandActive,
    paused: state.agentPaused,
    approvalMode: state.agentApprovalMode,
    activeOperationId: state.agentActiveOperationId,
    activeOperation: activeOperation ? serializeAgentOperation(activeOperation) : null,
    pendingApproval: state.agentPendingApproval
      ? {
          operationId: state.agentPendingApproval.operationId,
          command: state.agentPendingApproval.command,
          target: getAgentSessionTarget(),
          deadline: state.agentPendingApproval.deadline,
        }
      : null,
    lease: state.agentLease ? { ...state.agentLease } : null,
    lastController: state.agentLastController
      ? { ...state.agentLastController }
      : null,
    eventBuffer: state.agentEvents.length,
    eventBytes: state.agentEventBytes,
  };
}

function getAgentStatusSnapshot() {
  const activePort = state.activePort || state.selectedPort;
  const activeDeviceProfile = getActiveDeviceProfile();
  const session = {
    id: state.agentSessionId,
    label: getAgentSessionLabel(),
    target: getAgentSessionTarget(),
    lease: state.agentLease ? { ...state.agentLease } : null,
  };
  const serial = {
    connected: state.connected,
    connecting: state.connecting,
    port: getAgentPortName(activePort),
    baudRate: Number.parseInt(els.baudRate.value, 10) || null,
    dataBits: Number.parseInt(els.dataBits.value, 10) || null,
    stopBits: Number.parseInt(els.stopBits.value, 10) || null,
    parity: els.parity.value,
    flowControl: els.flowControl.value,
    dtr: els.dtrToggle.checked,
    rts: els.rtsToggle.checked,
    rxBytes: state.rxBytes,
    txBytes: state.txBytes,
    cursor: state.agentEventSequence,
    eventBuffer: state.agentEvents.length,
    eventBytes: state.agentEventBytes,
  };
  const network = {
    protocol: state.networkProtocol,
    role: state.networkRole,
    connected: state.networkConnected,
    state: state.networkState,
    host: state.networkHost,
    port: state.networkPort,
    peerCount: state.networkConnections,
    rxBytes: state.networkRxBytes,
    txBytes: state.networkTxBytes,
    paused: state.networkPaused,
    cursor: state.networkAgentEventSequence,
    eventBuffer: state.networkAgentEvents.length,
    eventBytes: state.networkAgentEventBytes,
  };
  const ssh = {
    state: state.sshState,
    connected: state.sshConnected,
    host: state.sshHost,
    port: state.sshPort,
    username: state.sshUsername,
    alias: state.sshAlias,
    fingerprint: state.sshFingerprint,
    cursor: state.sshOutputSequence,
    eventBuffer: state.sshOutputEvents.length,
  };
  return {
    app: "LinkTK",
    snapshotVersion: 1,
    session,
    serial,
    network,
    ssh,
    deviceProfile: activeDeviceProfile
      ? {
          ...activeDeviceProfile,
          commonCommands: [...activeDeviceProfile.commonCommands],
          dangerousPatterns: [...activeDeviceProfile.dangerousPatterns],
        }
      : null,
    taskTemplates: {
      total: state.taskTemplates.length,
      recent: state.taskTemplates.slice(-10).map((template) => ({
        taskId: template.id,
        name: template.name,
        transport: template.transport,
        profileId: template.profileId,
        steps: template.steps.length,
      })),
    },
    sftp: {
      panelOpen: state.sshFileDialogOpen,
      path: state.sshFilePath,
      entries: state.sshFileEntries.length,
      selected: state.sshFileSelected,
      busy: state.sshFileBusy,
    },
    ymodem: {
      busy: state.ymodemBusy,
      active: Boolean(state.ymodemSession?.active),
      mode: state.ymodemMode,
      blockSize: state.ymodemBlockSize,
      fileName: state.ymodemFile?.name || "",
      fileSize: state.ymodemFile?.size || 0,
      lastResult: state.ymodemLastResult,
      lastError: state.ymodemLastError,
    },
    ui: {
      workspaceMode: state.workspaceMode,
      consoleView: state.consoleView,
      receiveMode: state.receiveMode,
      sendMode: state.sendMode,
      showRx: state.showRx,
      showTx: state.showTx,
      showSys: state.showSys,
      timestamp: state.timestamp,
      timestampMode: state.timestampMode,
      autoScroll: state.autoScroll,
      followSuspended: state.followSuspended,
      ansiColors: state.ansiColors,
      dualMode: state.dualMode,
      keywordQuery: state.keywordQuery,
      keywordFilter: state.keywordFilter,
      keywordCaseSensitive: state.keywordCaseSensitive,
      keywordWholeWord: state.keywordWholeWord,
      paused: state.paused,
      sendPanelCollapsed: state.sendPanelCollapsed,
      quickSendCollapsed: state.quickSendCollapsed,
      networkSendPanelCollapsed: state.networkSendPanelCollapsed,
      networkQuickSendCollapsed: state.networkQuickSendCollapsed,
    },
    bridge: {
      active: state.bridgeActive,
      serialToNetwork: state.bridgeSerialToNetwork,
      networkToSerial: state.bridgeNetworkToSerial,
      serialToNetworkBytes: state.bridgeSerialToNetworkBytes,
      networkToSerialBytes: state.bridgeNetworkToSerialBytes,
    },
    autoSave: {
      enabled: state.autoSaveEnabled,
      rotationMode: state.autoSaveRotationMode,
      limit: state.autoSaveLimit,
      directoryName: state.autoSaveDirectoryName,
    },
    agent: getAgentControlSnapshot(),
    operations: {
      total: state.agentOperations.size,
      recent: state.agentActivity
        .slice(-10)
        .map((operation) => serializeAgentOperation(operation, { compact: true })),
    },
    transactions: {
      total: state.agentTransactions.size,
      recent: [...state.agentTransactions.values()]
        .slice(-10)
        .map((transaction) => ({
          transactionId: transaction.id,
          name: transaction.name,
          status: transaction.status,
          steps: transaction.steps.length,
          rollbackStatus: transaction.rollbackStatus,
          startedAt: transaction.startedAt,
          finishedAt: transaction.finishedAt,
        })),
    },
    connected: state.connected,
    connecting: state.connecting,
    supported: state.supported,
    port: serial.port,
    baudRate: serial.baudRate,
    dataBits: serial.dataBits,
    stopBits: serial.stopBits,
    parity: serial.parity,
    consoleView: state.consoleView,
    receiveMode: state.receiveMode,
    sendMode: state.sendMode,
    rxBytes: state.rxBytes,
    txBytes: state.txBytes,
    cursor: state.agentEventSequence,
    workspaceMode: state.workspaceMode,
    networkProtocol: state.networkProtocol,
    ssh,
  };
}

function getAgentCapabilities() {
  return {
    serial: Boolean(state.supported),
    terminal: Boolean(state.terminal),
    network: true,
    ssh: true,
    sessions: true,
    snapshot: true,
    operations: true,
    approval: true,
    humanControl: true,
    deviceProfiles: true,
    transactions: true,
    taskTemplates: true,
    evidence: true,
    coordination: true,
  };
}

function publishAgentState({ renderActivity = true } = {}) {
  void state.agentBridge?.updateState(getAgentStatusSnapshot(), getAgentCapabilities());
  if (renderActivity) renderAgentActivity();
}

function updateAgentUI() {
  if (!els.agentState || !els.agentStateText) return;
  const connected = Boolean(state.agentBridge?.connected);
  const ready = connected && state.agentBridgeReady;
  let stateName = "idle";
  let label = t("agent.state.offline");
  let title = label;

  if (ready && state.agentPendingApproval) {
    stateName = "connecting";
    label = t("agent.state.waitingApproval");
    title = t("agent.state.titleApproval");
  } else if (ready && state.agentPaused) {
    stateName = "error";
    label = t("agent.state.paused");
    title = t("agent.state.titlePaused");
  } else if (ready && state.agentCommandActive) {
    stateName = "connecting";
    label = t("agent.state.running");
    title = t("agent.state.titleRunning");
  } else if (ready && state.agentControllerConnected) {
    stateName = "connected";
    label = t("agent.state.online");
    title = t("agent.state.titleOnline");
  } else if (ready) {
    stateName = "ready";
    label = t("agent.state.ready");
    title = t("agent.state.titleReady");
  } else if (connected) {
    stateName = "connecting";
    label = t("agent.state.pairing");
    title = t("agent.state.titlePairing");
  } else if (state.agentBridgeError) {
    stateName = "error";
    title = state.agentBridgeError;
  }

  els.agentState.dataset.state = stateName;
  els.agentStateText.textContent = label;
  els.agentState.title = state.agentBridgeError || title;
  els.agentState.setAttribute(
    "aria-label",
    t("agent.state.aria", { status: state.agentBridgeError || title }),
  );
  if (els.agentActivityButton) {
    els.agentActivityButton.dataset.state = stateName;
  }
}

const AGENT_OPERATION_STATUS_IDS = new Set([
  "queued",
  "waiting_approval",
  "running",
  "cancelling",
  "succeeded",
  "failed",
  "blocked",
  "cancelled",
  "withdrawn",
  "completed_with_errors",
]);

function formatAgentOperationStatus(status) {
  return AGENT_OPERATION_STATUS_IDS.has(status)
    ? t(`agent.status.${status}`)
    : status || t("agent.status.unknown");
}

function formatAgentDuration(milliseconds) {
  const value = Math.max(0, Number(milliseconds) || 0);
  if (value < 1000) return `${value} ms`;
  if (value < 60000) return `${(value / 1000).toFixed(1)} s`;
  return `${Math.floor(value / 60000)} min ${Math.round((value % 60000) / 1000)} s`;
}

function formatAgentRisk(risk) {
  return ["read", "write", "dangerous"].includes(risk)
    ? t(`agent.risk.${risk}`)
    : t("agent.risk.unrated");
}

function formatAgentLeaseRemaining(lease) {
  if (!lease?.expiresAt) return "";
  const remaining = Math.max(0, Number(lease.expiresAt) - Date.now());
  if (remaining <= 0) return t("agent.lease.expired");
  if (remaining < 60000) {
    return t("agent.lease.seconds", { count: Math.ceil(remaining / 1000) });
  }
  return t("agent.lease.minutes", { count: Math.ceil(remaining / 60000) });
}

function updateAgentLeaseSummary() {
  if (els.agentLeaseState) {
    els.agentLeaseState.textContent = state.agentLease
      ? state.agentLease.controllerLabel ||
        state.agentLease.controllerId ||
        t("agent.lease.controllerDefault")
      : t("agent.lease.idle");
  }
  if (els.agentLeaseMeta) {
    els.agentLeaseMeta.textContent = state.agentLease
      ? `${t(
          state.agentLease.mode === "shared" ? "agent.lease.shared" : "agent.lease.exclusive",
        )} · ${formatAgentLeaseRemaining(state.agentLease)}`
      : t("agent.lease.none");
  }
}

function renderAgentActivity() {
  if (!els.agentActivityDialog || !els.agentActivityList) return;

  const operations = [...state.agentActivity].reverse();
  if (state.agentActivityOpen && state.agentActivityView === "records") {
    state.agentActivityLastSeenSequence = Math.max(
      state.agentActivityLastSeenSequence,
      state.agentOperationSequence,
    );
  }
  const unreadCount = operations.filter(
    (operation) =>
      Number(operation.sequence) > state.agentActivityLastSeenSequence,
  ).length;
  const sessionLabel = getAgentSessionLabel();
  const sessionTarget = getAgentSessionTarget();
  els.agentSessionLabelText.textContent = sessionLabel;
  const shortSessionId = state.agentSessionId.slice(-8);
  els.agentSessionIdText.textContent = shortSessionId
    ? t("agent.session.shortId", { id: shortSessionId })
    : t("agent.session.uninitialized");
  els.agentSessionIdText.title = state.agentSessionId;
  els.agentSessionTarget.textContent = sessionTarget;
  if (els.agentActivityCount) {
    els.agentActivityCount.textContent = String(unreadCount);
    els.agentActivityCount.hidden = unreadCount === 0;
  }
  if (els.agentPendingBadge) {
    els.agentPendingBadge.hidden = !state.agentPendingApproval;
  }
  if (els.agentActivityButton) {
    els.agentActivityButton.dataset.pending = String(Boolean(state.agentPendingApproval));
    els.agentActivityButton.title =
      unreadCount > 0
        ? t("agent.records.unreadTitle", { count: unreadCount })
        : t("agent.records.viewTitle");
    els.agentActivityButton.setAttribute(
      "aria-label",
      unreadCount > 0
        ? t("agent.records.unreadAria", { count: unreadCount })
        : t("agent.records.aria"),
    );
  }
  updateAgentLeaseSummary();
  const activeProfile = getActiveDeviceProfile();
  if (els.agentDeviceProfileName) {
    els.agentDeviceProfileName.textContent = activeProfile?.name || t("agent.profile.none");
  }
  if (els.agentDeviceProfileSummary) {
    els.agentDeviceProfileSummary.textContent = getDeviceProfileSummary(activeProfile);
  }
  if (els.agentTaskCount) {
    els.agentTaskCount.textContent = tCount("agent.tasks.count", state.taskTemplates.length);
  }
  els.agentApprovalMode.value = state.agentApprovalMode;

  let controlState = t("agent.state.offline");
  if (state.agentBridgeReady && state.agentPendingApproval) {
    controlState = t("agent.control.waitingUser");
  } else if (state.agentBridgeReady && state.agentPaused) {
    controlState = t("agent.control.pausedWrites");
  } else if (state.agentBridgeReady && state.agentCommandActive) {
    controlState = t("agent.control.running");
  } else if (state.agentBridgeReady && state.agentControllerConnected) {
    controlState = t("agent.state.online");
  } else if (state.agentBridgeReady) {
    controlState = t("agent.control.waitingController");
  }
  els.agentControlState.textContent = controlState;
  if (els.agentControlHint) {
    els.agentControlHint.textContent = state.agentPendingApproval
      ? t("agent.control.hintApproval")
      : state.agentPaused
        ? t("agent.control.hintPaused")
        : state.agentControllerConnected
          ? t("agent.control.hintConnected")
          : state.agentBridgeReady
            ? t("agent.control.hintReady")
            : t("agent.control.hintOffline");
  }

  const pauseText = els.agentPauseButton.querySelector("span");
  if (pauseText) {
    pauseText.textContent = state.agentPaused
      ? t("agent.control.resume")
      : t("agent.control.pause");
  }
  els.agentPauseButton.classList.toggle("button--danger", state.agentPaused);
  els.agentPauseButton.classList.toggle("button--secondary", !state.agentPaused);
  els.agentPauseButton.setAttribute("aria-pressed", String(state.agentPaused));

  const activeOperation = getActiveAgentOperation();
  els.agentCancelOperationButton.disabled = !activeOperation;
  els.agentActiveOperation.hidden = !activeOperation;
  if (activeOperation) {
    els.agentActiveOperationStatus.textContent =
      `${formatAgentOperationStatus(activeOperation.status)} · ${activeOperation.label}`;
    els.agentActiveOperationCommand.textContent = activeOperation.command;
    els.agentActiveOperationDetail.textContent = [
      activeOperation.paramsSummary,
      activeOperation.target,
      activeOperation.controllerLabel || activeOperation.controllerId,
    ]
      .filter(Boolean)
      .join(" · ");
  }

  els.agentActivityList.replaceChildren();
  els.agentActivityList.hidden = operations.length === 0;
  els.agentActivityEmpty.hidden = operations.length > 0;
  operations.forEach((operation) => {
    const row = document.createElement("article");
    row.className = "agent-activity-item";
    row.dataset.status = operation.status;
    row.dataset.risk = operation.risk;

    const dot = document.createElement("span");
    dot.className = "agent-activity-item__dot";
    dot.setAttribute("aria-hidden", "true");

    const main = document.createElement("div");
    main.className = "agent-activity-item__main";
    const heading = document.createElement("div");
    heading.className = "agent-activity-item__heading";
    const title = document.createElement("strong");
    title.textContent = operation.label;
    const status = document.createElement("span");
    status.className = "agent-activity-item__status";
    status.dataset.status = operation.status;
    status.textContent = formatAgentOperationStatus(operation.status);
    const risk = document.createElement("span");
    risk.className = "agent-activity-item__risk";
    risk.dataset.risk = operation.risk;
    risk.textContent = formatAgentRisk(operation.risk);
    heading.append(title, status, risk);
    const facts = document.createElement("div");
    facts.className = "agent-activity-item__facts";
    [
      formatDateTime(new Date(operation.createdAt), { hour12: false }),
      operation.finishedAt
        ? formatAgentDuration(operation.durationMs)
        : t("agent.activity.running", {
            duration: formatAgentDuration(
              Date.now() - (operation.startedAt || operation.createdAt),
            ),
          }),
      operation.controllerLabel || operation.controllerId || t("agent.activity.pageUser"),
      operation.target,
    ].forEach((value) => {
      const item = document.createElement("small");
      item.textContent = value;
      facts.append(item);
    });
    const details = document.createElement("details");
    details.className = "agent-activity-item__details";
    details.dataset.operationId = operation.id;
    details.open = state.agentActivityExpanded.has(operation.id);
    details.addEventListener("toggle", () => {
      if (details.open) {
        state.agentActivityExpanded.add(operation.id);
      } else {
        state.agentActivityExpanded.delete(operation.id);
      }
    });
    const summary = document.createElement("summary");
    summary.textContent = t("agent.activity.details");
    const detailBody = document.createElement("div");
    const command = document.createElement("code");
    command.textContent = `command: ${operation.command}`;
    const params = document.createElement("pre");
    params.textContent = JSON.stringify(operation.params || {}, null, 2).slice(0, 4000);
    const result = document.createElement("pre");
    result.textContent = (
      operation.error ||
      summarizeAgentResultPreview(operation.result) ||
      t("agent.activity.noResultSummary")
    ).slice(0, 4000);
    detailBody.append(command, params, result);
    details.append(summary, detailBody);
    main.append(heading, facts, details);

    const meta = document.createElement("div");
    meta.className = "agent-activity-item__meta";
    const duration = document.createElement("span");
    duration.textContent = operation.finishedAt
      ? formatAgentDuration(operation.durationMs)
      : formatAgentDuration(Date.now() - (operation.startedAt || operation.createdAt));
    const actions = document.createElement("div");
    actions.className = "agent-activity-item__actions";
    const evidenceButton = document.createElement("button");
    evidenceButton.className = "icon-button icon-button--small";
    evidenceButton.type = "button";
    evidenceButton.title = t("agent.activity.evidenceTitle");
    evidenceButton.dataset.agentAction = "evidence";
    evidenceButton.dataset.operationId = operation.id;
    evidenceButton.innerHTML = '<i data-lucide="file" aria-hidden="true"></i>';
    const taskButton = document.createElement("button");
    taskButton.className = "icon-button icon-button--small";
    taskButton.type = "button";
    taskButton.title = t("agent.activity.saveTaskTitle");
    taskButton.dataset.agentAction = "save-task";
    taskButton.dataset.operationId = operation.id;
    taskButton.innerHTML = '<i data-lucide="bookmark-plus" aria-hidden="true"></i>';
    actions.append(evidenceButton, taskButton);
    meta.append(duration, actions);
    row.append(dot, main, meta);
    els.agentActivityList.append(row);
  });
  renderAgentTaskTemplates();
  createIcons({ icons: { BookmarkPlus, File, Play, Trash2 } });
}

function renderAgentTaskTemplates() {
  if (!els.agentTaskList || !els.agentTaskEmpty) return;
  els.agentTaskList.replaceChildren();
  els.agentTaskEmpty.hidden = state.taskTemplates.length > 0;
  [...state.taskTemplates].reverse().forEach((template) => {
    const row = document.createElement("article");
    row.className = "agent-task-item";
    const main = document.createElement("div");
    main.className = "agent-task-item__main";
    const title = document.createElement("strong");
    title.textContent = template.name;
    const detail = document.createElement("span");
    detail.textContent = [
      template.description,
      tCount("agent.tasks.steps", template.steps.length),
      template.transport.toUpperCase(),
      template.atomic ? t("agent.tasks.atomic") : t("agent.tasks.partial"),
    ]
      .filter(Boolean)
      .join(" · ");
    main.append(title, detail);
    const actions = document.createElement("div");
    actions.className = "agent-task-item__actions";
    const runButton = document.createElement("button");
    runButton.className = "icon-button icon-button--small";
    runButton.type = "button";
    runButton.title = t("agent.tasks.runTitle");
    runButton.dataset.agentAction = "run-task";
    runButton.dataset.taskId = template.id;
    runButton.innerHTML = '<i data-lucide="play" aria-hidden="true"></i>';
    const deleteButton = document.createElement("button");
    deleteButton.className = "icon-button icon-button--small";
    deleteButton.type = "button";
    deleteButton.title = t("agent.tasks.deleteTitle");
    deleteButton.dataset.agentAction = "delete-task";
    deleteButton.dataset.taskId = template.id;
    deleteButton.innerHTML = '<i data-lucide="trash-2" aria-hidden="true"></i>';
    actions.append(runButton, deleteButton);
    row.append(main, actions);
    els.agentTaskList.append(row);
  });
}

function sanitizeAgentResult(result) {
  try {
    const serialized = JSON.stringify(result);
    if (serialized.length <= 65536) return result;
    return {
      truncated: true,
      serializedBytes: serialized.length,
      preview: serialized.slice(0, 65536),
    };
  } catch {
    return { value: String(result) };
  }
}

function serializeAgentOperation(operation, { compact = false, includeResult = false } = {}) {
  if (!operation) return null;
  return {
    operationId: operation.id,
    requestId: operation.requestId || "",
    command: operation.command,
    label: operation.label,
    risk: operation.risk,
    status: operation.status,
    detached: operation.detached,
    sessionId: operation.sessionId,
    sessionLabel: operation.sessionLabel,
    target: operation.target,
    controllerId: operation.controllerId,
    controllerLabel: operation.controllerLabel,
    paramsSummary: operation.paramsSummary,
    approval: operation.approval,
    approvalDeadline: operation.approvalDeadline || 0,
    withdrawnAt: operation.withdrawnAt || 0,
    withdrawReasonCode: operation.withdrawReasonCode || "",
    deliveryState: operation.deliveryState || "",
    deliveryNotice: operation.deliveryNotice || "",
    createdAt: operation.createdAt,
    startedAt: operation.startedAt,
    finishedAt: operation.finishedAt,
    durationMs: operation.durationMs,
    error: operation.error,
    errorCode: operation.errorCode || "",
    evidenceAvailable: Boolean(operation.evidence),
    transactionId: operation.transactionId || "",
    ...(compact
      ? {}
      : {
          result: includeResult ? operation.result : undefined,
          resultPreview: operation.result ? summarizeAgentResultPreview(operation.result) : "",
        }),
  };
}

function summarizeAgentResultPreview(result) {
  if (result === undefined || result === null) return "";
  const text = typeof result === "string" ? result : JSON.stringify(result);
  return String(text).length > 240 ? `${String(text).slice(0, 237)}...` : String(text);
}

export { formatAgentDuration, formatAgentLeaseRemaining, formatAgentOperationStatus, formatAgentRisk, getActiveAgentOperation, getActiveDeviceProfile, getAgentCapabilities, getAgentControlSnapshot, getAgentPortName, getAgentSessionLabel, getAgentSessionTarget, getAgentStatusSnapshot, getDeviceProfileSummary, publishAgentState, renderAgentActivity, renderAgentTaskTemplates, resolveAgentEnding, sanitizeAgentResult, serializeAgentOperation, summarizeAgentResultPreview, updateAgentLeaseSummary, updateAgentUI };
