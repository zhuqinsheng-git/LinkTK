// Module: AI operation lifecycle and human approval.
// Owns: operation create/finish/cancel, approval scopes, upload approvals, and operation history.
// Depends on: core, shared policy, agent/runtime.js, toast.
// Called by: app.js; command execution records are still assembled by app.js.

import { AGENT_APPROVAL_FALLBACK_GRACE_MS, AGENT_COMMAND_IDS, AGENT_DANGEROUS_COMMANDS, AGENT_READ_COMMANDS, AGENT_UPLOAD_APPROVAL_TTL_MS, AGENT_UPLOAD_SCOPED_COMMANDS, DEFAULT_AGENT_APPROVAL_WINDOW_MS, MAX_AGENT_ACTIVITY, MAX_AGENT_OPERATIONS } from "../core/constants.js";
import { els } from "../core/dom.js";
import { t, tCount } from "../core/i18n.js";
import { state } from "../core/state.js";
import { isReadOnlyAgentTransfer } from "../../shared/agent-command-policy.js";
import { showToast } from "../features/toast.js";
import { getActiveAgentOperation, getAgentSessionLabel, getAgentSessionTarget, getAgentStatusSnapshot, publishAgentState, sanitizeAgentResult, serializeAgentOperation, updateAgentUI } from "./runtime.js";

function captureAgentEvidenceSnapshot() {
  const snapshot = getAgentStatusSnapshot();
  return {
    session: snapshot.session,
    serial: {
      connected: snapshot.serial.connected,
      port: snapshot.serial.port,
      baudRate: snapshot.serial.baudRate,
      rxBytes: snapshot.serial.rxBytes,
      txBytes: snapshot.serial.txBytes,
      cursor: snapshot.serial.cursor,
    },
    network: {
      protocol: snapshot.network.protocol,
      role: snapshot.network.role,
      connected: snapshot.network.connected,
      host: snapshot.network.host,
      port: snapshot.network.port,
      peerCount: snapshot.network.peerCount,
      cursor: snapshot.network.cursor,
    },
    ssh: {
      connected: snapshot.ssh.connected,
      host: snapshot.ssh.host,
      port: snapshot.ssh.port,
      username: snapshot.ssh.username,
      alias: snapshot.ssh.alias,
      cursor: snapshot.ssh.cursor,
    },
    deviceProfile: snapshot.deviceProfile,
    bridge: snapshot.bridge,
    ui: snapshot.ui,
  };
}

const AGENT_COMMAND_ID_SET = new Set(AGENT_COMMAND_IDS);

function getAgentCommandLabel(command) {
  return AGENT_COMMAND_ID_SET.has(command)
    ? t(`agent.cmd.${command}`)
    : t("agent.op.unknown", { command: command || "unknown" });
}

// Stable machine codes for the terminal approval states. AI clients should match
// these instead of the localized error prose, which follows the UI language.
function approvalCodeForOutcome(outcome, withdrawReasonCode = "") {
  if (outcome === "denied") return "user-denied";
  if (outcome === "cancelled") return "cancelled";
  if (outcome === "withdrawn") {
    return withdrawReasonCode === "timeout" ? "approval-timeout" : "withdrawn";
  }
  return "";
}

function getAgentCommandRisk(command, params = {}) {
  if (command === "sftp_download_to_file") {
    return isReadOnlyAgentTransfer(command, params) ? "read" : "dangerous";
  }
  if (command === "transaction_execute" || command === "task_run") {
    const steps = Array.isArray(params.steps)
      ? params.steps
      : Array.from(state.taskTemplates)
          .find((template) => template.id === params.taskId || template.name === params.name)
          ?.steps || [];
    if (
      steps.some((step) => {
        const nestedCommand = String(step?.command || "");
        return (
          AGENT_DANGEROUS_COMMANDS.has(nestedCommand) ||
          (!AGENT_READ_COMMANDS.has(nestedCommand) &&
            (nestedCommand.startsWith("sftp_") ||
              nestedCommand.includes("disconnect") ||
              nestedCommand === "ymodem_cancel"))
        );
      })
    ) {
      return "dangerous";
    }
    return steps.some((step) => !AGENT_READ_COMMANDS.has(String(step?.command || "")))
      ? "write"
      : "read";
  }
  if (AGENT_DANGEROUS_COMMANDS.has(command)) return "dangerous";
  return AGENT_READ_COMMANDS.has(command) ? "read" : "write";
}

