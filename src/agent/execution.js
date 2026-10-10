// Module: AI command, transaction, and task execution core.
// Owns: command dispatch, operation records, transaction rollback, and task template execution.
// Depends on: agent catalog/events/operations/runtime/commands and the workspace runtimes.
// Used by: app.js injects three entry points when initializing the AI controller.

import { errorMessage } from "../core/errors.js";
import { t } from "../core/i18n.js";
import { persistSettings } from "../core/settings.js";
import { state } from "../core/state.js";
import { createMacroForAgent, deleteMacroForAgent, listMacrosForAgent } from "../features/macro.js";
import { runMacroForAgent } from "../features/macro-runtime.js";
import { cancelYmodemTransfer } from "../features/ymodem-runtime.js";
import { createTaskFromAgentOperation, createTaskTemplateForAgent, deleteDeviceProfileForAgent, deleteTaskTemplateForAgent, findTaskTemplateForAgent, getAgentEvidenceForOperation, listDeviceProfilesForAgent, listTaskTemplatesForAgent, normalizeAgentStep, replaceTaskVariables, selectDeviceProfileForAgent, upsertDeviceProfileForAgent } from "./catalog.js";
import { appendSshAgentUpload, applyTransactionUndo, beginSshAgentUpload, closeSshAgentDownload, deleteSshEntryForAgent, downloadSshFileForAgent, downloadSshFileToLocalForAgent, execNetworkAgentCommand, execSshAgentCommand, finishSshAgentUpload, getBridgeAgentStatus, getYmodemAgentStatus, listNetworkPresetsForAgent, listSerialPresetsForAgent, listSshDirectoryForAgent, listSshPresetsForAgent, makeSshDirectoryForAgent, openSshAgentDownload, prepareTransactionUndo, readNetworkAgentEvents, readSshAgentDownload, readSshAgentEvents, renameSshEntryForAgent, sendNetworkAgentPayload, sendSshAgentPayload, uploadSshFileForAgent, uploadSshFileFromLocalForAgent, waitForNetworkAgentResponse, waitForSshAgentEvents } from "./commands.js";
import { connectNetworkForAgent, connectSerialForAgent, connectSshForAgent, connectSshPresetForAgent, disconnectNetworkForAgent, disconnectSerialForAgent, disconnectSshForAgent, listSerialPortsForAgent, receiveYmodemForAgent, sendAgentPayload, sendYmodemForAgent, startBridgeForAgent, stopBridgeForAgent } from "./device-commands.js";
import { agentEventsText, agentPatternMatcher, delay, getAgentEventsSince, serializeAgentEvent, waitForAgentEvents } from "./events.js";
import { approveAgentUploadScope, cancelAgentOperation, createAgentOperation, finishAgentOperation, getAgentCommandLabel, getAgentOperationForStatus, hasAgentUploadApprovalScope, listAgentOperations, requestAgentApproval, revokeAgentUploadApproval } from "./operations.js";
import { getAgentCapabilities, getAgentStatusSnapshot, publishAgentState, serializeAgentOperation, updateAgentUI } from "./runtime.js";
import { createAgentTransaction, listAgentTransactions, serializeAgentTransaction } from "./transactions.js";

async function runTaskTemplateForAgent(params = {}, context = {}) {
  const template = findTaskTemplateForAgent(params);
  if (!template) throw new Error(t("agent.transaction.taskNotFound"));
  if (
    template.profileId &&
    state.deviceProfiles.some((profile) => profile.id === template.profileId)
  ) {
    state.activeDeviceProfileId = template.profileId;
    persistSettings();
  }
  return executeTransactionForAgent(
    {
      name: t("agent.task.runName", { name: template.name }),
      steps: template.steps,
      atomic: params.atomic ?? template.atomic,
      allowIrreversible: params.allowIrreversible ?? template.allowIrreversible,
      stopOnError: true,
      variables: params.variables || {},
      sourceTaskId: template.id,
    },
    context,
  );
}