function summarizeAgentParameter(key, value) {
  if (/password|passphrase|privateKey/i.test(key)) return t("agent.param.redacted");
  if (/base64$/i.test(key)) {
    return tCount("agent.param.chars", String(value || "").length);
  }
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (
      trimmed.length > 1 &&
      trimmed.length <= 100000 &&
      (trimmed.startsWith("{") || trimmed.startsWith("["))
    ) {
      try {
        const parsed = JSON.parse(trimmed);
        if (parsed && typeof parsed === "object") {
          return summarizeAgentParameter(key, parsed);
        }
      } catch {
        // Keep non-JSON strings readable instead of surfacing a parser error.
      }
    }
  }
  if (Array.isArray(value)) {
    return key === "steps"
      ? tCount("agent.param.steps", value.length)
      : tCount("agent.param.items", value.length);
  }
  if (value && typeof value === "object") {
    return tCount("agent.param.keys", Object.keys(value).length);
  }
  const text = String(value ?? "");
  return text.length > 120 ? `${text.slice(0, 117)}...` : text;
}

function summarizeAgentParams(params = {}) {
  return Object.entries(params)
    .filter(([key]) => !["transport", "sessionId"].includes(key))
    .slice(0, 8)
    .map(([key, value]) => `${key}=${summarizeAgentParameter(key, value)}`)
    .join(" · ");
}

function trimAgentOperationHistory() {
  while (state.agentOperations.size > MAX_AGENT_OPERATIONS) {
    const oldest = state.agentOperations.keys().next().value;
    state.agentOperations.delete(oldest);
  }
  state.agentActivity = state.agentActivity
    .filter((operation) => state.agentOperations.has(operation.id))
    .slice(-MAX_AGENT_ACTIVITY);
}

function createAgentOperation(
  command,
  params = {},
  {
    detached = false,
    controller = null,
    requestId = "",
    timeoutMs = 0,
    deadline = 0,
  } = {},
) {
  state.agentOperationSequence += 1;
  const id =
    crypto.randomUUID?.() ||
    `agent-operation-${Date.now()}-${state.agentOperationSequence}`;
  const operation = {
    id,
    requestId: String(requestId || ""),
    sequence: state.agentOperationSequence,
    command,
    label: getAgentCommandLabel(command),
    risk: getAgentCommandRisk(command, params),
    status: "queued",
    detached,
    sessionId: state.agentSessionId,
    sessionLabel: getAgentSessionLabel(),
    target: getAgentSessionTarget(),
    controllerId: String(controller?.id || ""),
    controllerLabel: String(controller?.label || ""),
    paramsSummary: summarizeAgentParams(params),
    params: { ...params },
    approval: "not-required",
    approvalDeadline:
      Number(deadline) ||
      Date.now() +
        Math.max(1000, Number(timeoutMs) || DEFAULT_AGENT_APPROVAL_WINDOW_MS),
    approvalFallbackTimer: null,
    createdAt: Date.now(),
    startedAt: 0,
    finishedAt: 0,
    durationMs: 0,
    error: "",
    errorCode: "",
    result: undefined,
    withdrawnAt: 0,
    withdrawReasonCode: "",
    withdrawalReason: "",
    withdrawnWhileRunning: false,
    deliveryState: "",
    deliveryNotice: "",
    cancelController: new AbortController(),
    evidence: {
      evidenceVersion: 1,
      request: {
        command,
        transport:
          command.startsWith("ssh_") || command.startsWith("sftp_")
            ? "ssh"
            : command.startsWith("network_")
              ? "network"
              : "serial",
        params: { ...params },
      },
      before: captureAgentEvidenceSnapshot(),
      after: null,
    },
  };
  state.agentOperations.set(id, operation);
  state.agentActivity.push(operation);
  trimAgentOperationHistory();
  return operation;
}

function updateAgentOperation(operation, patch = {}) {
  Object.assign(operation, patch);
  publishAgentState();
  updateAgentUI();
}

function finishAgentOperation(
  operation,
  status,
  { error = "", result = undefined, errorCode = "" } = {},
) {
  const finishedAt = Date.now();
  if (operation.approvalFallbackTimer) {
    window.clearTimeout(operation.approvalFallbackTimer);
    operation.approvalFallbackTimer = null;
  }
  if (state.agentPendingApproval?.operationId === operation.id) {
    const outcome =
      status === "withdrawn"
        ? "withdrawn"
        : status === "cancelled"
          ? "cancelled"
          : "denied";
    closeAgentApproval(
      outcome,
      error,
      errorCode || approvalCodeForOutcome(outcome, operation.withdrawReasonCode),
    );
  }
  operation.status = status;
  operation.finishedAt = finishedAt;
  operation.durationMs = Math.max(0, finishedAt - (operation.startedAt || operation.createdAt));
  operation.error = error;
  operation.errorCode = String(errorCode || "");
  if (result !== undefined) operation.result = sanitizeAgentResult(result);
  if (operation.evidence) {
    operation.evidence.after = captureAgentEvidenceSnapshot();
    operation.evidence.finishedAt = finishedAt;
    operation.evidence.result = result === undefined ? undefined : sanitizeAgentResult(result);
    operation.evidence.error = error;
  }
  if (state.agentActiveOperationId === operation.id) {
    state.agentActiveOperationId = "";
    state.agentCommandActive = false;
  }
  publishAgentState();
  updateAgentUI();
}

function getAgentOperationForStatus(operationId = "") {
  const id = String(operationId || state.agentActiveOperationId || "").trim();
  if (id) return state.agentOperations.get(id) || null;
  return state.agentActivity.at(-1) || null;
}

function listAgentOperations(limit = 20) {
  const count = Math.max(1, Math.min(MAX_AGENT_ACTIVITY, Number(limit) || 20));
  return state.agentActivity
    .slice(-count)
    .reverse()
    .map((operation) => serializeAgentOperation(operation));
}

function cancelAgentOperation(operationId = "") {
  const operation =
    (operationId && state.agentOperations.get(String(operationId))) ||
    getActiveAgentOperation();
  if (!operation) throw new Error(t("agent.error.nothingToCancel"));
  if (
    ["succeeded", "failed", "blocked", "cancelled", "withdrawn"].includes(
      operation.status,
    )
  ) {
    return serializeAgentOperation(operation, { includeResult: true });
  }
  if (state.agentPendingApproval?.operationId === operation.id) {
    closeAgentApproval("cancelled", t("agent.cancelled"), "cancelled");
  }
  operation.status = "cancelling";
  operation.cancelRequestedAt = Date.now();
  operation.cancelController?.abort();
  publishAgentState();
  updateAgentUI();
  return serializeAgentOperation(operation, { includeResult: true });
}

function pruneAgentUploadApprovals(now = Date.now()) {
  state.agentApprovedUploads.forEach((approvedAt, uploadId) => {
    if (
      !state.sshAgentUploads.has(uploadId) ||
      now - Number(approvedAt || 0) > AGENT_UPLOAD_APPROVAL_TTL_MS
    ) {
      state.agentApprovedUploads.delete(uploadId);
    }
  });
}

function approveAgentUploadScope(uploadId) {
  const id = String(uploadId || "").trim();
  if (!id || !state.sshAgentUploads.has(id)) return false;
  state.agentApprovedUploads.set(id, Date.now());
  return true;
}

function revokeAgentUploadApproval(uploadId) {
  const id = String(uploadId || "").trim();
  if (!id) return;
  state.agentApprovedUploads.delete(id);
}