async function executeTransactionForAgent(params = {}, context = {}) {
  const rawSteps = Array.isArray(params.steps) ? params.steps : [];
  const steps = rawSteps
    .map(normalizeAgentStep)
    .filter(Boolean)
    .slice(0, 50);
  if (!steps.length) throw new Error(t("agent.transaction.noSteps"));
  const atomic = params.atomic !== false;
  const allowIrreversible = Boolean(params.allowIrreversible);
  const stopOnError = params.stopOnError !== false;
  const variables = params.variables || {};
  const transaction = createAgentTransaction(params.name, steps);
  let hadStepFailure = false;

  const rollbackCompletedSteps = async () => {
    let failed = false;
    for (const result of [...transaction.stepResults].reverse()) {
      if (["unavailable", "succeeded"].includes(result.rollback)) {
        continue;
      }
      if (result.status !== "succeeded" && !result.executionStarted) {
        result.rollback = "not-needed";
        continue;
      }
      if (!result.undo) {
        failed = true;
        result.rollback = "unavailable";
        continue;
      }
      if (result.undo.kind === "not-required") {
        result.rollback = "not-needed";
        continue;
      }
      if (result.undo.kind === "unsupported") {
        failed = true;
        result.rollback = "unavailable";
        continue;
      }
      try {
        result.rollback = "running";
        result.rollbackResult = await applyTransactionUndo(result.undo, context);
        result.rollback = "succeeded";
      } catch (error) {
        failed = true;
        result.rollback = "failed";
        result.rollbackError = errorMessage(error, t("agent.transaction.rollbackFailed"));
      }
    }
    return failed ? "failed" : "succeeded";
  };

  try {
    for (const step of steps) {
      if (context.signal?.aborted) {
        throw new DOMException(t("agent.cancelled"), "AbortError");
      }
      const stepResult = {
        stepId: step.id,
        label: step.label || getAgentCommandLabel(step.command),
        command: step.command,
        status: "running",
        undo: null,
        rollback: "not-needed",
        executionStarted: false,
        error: "",
        startedAt: Date.now(),
        finishedAt: 0,
        result: undefined,
      };
      transaction.stepResults.push(stepResult);
      transaction.status = "running";
      publishAgentState();
      updateAgentUI();

      try {
        const undo = await prepareTransactionUndo(step, context);
        stepResult.undo = undo;
        if (atomic && undo.kind === "unsupported" && !allowIrreversible) {
          throw new Error(t("agent.transaction.irreversibleStep", { reason: undo.reason }));
        }
        const stepParams = replaceTaskVariables(step.params || {}, variables);
        stepResult.executionStarted = true;
        stepResult.result = await executeAgentCommand(step.command, stepParams, {
          signal: context.signal,
          transactionId: transaction.id,
        });
        stepResult.status = "succeeded";
        stepResult.finishedAt = Date.now();
        persistSettings();
      } catch (error) {
        const message = errorMessage(error, t("agent.transaction.stepFailed"));
        stepResult.status =
          error?.name === "AbortError" ? "cancelled" : "failed";
        stepResult.finishedAt = Date.now();
        stepResult.error = message;
        if (error?.name === "AbortError") throw error;
        const canContinue =
          !atomic && (!stopOnError || Boolean(step.continueOnError));
        if (!canContinue) throw error;
        hadStepFailure = true;
        persistSettings();
      }
    }
    transaction.status = hadStepFailure ? "completed_with_errors" : "succeeded";
    transaction.rollbackStatus = "not-needed";
    transaction.finishedAt = Date.now();
    transaction.result = {
      transaction: serializeAgentTransaction(transaction),
      steps: transaction.stepResults.map((step) => ({
        stepId: step.stepId,
        status: step.status,
        result: step.result,
      })),
    };
    publishAgentState();
    updateAgentUI();
    return transaction.result;
  } catch (error) {
    const message = errorMessage(error, t("agent.transaction.failed"));
    const failedStep = [...transaction.stepResults]
      .reverse()
      .find((step) => step.status === "running");
    if (failedStep) {
      failedStep.status =
        error?.name === "AbortError" ? "cancelled" : "failed";
      failedStep.finishedAt = Date.now();
      failedStep.error = message;
    }
    transaction.error = message;
    transaction.status =
      error?.name === "AbortError" ? "cancelled" : "failed";
    transaction.finishedAt = Date.now();
    if (
      transaction.stepResults.some(
        (step) =>
          step.undo &&
          step.undo.kind !== "not-required" &&
          (step.status === "succeeded" || step.executionStarted),
      )
    ) {
      transaction.rollbackStatus = await rollbackCompletedSteps();
    } else {
      transaction.rollbackStatus = "not-needed";
    }
    transaction.result = {
      transaction: serializeAgentTransaction(transaction),
      rollbackStatus: transaction.rollbackStatus,
    };
    publishAgentState();
    updateAgentUI();
    if (error?.name === "AbortError") throw error;
    throw new Error(
      `${message}${
        transaction.rollbackStatus === "succeeded"
          ? t("agent.transaction.suffixRolledBack")
          : transaction.rollbackStatus === "failed"
            ? t("agent.transaction.suffixRollbackFailed")
            : ""
      }`,
    );
  }
}