function clearAgentUploadApprovals() {
  state.agentApprovedUploads.clear();
}

function hasAgentUploadApprovalScope(operation) {
  if (state.agentApprovalMode !== "confirm-writes") return false;
  if (!AGENT_UPLOAD_SCOPED_COMMANDS.has(operation.command)) return false;
  const uploadId = String(operation.params?.uploadId || "").trim();
  if (!uploadId) return false;
  pruneAgentUploadApprovals();
  if (!state.agentApprovedUploads.has(uploadId)) return false;
  if (!state.sshAgentUploads.has(uploadId)) {
    state.agentApprovedUploads.delete(uploadId);
    return false;
  }
  return true;
}

function requestAgentApproval(operation) {
  if (operation.risk === "read") return Promise.resolve({ outcome: "approved" });
  if (state.agentApprovalMode === "read-only") {
    return Promise.resolve({
      outcome: "denied",
      reason: t("agent.approval.readOnlyDenied"),
      code: "policy-denied",
    });
  }
  if (state.agentApprovalMode === "trusted") {
    return Promise.resolve({ outcome: "approved" });
  }

  return new Promise((resolve) => {
    const now = Date.now();
    const deadline =
      Number(operation.approvalDeadline) > now
        ? Number(operation.approvalDeadline)
        : now + DEFAULT_AGENT_APPROVAL_WINDOW_MS;
    operation.approvalDeadline = deadline;
    state.agentPendingApproval = {
      id: crypto.randomUUID?.() || `approval-${Date.now()}`,
      operationId: operation.id,
      command: operation.command,
      deadline,
      resolve,
    };
    populateAgentApprovalDialog(operation);
    if (!els.agentApprovalDialog.open) els.agentApprovalDialog.showModal();
    updateAgentApprovalCountdown();
    state.agentApprovalCountdownTimer = window.setInterval(
      updateAgentApprovalCountdown,
      250,
    );
    operation.approvalFallbackTimer = window.setTimeout(
      () =>
        withdrawAgentOperation(
          operation.id,
          t("agent.approval.waitingTimeout"),
          "timeout",
        ),
      Math.max(0, deadline - now + AGENT_APPROVAL_FALLBACK_GRACE_MS),
    );
    publishAgentState();
    updateAgentUI();
  });
}

function settleAgentApproval(approved) {
  const pending = state.agentPendingApproval;
  if (!pending) return;
  const operation = state.agentOperations.get(pending.operationId);
  if (
    approved &&
    (!operation ||
      operation.status !== "waiting_approval" ||
      operation.withdrawnAt ||
      Date.now() > pending.deadline)
  ) {
    closeAgentApproval("withdrawn", t("agent.approval.windowExpired"), "approval-timeout");
    withdrawAgentOperation(
      operation?.id || pending.operationId,
      t("agent.approval.waitingTimeout"),
      "timeout",
    );
    return;
  }
  closeAgentApproval(
    approved ? "approved" : "denied",
    approved ? "" : t("agent.approval.denied"),
    approved ? "" : "user-denied",
  );
}

function closeAgentApproval(outcome, reason = "", code = "") {
  const pending = state.agentPendingApproval;
  if (!pending) return false;
  const operation = state.agentOperations.get(pending.operationId);
  if (operation?.approvalFallbackTimer) {
    window.clearTimeout(operation.approvalFallbackTimer);
    operation.approvalFallbackTimer = null;
  }
  if (state.agentApprovalCountdownTimer) {
    window.clearInterval(state.agentApprovalCountdownTimer);
    state.agentApprovalCountdownTimer = null;
  }
  state.agentPendingApproval = null;
  if (els.agentApprovalDialog.open) els.agentApprovalDialog.close();
  pending.resolve({ outcome, reason, code: code || approvalCodeForOutcome(outcome) });
  publishAgentState();
  updateAgentUI();
  return true;
}

function updateAgentApprovalCountdown() {
  const pending = state.agentPendingApproval;
  if (!pending || !els.agentApprovalCountdown) return;
  const remainingMs = Math.max(0, Number(pending.deadline) - Date.now());
  const remainingSeconds = Math.ceil(remainingMs / 1000);
  els.agentApprovalCountdown.textContent =
    remainingSeconds > 0
      ? t("agent.approval.remaining", { seconds: remainingSeconds })
      : t("agent.approval.expired");
  els.agentApprovalCountdown.classList.toggle(
    "is-urgent",
    remainingSeconds <= 10,
  );
}

function populateAgentApprovalDialog(operation) {
  els.agentApprovalCommand.textContent = operation.label;
  els.agentApprovalSession.textContent = getAgentSessionLabel();
  els.agentApprovalTarget.textContent = getAgentSessionTarget();
  els.agentApprovalDetail.textContent = [
    t("agent.approval.detailCommand", { command: operation.command }),
    operation.paramsSummary
      ? t("agent.approval.detailParams", { params: operation.paramsSummary })
      : "",
    t("agent.approval.detailRisk", {
      risk:
        operation.risk === "dangerous"
          ? t("agent.approval.riskDangerous")
          : t("agent.approval.riskWrite"),
    }),
  ]
    .filter(Boolean)
    .join("\n");
  els.agentApprovalWarningText.textContent =
    operation.risk === "dangerous"
      ? t("agent.approval.warningDangerous")
      : t("agent.approval.warningWrite");
  if (els.agentApprovalCountdown) {
    els.agentApprovalCountdown.textContent = t("agentApproval.waiting");
    els.agentApprovalCountdown.classList.remove("is-urgent");
  }
}

function withdrawAgentOperation(operationKey, reason, reasonCode = "withdrawn") {
  const key = String(operationKey || "");
  const operation =
    state.agentOperations.get(key) ||
    [...state.agentOperations.values()].find(
      (candidate) => candidate.requestId === key,
    );
  if (!operation) return null;

  operation.withdrawnAt = operation.withdrawnAt || Date.now();
  operation.withdrawReasonCode = String(reasonCode || "withdrawn");
  operation.withdrawalReason = String(reason || operation.withdrawalReason || "");

  const withdrawCode = approvalCodeForOutcome("withdrawn", operation.withdrawReasonCode);

  if (["queued", "waiting_approval"].includes(operation.status)) {
    operation.approval = "withdrawn";
    if (state.agentPendingApproval?.operationId === operation.id) {
      closeAgentApproval("withdrawn", operation.withdrawalReason, withdrawCode);
    }
    finishAgentOperation(operation, "withdrawn", {
      error: operation.withdrawalReason || t("agent.withdrawn"),
      errorCode: withdrawCode,
    });
    showToast(
      operation.withdrawalReason || t("agent.withdrawnNotExecuted"),
      "info",
    );
    return serializeAgentOperation(operation, { includeResult: true });
  }

  if (
    ["running", "cancelling", "succeeded", "failed", "blocked"].includes(
      operation.status,
    )
  ) {
    operation.withdrawnWhileRunning = operation.status === "running";
    operation.deliveryState = "result-undelivered";
    operation.deliveryNotice = t("agent.delivery.controllerLeft");
    publishAgentState();
    updateAgentUI();
    showToast(operation.deliveryNotice, "info");
  }
  return serializeAgentOperation(operation, { includeResult: true });
}

export { approveAgentUploadScope, cancelAgentOperation, captureAgentEvidenceSnapshot, clearAgentUploadApprovals, closeAgentApproval, createAgentOperation, finishAgentOperation, getAgentCommandLabel, getAgentCommandRisk, getAgentOperationForStatus, hasAgentUploadApprovalScope, listAgentOperations, populateAgentApprovalDialog, pruneAgentUploadApprovals, requestAgentApproval, revokeAgentUploadApproval, settleAgentApproval, summarizeAgentParameter, summarizeAgentParams, trimAgentOperationHistory, updateAgentApprovalCountdown, updateAgentOperation, withdrawAgentOperation };