async function executeAgentOperationRecord(operation, context = {}) {
  const readOnly = operation.risk === "read";
  if (!readOnly) {
    if (state.agentActiveOperationId && state.agentActiveOperationId !== operation.id) {
      finishAgentOperation(operation, "blocked", {
        error: t("agent.busy.writeInFlight"),
        errorCode: "busy",
      });
      throw new Error(t("agent.busy.writeInFlight"));
    }
    state.agentActiveOperationId = operation.id;
    state.agentCommandActive = true;
  }

  operation.startedAt = Date.now();
  operation.status = "running";
  publishAgentState();
  updateAgentUI();

  try {
    if (operation.risk !== "read" && state.agentPaused) {
      finishAgentOperation(operation, "blocked", {
        error: t("agent.paused.error"),
        errorCode: "paused",
      });
      throw new Error(t("agent.paused.resumeHint"));
    }

    if (operation.risk !== "read") {
      operation.status = "waiting_approval";
      operation.approval = state.agentApprovalMode;
      publishAgentState();
      updateAgentUI();
      const scopedUploadApproval = hasAgentUploadApprovalScope(operation);
      const approval = scopedUploadApproval
        ? { outcome: "approved" }
        : await requestAgentApproval(operation);
      operation.approval =
        approval.outcome === "approved"
          ? scopedUploadApproval
            ? "approved-scope"
            : "approved-once"
          : approval.outcome;
      if (approval.outcome !== "approved") {
        const reason =
          approval.reason ||
          (approval.outcome === "denied"
            ? t("agent.approval.denied")
            : t("agent.withdrawn"));
        const status =
          approval.outcome === "denied"
            ? "blocked"
            : approval.outcome === "cancelled"
              ? "cancelled"
              : "withdrawn";
        if (!["blocked", "cancelled", "withdrawn"].includes(operation.status)) {
          finishAgentOperation(operation, status, {
            error: reason,
            errorCode: approval.code || "",
          });
        }
        throw new Error(reason);
      }
    }

    if (operation.cancelController.signal.aborted) {
      finishAgentOperation(operation, "cancelled", {
        error: t("agent.cancelled"),
        errorCode: "cancelled",
      });
      throw new DOMException(t("agent.cancelled"), "AbortError");
    }

    operation.status = "running";
    publishAgentState();
    updateAgentUI();
    const result = await executeAgentCommand(
      operation.command,
      operation.params,
      {
        signal: operation.cancelController.signal,
        operationId: operation.id,
        transactionId: operation.transactionId,
        controller: context.controller || null,
      },
    );

    if (operation.cancelController.signal.aborted || operation.status === "cancelling") {
      finishAgentOperation(operation, "cancelled", {
        error: t("agent.cancelled"),
        errorCode: "cancelled",
        result,
      });
      throw new DOMException(t("agent.cancelled"), "AbortError");
    }

    operation.transactionId =
      result?.transactionId ||
      result?.transaction?.transactionId ||
      operation.transactionId ||
      "";
    if (operation.command === "sftp_upload_begin") {
      approveAgentUploadScope(result?.uploadId);
    } else if (operation.command === "sftp_upload_end") {
      revokeAgentUploadApproval(operation.params?.uploadId);
    }
    finishAgentOperation(operation, "succeeded", { result });
    return result;
  } catch (error) {
    if (
      operation.status !== "succeeded" &&
      operation.status !== "blocked" &&
      operation.status !== "cancelled" &&
      operation.status !== "withdrawn"
    ) {
      const message = errorMessage(error, t("agent.failed"));
      const cancelled = operation.cancelController.signal.aborted;
      finishAgentOperation(operation, cancelled ? "cancelled" : "failed", {
        error: message,
        errorCode: cancelled ? "cancelled" : "",
      });
    }
    throw error;
  }
}

async function runAgentOperation(command, params = {}, context = {}) {
  const operation = createAgentOperation(command, params, {
    controller: context.controller,
    requestId: context.requestId,
    timeoutMs: context.timeoutMs,
    deadline: context.deadline,
  });
  return executeAgentOperationRecord(operation, context);
}

function startAgentOperation(command, params = {}, context = {}) {
  const operation = createAgentOperation(command, params, {
    detached: true,
    controller: context.controller,
    requestId: context.requestId,
    timeoutMs: context.timeoutMs,
    deadline: context.deadline,
  });
  void executeAgentOperationRecord(operation, context).catch(() => {});
  return serializeAgentOperation(operation, { includeResult: true });
}

async function executeAgentCommand(command, params = {}, context = {}) {
  params = {
    ...params,
    pattern:
      params.pattern ??
      params.expect ??
      "",
  };

  if (command === "status") {
    return getAgentStatusSnapshot();
  }

  if (command === "snapshot") {
    return getAgentStatusSnapshot();
  }

  if (command === "operation_status") {
    const operation = getAgentOperationForStatus(params.operationId);
    return operation
      ? serializeAgentOperation(operation, { includeResult: true })
      : { operation: null };
  }

  if (command === "operation_list") {
    return {
      activeOperationId: state.agentActiveOperationId,
      operations: listAgentOperations(params.limit),
    };
  }

  if (command === "operation_cancel") {
    return {
      operation: cancelAgentOperation(params.operationId),
      activeOperationId: state.agentActiveOperationId,
    };
  }

  if (command === "transaction_execute") {
    return executeTransactionForAgent(params, context);
  }

  if (command === "transaction_list") {
    return {
      total: state.agentTransactions.size,
      transactions: listAgentTransactions(params.limit),
    };
  }

  if (command === "task_template_list") {
    return listTaskTemplatesForAgent();
  }

  if (command === "task_run") {
    return runTaskTemplateForAgent(params, context);
  }

  if (command === "task_create") {
    return createTaskTemplateForAgent(params);
  }

  if (command === "task_create_from_operation") {
    return createTaskFromAgentOperation(params);
  }

  if (command === "task_delete") {
    return deleteTaskTemplateForAgent(params);
  }

  if (command === "device_profile_list") {
    return listDeviceProfilesForAgent();
  }

  if (command === "device_profile_select") {
    return selectDeviceProfileForAgent(params);
  }

  if (command === "device_profile_upsert") {
    return upsertDeviceProfileForAgent(params);
  }

  if (command === "device_profile_delete") {
    return deleteDeviceProfileForAgent(params);
  }

  if (command === "evidence_get") {
    return getAgentEvidenceForOperation(params.operationId);
  }

  if (command === "send") {
    return sendAgentPayload(params);
  }

  if (command === "read") {
    const limit = Math.max(1, Math.min(1000, Number(params.limit) || 200));
    const hasSince = Number.isFinite(Number(params.since));
    const since = hasSince
      ? Number(params.since)
      : Math.max(0, state.agentEventSequence - limit);
    const timeoutMs = Math.max(0, Math.min(120000, Number(params.timeoutMs) || 0));
    if (timeoutMs > 0) {
      await waitForAgentEvents({
        since,
        direction: "all",
        timeoutMs,
        signal: context.signal,
      });
    }
    const events = getAgentEventsSince(since, { limit, direction: "all" });
    const output = agentEventsText(events);
    return {
      cursor: state.agentEventSequence,
      truncated: output.truncated,
      text: output.text,
      events: events.map(serializeAgentEvent),
    };
  }

  if (command === "wait") {
    const timeoutMs = Math.max(10, Math.min(120000, Number(params.timeoutMs) || 5000));
    const since = Number.isFinite(Number(params.since))
      ? Number(params.since)
      : state.agentEventSequence;
    const direction = ["rx", "tx", "all"].includes(params.direction)
      ? params.direction
      : "rx";
    const matcher = agentPatternMatcher(params);
    const result = await waitForAgentEvents({
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
      cursor: state.agentEventSequence,
      text: output.text,
      truncated: output.truncated,
      events: result.events.map(serializeAgentEvent),
    };
  }

  if (command === "exec") {
    const timeoutMs = Math.max(10, Math.min(120000, Number(params.timeoutMs) || 5000));
    const captureMs = Math.max(0, Math.min(5000, Number(params.captureMs) || 0));
    const baseline = state.agentEventSequence;
    const sent = await sendAgentPayload(params);
    const pattern = String(params.pattern || "");
    const matcher = agentPatternMatcher(params);
    const result = await waitForAgentEvents({
      since: baseline,
      direction: "rx",
      timeoutMs,
      predicate: (events) => matcher(agentEventsText(events).text),
      signal: context.signal,
    });
    if (result.matched && captureMs > 0) await delay(captureMs, context.signal);

    const events = getAgentEventsSince(baseline, { direction: "rx", limit: 1000 });
    const output = agentEventsText(events);
    return {
      sent,
      baseline,
      cursor: state.agentEventSequence,
      matched: result.matched,
      timedOut: result.timedOut,
      pattern,
      text: output.text,
      truncated: output.truncated,
      events: events.map(serializeAgentEvent),
    };
  }

  if (command === "serial_status") {
    return {
      ...getAgentStatusSnapshot().serial,
      capabilities: getAgentCapabilities(),
    };
  }

  if (command === "serial_ports") {
    return listSerialPortsForAgent();
  }

  if (command === "serial_presets") {
    return listSerialPresetsForAgent();
  }

  if (command === "serial_connect") {
    return connectSerialForAgent(params, context);
  }

  if (command === "serial_disconnect") {
    return disconnectSerialForAgent();
  }

  if (command === "network_status") {
    return {
      ...getAgentStatusSnapshot().network,
      presets: state.networkConnectionPresets.length,
      capabilities: getAgentCapabilities(),
    };
  }

  if (command === "network_presets") {
    return listNetworkPresetsForAgent();
  }

  if (command === "network_connect") {
    return connectNetworkForAgent(params, context);
  }

  if (command === "network_disconnect") {
    return disconnectNetworkForAgent(context);
  }

  if (command === "network_send") {
    return sendNetworkAgentPayload(params);
  }

  if (command === "network_read") {
    return readNetworkAgentEvents(params, context);
  }

  if (command === "network_wait") {
    return waitForNetworkAgentResponse(params, context);
  }

  if (command === "network_exec") {
    return execNetworkAgentCommand(params, context);
  }

  if (command === "ymodem_status") {
    return getYmodemAgentStatus();
  }

  if (command === "ymodem_send") {
    return sendYmodemForAgent(params, context);
  }

  if (command === "ymodem_receive") {
    return receiveYmodemForAgent(params, context);
  }

  if (command === "ymodem_cancel") {
    await cancelYmodemTransfer();
    return getYmodemAgentStatus();
  }

  if (command === "macro_list") {
    return listMacrosForAgent();
  }

  if (command === "macro_run") {
    return runMacroForAgent(params, context);
  }

  if (command === "macro_create") {
    return createMacroForAgent(params);
  }

  if (command === "macro_delete") {
    return deleteMacroForAgent(params);
  }

  if (command === "bridge_status") {
    return getBridgeAgentStatus();
  }

  if (command === "bridge_start") {
    return startBridgeForAgent(params);
  }

  if (command === "bridge_stop") {
    return stopBridgeForAgent();
  }

  if (command === "ssh_status") {
    return {
      ...getAgentStatusSnapshot().ssh,
      capabilities: getAgentCapabilities(),
    };
  }

  if (command === "ssh_connect") {
    return connectSshForAgent(params);
  }

  if (command === "ssh_presets") {
    return listSshPresetsForAgent();
  }

  if (command === "ssh_connect_preset") {
    return connectSshPresetForAgent(params);
  }

  if (command === "ssh_disconnect") {
    return disconnectSshForAgent();
  }

  if (command === "ssh_send") {
    return sendSshAgentPayload(params);
  }

  if (command === "ssh_read") {
    return readSshAgentEvents(params, context);
  }

  if (command === "ssh_wait") {
    return waitForSshAgentEvents(params, context);
  }

  if (command === "ssh_exec") {
    return execSshAgentCommand(params, context);
  }

  if (command === "sftp_list") {
    return listSshDirectoryForAgent(params);
  }

  if (command === "sftp_mkdir") {
    return makeSshDirectoryForAgent(params);
  }

  if (command === "sftp_rename") {
    return renameSshEntryForAgent(params);
  }

  if (command === "sftp_delete") {
    return deleteSshEntryForAgent(params);
  }

  if (command === "sftp_upload_begin") {
    return beginSshAgentUpload(params);
  }

  if (command === "sftp_upload_chunk") {
    return appendSshAgentUpload(params);
  }

  if (command === "sftp_upload_end") {
    return finishSshAgentUpload(params);
  }

  if (command === "sftp_upload") {
    return uploadSshFileForAgent(params);
  }

  if (command === "sftp_upload_from_file") {
    return uploadSshFileFromLocalForAgent(params, context);
  }

  if (command === "sftp_download_open") {
    return openSshAgentDownload(params);
  }

  if (command === "sftp_download_chunk") {
    return readSshAgentDownload(params);
  }

  if (command === "sftp_download_close") {
    return closeSshAgentDownload(params);
  }

  if (command === "sftp_download") {
    return downloadSshFileForAgent(params);
  }

  if (command === "sftp_download_to_file") {
    return downloadSshFileToLocalForAgent(params, context);
  }

  throw new Error(t("agent.error.unknownCommand", { command }));
}

export { executeAgentCommand, executeAgentOperationRecord, executeTransactionForAgent, runAgentOperation, runTaskTemplateForAgent, startAgentOperation };
